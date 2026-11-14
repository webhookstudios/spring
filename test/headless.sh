#!/bin/bash
# Runs the extension in a headless nested GNOME Shell with a throwaway HOME,
# and checks it with commands sent to the shell over D-Bus.
#
#   test/headless.sh                         run the checks, print the shell log
#   CHECKS=test/screenshots.sh test/headless.sh   take the README screenshots
#   test/headless.sh shell [seconds]         only start the shell and keep it
#
# The nested shell has no service manager of its own, so test apps are
# started in a transient scope of your real one, named the way GNOME names
# app scopes. That is how Spring finds them; the scopes go away with the apps.
set -u

UUID=spring@webhookstudios.github.io
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$(mktemp -d)}"
REAL_RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export REAL_RUNTIME
export HOME="$WORK/home"
export GSETTINGS_BACKEND=keyfile
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" XDG_CACHE_HOME="$HOME/.cache"
unset DISPLAY WAYLAND_DISPLAY
# A private runtime dir keeps the nested shell away from the real session.
# (It has to be a short path: the Wayland socket name has a length limit.)
XDG_RUNTIME_DIR="$(mktemp -d /tmp/dmrun.XXXXXX)"
export XDG_RUNTIME_DIR
trap 'fusermount3 -uz "$XDG_RUNTIME_DIR/doc" 2>/dev/null; rm -rf "$XDG_RUNTIME_DIR" 2>/dev/null || true' EXIT
mkdir -p "$XDG_CONFIG_HOME/glib-2.0/settings" "$XDG_DATA_HOME/gnome-shell/extensions" \
    "$XDG_DATA_HOME/applications" "$XDG_CACHE_HOME"
glib-compile-schemas "$ROOT/$UUID/schemas"
ln -sfn "$ROOT/$UUID" "$XDG_DATA_HOME/gnome-shell/extensions/$UUID"

# The busy test app: about 200 MB of memory and one busy core.
cat > "$XDG_DATA_HOME/applications/spring.test.Busy.desktop" <<EOT
[Desktop Entry]
Type=Application
Name=Busy Test App
Exec=gjs -m $ROOT/test/busy-app.js
Icon=application-x-executable
EOT

cat > "$XDG_CONFIG_HOME/glib-2.0/settings/keyfile" <<EOT
[org/gnome/shell]
enabled-extensions=['$UUID']
welcome-dialog-last-shown-version='999'
favorite-apps=['org.gnome.Nautilus.desktop', 'org.gnome.TextEditor.desktop', 'org.gnome.Settings.desktop']

[org/gnome/desktop/notifications]
show-banners=false
EOT

LOG="$WORK/shell.log"
echo "work dir: $WORK"
export LOG WORK UUID ROOT
dbus-run-session -- bash "$ROOT/test/headless-inner.sh" "$@"
