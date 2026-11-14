#!/bin/bash
# Checks run against the nested shell. Sourced by headless-inner.sh, which
# provides eval_js, val, launch_app, scope_path, $UUID, $ROOT and $WORK.
SHOTS="${SHOTS:-$WORK/shots}"
mkdir -p "$SHOTS"
export GSETTINGS_SCHEMA_DIR="$ROOT/$UUID/schemas"
SET="gsettings set org.gnome.shell.extensions.spring"
BTN="Main.panel.statusArea['$UUID']"
APP=spring.test.Busy.desktop
ROW="$BTN._appRows.get('$APP')"
PASS=0
FAIL=0

shot() {
    timeout 15 gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$SHOTS/$1.png" >/dev/null 2>&1
    echo "   (screenshot $1)"
}
show() { echo "== $1: $(val "$2")"; }
check() {
    if [ "$2" = true ]; then
        PASS=$((PASS + 1)); echo "PASS $1"
    else
        FAIL=$((FAIL + 1)); echo "FAIL $1 ${3:+($3)}"
    fi
}
is_true() { [ "$(val "$1")" = true ] && echo true || echo false; }
# Runs a Python expression on the JSON value of a JS expression ("v").
py_check() {
    local json
    json="$(val "$2")"
    python3 -c "import json,sys; v=json.loads(sys.argv[1]); exec(sys.argv[2])" "$json" "$3" 2>&1
}

# A script keeps its own name as the process name; a copied coreutils
# program may not run under another name.
printf '#!/bin/sh\nwhile :; do :; done\n' > "$WORK/spring-burn"
chmod +x "$WORK/spring-burn"
cp /usr/bin/sleep "$WORK/spring-test-sleep"
export SPRING_BURN="$WORK/spring-burn"
NCPU=$(grep -c '^cpu[0-9]' /proc/stat)

check "extension is enabled" "$(is_true "Main.extensionManager.lookup('$UUID').state === 1")" \
    "$(val "Main.extensionManager.lookup('$UUID').error")"
check "the shell has request_quit" "$(is_true "typeof imports.gi.Shell.App.prototype.request_quit === 'function'")"

echo "##### top bar"
check "no sampler process while closed" "$([ -z "$(pgrep -f "$UUID/sampler.js")" ] && echo true || echo false)"
$SET show-numbers true
sleep 3
show "figures" "$BTN._figures.text"
check "figures shown" "$(is_true "$BTN._figures.visible && /^CPU [0-9]+%  MEM [0-9]+%$/.test($BTN._figures.text)")" \
    "$(val "$BTN._figures.text")"
check "bars shown" "$(is_true "$BTN._bars.visible")"
R=$(py_check "memory matches /proc/meminfo" "$BTN._system.latest" "
m={l.split(':')[0]: int(l.split()[1])*1024 for l in open('/proc/meminfo')}
used=m['MemTotal']-m['MemAvailable']
ok=abs(v['memUsed']-used)/m['MemTotal']<0.03 and v['memTotal']==m['MemTotal'] and 0<=v['cpu']<=1 and v['ncpu']==$NCPU
print('true' if ok else 'false', round(v['memUsed']/1e9,2), round(used/1e9,2), v['cpu'])")
check "overall figures match /proc" "${R%% *}" "$R"
$SET memory-format amount
sleep 0.3
check "memory as an amount" "$(is_true "/MEM [0-9.]+.(GB|MB)$/.test($BTN._figures.text)")" "$(val "$BTN._figures.text")"
shot topbar
$SET memory-format percent

echo "##### apps"
UNIT1=$(launch_app spring.test.Busy gjs -m "$ROOT/test/busy-app.js")
sleep 5
eval_js "$BTN.menu.open()" >/dev/null
sleep 1
check "sampler runs while open" "$([ -n "$(pgrep -f "$UUID/sampler.js")" ] && echo true || echo false)"
sleep 3
show "app rows" "[...$BTN._appRows.values()].map(r => r.name+' cpu='+r.cpuLabel.text+' mem='+r.memLabel.text+' sub='+r.subLabel.text).join('  |  ')"
check "test app listed" "$(is_true "!!$ROW")"
SCOPE1=$(scope_path "$UNIT1")
R=$(py_check "app figures" "$ROW.stats" "
cg='$SCOPE1'
cur=int(open(cg+'/memory.current').read())
st={l.split()[0]: int(l.split()[1]) for l in open(cg+'/memory.stat')}
mem=cur-st['active_file']-st['inactive_file']
ok=v['cgroups']==[cg] and abs(v['mem']-mem)<max(8e6, 0.05*mem) and v['mem']>200e6 and 0.8<v['cpu']<1.3 and v['count']==2
print('true' if ok else 'false', 'cpu', round(v['cpu'],2), 'mem', round(v['mem']/1e6), 'vs', round(mem/1e6), 'count', v['count'])")
check "app figures match its scope (one busy core, 200+ MB, 2 processes)" "${R%% *}" "$R"
EXPECT=$(python3 -c "print(round(100/$NCPU))")
show "test app CPU shown (expect about $EXPECT% of $NCPU threads)" "$ROW.cpuLabel.text"
$SET cpu-per-core true
sleep 0.3
check "per core: about 100%" "$(is_true "(p => p > 80 && p < 130)(parseFloat($ROW.cpuLabel.text))")" "$(val "$ROW.cpuLabel.text")"
$SET cpu-per-core false
check "busiest app first" "$(is_true "$BTN._appList.get_first_child() === $ROW")"
eval_js "$BTN._tips._show($ROW.killButton)" >/dev/null
sleep 0.3
check "hover tip on Force quit" "$(is_true "$BTN._tips.shownText === 'Force quit Busy Test App'")" "$(val "$BTN._tips.shownText")"
shot apps-tip
eval_js "$BTN._tips.hide()" >/dev/null
shot apps

echo "##### End the test app (asks it to quit)"
eval_js "$ROW.endButton.emit('clicked', 1)" >/dev/null
sleep 0.5
check "asks first" "$(is_true "$ROW.confirming && $ROW.confirm.title.text === 'End Busy Test App?'")"
shot confirm-end
eval_js "$ROW.confirm.okButton.emit('clicked', 1)" >/dev/null
sleep 4
check "app used its Quit action" "$(grep -q 'quit action' "$WORK/spring.test.Busy.log" && echo true || echo false)"
check "app gone from the list" "$(is_true "!$ROW")"
check "its scope is gone" "$([ ! -d "$SCOPE1" ] && echo true || echo false)"

echo "##### Force quit the test app (stops all its processes)"
UNIT2=$(launch_app spring.test.Busy gjs -m "$ROOT/test/busy-app.js")
SCOPE2=$(scope_path "$UNIT2")
sleep 7
check "second test app listed with figures" "$(is_true "!!$ROW?.stats?.cgroups?.length")"
eval_js "$ROW.killButton.emit('clicked', 1)" >/dev/null
sleep 0.5
show "question" "$ROW.confirm.title.text + ' ' + $ROW.confirm.note.text"
check "asks first, names the processes" "$(is_true "$ROW.confirm.note.text.startsWith('All 2 of its processes stop at once')")"
shot confirm-force
eval_js "$ROW.confirm.okButton.emit('clicked', 1)" >/dev/null
sleep 2
check "its scope is gone" "$([ ! -d "$SCOPE2" ] && echo true || echo false)"
check "no burner left" "$([ -z "$(pgrep -f "$WORK/spring-burn")" ] && echo true || echo false)"
sleep 1
check "app gone from the list" "$(is_true "!$ROW")"
check "Force quit did not use the Quit action" "$([ "$(grep -c 'quit action' "$WORK/spring.test.Busy.log")" = 0 ] && echo true || echo false)"

echo "##### processes"
"$WORK/spring-test-sleep" 1000 & SLEEP1=$!
"$WORK/spring-test-sleep" 1001 & SLEEP2=$!
# Time the shell spends on each update.
eval_js "(() => { const b = $BTN; const h = b._helper; const orig = h._onSample; b.__times = []; h._onSample = d => { const t = imports.gi.GLib.get_monotonic_time(); orig(d); b.__times.push(imports.gi.GLib.get_monotonic_time() - t); }; return 1; })()" >/dev/null
eval_js "$BTN.__procsFrom = $BTN.__times.length; $BTN._setView('procs')" >/dev/null
sleep 4
show "note" "$BTN._procNote.text"
show "first rows" "[...$BTN._procList.get_children()].slice(0, 6).map(r => r.nameLabel.text+' '+r.cpuLabel.text+' '+r.memLabel.text).join('  |  ')"
check "rows up to the limit" "$(is_true "$BTN._procRows.size === Math.min(60, $BTN._sample.procs.length) && $BTN._procRows.size > 20")" "$(val "$BTN._procRows.size")"
check "sorted by processor use" "$(is_true "(rows => rows.every((r, i) => i === 0 || (rows[i-1].cpu ?? -1) >= (r.cpu ?? -1)))([...$BTN._procList.get_children()].map(r => ({cpu: $BTN._sample.procs.find(p => p[0] === r.pid)?.[1]})))")"
check "no kernel threads" "$(is_true "![...$BTN._procInfo.values()].some(i => i[0] === 'kthreadd' || i[0].startsWith('kworker'))")"
check "the shell itself cannot be ended" "$(is_true "(() => { const pid = new imports.gi.Gio.Credentials().get_unix_pid(); return $BTN._procInfo.get(pid)?.[4] === 'protected'; })()")"
shot procs
show "shell time per update, ms: first, then max and mean of the rest" "(t => [t[0], Math.max(...t.slice(1)), t.slice(1).reduce((a, b) => a + b, 0) / (t.length - 1)].map(n => (n / 1000).toFixed(1)).join(', '))($BTN.__times.slice($BTN.__procsFrom))"

eval_js "$BTN._search.text = 'spring-test'" >/dev/null
sleep 0.4
show "search rows" "[...$BTN._procRows.values()].map(r => r.nameLabel.text + ' ' + r.pid).join(', ')"
check "search finds both test processes, full names" "$(is_true "$BTN._procRows.size === 2 && [...$BTN._procRows.values()].every(r => r.nameLabel.text === 'spring-test-sleep')")"
shot procs-search
PROW="$BTN._procRows.get($SLEEP1)"
eval_js "$PROW.endButton.emit('clicked', 1)" >/dev/null
sleep 0.4
check "asks before ending a process" "$(is_true "$PROW.confirming && $PROW.confirm.title.text === 'End “spring-test-sleep” ($SLEEP1)?'")" "$(val "$PROW.confirm.title.text")"
shot confirm-process
eval_js "$PROW.confirm.okButton.emit('clicked', 1)" >/dev/null
PROW2="$BTN._procRows.get($SLEEP2)"
eval_js "$PROW2.killButton.emit('clicked', 1)" >/dev/null
sleep 0.3
eval_js "$PROW2.confirm.okButton.emit('clicked', 1)" >/dev/null
sleep 1.5
wait $SLEEP1; S1=$?
wait $SLEEP2; S2=$?
check "End sent TERM (exit 143)" "$([ $S1 = 143 ] && echo true || echo false)" "$S1"
check "Force quit sent KILL (exit 137)" "$([ $S2 = 137 ] && echo true || echo false)" "$S2"
sleep 2.5
check "ended processes leave the list" "$(is_true "$BTN._procRows.size === 0 && $BTN._procNote.text.startsWith('Nothing matches')")" "$(val "$BTN._procNote.text")"

echo "##### other users"
eval_js "$BTN._search.text = 'systemd-'" >/dev/null
sleep 0.4
ROOTPID=$(val "[...$BTN._procRows.values()].find(r => r.info[1] === 0 && r.info[4] !== 'protected')?.pid ?? 0")
echo "== a root process: $ROOTPID $(val "$BTN._procRows.get($ROOTPID)?.subLabel.text")"
if [ "$ROOTPID" != 0 ]; then
    eval_js "$BTN._procRows.get($ROOTPID).endButton.emit('clicked', 1)" >/dev/null
    sleep 0.3
    check "asks for the password for root's processes" "$(is_true "$BTN._procRows.get($ROOTPID).confirm.note.text.includes('It belongs to root, so you will be asked for your password.')")"
    shot confirm-root
    eval_js "$BTN._procRows.get($ROOTPID).confirm.cancelButton.emit('clicked', 1)" >/dev/null
fi
$SET show-other-users false
sleep 0.4
check "system processes hidden when turned off" "$(is_true "$BTN._procRows.size === 0 || [...$BTN._procRows.values()].every(r => r.info[1] === $(id -u))")"
$SET show-other-users true
eval_js "$BTN._search.text = ''" >/dev/null
check "pid 1 has no buttons" "$(is_true "(r => !r || !r.endButton.visible && !r.killButton.visible)($BTN._procRows.get(1))")"
check "the sampler does not list itself" "$(is_true "![...$BTN._procInfo.values()].some(i => i[3].includes('sampler.js'))")"
echo "pkexec helper rejects bad input: $("$ROOT/data/spring-kill" HUP 5 2>&1; echo " exit $?") / $("$ROOT/data/spring-kill" TERM 1 2>&1; echo " exit $?") / $("$ROOT/data/spring-kill" TERM '1;x' 2>&1; echo " exit $?")"

echo "##### sorting and limits"
$SET process-sort memory
sleep 0.4
check "sorted by memory" "$(is_true "(rows => rows.every((r, i) => i === 0 || rows[i-1] >= r))([...$BTN._procList.get_children()].map(r => $BTN._sample.procs.find(p => p[0] === r.pid)?.[2] ?? 0))")"
$SET process-sort name
sleep 0.4
check "sorted by name" "$(is_true "(rows => rows.every((r, i) => i === 0 || rows[i-1].localeCompare(r) <= 0))([...$BTN._procList.get_children()].map(r => r.nameLabel.text))")"
$SET process-sort cpu
$SET process-limit 20
sleep 0.4
check "limit of 20 with a note" "$(is_true "$BTN._procRows.size === 20 && /^Showing 20 of [0-9]+. Search to find the rest.$/.test($BTN._procNote.text)")" "$(val "$BTN._procNote.text")"
$SET process-limit 60
ORDER1=$(val "[...$BTN._procList.get_children()].map(r => r.pid).join(',')")
eval_js "$BTN._procScroll.hover = true" >/dev/null
sleep 4.5
ORDER2=$(val "[...$BTN._procList.get_children()].map(r => r.pid).join(',')")
eval_js "$BTN._procScroll.hover = false" >/dev/null
check "rows keep still under the pointer" "$([ "$ORDER1" = "$ORDER2" ] && echo true || echo false)"

echo "##### closing"
eval_js "$BTN.menu.close()" >/dev/null
sleep 2.5
check "sampler stops when closed" "$([ -z "$(pgrep -f "$UUID/sampler.js")" ] && echo true || echo false)"
check "back on the apps view" "$(is_true "$BTN._view === 'apps' && $BTN._procRows.size === 0")"
$SET show-numbers false
$SET show-bars false
sleep 0.5
check "nothing read with bars and numbers off" "$(is_true "!$BTN._system.running")"
$SET show-bars true

echo "##### settings window"
export WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland
(timeout 14 gnome-extensions prefs "$UUID" > "$WORK/prefs.log" 2>&1 &)
sleep 6
shot prefs
head -10 "$WORK/prefs.log"

echo "##### disable / enable"
eval_js "$BTN.menu.open()" >/dev/null
sleep 1.5
gnome-extensions disable "$UUID"
sleep 2.5
check "button gone after disable" "$(is_true "!Main.panel.statusArea['$UUID']")"
check "no sampler left after disable" "$([ -z "$(pgrep -f "$UUID/sampler.js")" ] && echo true || echo false)"
gnome-extensions enable "$UUID"
sleep 2
check "back after enable" "$(is_true "Main.extensionManager.lookup('$UUID').state === 1 && !!Main.panel.statusArea['$UUID']")"

echo "##### apps-menu launcher"
eval_js "global.get_window_actors().forEach(a => a.meta_window.delete(global.get_current_time()))" >/dev/null
sleep 2
# The throwaway settings file catches what the launcher turns on.
(timeout 12 gjs -m "$ROOT/data/launcher.js" > "$WORK/launcher.log" 2>&1 &)
sleep 7
check "launcher opens the settings window" "$(is_true "global.get_window_actors().some(a => a.meta_window.get_title() === 'Spring')")"
head -5 "$WORK/launcher.log"

# Spring's own lines: stack frames in its files, and its warnings.
ERRORS=$(grep -cE "extensions/$UUID/|Spring:" "$LOG")
check "no JS errors or warnings from Spring in the shell log" "$([ "$ERRORS" = 0 ] && echo true || echo false)" "$ERRORS"
echo "##### $PASS passed, $FAIL failed"
