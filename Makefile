UUID    := audio-roster@amihaitech
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRC     := src
DIST    := dist

.PHONY: all schemas check test link unlink pack install nested nested-test logs prefs switch clean

all: check test

schemas:
	glib-compile-schemas --strict $(SRC)/schemas

check:
	@for f in $(wildcard $(SRC)/*.js $(SRC)/lib/*.js tests/*.js); do node --check "$$f" || exit 1; done

test: schemas
	GSETTINGS_BACKEND=memory gjs -m tests/run.js

link: schemas
	mkdir -p $(dir $(EXT_DIR))
# rm -rf never follows a symlink, so this removes either a previous link or an
# installed copy. Without it `ln -sfn` would nest the link INSIDE an installed
# directory, and the next `install` would delete through it into this repo.
	rm -rf $(EXT_DIR)
	ln -s $(CURDIR)/$(SRC) $(EXT_DIR)

unlink:
	@if [ -L "$(EXT_DIR)" ]; then rm -f "$(EXT_DIR)"; fi
	@find "$(EXT_DIR)" -maxdepth 1 -type l -delete 2>/dev/null || true

pack: schemas
	mkdir -p $(DIST)
	gnome-extensions pack $(SRC) --force --extra-source=lib --extra-source=$(CURDIR)/LICENSE --out-dir=$(DIST)

install: unlink pack
	gnome-extensions install --force $(DIST)/$(UUID).shell-extension.zip
# `gnome-extensions install --force` wipes the target directory recursively and
# follows symlinks while doing it. Fail loudly if the sources did not survive.
	@test -f $(SRC)/extension.js && test -f $(SRC)/lib/patcher.js \
		|| { echo 'FATAL: install damaged $(SRC); restore it with: git checkout -- $(SRC)'; exit 1; }

# Blocks until the nested shell window is closed. Manual use only.
nested:
	dbus-run-session -- gnome-shell --devkit --wayland

# Bounded smoke test in a nested shell with throwaway settings.
nested-test: link
	tests/nested-smoke.sh

logs:
	journalctl --user -f -o cat /usr/bin/gnome-shell

prefs:
	gnome-extensions prefs $(UUID)

# Turn the two old extensions off and this one on in the running session.
# Works only once the session has seen this extension: log out and back in
# after the first `make install`.
switch:
	-gnome-extensions disable quicksettings-audio-devices-hider@marcinjahn.com
	-gnome-extensions disable quicksettings-audio-devices-renamer@marcinjahn.com
	gnome-extensions enable $(UUID)

clean:
	rm -rf $(DIST) $(SRC)/schemas/gschemas.compiled
