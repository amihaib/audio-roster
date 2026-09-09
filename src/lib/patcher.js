/*
 * Audio Roster — hide and rename audio devices in GNOME Quick Settings
 * Copyright (C) 2026 AmihaiTech <https://github.com/amihaib>
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
 * PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program; if not, see <https://www.gnu.org/licenses/>.
 */

import {deviceKey, deviceLabel} from './devices.js';

// Hides and renames devices by overriding GNOME's StreamSlider._addDevice and
// _removeDevice on the prototype shared by every stream slider in the session --
// the panel's output and input sliders, plus any further copy another extension
// keeps alive (see attach's `discover`).
// _setActiveDevice is wrapped too, read-only, to know which device carries the
// check mark so a re-added item can get it back.
//
// Sliders are duck-typed (see GNOME 50 js/ui/status/volume.js):
//   _deviceItems   Map id -> PopupImageMenuItem (item.label.text)
//   _deviceSection PopupMenuSection (moveMenuItem)
//   _lookupDevice  id -> Gvc.MixerUIDevice | null
//   _control       Gvc.MixerControl (get_stream_from_device)
//
// No timers, no replacement of GNOME's Map: a hidden device simply never gets
// an item (entry.suppressed === true) until the rule changes or we detach.

export class SliderPatcher {
    constructor({rules, logger}) {
        this._rules = rules;
        this._logger = logger ?? console;
        // slider -> Map<id, {slider, key, label, suppressed}>. Gvc ids are unique per
        // device within a session, but NOT across sliders: a session can hold several
        // Quick Settings (other extensions clone the panel and keep the copy alive),
        // and every OutputStreamSlider gets _addDevice(1), _addDevice(8) ... for the
        // very same ids. A flat id -> entry map let the last slider to register
        // overwrite the others, so only one menu was ever filtered.
        this._entries = new Map();
        this._sliders = [];
        this._discover = null; // optional slider-finding callback given to attach()
        // Optional {install(slider) -> token|null, remove(token)} given to attach().
        // It owns everything Shell-specific about the extra row in a device menu; the
        // patcher only drives its lifecycle, one row per managed slider.
        this._menuEntry = null;
        this._menuTokens = new Map(); // slider -> token returned by menuEntry.install
        // slider -> id GNOME last marked active. An item's ornament cannot be read
        // back through any documented API, so this map starts empty at attach and
        // fills the first time GNOME emits an active-output/input-update.
        this._activeIds = new Map();
        this._proto = null;
        this._saved = null; // original property descriptors {add, remove, setActive}
        // The input slider's own prototype, patched separately so the always-show
        // rule can never reach an output slider. Null when GNOME's layout does not
        // allow it (see _installInputVisibility).
        this._inputProto = null;
        this._savedShouldBeVisible = null;
        this._originalAdd = null;
        this._originalRemove = null;
        this._originalSetActive = null;
        this._rulesHandle = null;
    }

    get attached() {
        return this._proto !== null;
    }

    // Counted per device key, not per entry: the same device listed by two sliders
    // is one device to the user.
    get stats() {
        const keys = new Set();
        const hiddenKeys = new Set();
        for (const entry of this._allEntries()) {
            keys.add(entry.key);
            if (entry.suppressed)
                hiddenKeys.add(entry.key);
        }
        let renamed = 0;
        for (const key of keys) {
            if (this._rules.customName(key) !== null)
                renamed++;
        }
        return {devices: keys.size, hidden: hiddenKeys.size, renamed};
    }

    // Restores GNOME's pristine state. Safe to call twice or without attach().
    detach() {
        if (!this.attached)
            return;

        // Un-patch first: this is the one step that must never be skipped.
        Object.defineProperty(this._proto, '_addDevice', this._saved.add);
        Object.defineProperty(this._proto, '_removeDevice', this._saved.remove);
        if (this._saved.setActive)
            Object.defineProperty(this._proto, '_setActiveDevice', this._saved.setActive);
        if (this._savedShouldBeVisible)
            Object.defineProperty(this._inputProto, '_shouldBeVisible', this._savedShouldBeVisible);

        try {
            if (this._rulesHandle)
                this._rules.disconnect(this._rulesHandle);
        } catch (e) {
            this._logger.error(`audio-roster: could not disconnect rules: ${e}`);
        }
        this._rulesHandle = null;

        // Both loops use the saved originals, never the (now restored) prototype.
        for (const [slider, entries] of this._entries) {
            this._removeMenuEntry(slider);
            for (const [id, entry] of entries) {
                try {
                    if (entry.suppressed) {
                        // GNOME's original returns quietly if the device is already gone.
                        this._originalAdd.call(slider, id);
                        // Already un-patched here, so this uses the saved reference.
                        this._restoreActive(slider);
                    } else {
                        const item = slider._deviceItems.get(id);
                        if (item && item.label.text !== entry.label)
                            item.label.text = entry.label;
                    }
                } catch (e) {
                    this._logger.error(`audio-roster: could not restore device ${id}: ${e}`);
                }
            }
        }
        for (const slider of this._sliders) {
            try {
                this._keepSorted(slider);
                // Recomputes visibility, which is GNOME's own rule again by now.
                slider._sync();
            } catch (e) {
                this._logger.error(`audio-roster: could not restore a slider: ${e}`);
            }
        }

        // A slider can hold a row without ever having held an entry, so no token
        // may be left behind by the pass above.
        for (const slider of [...this._menuTokens.keys()])
            this._removeMenuEntry(slider);

        this._entries.clear();
        this._activeIds.clear();
        this._sliders = [];
        this._discover = null;
        this._menuEntry = null;
        this._proto = null;
        this._saved = null;
        this._inputProto = null;
        this._savedShouldBeVisible = null;
        this._originalAdd = null;
        this._originalRemove = null;
        this._originalSetActive = null;
    }

    // `discover` is optional: a function the caller supplies that, given the slider
    // prototype, returns every slider instance it can find in the session (see
    // extension.js). Without it only `output` and `input` are managed.
    // `menuEntry` is optional too: {install(slider) -> token|null, remove(token)},
    // supplied by extension.js so no Shell knowledge enters this module.
    attach({output, input, discover, menuEntry}) {
        if (this.attached)
            throw new Error('SliderPatcher is already attached');

        const proto = findOwner(output, '_addDevice');
        if (!proto || !Object.hasOwn(proto, '_removeDevice'))
            throw new Error('slider prototype does not own _addDevice and _removeDevice');
        if (!proto.isPrototypeOf(input))
            throw new Error('input slider does not share the output slider prototype');

        this._proto = proto;
        this._saved = {
            add: Object.getOwnPropertyDescriptor(proto, '_addDevice'),
            remove: Object.getOwnPropertyDescriptor(proto, '_removeDevice'),
            setActive: null, // filled by _installWrappers if the prototype owns it
        };
        this._originalAdd = this._saved.add.value;
        this._originalRemove = this._saved.remove.value;
        this._discover = typeof discover === 'function' ? discover : null;
        this._menuEntry = menuEntry ?? null;
        this._sliders = [output, input];

        try {
            this._installWrappers(input);
            // The panel's own sliders are not optional: if either one cannot be taken
            // over, roll the whole attach back rather than run half-patched. Every
            // further slider is someone else's and is merely dropped when it fails.
            this._absorbSlider(output);
            this._absorbSlider(input);
            this._absorbDiscovered();
            this._syncPresent();
            this.resync();
            this._rulesHandle = this._rules.onRulesChanged(() => this._safeResync());
        } catch (e) {
            this.detach(); // leave GNOME exactly as we found it
            throw e;
        }
    }

    // Merges whatever `discover` finds into this._sliders (de-duplicated, validated as
    // a slider of this prototype) and registers every device item not tracked yet.
    // Idempotent, so it can run on attach and again before every resync: a clone of
    // Quick Settings that enters the tree after attach already holds its items and may
    // never see another device signal, so waiting for one would leave it unmanaged.
    _absorbDiscovered() {
        for (const candidate of this._discovered()) {
            if (this._sliders.includes(candidate))
                continue;
            if (!candidate || typeof candidate !== 'object')
                continue;
            if (!(candidate._deviceItems instanceof Map))
                continue;
            if (!this._proto.isPrototypeOf(candidate))
                continue;
            this._sliders.push(candidate);
        }

        // Per device, so a slider we already knew costs nothing and no device is
        // registered twice. Guarded per slider like resync(), and for the same reason:
        // these sliders belong to other extensions and can be disposed under us.
        const dead = [];
        for (const slider of [...this._sliders]) {
            try {
                this._absorbSlider(slider);
            } catch (e) {
                this._logger.error(`audio-roster: could not absorb a slider, dropping it: ${e}`);
                dead.push(slider);
            }
        }
        this._dropSliders(dead);
    }

    // Takes over one slider: registers every device it already holds and applies the
    // current rules to that slider alone, through the saved originals so it never
    // re-enters the wrappers. Idempotent — devices already tracked are skipped.
    _absorbSlider(slider) {
        this._installMenuEntry(slider);

        const entries = this._entriesFor(slider);
        for (const id of [...slider._deviceItems.keys()]) {
            if (entries.has(id))
                continue;

            const entry = this._register(slider, id);
            if (!entry)
                continue;
            if (this._rules.isHidden(entry.key)) {
                this._originalRemove.call(slider, id);
                entry.suppressed = true;
            } else {
                this._applyName(id, entry);
            }
        }
        this._keepSorted(slider);
    }

    // Adds the caller's extra row to a slider's device menu, at most once per slider.
    // Guarded on its own: a row we could not add must never cost that slider its
    // device filtering, so a throw here is logged and the absorb carries on. Without
    // a token the row is simply attempted again on the next absorb.
    _installMenuEntry(slider) {
        if (!this._menuEntry || this._menuTokens.has(slider))
            return;

        try {
            const token = this._menuEntry.install(slider);
            if (token !== null && token !== undefined)
                this._menuTokens.set(slider, token);
        } catch (e) {
            this._logger.error(`audio-roster: could not add the menu entry to a slider: ${e}`);
        }
    }

    // Drops the row again. The token goes whether or not the removal worked, so a
    // slider is never asked to remove the same row twice.
    _removeMenuEntry(slider) {
        if (!this._menuTokens.has(slider))
            return;

        const token = this._menuTokens.get(slider);
        this._menuTokens.delete(slider);
        try {
            this._menuEntry?.remove(token);
        } catch (e) {
            this._logger.error(`audio-roster: could not remove the menu entry of a slider: ${e}`);
        }
    }

    // A throw is our only liveness signal: no Shell import can tell us an actor was
    // disposed. Dropping frees the slider and its items for the rest of the session,
    // and `discover` can hand the slider back later, which re-absorbs it.
    _dropSliders(sliders) {
        for (const slider of sliders) {
            this._removeMenuEntry(slider);
            this._entries.delete(slider);
            this._activeIds.delete(slider);
            const index = this._sliders.indexOf(slider);
            if (index !== -1)
                this._sliders.splice(index, 1);
        }
    }

    // Never throws: a broken discover callback costs us the extra sliders, nothing else.
    _discovered() {
        if (!this._discover)
            return [];
        try {
            return [...(this._discover(this._proto) ?? [])];
        } catch (e) {
            this._logger.error(`audio-roster: could not discover further sliders: ${e}`);
            return [];
        }
    }

    // Re-applies the rules to every known device of every known slider. Each slider is
    // isolated: most of them belong to other extensions, and one disposed actor must
    // not cost the others their filtering. A slider that throws is dropped (after the
    // loops, so no map is mutated while it is being iterated) and logged once.
    resync() {
        const dead = new Set();

        for (const [slider, entries] of this._entries) {
            try {
                for (const [id, entry] of entries) {
                    const hidden = this._rules.isHidden(entry.key);
                    if (hidden && !entry.suppressed) {
                        // GNOME's original on purpose: the wrapper would treat this as the device vanishing.
                        this._originalRemove.call(slider, id);
                        entry.suppressed = true;
                    } else if (!hidden && entry.suppressed) {
                        this._originalAdd.call(slider, id);
                        entry.suppressed = false;
                        this._applyName(id, entry);
                        this._restoreActive(slider);
                    } else if (!hidden) {
                        this._applyName(id, entry);
                    }
                }
            } catch (e) {
                this._logger.error(`audio-roster: resync failed for a slider, dropping it: ${e}`);
                dead.add(slider);
            }
        }

        for (const slider of this._sliders) {
            if (dead.has(slider))
                continue; // already logged; do not touch it twice
            try {
                this._keepSorted(slider);
                // GNOME recomputes visibility in _sync(), which it calls on every
                // device change. A rules change is the one moment nothing calls it,
                // so the always-show-input setting would not take effect until the
                // next device appeared.
                slider._sync();
            } catch (e) {
                this._logger.error(`audio-roster: could not update a slider, dropping it: ${e}`);
                dead.add(slider);
            }
        }

        this._dropSliders(dead);
    }

    _safeResync() {
        try {
            // A settings change is exactly the moment the user waits to see something
            // happen, so look for sliders that appeared since attach before syncing.
            this._absorbDiscovered();
            this._syncPresent();
            this.resync();
            const {hidden, renamed} = this.stats;
            this._logger.log(`audio-roster: resync (${hidden} hidden, ${renamed} renamed)`);
        } catch (e) {
            this._logger.error(`audio-roster: resync failed: ${e}`);
        }
    }

    _installWrappers(input) {
        const patcher = this;
        const originalAdd = this._originalAdd;
        const originalRemove = this._originalRemove;

        // Regular functions so `this` is the slider GNOME calls the method on.
        Object.defineProperty(this._proto, '_addDevice', {
            ...this._saved.add,
            value: function (id) {
                try {
                    patcher._onAddDevice(this, id);
                } catch (e) {
                    patcher._logger.error(`audio-roster: _addDevice failed, using GNOME's: ${e}`);
                    originalAdd.call(this, id);
                }
            },
        });
        Object.defineProperty(this._proto, '_removeDevice', {
            ...this._saved.remove,
            value: function (id) {
                try {
                    patcher._onRemoveDevice(this, id);
                } catch (e) {
                    patcher._logger.error(`audio-roster: _removeDevice failed, using GNOME's: ${e}`);
                    originalRemove.call(this, id);
                }
            },
        });

        this._installInputVisibility(input);

        // GNOME 50's StreamSlider owns _setActiveDevice. If a future version moves it
        // elsewhere, give up the check-mark restoration instead of the extension.
        if (!Object.hasOwn(this._proto, '_setActiveDevice')) {
            this._logger.warn('audio-roster: the slider prototype does not own _setActiveDevice; ' +
                'the active-device check mark will not be restored when a device is un-hidden');
            return;
        }

        this._saved.setActive = Object.getOwnPropertyDescriptor(this._proto, '_setActiveDevice');
        this._originalSetActive = this._saved.setActive.value;
        const originalSetActive = this._originalSetActive;

        Object.defineProperty(this._proto, '_setActiveDevice', {
            ...this._saved.setActive,
            value: function (id) {
                // Only bookkeeping: the original always runs, exactly once.
                try {
                    patcher._activeIds.set(this, id);
                } catch (e) {
                    patcher._logger.error(`audio-roster: could not record the active device: ${e}`);
                }
                originalSetActive.call(this, id);
            },
        });
    }

    // GNOME shows the microphone slider only while an application is recording
    // (InputStreamSlider._maybeShowInput). With `always-show-input` on we widen that
    // to "there is still a microphone to choose", which is exactly _deviceItems.size:
    // a hidden device never gets an item, so hiding every microphone hides the slider
    // again.
    //
    // InputStreamSlider owns its own _shouldBeVisible. Patching that prototype and not
    // the shared one is what keeps the output sliders out of it, so refuse unless the
    // owner really is below the shared prototype -- if a future GNOME moves the method
    // up, give up the feature rather than make every slider always visible.
    _installInputVisibility(input) {
        const inputProto = findOwner(input, '_shouldBeVisible');
        const descriptor = inputProto
            ? Object.getOwnPropertyDescriptor(inputProto, '_shouldBeVisible')
            : null;

        if (!inputProto || !this._proto.isPrototypeOf(inputProto) ||
            typeof descriptor?.value !== 'function') {
            this._logger.warn('audio-roster: the input slider does not own _shouldBeVisible; ' +
                'the microphone slider will only show while an app is recording');
            return;
        }

        this._inputProto = inputProto;
        this._savedShouldBeVisible = descriptor;
        const original = descriptor.value;
        const patcher = this;

        Object.defineProperty(inputProto, '_shouldBeVisible', {
            ...descriptor,
            value: function () {
                try {
                    // No stream means there is nothing for the slider to control, so
                    // GNOME's answer stands even with the setting on.
                    if (patcher._rules.alwaysShowInput() &&
                        this._stream != null && this._deviceItems.size > 0)
                        return true;
                } catch (e) {
                    patcher._logger.error(`audio-roster: _shouldBeVisible failed, using GNOME's: ${e}`);
                }
                return original.call(this);
            },
        });
    }

    // GNOME's _addDevice never sets an ornament; only _setActiveDevice does, and the
    // Shell calls it from the active-output-update / active-input-update signals only.
    // So a device we re-add (un-hidden, or restored on detach) would show no check
    // mark until the user switches devices. Re-asserting the last known active id is
    // cheap: _setActiveDevice just loops over the items.
    _restoreActive(slider) {
        if (!this._originalSetActive || !this._activeIds.has(slider))
            return;
        this._originalSetActive.call(slider, this._activeIds.get(slider));
    }

    _onAddDevice(slider, id) {
        if (slider._deviceItems.has(id))
            return;

        // A Quick Settings we have never seen reaches us here first. It may already
        // hold items of its own, so take the whole slider over -- registering only the
        // triggering device would leave those items unfiltered and unrenamed until the
        // next rules change.
        if (!this._sliders.includes(slider)) {
            this._sliders.push(slider);
            this._absorbSlider(slider);
        }

        const entry = this._register(slider, id);
        if (!entry) {
            this._originalAdd.call(slider, id);
            return;
        }
        this._syncPresent();

        if (this._rules.isHidden(entry.key)) {
            entry.suppressed = true; // no item is created, so nothing flickers
            return;
        }

        this._originalAdd.call(slider, id);
        this._applyName(id, entry);
    }

    // Nothing to manage on a removal, so an unknown slider is simply left alone.
    _onRemoveDevice(slider, id) {
        this._originalRemove.call(slider, id);

        const entries = this._entries.get(slider);
        const entry = entries?.get(id);
        if (entry && entry.slider === slider) {
            entries.delete(id);
            this._syncPresent();
        }
    }

    _entriesFor(slider) {
        let entries = this._entries.get(slider);
        if (!entries) {
            entries = new Map();
            this._entries.set(slider, entries);
        }
        return entries;
    }

    * _allEntries() {
        for (const entries of this._entries.values())
            yield* entries.values();
    }

    _register(slider, id) {
        const device = slider._lookupDevice(id);
        if (!device)
            return null;

        const stream = slider._control?.get_stream_from_device?.(device) ?? null;
        const streamName = stream?.get_name?.() ?? null;
        const entry = {
            slider,
            key: deviceKey(device, streamName),
            label: deviceLabel(device),
            suppressed: false,
        };
        this._entriesFor(slider).set(id, entry);
        this._rules.markSeen(entry.key, entry.label);
        return entry;
    }

    _applyName(id, entry) {
        const item = entry.slider._deviceItems.get(id);
        if (!item)
            return;

        const name = this._rules.customName(entry.key) ?? entry.label;
        if (item.label.text !== name)
            item.label.text = name;
    }

    // Ascending id is GNOME's natural insertion order.
    _keepSorted(slider) {
        const ids = [...slider._deviceItems.keys()].sort((a, b) => a - b);
        ids.forEach((id, index) => {
            slider._deviceSection.moveMenuItem(slider._deviceItems.get(id), index);
        });
    }

    // The union of the device keys of every slider: the same device seen twice is
    // present once.
    _syncPresent() {
        const keys = new Set();
        for (const entry of this._allEntries())
            keys.add(entry.key);
        this._rules.setPresent([...keys]);
    }
}

function findOwner(object, name) {
    let proto = Object.getPrototypeOf(object);
    while (proto && !Object.hasOwn(proto, name))
        proto = Object.getPrototypeOf(proto);
    return proto;
}
