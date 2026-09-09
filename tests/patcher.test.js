import {SliderPatcher} from '../src/lib/patcher.js';
import {Rules} from '../src/lib/rules.js';
import {test, assert, assertEqual, assertDeepEqual, assertThrows} from './assert.js';
import {FakeControl, FakeDevice, FakeInputSlider, FakeOutputSlider, FakeSlider} from './fakes.js';
import {makeSettings, flush, countWrites} from './settings.js';

export const HDMI = {id: 1, description: 'HDMI / DisplayPort', origin: 'Radeon High Definition Audio Controller', port: 'hdmi-output-0', output: true};
export const LINE_OUT = {id: 8, description: 'Line Out', origin: 'Ryzen HD Audio Controller', port: 'analog-output-lineout', output: true};
export const HEADPHONES = {id: 9, description: 'Headphones', origin: 'Ryzen HD Audio Controller', port: 'analog-output-headphones', output: true};
export const MIC = {id: 10, description: 'Microphone', origin: 'C505 HD Webcam', port: 'analog-input-mic', output: false};

export const HDMI_KEY = 'output|Radeon High Definition Audio Controller|hdmi-output-0';
export const LINE_OUT_KEY = 'output|Ryzen HD Audio Controller|analog-output-lineout';
export const HEADPHONES_KEY = 'output|Ryzen HD Audio Controller|analog-output-headphones';
export const MIC_KEY = 'input|C505 HD Webcam|analog-input-mic';

export const HDMI_LABEL = 'HDMI / DisplayPort – Radeon High Definition Audio Controller';
export const LINE_OUT_LABEL = 'Line Out – Ryzen HD Audio Controller';
export const HEADPHONES_LABEL = 'Headphones – Ryzen HD Audio Controller';
export const MIC_LABEL = 'Microphone – C505 HD Webcam';

// The patcher modifies FakeSlider.prototype; every test restores it so tests stay independent.
const PRISTINE = {
    add: Object.getOwnPropertyDescriptor(FakeSlider.prototype, '_addDevice'),
    remove: Object.getOwnPropertyDescriptor(FakeSlider.prototype, '_removeDevice'),
    setActive: Object.getOwnPropertyDescriptor(FakeSlider.prototype, '_setActiveDevice'),
    // Patched on the input prototype only, like GNOME's InputStreamSlider.
    shouldBeVisible: Object.getOwnPropertyDescriptor(FakeInputSlider.prototype, '_shouldBeVisible'),
    // The shared one, which must never be touched: the output sliders inherit it.
    baseShouldBeVisible: Object.getOwnPropertyDescriptor(FakeSlider.prototype, '_shouldBeVisible'),
};

export function restorePrototype() {
    Object.defineProperty(FakeSlider.prototype, '_addDevice', PRISTINE.add);
    Object.defineProperty(FakeSlider.prototype, '_removeDevice', PRISTINE.remove);
    Object.defineProperty(FakeSlider.prototype, '_setActiveDevice', PRISTINE.setActive);
    Object.defineProperty(FakeInputSlider.prototype, '_shouldBeVisible', PRISTINE.shouldBeVisible);
    Object.defineProperty(FakeSlider.prototype, '_shouldBeVisible', PRISTINE.baseShouldBeVisible);
}

export function ptest(name, fn) {
    test(name, () => {
        try {
            fn();
        } finally {
            restorePrototype();
        }
    });
}

// Builds settings, rules, a fake mixer with `devices`, one output and one input
// slider, and (like GNOME does before any extension runs) adds every device to
// its slider. `configure(rules)` runs before that so pre-existing rules can be set.
// `sliders` swaps in other slider classes (used to test a prototype that does not
// own _setActiveDevice).
// `secondOutput: true` builds a SECOND output slider over the same FakeControl,
// holding items for the very same device ids. That mirrors the live session, where
// another extension keeps a cloned Quick Settings alive and two OutputStreamSliders
// each own a device menu of their own.
export function setup({
    devices = [HDMI, LINE_OUT, MIC],
    addAll = true,
    configure = () => {},
    sliders = {output: FakeOutputSlider, input: FakeInputSlider},
    secondOutput = false,
} = {}) {
    const settings = makeSettings();
    const rules = new Rules(settings);
    configure(rules);

    const control = new FakeControl(devices.map(d => new FakeDevice(d)));
    const {output: OutputClass, input: InputClass} = sliders;
    const output = new OutputClass(control);
    const input = new InputClass(control);
    const output2 = secondOutput ? new OutputClass(control) : null;
    if (addAll) {
        for (const d of devices) {
            (d.output ? output : input)._addDevice(d.id);
            if (output2 && d.output)
                output2._addDevice(d.id);
        }
    }

    const logger = {
        errors: [],
        warnings: [],
        log() {},
        warn(message) {
            this.warnings.push(String(message));
        },
        error(message) {
            this.errors.push(String(message));
        },
    };
    const patcher = new SliderPatcher({rules, logger});
    return {settings, rules, control, output, output2, input, patcher, logger};
}

ptest('attach hides pre-existing hidden devices and renames named ones', () => {
    const {rules, output, input, patcher} = setup({
        configure: r => {
            r.setHidden(HDMI_KEY, true);
            r.setName(LINE_OUT_KEY, 'Speakers');
        },
    });
    patcher.attach({output, input});

    assertEqual(patcher.attached, true);
    assertDeepEqual(output.visibleLabels(), ['Speakers']);
    assertEqual(output.menuEnabled, false, 'arrow disappears with a single visible device');
    assertDeepEqual(input.visibleLabels(), [MIC_LABEL]);
    assertDeepEqual([...rules.known()].sort(), [
        [HDMI_KEY, HDMI_LABEL], [LINE_OUT_KEY, LINE_OUT_LABEL], [MIC_KEY, MIC_LABEL],
    ].sort());
    assertDeepEqual([...rules.present()].sort(), [HDMI_KEY, LINE_OUT_KEY, MIC_KEY].sort());
});

ptest('a device added later while hidden never gets an item; a visible one is added renamed', () => {
    const {rules, output, input, patcher, control} = setup({
        devices: [],
        configure: r => {
            r.setHidden(HDMI_KEY, true);
            r.setName(LINE_OUT_KEY, 'Speakers');
        },
    });
    patcher.attach({output, input});

    control.add(new FakeDevice(HDMI));
    const before = output.syncCount;
    output._addDevice(HDMI.id);
    assertDeepEqual(output.visibleLabels(), []);
    assertEqual(output._deviceItems.size, 0);
    assertEqual(output.syncCount, before, 'no item was created and destroyed');
    assert(rules.present().has(HDMI_KEY), 'hidden devices are still tracked as present');
    assertEqual(rules.known().get(HDMI_KEY), HDMI_LABEL);

    control.add(new FakeDevice(LINE_OUT));
    output._addDevice(LINE_OUT.id);
    assertDeepEqual(output.visibleLabels(), ['Speakers']);
});

ptest('a late-arriving device is appended exactly like GNOME does', () => {
    const {output, input, patcher, control} = setup({devices: [LINE_OUT]});
    patcher.attach({output, input});

    control.add(new FakeDevice(HDMI));
    output._addDevice(HDMI.id);
    assertDeepEqual(output.visibleLabels(), [LINE_OUT_LABEL, HDMI_LABEL]);
});

ptest('portless devices are keyed by their stream name', () => {
    const {rules, output, input, patcher, control} = setup({devices: []});
    patcher.attach({output, input});

    control.add(new FakeDevice({id: 20, description: 'Speakers', origin: 'USB DAC', port: null, output: true}));
    control.setStream(20, 'alsa_output.usb-dac');
    output._addDevice(20);
    assert(rules.present().has('output|USB DAC|stream:alsa_output.usb-dac'));
});

ptest('removing a hidden (suppressed) device drops it from present without touching items', () => {
    const {rules, output, input, patcher, control} = setup({configure: r => r.setHidden(HDMI_KEY, true)});
    patcher.attach({output, input});
    assertEqual(output._deviceItems.size, 1);

    control.remove(HDMI.id);
    output._removeDevice(HDMI.id);
    assert(!rules.present().has(HDMI_KEY));
    assertDeepEqual(output.visibleLabels(), [LINE_OUT_LABEL]);
});

ptest('removing a visible device destroys its item and updates present', () => {
    const {rules, output, input, patcher, control} = setup();
    patcher.attach({output, input});

    control.remove(LINE_OUT.id);
    output._removeDevice(LINE_OUT.id);
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL]);
    assertDeepEqual([...rules.present()].sort(), [HDMI_KEY, MIC_KEY].sort());
});

ptest('a remove routed through the other slider leaves the entry alone', () => {
    const {rules, output, input, patcher} = setup();
    patcher.attach({output, input});

    input._removeDevice(HDMI.id); // wrong slider for an output id: GNOME's original is a no-op there
    assert(rules.present().has(HDMI_KEY), 'entry survives a remove from the wrong slider');
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);
});

ptest('resync applies current rules to existing devices', () => {
    const {rules, output, input, patcher} = setup();
    patcher.attach({output, input});
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);

    rules.setHidden(HDMI_KEY, true);
    rules.setName(LINE_OUT_KEY, 'Speakers');
    patcher.resync();
    assertDeepEqual(output.visibleLabels(), ['Speakers']);

    rules.setHidden(HDMI_KEY, false);
    rules.setName(LINE_OUT_KEY, null);
    patcher.resync();
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL], 'un-hidden device returns to id order');
    assertEqual(output.menuEnabled, true);
});

ptest('one override on the shared prototype serves both sliders', () => {
    const {rules, output, input, patcher, control} = setup({
        devices: [],
        configure: r => r.setHidden(MIC_KEY, true),
    });
    patcher.attach({output, input});

    assert(FakeSlider.prototype._addDevice !== PRISTINE.add.value, 'shared prototype is patched');
    assert(!Object.hasOwn(FakeOutputSlider.prototype, '_addDevice'), 'subclass prototypes untouched');
    assert(!Object.hasOwn(FakeInputSlider.prototype, '_addDevice'), 'subclass prototypes untouched');

    control.add(new FakeDevice(MIC));
    input._addDevice(MIC.id);
    assertDeepEqual(input.visibleLabels(), []);
    assert(rules.present().has(MIC_KEY));
});

ptest('registry writes happen only when something changed', () => {
    const {settings, output, input, patcher} = setup();
    const writes = countWrites(settings);
    patcher.attach({output, input});
    assertEqual(writes.n, 4, '3 markSeen + 1 setPresent');

    patcher.resync();
    output._addDevice(HDMI.id);
    assertEqual(writes.n, 4, 'nothing changed, nothing written');
});

ptest('a failing rule lookup falls back to GNOME behaviour and logs once', () => {
    const {rules, output, input, patcher, control, logger} = setup();
    patcher.attach({output, input});

    rules.isHidden = () => {
        throw new Error('boom');
    };
    control.add(new FakeDevice(HEADPHONES));
    output._addDevice(HEADPHONES.id);

    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL, HEADPHONES_LABEL]);
    assertEqual(logger.errors.length, 1);
    assert(rules.present().has(HEADPHONES_KEY), 'device was still registered');
});

ptest('attach refuses sliders that do not share a prototype and leaves it untouched', () => {
    const {output, patcher} = setup();
    class Other {
        constructor() {
            this._deviceItems = new Map();
        }

        _addDevice() {}

        _removeDevice() {}

        _lookupDevice() {
            return null;
        }
    }

    assertThrows(() => patcher.attach({output, input: new Other()}));
    assertEqual(FakeSlider.prototype._addDevice, PRISTINE.add.value);
    assertEqual(patcher.attached, false);
});

ptest('hiding a device through settings removes it live; un-hiding re-adds it in id order', () => {
    const {rules, output, input, patcher} = setup();
    patcher.attach({output, input});

    rules.setHidden(HDMI_KEY, true);
    flush();
    assertDeepEqual(output.visibleLabels(), [LINE_OUT_LABEL]);
    assertEqual(output.menuEnabled, false);

    rules.setHidden(HDMI_KEY, false);
    flush();
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);
    assertEqual(output.menuEnabled, true);
});

ptest('renaming through settings applies live and clearing restores the original', () => {
    const {rules, output, input, patcher, logger} = setup();
    const logged = [];
    logger.log = message => logged.push(String(message));
    patcher.attach({output, input});

    rules.setName(LINE_OUT_KEY, 'Speakers');
    flush();
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, 'Speakers']);
    assertEqual(logged.filter(m => m.includes('audio-roster: resync (0 hidden, 1 renamed)')).length, 1);

    rules.setName(LINE_OUT_KEY, '');
    flush();
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);
});

ptest('detach restores items, labels, order and the prototype, and stops listening', () => {
    const {rules, output, input, patcher} = setup({
        configure: r => {
            r.setHidden(HDMI_KEY, true);
            r.setName(LINE_OUT_KEY, 'Speakers');
        },
    });
    patcher.attach({output, input});
    assertDeepEqual(output.visibleLabels(), ['Speakers']);

    patcher.detach();
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);
    assertDeepEqual(input.visibleLabels(), [MIC_LABEL]);
    assertEqual(FakeSlider.prototype._addDevice, PRISTINE.add.value);
    assertEqual(FakeSlider.prototype._removeDevice, PRISTINE.remove.value);
    assertEqual(FakeSlider.prototype._setActiveDevice, PRISTINE.setActive.value);
    assertEqual(patcher.attached, false);

    patcher.detach(); // idempotent

    rules.setHidden(LINE_OUT_KEY, true);
    flush();
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL], 'no effect after detach');
});

ptest('detach tolerates a device that vanished while hidden', () => {
    const {output, input, patcher, control, logger} = setup({configure: r => r.setHidden(HDMI_KEY, true)});
    patcher.attach({output, input});

    control.remove(HDMI.id); // gone from Gvc, but no output-removed signal was delivered yet
    patcher.detach();
    assertDeepEqual(output.visibleLabels(), [LINE_OUT_LABEL]);
    assertEqual(logger.errors.length, 0);
    assertEqual(FakeSlider.prototype._addDevice, PRISTINE.add.value);
});

ptest('re-attaching with unchanged devices writes nothing', () => {
    const {settings, output, input, patcher} = setup();
    patcher.attach({output, input});
    patcher.detach();

    const writes = countWrites(settings);
    patcher.attach({output, input});
    assertEqual(writes.n, 0);
});

ptest('stats count devices, hidden and renamed', () => {
    const {output, input, patcher} = setup({
        configure: r => {
            r.setHidden(HDMI_KEY, true);
            r.setName(LINE_OUT_KEY, 'Speakers');
        },
    });
    patcher.attach({output, input});
    assertDeepEqual(patcher.stats, {devices: 3, hidden: 1, renamed: 1});
});

ptest('a failure during attach rolls everything back', () => {
    const {rules, output, input, patcher} = setup();
    // Succeeds once so HDMI is really suppressed before the failure: the rollback must re-add it.
    let calls = 0;
    rules.isHidden = key => {
        if (calls++ > 0)
            throw new Error('boom');
        return key === HDMI_KEY;
    };

    assertThrows(() => patcher.attach({output, input}));
    assertEqual(patcher.attached, false);
    assertEqual(FakeSlider.prototype._addDevice, PRISTINE.add.value);
    assertEqual(FakeSlider.prototype._removeDevice, PRISTINE.remove.value);
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);
});

// GNOME sets the check mark only from _setActiveDevice (active-output-update /
// active-input-update), never in _addDevice, so every re-add has to re-assert it.
ptest('un-hiding the active device gives it its check mark back', () => {
    const {rules, output, input, patcher} = setup();
    patcher.attach({output, input});

    output._setActiveDevice(HDMI.id);
    assertDeepEqual(output.checkedIds(), [HDMI.id]);

    rules.setHidden(HDMI_KEY, true);
    flush();
    assertDeepEqual(output.visibleLabels(), [LINE_OUT_LABEL]);
    assertDeepEqual(output.checkedIds(), [], 'the item is gone with the device');

    rules.setHidden(HDMI_KEY, false);
    flush();
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);
    assertDeepEqual(output.checkedIds(), [HDMI.id], 're-added active device is checked again');
});

ptest('a device hidden from the start is checked when un-hidden while it is active', () => {
    const {rules, output, input, patcher} = setup({configure: r => r.setHidden(HDMI_KEY, true)});
    patcher.attach({output, input});
    assertDeepEqual(output.visibleLabels(), [LINE_OUT_LABEL]);

    // GNOME reports the active device even while it has no menu item at all.
    output._setActiveDevice(HDMI.id);
    assertDeepEqual(output.checkedIds(), []);

    rules.setHidden(HDMI_KEY, false);
    flush();
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);
    assertDeepEqual(output.checkedIds(), [HDMI.id]);
});

ptest('detach re-adds a suppressed active device with its check mark', () => {
    const {output, input, patcher} = setup({configure: r => r.setHidden(HDMI_KEY, true)});
    patcher.attach({output, input});
    output._setActiveDevice(HDMI.id);
    output._setActiveDevice(LINE_OUT.id);
    output._setActiveDevice(HDMI.id); // the last update wins

    patcher.detach();
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);
    assertDeepEqual(output.checkedIds(), [HDMI.id]);
});

ptest('a prototype without _setActiveDevice is patched anyway, with a warning', () => {
    // If a future GNOME moves _setActiveDevice off the slider prototype, hiding and
    // renaming must keep working; only the check-mark restoration is given up.
    class BareSlider extends FakeSlider {
        _addDevice(id) {
            super._addDevice(id);
        }

        _removeDevice(id) {
            super._removeDevice(id);
        }
    }
    class BareOutput extends BareSlider {
        _lookupDevice(id) {
            return this._control.lookup_output_id(id);
        }
    }
    class BareInput extends BareSlider {
        _lookupDevice(id) {
            return this._control.lookup_input_id(id);
        }

        // Owned here like GNOME's InputStreamSlider, so this test is about
        // _setActiveDevice alone.
        _shouldBeVisible() {
            return super._shouldBeVisible() && this._showInput;
        }
    }
    assert(!Object.hasOwn(BareSlider.prototype, '_setActiveDevice'), 'the test prototype does not own it');
    const barePristineAdd = BareSlider.prototype._addDevice;

    const {rules, output, input, patcher, logger} = setup({
        sliders: {output: BareOutput, input: BareInput},
    });
    patcher.attach({output, input});

    assertEqual(patcher.attached, true);
    assertEqual(logger.errors.length, 0);
    assertEqual(logger.warnings.length, 1);
    assert(logger.warnings[0].includes('_setActiveDevice'), logger.warnings[0]);

    output._setActiveDevice(HDMI.id); // inherited and unpatched
    rules.setHidden(HDMI_KEY, true);
    flush();
    assertDeepEqual(output.visibleLabels(), [LINE_OUT_LABEL]);

    rules.setHidden(HDMI_KEY, false);
    flush();
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL], 'hide and un-hide still work');
    assertDeepEqual(output.checkedIds(), [], 'without the method there is nothing to restore');

    patcher.detach();
    assertEqual(BareSlider.prototype._addDevice, barePristineAdd, 'the patched prototype is restored');
    assertEqual(FakeSlider.prototype._addDevice, PRISTINE.add.value, 'the base prototype was never touched');
});

// --- more than one Quick Settings in the session -----------------------------
// Other extensions (dash-to-panel among them) clone Quick Settings and keep the
// copy alive, so a session can hold several OutputStreamSliders, each with its own
// _deviceItems and its own device menu. All of them must be managed, or the menu
// the user actually looks at keeps showing a device that was hidden.

ptest('hiding a device removes its item from every slider, not just the panel one', () => {
    const {rules, output, output2, input, patcher} = setup({secondOutput: true});
    // Junk in the discover result must be ignored, duplicates de-duplicated.
    patcher.attach({
        output,
        input,
        discover: () => [output2, output2, output, null, {}, {_deviceItems: new Map()}],
    });

    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);
    assertDeepEqual(output2.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);

    rules.setHidden(HDMI_KEY, true);
    flush();
    assertDeepEqual(output.visibleLabels(), [LINE_OUT_LABEL]);
    assertDeepEqual(output2.visibleLabels(), [LINE_OUT_LABEL], 'the second menu is filtered too');
    assertEqual(output2.menuEnabled, false);

    rules.setHidden(HDMI_KEY, false);
    flush();
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);
    assertDeepEqual(output2.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL], 'restored in id order');
});

ptest('a rename applies to the items of every slider', () => {
    const {rules, output, output2, input, patcher} = setup({secondOutput: true});
    patcher.attach({output, input, discover: () => [output2]});

    rules.setName(LINE_OUT_KEY, 'Speakers');
    flush();
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, 'Speakers']);
    assertDeepEqual(output2.visibleLabels(), [HDMI_LABEL, 'Speakers']);

    rules.setName(LINE_OUT_KEY, '');
    flush();
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);
    assertDeepEqual(output2.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);
});

ptest('detach restores items, labels and order in every slider', () => {
    const {output, output2, input, patcher} = setup({
        secondOutput: true,
        configure: r => {
            r.setHidden(HDMI_KEY, true);
            r.setName(LINE_OUT_KEY, 'Speakers');
        },
    });
    patcher.attach({output, input, discover: () => [output2]});
    assertDeepEqual(output.visibleLabels(), ['Speakers']);
    assertDeepEqual(output2.visibleLabels(), ['Speakers']);

    patcher.detach();
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);
    assertDeepEqual(output2.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL], 'the second menu is pristine too');
    assertDeepEqual([...output2._deviceItems.keys()].sort((a, b) => a - b), [HDMI.id, LINE_OUT.id]);
    assertEqual(input.visibleLabels().length, 1);
    assertEqual(FakeSlider.prototype._addDevice, PRISTINE.add.value);
});

ptest('a slider that appears after attach is managed from its first device', () => {
    const {rules, control, output, input, patcher} = setup({
        configure: r => r.setHidden(HDMI_KEY, true),
    });
    patcher.attach({output, input}); // no discover: this slider does not exist yet

    const late = new FakeOutputSlider(control);
    late._addDevice(HDMI.id);
    late._addDevice(LINE_OUT.id);
    assertDeepEqual(late.visibleLabels(), [LINE_OUT_LABEL], 'the hidden device gets no item here either');
    assertEqual(late._deviceItems.size, 1);

    rules.setHidden(HDMI_KEY, false);
    flush();
    assertDeepEqual(late.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL], 'self-registered slider is resynced');
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL], 'and the original one still is');
});

ptest('a device shown in two sliders is counted once', () => {
    const {rules, output, output2, input, patcher} = setup({
        secondOutput: true,
        configure: r => {
            r.setHidden(HDMI_KEY, true);
            r.setName(LINE_OUT_KEY, 'Speakers');
        },
    });
    patcher.attach({output, input, discover: () => [output2]});

    assertDeepEqual(output2.visibleLabels(), ['Speakers'], 'the second slider really is managed');
    assertDeepEqual(patcher.stats, {devices: 3, hidden: 1, renamed: 1}, 'unique device keys, not entries');
    assertDeepEqual([...rules.present()].sort(), [HDMI_KEY, LINE_OUT_KEY, MIC_KEY].sort());
});

ptest('a discover function that throws does not stop attach', () => {
    const {rules, output, input, patcher, logger} = setup();
    patcher.attach({
        output,
        input,
        discover: () => {
            throw new Error('boom');
        },
    });

    assertEqual(patcher.attached, true);
    assertEqual(logger.errors.length, 1, 'the failure is logged once');
    assert(logger.errors[0].includes('boom'), logger.errors[0]);

    rules.setHidden(HDMI_KEY, true);
    rules.setHidden(MIC_KEY, true);
    flush();
    assertDeepEqual(output.visibleLabels(), [LINE_OUT_LABEL], 'the output slider is still managed');
    assertDeepEqual(input.visibleLabels(), [], 'the input slider is still managed');
});

ptest('a slider discovered only later is absorbed on the next resync', () => {
    const {rules, output, output2, input, patcher} = setup({
        secondOutput: true,
        configure: r => r.setName(LINE_OUT_KEY, 'Speakers'),
    });
    // The clone is not in the tree yet when attach walks it; it turns up later.
    let calls = 0;
    patcher.attach({output, input, discover: () => (calls++ === 0 ? [] : [output2])});

    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, 'Speakers']);
    assertDeepEqual(output2.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL], 'not managed yet');

    rules.setHidden(HDMI_KEY, true);
    flush();
    assertDeepEqual(output.visibleLabels(), ['Speakers']);
    assertDeepEqual(output2.visibleLabels(), ['Speakers'], 'absorbed, then hidden and renamed');
    assertDeepEqual(patcher.stats, {devices: 3, hidden: 1, renamed: 1}, 'still counted once');

    // Absorbing again must not double-register anything.
    rules.setHidden(HDMI_KEY, false);
    flush();
    assertDeepEqual(output2.visibleLabels(), [HDMI_LABEL, 'Speakers']);
    assertDeepEqual(patcher.stats, {devices: 3, hidden: 0, renamed: 1});
});

// --- sliders we do not own can die under us ---------------------------------
// The extra sliders belong to other extensions. A disposed GJS actor throws on any
// access, so one bad slider must never cost the others their filtering.

ptest('a slider that throws during resync is isolated, and dropped', () => {
    const {rules, control, output, output2, input, patcher, logger} = setup({secondOutput: true});
    // A device only this clone knows about, so dropping it is visible in stats.
    control.add(new FakeDevice(HEADPHONES));
    output2._addDevice(HEADPHONES.id);
    // A third slider AFTER the failing one: it must still be filtered.
    const output3 = new FakeOutputSlider(control);
    output3._addDevice(HDMI.id);
    output3._addDevice(LINE_OUT.id);

    let calls = 0;
    patcher.attach({output, input, discover: () => (calls++ === 0 ? [output2, output3] : [])});
    assertDeepEqual(patcher.stats, {devices: 4, hidden: 0, renamed: 0});

    output2._deviceItems.get(HDMI.id).destroy = () => {
        throw new Error('disposed actor');
    };

    rules.setHidden(HDMI_KEY, true);
    flush();
    assertDeepEqual(output.visibleLabels(), [LINE_OUT_LABEL], 'the panel slider is still filtered');
    assertDeepEqual(output3.visibleLabels(), [LINE_OUT_LABEL], 'a later slider is still filtered');
    assertEqual(logger.errors.length, 1, 'logged once for the failing slider');
    assertDeepEqual(patcher.stats, {devices: 3, hidden: 1, renamed: 0}, 'the dead slider is gone');

    const untouched = output2.visibleLabels();
    rules.setHidden(HDMI_KEY, false);
    flush();
    assertDeepEqual(output2.visibleLabels(), untouched, 'the dropped slider is never poked again');
    assertEqual(logger.errors.length, 1, 'and never logs again');
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL]);
    assertDeepEqual(output3.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL], 'keepSorted ran for it too');
});

ptest('a slider first seen through _addDevice absorbs the devices it already holds', () => {
    const {control, output, input, patcher} = setup({
        configure: r => {
            r.setHidden(HDMI_KEY, true);
            r.setName(LINE_OUT_KEY, 'Speakers');
        },
    });
    // Built and filled before we ever see it; only its next device announces it.
    const clone = new FakeOutputSlider(control);
    clone._addDevice(HDMI.id);
    clone._addDevice(LINE_OUT.id);

    patcher.attach({output, input});

    control.add(new FakeDevice(HEADPHONES));
    clone._addDevice(HEADPHONES.id);

    assertEqual(clone._deviceItems.has(HDMI.id), false, 'the hidden device it already held is gone');
    assertDeepEqual(clone.visibleLabels(), ['Speakers', HEADPHONES_LABEL],
        'existing items are filtered and renamed at once, without waiting for a rules change');
});

ptest('a dropped slider is re-absorbed when discover hands it back', () => {
    const {rules, output, output2, input, patcher, logger} = setup({secondOutput: true});
    let hand = true;
    patcher.attach({output, input, discover: () => (hand ? [output2] : [])});

    const item = output2._deviceItems.get(HDMI.id);
    const realDestroy = item.destroy.bind(item);
    item.destroy = () => {
        throw new Error('disposed actor');
    };

    hand = false;
    rules.setHidden(HDMI_KEY, true);
    flush();
    assertEqual(logger.errors.length, 1);

    item.destroy = realDestroy; // the actor was fine after all, or discover has a rebuilt one
    rules.setName(LINE_OUT_KEY, 'Speakers');
    flush();
    assertDeepEqual(output2.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL],
        'stays dropped while discover does not return it');

    hand = true;
    rules.setName(LINE_OUT_KEY, 'Studio');
    flush();
    assertDeepEqual(output2.visibleLabels(), ['Studio'], 're-absorbed, hidden and renamed');
    assertEqual(logger.errors.length, 1, 'no new errors');
});

// --- the extra row in every device menu --------------------------------------
// extension.js replaces GNOME's "Sound Settings" row with one that opens this
// extension's preferences. Everything Shell-specific about that row lives there;
// the patcher only receives {install(slider) -> token|null, remove(token)} and
// drives its lifecycle, one row per managed slider.
//
// Sliders are compared by identity, never with assertDeepEqual: a FakeSlider holds
// items that point back at their section, and JSON.stringify chokes on the cycle.

// Records every call. `failInstallFor` / `failRemoveFor` name a slider whose
// install / remove throws, standing in for a disposed menu.
function fakeMenuEntry({failInstallFor = null, failRemoveFor = null} = {}) {
    return {
        installed: [], // sliders install() was called for, in order
        removed: [],   // tokens remove() was called with, in order
        install(slider) {
            this.installed.push(slider);
            if (slider === failInstallFor)
                throw new Error('install boom');
            return {slider};
        },
        remove(token) {
            this.removed.push(token);
            if (token.slider === failRemoveFor)
                throw new Error('remove boom');
        },
    };
}

ptest('the menu entry is installed exactly once per slider', () => {
    const {rules, output, output2, input, patcher} = setup({secondOutput: true});
    const menuEntry = fakeMenuEntry();
    patcher.attach({output, input, discover: () => [output2], menuEntry});

    assertEqual(menuEntry.installed.length, 3, 'output, input and the discovered slider');
    assert(menuEntry.installed[0] === output, 'the output slider got a row');
    assert(menuEntry.installed[1] === input, 'the input slider got a row');
    assert(menuEntry.installed[2] === output2, 'the discovered slider got a row');

    // attach absorbs output and input directly and again through _absorbDiscovered,
    // and every rules change absorbs them once more: none of that may add a row.
    rules.setHidden(HDMI_KEY, true);
    flush();
    rules.setName(LINE_OUT_KEY, 'Speakers');
    flush();
    assertEqual(menuEntry.installed.length, 3, 'resyncs never install a second row');
});

ptest('a slider that appears after attach gets a menu entry too', () => {
    const {control, output, input, patcher} = setup();
    const menuEntry = fakeMenuEntry();
    patcher.attach({output, input, menuEntry}); // no discover: this slider does not exist yet

    const late = new FakeOutputSlider(control);
    late._addDevice(HDMI.id); // self-registers through the wrapped _addDevice

    assertEqual(menuEntry.installed.length, 3);
    assert(menuEntry.installed[2] === late, 'the self-registered slider got a row');

    late._addDevice(LINE_OUT.id);
    assertEqual(menuEntry.installed.length, 3, 'and only one');
});

ptest('detach removes every menu entry once, and only once', () => {
    const {output, output2, input, patcher} = setup({secondOutput: true});
    const menuEntry = fakeMenuEntry();
    patcher.attach({output, input, discover: () => [output2], menuEntry});
    assertEqual(menuEntry.installed.length, 3);

    patcher.detach();
    assertEqual(menuEntry.removed.length, 3, 'one removal per installed row');
    assertEqual(new Set(menuEntry.removed.map(t => t.slider)).size, 3, 'a different row each time');
    assertEqual(patcher._menuTokens.size, 0, 'no token left behind');

    patcher.detach(); // idempotent
    assertEqual(menuEntry.removed.length, 3, 'a second detach removes nothing again');
});

ptest('a slider dropped during resync loses its menu entry', () => {
    const {rules, output, output2, input, patcher, logger} = setup({secondOutput: true});
    const menuEntry = fakeMenuEntry();
    let calls = 0;
    patcher.attach({output, input, discover: () => (calls++ === 0 ? [output2] : []), menuEntry});
    assertEqual(menuEntry.installed.length, 3);

    output2._deviceItems.get(HDMI.id).destroy = () => {
        throw new Error('disposed actor');
    };
    rules.setHidden(HDMI_KEY, true);
    flush();

    assertEqual(logger.errors.length, 1, 'the dead slider is logged once');
    assertEqual(menuEntry.removed.length, 1, 'and its row is taken back');
    assert(menuEntry.removed[0].slider === output2, 'the dropped slider, not another one');
    assertEqual(patcher._menuTokens.size, 2, 'the surviving sliders keep theirs');
});

ptest('a menu entry that cannot be installed costs only the entry', () => {
    const {rules, output, output2, input, patcher, logger} = setup({
        secondOutput: true,
        configure: r => {
            r.setHidden(HDMI_KEY, true);
            r.setName(LINE_OUT_KEY, 'Speakers');
        },
    });
    const menuEntry = fakeMenuEntry({failInstallFor: output2});
    patcher.attach({output, input, discover: () => [output2], menuEntry});

    assertEqual(patcher.attached, true);
    assertEqual(logger.errors.length, 1, 'the failure is logged');
    assert(logger.errors[0].includes('install boom'), logger.errors[0]);
    assertEqual(patcher._menuTokens.has(output2), false, 'no token without a row');
    assertDeepEqual(output2.visibleLabels(), ['Speakers'],
        'the slider is still filtered and renamed');

    // A failed row must not get the slider dropped either.
    rules.setHidden(HDMI_KEY, false);
    flush();
    assertDeepEqual(output2.visibleLabels(), [HDMI_LABEL, 'Speakers'], 'still managed');
});

ptest('a menu entry that cannot be removed does not stop detach', () => {
    const {output, output2, input, patcher, logger} = setup({
        secondOutput: true,
        configure: r => {
            r.setHidden(HDMI_KEY, true);
            r.setName(LINE_OUT_KEY, 'Speakers');
        },
    });
    const menuEntry = fakeMenuEntry({failRemoveFor: output});
    patcher.attach({output, input, discover: () => [output2], menuEntry});
    assertDeepEqual(output2.visibleLabels(), ['Speakers']);

    patcher.detach();
    assertEqual(logger.errors.length, 1, 'the failure is logged once');
    assert(logger.errors[0].includes('remove boom'), logger.errors[0]);
    assertEqual(menuEntry.removed.length, 3, 'the other rows are still taken back');
    assertEqual(patcher._menuTokens.size, 0);
    assertDeepEqual(output.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL], 'its devices are restored');
    assertDeepEqual(output2.visibleLabels(), [HDMI_LABEL, LINE_OUT_LABEL], 'and every other slider is');
    assertEqual(FakeSlider.prototype._addDevice, PRISTINE.add.value, 'the prototype is un-patched');
    assertEqual(patcher.attached, false);
});

// --- the microphone slider ---------------------------------------------------
// GNOME shows it only while an app is recording (InputStreamSlider._maybeShowInput),
// so the device list behind it is unreachable the rest of the time.

ptest('the microphone slider stays visible with a microphone left to choose', () => {
    const {output, input, patcher} = setup();
    assertEqual(input.visible, false, 'GNOME hides it while nothing is recording');

    patcher.attach({output, input});

    assertEqual(input.visible, true);
    assertEqual(input._showInput, false, 'still nothing recording; GNOME’s own flag is untouched');
    assertDeepEqual(input.visibleLabels(), [MIC_LABEL]);
});

ptest('hiding every microphone hides the slider again', () => {
    const {rules, output, input, patcher} = setup();
    patcher.attach({output, input});
    assertEqual(input.visible, true);

    rules.setHidden(MIC_KEY, true);
    flush();
    assertEqual(input.visible, false, 'nothing left to choose');
    assertDeepEqual(input.visibleLabels(), []);

    rules.setHidden(MIC_KEY, false);
    flush();
    assertEqual(input.visible, true);
});

ptest('with the setting off GNOME’s recording rule stands', () => {
    const {rules, output, input, patcher} = setup({
        configure: r => r.setAlwaysShowInput(false),
    });
    patcher.attach({output, input});

    assertEqual(input.visible, false);

    input.setRecording(true);
    assertEqual(input.visible, true, 'GNOME still shows it while recording');

    // Turning the setting on takes effect without waiting for a device change.
    input.setRecording(false);
    rules.setAlwaysShowInput(true);
    flush();
    assertEqual(input.visible, true);
});

ptest('the always-show rule never reaches an output slider', () => {
    const {output, input, patcher} = setup();
    patcher.attach({output, input});

    assertEqual(FakeSlider.prototype._shouldBeVisible, PRISTINE.baseShouldBeVisible.value,
        'the shared prototype is untouched');

    output._stream = null;
    output._sync();
    assertEqual(output.visible, false, 'an output slider with no stream is still hidden');
});

ptest('detach gives the microphone slider back to GNOME', () => {
    const {output, input, patcher} = setup();
    patcher.attach({output, input});
    assertEqual(input.visible, true);

    patcher.detach();

    assertEqual(input.visible, false, 'hidden again, nothing is recording');
    assertEqual(FakeInputSlider.prototype._shouldBeVisible, PRISTINE.shouldBeVisible.value,
        'the input prototype is un-patched');
    assertDeepEqual(input.visibleLabels(), [MIC_LABEL], 'and its device is still there');
});

ptest('an input prototype that does not own _shouldBeVisible is left alone', () => {
    // If a future GNOME moves the method onto the shared prototype, patching it would
    // make every output slider always visible too. Give the feature up instead.
    class PlainInput extends FakeSlider {
        _lookupDevice(id) {
            return this._control.lookup_input_id(id);
        }
    }
    const {output, input, patcher, logger} = setup({
        sliders: {output: FakeOutputSlider, input: PlainInput},
    });
    patcher.attach({output, input});

    assertEqual(patcher.attached, true, 'hiding and renaming still work');
    assertEqual(logger.errors.length, 0);
    assertEqual(logger.warnings.length, 1);
    assert(logger.warnings[0].includes('_shouldBeVisible'), logger.warnings[0]);
    assertEqual(FakeSlider.prototype._shouldBeVisible, PRISTINE.baseShouldBeVisible.value,
        'the shared prototype is untouched');
    assertEqual(input.visible, true, 'a plain slider has no recording rule to obey');
    assertDeepEqual(input.visibleLabels(), [MIC_LABEL]);
});
