#!/bin/bash
# README screenshots with real apps in the nested shell. Run with
#   CHECKS=test/screenshots.sh test/headless.sh
# The pictures land in docs/screenshots/, cropped to the panel.
SHOTS="${SHOTS:-$WORK/shots}"
OUT="$ROOT/docs/screenshots"
mkdir -p "$SHOTS" "$OUT"
export GSETTINGS_SCHEMA_DIR="$ROOT/$UUID/schemas"
SET="gsettings set org.gnome.shell.extensions.spring"
BTN="Main.panel.statusArea['$UUID']"
shot() {
    timeout 15 gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$SHOTS/$1.png" >/dev/null 2>&1
    echo "shot $1"
}
# Crops a shot to the open panel, from the top of the screen.
crop_panel() {
    local box
    box=$(val "(() => { const a = $BTN.menu.actor; const [x, y] = a.get_transformed_position(); const [w, h] = a.get_transformed_size(); return [x, y, w, h].map(Math.round).join(' '); })()")
    python3 - "$SHOTS/$1.png" "$OUT/$2.png" $box <<'PY'
import sys
from PIL import Image
src, dst, x, y, w, h = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:7])
im = Image.open(src)
left = max(0, x - 24)
im.crop((left, 0, min(im.width, x + w + 24), min(im.height, y + h + 20))).save(dst)
PY
    echo "  -> $2.png"
}

launch_app org.gnome.TextEditor gnome-text-editor >/dev/null
launch_app org.gnome.Calculator gnome-calculator >/dev/null
launch_app org.gnome.clocks gnome-clocks >/dev/null
launch_app org.gnome.Nautilus nautilus --new-window >/dev/null
sleep 6
launch_app org.gnome.baobab baobab / >/dev/null
sleep 2
eval_js "global.get_window_actors().forEach(a => a.meta_window.minimize())" >/dev/null
sleep 1

eval_js "$BTN.menu.open()" >/dev/null
sleep 4
val "[...$BTN._appRows.values()].map(r => r.name + ' ' + r.cpuLabel.text + ' ' + r.memLabel.text).join('  |  ')"
eval_js "global.get_window_actors().forEach(a => a.meta_window.minimize())" >/dev/null
sleep 1
shot apps
crop_panel apps apps

ROW="[...$BTN._appRows.values()].find(r => r.name === 'Text Editor')"
eval_js "$ROW.killButton.emit('clicked', 1)" >/dev/null
sleep 0.6
shot confirm
crop_panel confirm confirm
eval_js "$ROW.closeConfirm()" >/dev/null

eval_js "$BTN._setView('procs')" >/dev/null
sleep 3
eval_js "$BTN._search.text = 'systemd'" >/dev/null
sleep 2.5
val "$BTN._procNote.text"
shot processes
crop_panel processes processes

eval_js "$BTN.menu.close()" >/dev/null
$SET show-numbers true
sleep 3
shot topbar
python3 - "$SHOTS/topbar.png" "$OUT/topbar.png" "$(val "Math.round($BTN.get_transformed_position()[0])")" <<'PY'
import sys
from PIL import Image
src, dst, x = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src)
im.crop((max(0, x - 40), 0, im.width, 32)).resize(((im.width - max(0, x - 40)) * 2, 64), Image.LANCZOS).save(dst)
PY
echo "  -> topbar.png"
$SET show-numbers false

export WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland
(timeout 14 gnome-extensions prefs "$UUID" > "$WORK/prefs.log" 2>&1 &)
sleep 6
box=$(val "(() => { const w = global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === 'Spring'); const r = w.get_frame_rect(); return [r.x, r.y, r.width, r.height].join(' '); })()")
shot settings
python3 - "$SHOTS/settings.png" "$OUT/settings.png" $box <<'PY'
import sys
from PIL import Image
src, dst, x, y, w, h = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:7])
Image.open(src).crop((x, y, x + w, y + h)).save(dst)
PY
echo "  -> settings.png ($box)"
