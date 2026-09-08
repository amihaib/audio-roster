// Test doubles that mirror the GNOME 50 / libgvc objects the extension touches.

// Mirrors Gvc.MixerUIDevice: GObject properties `description` and `origin`
// plus the getters GNOME's volume.js and our code call.
export class FakeDevice {
    constructor({id, description, origin = null, port = null, output = true}) {
        this._id = id;
        this.description = description;
        this.origin = origin;
        this._port = port;
        this._output = output;
    }

    get_id() {
        return this._id;
    }

    get_description() {
        return this.description;
    }

    get_origin() {
        return this.origin;
    }

    get_port() {
        return this._port;
    }

    is_output() {
        return this._output;
    }

    get_gicon() {
        return null;
    }
}

// Mirrors the parts of Gvc.MixerControl the code uses.
export class FakeControl {
    constructor(devices = []) {
        this._devices = new Map();
        this._streams = new Map();
        for (const device of devices)
            this.add(device);
    }

    add(device) {
        this._devices.set(device.get_id(), device);
        return device;
    }

    remove(id) {
        this._devices.delete(id);
    }

    setStream(id, name) {
        this._streams.set(id, {get_name: () => name});
    }

    lookup_output_id(id) {
        const device = this._devices.get(id);
        return device && device.is_output() ? device : null;
    }

    lookup_input_id(id) {
        const device = this._devices.get(id);
        return device && !device.is_output() ? device : null;
    }

    get_stream_from_device(device) {
        return this._streams.get(device.get_id()) ?? null;
    }
}

// Mirrors PopupMenu.Ornament from GNOME 50's js/ui/popupMenu.js.
export const ORNAMENT_NONE = 0;
export const ORNAMENT_CHECK = 2;

// Mirrors PopupMenu.PopupImageMenuItem: `.label.text`, setOrnament() and destroy().
// The ornament values are PopupMenu.Ornament.NONE and .CHECK; the literals
// live in this fake only, the extension never names them.
export class FakeItem {
    constructor(text, gicon) {
        this.label = {text};
        this.gicon = gicon;
        this.section = null;
        this.destroyed = false;
        this.ornament = ORNAMENT_NONE;
    }

    setOrnament(value) {
        this.ornament = value;
    }

    destroy() {
        this.destroyed = true;
        this.section?._remove(this);
        this.section = null;
    }
}

// Mirrors PopupMenu.PopupMenuSection, including the exact moveMenuItem algorithm
// of GNOME 50's PopupMenuBase (set_child_below_sibling == insert before).
export class FakeSection {
    constructor() {
        this.items = [];
    }

    addMenuItem(item) {
        item.section = this;
        this.items.push(item);
    }

    _getMenuItems() {
        return [...this.items];
    }

    moveMenuItem(menuItem, position) {
        const items = this._getMenuItems();
        let i = 0;
        while (i < items.length && position > 0) {
            if (items[i] !== menuItem)
                position--;
            i++;
        }

        const current = this.items.indexOf(menuItem);
        if (current === -1)
            throw new Error('moveMenuItem: item is not in this section');

        if (i < items.length) {
            if (items[i] === menuItem)
                return;
            this.items.splice(current, 1);
            this.items.splice(this.items.indexOf(items[i]), 0, menuItem);
        } else {
            this.items.splice(current, 1);
            this.items.push(menuItem);
        }
    }

    _remove(item) {
        const index = this.items.indexOf(item);
        if (index !== -1)
            this.items.splice(index, 1);
    }

    labels() {
        return this.items.map(item => item.label.text);
    }
}

// Mirrors StreamSlider from GNOME 50 js/ui/status/volume.js. Keep the bodies of
// _addDevice/_removeDevice/_sync identical to GNOME's so the patcher is tested
// against the real semantics.
export class FakeSlider {
    constructor(control) {
        this._control = control;
        this._deviceItems = new Map();
        this._deviceSection = new FakeSection();
        this.menuEnabled = false;
        this.syncCount = 0;
    }

    _lookupDevice(_id) {
        throw new Error('_lookupDevice must be implemented by a subclass');
    }

    _addDevice(id) {
        if (this._deviceItems.has(id))
            return;

        const device = this._lookupDevice(id);
        if (!device)
            return;

        const {description, origin} = device;
        const name = origin
            ? `${description} – ${origin}`
            : description;
        const item = new FakeItem(name, device.get_gicon());

        this._deviceSection.addMenuItem(item);
        this._deviceItems.set(id, item);

        this._sync();
    }

    _removeDevice(id) {
        this._deviceItems.get(id)?.destroy();
        if (this._deviceItems.delete(id))
            this._sync();
    }

    // GNOME calls this from the active-output-update / active-input-update signals
    // only: _addDevice never sets an ornament on a freshly created item.
    // Mirrors StreamSlider's implementation in GNOME 50's js/ui/status/volume.js.
    _setActiveDevice(activeId) {
        for (const [id, item] of this._deviceItems)
            item.setOrnament(id === activeId ? ORNAMENT_CHECK : ORNAMENT_NONE);
    }

    _sync() {
        this.syncCount++;
        this.menuEnabled = this._deviceItems.size > 1;
    }

    visibleLabels() {
        return this._deviceSection.labels();
    }

    // Ids whose item carries the CHECK ornament.
    checkedIds() {
        return [...this._deviceItems]
            .filter(([, item]) => item.ornament === ORNAMENT_CHECK)
            .map(([id]) => id);
    }
}

export class FakeOutputSlider extends FakeSlider {
    _lookupDevice(id) {
        return this._control.lookup_output_id(id);
    }
}

export class FakeInputSlider extends FakeSlider {
    _lookupDevice(id) {
        return this._control.lookup_input_id(id);
    }
}
