#!/usr/bin/env bash
# Starts a nested GNOME Shell (devkit) with THROWAWAY settings, enables the extension
# inside it, changes a rule, and checks the shell log. It never touches the real
# session's dconf: GSettings use the keyfile backend under a temp XDG_CONFIG_HOME.
# The nested shell window appears on the desktop for about 30 seconds.
set -euo pipefail

UUID=audio-roster@amihaitech
SCHEMA=org.gnome.shell.extensions.audio-roster
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

if [ ! -e "$EXT_DIR/metadata.json" ]; then
    echo "extension not installed at $EXT_DIR; run 'make link' first" >&2
    exit 2
fi

if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -z "${DISPLAY:-}" ]; then
    # Not launched from inside the graphical session: borrow its sockets.
    export WAYLAND_DISPLAY=$(ls "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" | grep -E '^wayland-[0-9]+$' | head -1)
    export DISPLAY=${DISPLAY:-:0}
fi

TMP=$(mktemp -d /tmp/qs-audio-devices-nested.XXXXXX)
LOG=$TMP/shell.log
export XDG_CONFIG_HOME=$TMP/config
export GSETTINGS_BACKEND=keyfile
export GSETTINGS_SCHEMA_DIR=$EXT_DIR/schemas
mkdir -p "$XDG_CONFIG_HOME"

dbus-run-session -- bash -c '
    LOG=$1; UUID=$2; SCHEMA=$3
    gnome-shell --devkit --wayland >"$LOG" 2>&1 &
    SHELL_PID=$!
    for _ in $(seq 1 30); do
        if gdbus introspect --session --dest org.gnome.Shell --object-path /org/gnome/Shell >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    sleep 3
    gnome-extensions enable "$UUID" || echo "SMOKE: gnome-extensions enable failed" >>"$LOG"
    sleep 6
    gsettings set "$SCHEMA" hidden-devices "[\"output|nobody|nothing\"]" || echo "SMOKE: gsettings set failed" >>"$LOG"
    sleep 3
    kill "$SHELL_PID" 2>/dev/null || true
    for _ in $(seq 1 15); do
        kill -0 "$SHELL_PID" 2>/dev/null || break
        sleep 1
    done
    kill -9 "$SHELL_PID" 2>/dev/null || true
    wait "$SHELL_PID" 2>/dev/null || true
' _ "$LOG" "$UUID" "$SCHEMA"

echo "--- relevant log lines ($LOG) ---"
grep -E "qs-audio-devices|SMOKE:|JS ERROR" "$LOG" || true

# A runtime throw logs a bare "JS ERROR: TypeError: ..." with our files named only in
# the stack lines below it, so scan the stack window, not the JS ERROR line alone.
# The window goes to a file rather than into a pipe: `grep -q` exits on its first
# match, the upstream grep then dies of SIGPIPE, and under `set -o pipefail` the
# leading `!` would turn that failure into a clean bill of health.
grep -A6 "JS ERROR" "$LOG" > "$TMP/js-errors.txt" || true

if grep -q "audio-roster: attached" "$LOG" \
   && grep -q "audio-roster: resync" "$LOG" \
   && ! grep -q "qs-audio-devices" "$TMP/js-errors.txt"; then
    echo "NESTED SMOKE: OK"
else
    echo "NESTED SMOKE: FAILED (full log: $LOG)"
    exit 1
fi
