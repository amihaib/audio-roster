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

import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Rules} from './lib/rules.js';
import {SliderPatcher} from './lib/patcher.js';

// The volume sliders are created in Quick Settings' async _setupIndicators(), so at
// login they may not exist yet when enable() runs. Poll for 60 seconds, then give up:
// GNOME disables the extension while the screen is locked and enables it again on
// unlock, so enable() may run several times in one login session.
const POLL_INTERVAL_MS = 100;
const MAX_POLLS = 600; // 60 seconds

// GNOME's StreamSlider._init ends with menu.addSettingsAction(_('Sound Settings'),
// 'gnome-sound-panel.desktop'), and PopupMenuBase.addSettingsAction stores the item
// it made under the desktop file name. That key is the handle: unlike the row's
// label it is neither localised nor GNOME-version-dependent.
const SOUND_PANEL_DESKTOP = 'gnome-sound-panel.desktop';
const MENU_ENTRY_LABEL = 'Sound Devices…';

// Quick Settings can exist more than once in a session (other extensions clone
// the panel and keep the copy alive), and every copy has its own device menu.
// Walk the stage so the patcher manages all of them, not just the panel's.
function discoverSliders(proto) {
    const found = [];
    const seen = new Set();
    const visit = (actor, depth) => {
        if (!actor || depth > 40 || seen.has(actor))
            return;
        seen.add(actor);
        if (proto.isPrototypeOf(actor))
            found.push(actor);
        let children = [];
        try {
            children = actor.get_children?.() ?? [];
        } catch {
            return;
        }
        for (const child of children)
            visit(child, depth + 1);
    };
    visit(global.stage, 0);
    return found;
}

export default class QsAudioDevicesExtension extends Extension {
    enable() {
        this._logger = this.getLogger();
        this._rules = new Rules(this.getSettings());
        this._patcher = new SliderPatcher({rules: this._rules, logger: this._logger});
        this._pollId = 0;
        this._polls = 0;

        // Live tokens of every menu row, so one session-mode handler can keep them
        // all in step instead of one handler per slider.
        this._menuTokens = new Set();
        this._sessionModeId = Main.sessionMode.connect('updated', () => this._syncMenuEntries());
        this._menuEntry = {
            install: slider => this._installMenuEntry(slider),
            remove: token => this._removeMenuEntry(token),
        };

        if (!this._tryAttach())
            this._startPolling();
    }

    disable() {
        this._stopPolling();

        try {
            this._patcher?.detach(); // takes every menu row back with it
        } catch (e) {
            this._logger?.error(`audio-roster: detach failed: ${e}`);
        }

        if (this._sessionModeId) {
            Main.sessionMode.disconnect(this._sessionModeId);
            this._sessionModeId = 0;
        }
        this._menuTokens = null;
        this._menuEntry = null;

        // Nothing tracks devices while the extension is off, so the preferences
        // window must not keep showing the last-known ones as connected.
        try {
            this._rules?.setPresent([]);
        } catch (e) {
            this._logger?.error(`audio-roster: could not clear the present-devices list: ${e}`);
        }

        this._patcher = null;
        this._rules = null;
        this._logger = null;
    }

    // Replaces GNOME's "Sound Settings" row with one that opens this extension's
    // preferences, in this slider's device menu. Returns an opaque token for the
    // patcher, or null when there is no menu to add it to.
    _installMenuEntry(slider) {
        if (!slider.menu)
            return null;

        const settingsAction = slider.menu._settingsActions?.[SOUND_PANEL_DESKTOP] ?? null;
        const wasVisible = settingsAction ? settingsAction.visible : null;
        if (settingsAction)
            settingsAction.visible = false;

        let item;
        try {
            // No icon: addAction would build a PopupImageMenuItem, and GNOME's own
            // settings row has none.
            item = slider.menu.addAction(MENU_ENTRY_LABEL, () => {
                Main.panel.closeQuickSettings();
                this.openPreferences();
            });
        } catch (e) {
            // Never leave GNOME's row hidden with nothing in its place.
            if (settingsAction)
                settingsAction.visible = wasVisible;
            throw e;
        }

        // What addSettingsAction does for GNOME's row, kept up to date by
        // _syncMenuEntries: GNOME hides settings rows whenever the session mode
        // disallows settings, and ours must follow.
        item.visible = Main.sessionMode.allowSettings;

        const token = {item, settingsAction, wasVisible};
        this._menuTokens.add(token);
        return token;
    }

    _removeMenuEntry(token) {
        this._menuTokens?.delete(token);

        // Either half can fail on its own if the menu died with its slider.
        try {
            token.item.destroy();
        } catch (e) {
            this._logger?.error(`audio-roster: could not remove the ${MENU_ENTRY_LABEL} entry: ${e}`);
        }
        try {
            if (token.settingsAction)
                token.settingsAction.visible = token.wasVisible;
        } catch (e) {
            this._logger?.error(`audio-roster: could not restore GNOME's sound settings entry: ${e}`);
        }
    }

    // PopupMenuBase connects 'updated' in its own constructor and re-shows every
    // settings action from it (_sessionUpdated -> _setSettingsVisibility). Our handler
    // is connected later, so it runs after GNOME's and hides that row again; without
    // this, every lock/unlock would leave both rows in the menu.
    _syncMenuEntries() {
        for (const token of this._menuTokens ?? []) {
            try {
                token.item.visible = Main.sessionMode.allowSettings;
                if (token.settingsAction)
                    token.settingsAction.visible = false;
            } catch (e) {
                this._logger?.error(`audio-roster: could not update the ${MENU_ENTRY_LABEL} entry: ${e}`);
            }
        }
    }

    _findSliders() {
        const quickSettings = Main.panel?.statusArea?.quickSettings;
        const output = quickSettings?._volumeOutput?._output;
        const input = quickSettings?._volumeInput?._input;
        return output && input ? {output, input} : null;
    }

    // Returns true once the sliders exist, whether or not attaching succeeded
    // (a failed attach is logged and never retried).
    _tryAttach() {
        const sliders = this._findSliders();
        if (!sliders)
            return false;

        try {
            this._patcher.attach({...sliders, discover: discoverSliders, menuEntry: this._menuEntry});
            const {devices, hidden, renamed} = this._patcher.stats;
            this._logger.log(`audio-roster: attached (${devices} devices, ${hidden} hidden, ${renamed} renamed)`);
        } catch (e) {
            this._logger.error(`audio-roster: could not attach, extension inactive: ${e}`);
        }
        return true;
    }

    _startPolling() {
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
            try {
                this._polls++;
                if (this._tryAttach()) {
                    this._pollId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                if (this._polls >= MAX_POLLS) {
                    this._logger.error('audio-roster: Quick Settings volume sliders never appeared; extension inactive');
                    this._pollId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            } catch (e) {
                this._logger.error(`audio-roster: error while waiting for the volume sliders: ${e}`);
                this._pollId = 0;
                return GLib.SOURCE_REMOVE;
            }
        });
        GLib.Source.set_name_by_id(this._pollId, '[qs-audio-devices] wait for volume sliders');
    }

    _stopPolling() {
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = 0;
        }
    }
}
