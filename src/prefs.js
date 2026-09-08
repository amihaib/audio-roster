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

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {INPUT, OUTPUT, keyType} from './lib/devices.js';
import {Rules} from './lib/rules.js';

const GROUP_DESCRIPTION = 'Every device GNOME has seen. Switch a device off to hide it from Quick Settings. Expand it to rename it or forget it.';

export default class QsAudioDevicesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const rules = new Rules(this.getSettings());
        const pages = [
            new DevicePage(rules, OUTPUT, {
                title: 'Outputs',
                iconName: 'audio-speakers-symbolic',
                groupTitle: 'Output devices',
            }),
            new DevicePage(rules, INPUT, {
                title: 'Inputs',
                iconName: 'audio-input-microphone-symbolic',
                groupTitle: 'Input devices',
            }),
        ];
        for (const page of pages)
            window.add(page.widget);

        // Rebuild only when devices appear, disappear or are forgotten. Hide/rename
        // changes never rebuild, so typing a name is never interrupted.
        const handle = rules.onRegistryChanged(() => pages.forEach(page => page.rebuild()));
        window.connect('close-request', () => {
            rules.disconnect(handle);
            return false;
        });
    }
}

class DevicePage {
    constructor(rules, type, {title, iconName, groupTitle}) {
        this._rules = rules;
        this._type = type;
        this._rows = [];

        this.widget = new Adw.PreferencesPage({title, icon_name: iconName});
        this._group = new Adw.PreferencesGroup({title: groupTitle, description: GROUP_DESCRIPTION});
        this.widget.add(this._group);
        this.rebuild();
    }

    rebuild() {
        for (const row of this._rows)
            this._group.remove(row);
        this._rows = [];

        const present = this._rules.present();
        const devices = [...this._rules.known()]
            .filter(([key]) => keyType(key) === this._type)
            .map(([key, label]) => ({key, label, connected: present.has(key)}))
            .sort((a, b) => {
                if (a.connected !== b.connected)
                    return a.connected ? -1 : 1;
                return a.label.localeCompare(b.label);
            });

        if (devices.length === 0) {
            this._add(new Adw.ActionRow({
                title: 'No devices seen yet',
                subtitle: 'Open the Quick Settings menu once while the extension is enabled.',
                use_markup: false,
            }));
            return;
        }

        for (const device of devices)
            this._add(this._buildRow(device));
    }

    _add(row) {
        this._group.add(row);
        this._rows.push(row);
    }

    _buildRow({key, label, connected}) {
        const rules = this._rules;
        // use_markup false: device labels may contain '&' or '<'.
        const row = new Adw.ExpanderRow({title: label, use_markup: false});

        const updateSubtitle = () => {
            const name = rules.customName(key);
            let subtitle = connected ? 'Connected' : 'Not connected';
            if (name)
                subtitle += ` · shown as “${name}”`;
            row.subtitle = subtitle;
        };
        updateSubtitle();

        const shown = new Gtk.Switch({
            active: !rules.isHidden(key),
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Show in Quick Settings',
        });
        shown.connect('notify::active', () => rules.setHidden(key, !shown.active));
        row.add_suffix(shown);

        const nameRow = new Adw.EntryRow({
            title: 'Name in Quick Settings',
            text: rules.customName(key) ?? '',
            show_apply_button: true,
        });
        nameRow.connect('apply', () => {
            rules.setName(key, nameRow.text);
            nameRow.text = rules.customName(key) ?? '';
            updateSubtitle();
        });
        const reset = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            has_frame: false,
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Use original name',
        });
        reset.connect('clicked', () => {
            rules.setName(key, null);
            nameRow.text = '';
            updateSubtitle();
        });
        nameRow.add_suffix(reset);
        row.add_row(nameRow);

        const forget = new Adw.ButtonRow({
            title: 'Forget this device',
            start_icon_name: 'user-trash-symbolic',
            sensitive: !connected,
            tooltip_text: connected ? 'Disconnect the device first' : 'Remove this device and its rules',
        });
        forget.add_css_class('destructive-action');
        forget.connect('activated', () => rules.forget(key));
        row.add_row(forget);

        return row;
    }
}
