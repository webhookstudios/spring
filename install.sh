#!/bin/sh
# Installs Spring for the current user, without root: the extension, plus an
# apps-menu entry that opens its settings. Ending processes of other users
# then asks for the password with the system's generic message; the deb
# package adds a clearer one.
set -e

UUID=spring@webhookstudios.github.io
APP_ID=io.github.webhookstudios.Spring
ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST="$DATA/gnome-shell/extensions/$UUID"

mkdir -p "$DATA/gnome-shell/extensions" "$DATA/spring-monitor" "$DATA/applications" \
    "$DATA/icons/hicolor/scalable/apps"

# A link here is a development setup pointing at a source folder: leave it.
if [ -L "$DEST" ]; then
    echo "Keeping existing link: $DEST"
else
    rm -rf "$DEST"
    cp -r "$ROOT/$UUID" "$DEST"
fi
glib-compile-schemas "$DEST/schemas"

cp "$ROOT/data/launcher.js" "$DATA/spring-monitor/launcher.js"
cp "$ROOT/data/$APP_ID.svg" "$DATA/icons/hicolor/scalable/apps/"
# The icon is given by its full path: the shell does not notice a new icon
# in the user's icon folder until the next login, and would show a generic
# one until then.
ICON="$DATA/icons/hicolor/scalable/apps/$APP_ID.svg"
sed -e "s|@EXEC@|gjs -m \"$DATA/spring-monitor/launcher.js\"|" -e "s|@ICON@|$ICON|" \
    "$ROOT/data/$APP_ID.desktop.in" > "$DATA/applications/$APP_ID.desktop"
update-desktop-database "$DATA/applications" 2>/dev/null || true

cat <<EOT
Spring is installed in:
  $DEST

Log out and back in, then open Spring from the apps menu.
EOT
