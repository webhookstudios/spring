#!/bin/sh
# Builds dist/spring-monitor_<version>_all.deb. Needs only dpkg-deb.
#
# The package is named spring-monitor because Ubuntu already has a package
# called spring. It installs Spring for every user of the machine:
#   /usr/share/gnome-shell/extensions/<uuid>/   the extension
#   /usr/share/glib-2.0/schemas/                its settings schema
#   /usr/bin/spring-monitor                     apps-menu launcher
#   /usr/libexec/spring-monitor/spring-kill     ends another user's process
#   /usr/share/polkit-1/actions/                the password prompt for that
#   /usr/share/applications, /usr/share/icons   apps-menu entry and icon
set -e

UUID=spring@webhookstudios.github.io
APP_ID=io.github.webhookstudios.Spring
PKG=spring-monitor
ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(sed -n 's/.*"version-name": *"\([^"]*\)".*/\1/p' "$ROOT/$UUID/metadata.json")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

EXT="$STAGE/usr/share/gnome-shell/extensions/$UUID"
install -d "$EXT" "$STAGE/DEBIAN" "$STAGE/usr/bin" \
    "$STAGE/usr/libexec/$PKG" \
    "$STAGE/usr/share/polkit-1/actions" \
    "$STAGE/usr/share/glib-2.0/schemas" \
    "$STAGE/usr/share/applications" \
    "$STAGE/usr/share/icons/hicolor/scalable/apps" \
    "$STAGE/usr/share/doc/$PKG"

install -m 644 "$ROOT/$UUID"/*.js "$ROOT/$UUID/metadata.json" \
    "$ROOT/$UUID/stylesheet.css" "$EXT/"
cp -r "$ROOT/$UUID/sedge" "$EXT/"
find "$EXT/sedge" -type f -exec chmod 644 {} +
install -d "$EXT/icons"
install -m 644 "$ROOT/$UUID/icons"/*.svg "$EXT/icons/"
# With no schemas folder of its own, the extension reads its schema from
# the system one, which dpkg compiles through glib's trigger.
install -m 644 "$ROOT/$UUID/schemas"/*.gschema.xml "$STAGE/usr/share/glib-2.0/schemas/"
install -m 755 "$ROOT/data/launcher.js" "$STAGE/usr/bin/$PKG"
install -m 755 "$ROOT/data/spring-kill" "$STAGE/usr/libexec/$PKG/spring-kill"
install -m 644 "$ROOT/data/$APP_ID.policy" "$STAGE/usr/share/polkit-1/actions/"
install -m 644 "$ROOT/data/$APP_ID.svg" "$STAGE/usr/share/icons/hicolor/scalable/apps/"
sed -e "s|@EXEC@|$PKG|" -e "s|@ICON@|$APP_ID|" "$ROOT/data/$APP_ID.desktop.in" \
    > "$STAGE/usr/share/applications/$APP_ID.desktop"
chmod 644 "$STAGE/usr/share/applications/$APP_ID.desktop"

cat > "$STAGE/usr/share/doc/$PKG/copyright" <<EOT
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: Spring
Source: https://github.com/webhookstudios/spring

Files: *
Copyright: $(date +%Y) webhookstudios
License: GPL-2+
 On Debian systems, the full text of the GNU General Public License
 version 2 can be found in /usr/share/common-licenses/GPL-2.

Files: usr/share/gnome-shell/extensions/*/sedge/fonts/*
Copyright: 2023 The Young Serif Project Authors; 2015 The Public Sans Project Authors
License: OFL-1.1
 The full license texts are in the extension's sedge/fonts/ folder.
EOT
chmod 644 "$STAGE/usr/share/doc/$PKG/copyright"

cat > "$STAGE/DEBIAN/control" <<EOT
Package: $PKG
Version: $VERSION
Architecture: all
Maintainer: webhookstudios <354619278+webhookstudios@users.noreply.github.com>
Installed-Size: $(du -sk "$STAGE/usr" | cut -f1)
Depends: gnome-shell (>= 50~), gnome-shell (<< 51~), gjs, gir1.2-adw-1, gir1.2-gtk-4.0, procps, pkexec | policykit-1
Section: gnome
Priority: optional
Homepage: https://github.com/webhookstudios/spring
Description: Task manager for the GNOME top bar
 Spring is a GNOME Shell extension that adds a task manager to the top bar.
 It shows processor and memory use at a glance, lists every open app with
 the processor and memory it uses, and has a searchable list of all
 processes. Any app or process can be ended or force quit from there.
 .
 After installing, log out and back in, then open Spring from the apps menu.
EOT

# Folders are created with the builder's umask; packages want 755.
find "$STAGE" -type d -exec chmod 755 {} +

mkdir -p "$ROOT/dist"
dpkg-deb --root-owner-group --build "$STAGE" "$ROOT/dist/${PKG}_${VERSION}_all.deb"
