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

// Typed access to the extension's GSettings keys. Every write compares first so that
// re-enabling with unchanged devices performs no dconf writes at all.

export const HIDDEN_KEY = 'hidden-devices';
export const NAMES_KEY = 'device-names';
export const KNOWN_KEY = 'known-devices';
export const PRESENT_KEY = 'present-devices';
export const ALWAYS_SHOW_INPUT_KEY = 'always-show-input';

export class Rules {
    constructor(settings) {
        this._settings = settings;
    }

    // --- reads ---

    isHidden(key) {
        return this._settings.get_strv(HIDDEN_KEY).includes(key);
    }

    customName(key) {
        return normalizeName(this._dict(NAMES_KEY)[key]);
    }

    hidden() {
        return this._settings.get_strv(HIDDEN_KEY);
    }

    names() {
        return new Map(Object.entries(this._dict(NAMES_KEY)));
    }

    known() {
        return new Map(Object.entries(this._dict(KNOWN_KEY)));
    }

    present() {
        return new Set(this._settings.get_strv(PRESENT_KEY));
    }

    alwaysShowInput() {
        return this._settings.get_boolean(ALWAYS_SHOW_INPUT_KEY);
    }

    // --- writes used by preferences ---

    setHidden(key, hidden) {
        const current = this._settings.get_strv(HIDDEN_KEY);
        if (current.includes(key) === hidden)
            return;

        const next = hidden ? [...current, key] : current.filter(k => k !== key);
        this._settings.set_strv(HIDDEN_KEY, next);
    }

    setName(key, name) {
        const dict = this._dict(NAMES_KEY);
        const normalized = normalizeName(name);

        if (normalized === null) {
            if (!(key in dict))
                return;
            delete dict[key];
        } else {
            if (dict[key] === normalized)
                return;
            dict[key] = normalized;
        }
        this._setDict(NAMES_KEY, dict);
    }

    forget(key) {
        this.setHidden(key, false);
        this.setName(key, null);

        const known = this._dict(KNOWN_KEY);
        if (key in known) {
            delete known[key];
            this._setDict(KNOWN_KEY, known);
        }
    }

    // --- writes used by the extension ---

    markSeen(key, label) {
        const known = this._dict(KNOWN_KEY);
        if (known[key] === label)
            return;

        known[key] = label;
        this._setDict(KNOWN_KEY, known);
    }

    setAlwaysShowInput(value) {
        if (this._settings.get_boolean(ALWAYS_SHOW_INPUT_KEY) === value)
            return;
        this._settings.set_boolean(ALWAYS_SHOW_INPUT_KEY, value);
    }

    setPresent(keys) {
        const next = [...new Set(keys)].sort();
        const current = [...this._settings.get_strv(PRESENT_KEY)].sort();
        if (current.length === next.length && current.every((k, i) => k === next[i]))
            return;

        this._settings.set_strv(PRESENT_KEY, next);
    }

    // --- signals ---

    onRulesChanged(callback) {
        return this._connect([HIDDEN_KEY, NAMES_KEY, ALWAYS_SHOW_INPUT_KEY], callback);
    }

    onRegistryChanged(callback) {
        return this._connect([KNOWN_KEY, PRESENT_KEY], callback);
    }

    disconnect(handle) {
        for (const id of handle)
            this._settings.disconnect(id);
        handle.length = 0;
    }

    // --- internals ---

    _connect(keys, callback) {
        return keys.map(key => this._settings.connect(`changed::${key}`, () => callback()));
    }

    _dict(key) {
        return this._settings.get_value(key).deepUnpack();
    }

    _setDict(key, dict) {
        this._settings.set_value(key, new GLib.Variant('a{ss}', dict));
    }
}

function normalizeName(name) {
    if (typeof name !== 'string')
        return null;
    const trimmed = name.trim();
    return trimmed === '' ? null : trimmed;
}
