# Audio Roster

A GNOME Shell 50 extension that hides and renames audio output and input devices in
the Quick Settings device lists. Switching stays native: the arrow next to the
volume slider opens GNOME's own list, now showing only the devices you want, with
the names you chose.

Built to replace three extensions that fought over the same private Shell code:
Quick Settings Audio Devices Hider, Quick Settings Audio Devices Renamer and
Quick Settings Audio Panel.

- Hide the devices you never pick, so the list holds only what you use.
- Rename the ones whose stock labels are unhelpful ("Line Out – Ryzen HD Audio
  Controller" can just be "Speakers").
- Rules are keyed to the sound card and port, not to the display label, so they
  survive a language change or a Bluetooth profile switch.
- Nothing is disabled at the system level: devices stay available everywhere else,
  they are just hidden from this one list.

## Requirements

- GNOME Shell 50 (tested on Ubuntu 26.04.1, Wayland, PipeWire)
- `gnome-extensions` CLI (part of gnome-shell), `make`, `gjs` (tests), `node` (syntax check)

## Install

```bash
git clone https://github.com/amihaib/audio-roster.git
cd audio-roster
make install          # packs src/ and installs the zip for your user
# Wayland cannot load new extension code into a running session:
# log out and back in, then
make switch
```

GNOME Shell only scans the extensions folder at login, so the log out/in is
required before the extension can be enabled.

## Configure

`gnome-extensions prefs audio-roster@amihaitech` (or open it from the
Extensions app). Outputs and Inputs each list every device GNOME has seen:

- the switch on the right shows or hides the device in Quick Settings;
- expand a row to set the name shown in Quick Settings (leave it empty for the
  original name);
- devices marked "Not connected" can be forgotten; a connected one simply
  reappears, so forget is only offered while it is disconnected.

Connect a Bluetooth or USB device once so it appears in the list, then configure it.

The device dropdown also gets a **Sound Devices…** row in place of GNOME's "Sound
Settings", which opens these preferences. GNOME's sound panel is still one click
away through the gear icon at the top of Quick Settings.

## Moving off the old extensions

If you came here from the Hider and Renamer extensions, `make switch` runs the
three commands below: it disables both of them and enables this one. (You can skip
it and just run `gnome-extensions enable audio-roster@amihaitech` if you never had
them.)

```bash
gnome-extensions disable quicksettings-audio-devices-hider@marcinjahn.com
gnome-extensions disable quicksettings-audio-devices-renamer@marcinjahn.com
gnome-extensions enable audio-roster@amihaitech
```

When satisfied, uninstall them (`gnome-extensions uninstall <uuid>`). Uninstalling
Quick Settings Audio Panel as well removes its sliders-at-the-top layout and its
application mixer; this extension does not provide those. Their leftover settings can
be cleared with `dconf reset -f /org/gnome/shell/extensions/<name>/`.

## How it works

- GNOME builds each device row in one method, `StreamSlider._addDevice`. The
  extension overrides that method (and `_removeDevice`) on the prototype shared by
  the output and input sliders. Hidden devices never get a row; other rows get
  their custom label. Disabling the extension restores everything.
- Devices are identified by `type|origin|port` (the origin is the card description
  libgvc reports, the port its unlocalised name), not by their display label, so a
  language change or a Bluetooth profile switch does not orphan your rules. A device
  without a port falls back to `type|origin|stream:<stream name>` and, failing that,
  to `type|origin|desc:<description>`. Two identical devices — same model, same card
  description, same port — therefore share one key, so hiding or renaming one of them
  affects both.
- The extension runs only in the normal session. GNOME disables it while the screen
  is locked, and everything it patched is restored until you unlock.

## Development

```bash
make test         # unit tests in plain gjs (memory-backed GSettings, fake sliders)
make check        # syntax check with node
make link         # symlink src/ into ~/.local/share/gnome-shell/extensions
make nested-test  # 30 s smoke test in a nested shell with throwaway settings
make logs         # follow gnome-shell's journal
```

After changing code, `make install` and log out/in (Wayland). Logs are prefixed
`audio-roster:`.

GJS caches extension modules for the whole login session, so disabling and
re-enabling the extension does **not** reload edited code — only a fresh login does.
`make nested-test` sidesteps that by running a nested shell.

## Contributing

Issues and pull requests are welcome. Please keep `make test` green and `make check`
clean; `src/lib/` must stay free of GNOME Shell imports so it can run under plain
`gjs` in the test suite.

## License

Copyright (C) 2026 AmihaiTech (<https://github.com/amihaib>)

GPL-3.0-or-later. See [LICENSE](LICENSE).
