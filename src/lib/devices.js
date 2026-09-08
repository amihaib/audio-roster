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

// Pure helpers describing a Gvc.MixerUIDevice. No GNOME Shell imports, so this
// runs in plain gjs for tests.

export const OUTPUT = 'output';
export const INPUT = 'input';

export function deviceType(device) {
    return device.is_output() ? OUTPUT : INPUT;
}

// Must match GNOME's volume.js label exactly (en dash U+2013) so the labels shown
// in preferences are the ones the user sees in the menu.
export function deviceLabel(device) {
    const description = device.get_description() ?? '';
    const origin = device.get_origin();
    return origin ? `${description} – ${origin}` : description;
}

// Stable identity for rules. The port name is unlocalised and does not change when
// a Bluetooth device switches profile; the origin (card description) distinguishes cards.
// Portless devices fall back to the stream name, then to the description.
export function deviceKey(device, streamName = null) {
    const port = device.get_port();
    let tail;
    if (port)
        tail = port;
    else if (streamName)
        tail = `stream:${streamName}`;
    else
        tail = `desc:${device.get_description() ?? ''}`;

    return `${deviceType(device)}|${device.get_origin() ?? ''}|${tail}`;
}

export function keyType(key) {
    return key.startsWith(`${INPUT}|`) ? INPUT : OUTPUT;
}
