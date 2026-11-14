// Small shared pieces: number formats, hover tips, icon buttons, and ending
// apps and processes.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Installed by the package; asks for the password with its own message.
const KILL_HELPER = '/usr/libexec/spring-monitor/spring-kill';

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes))
        return '–';
    if (bytes < 1e6)
        return `${Math.max(0, Math.round(bytes / 1e3))}\u00a0kB`;  // as GLib does
    return GLib.format_size(Math.round(bytes));
}

// cores: 1 means one core fully busy.
export function cpuPercent(cores, ncpu, perCore) {
    if (cores === null || cores === undefined || !Number.isFinite(cores))
        return null;
    return perCore ? cores * 100 : cores * 100 / Math.max(1, ncpu);
}

export function formatPercent(pct) {
    if (pct === null)
        return '–';
    if (pct < 0.05)
        return '0%';
    if (pct < 9.95)
        return `${pct.toFixed(1)}%`;
    return `${Math.round(pct)}%`;
}

// icon: a themed icon name or a Gio.Icon.
export function iconButton(icon, accessibleName, extraClass = '') {
    const child = typeof icon === 'string'
        ? new St.Icon({icon_name: icon, icon_size: 16})
        : new St.Icon({gicon: icon, icon_size: 16});
    return new St.Button({
        style_class: `spring-icon-button ${extraClass}`.trim(),
        child,
        can_focus: true,
        accessible_name: accessibleName,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

// A button that looks greyed out but still shows its tip on hover, so the
// tip can say what to do first.
export function setButtonEnabled(button, enabled) {
    button._springDisabled = !enabled;
    if (enabled)
        button.remove_style_pseudo_class('insensitive');
    else
        button.add_style_pseudo_class('insensitive');
}

export const isButtonEnabled = button => !button._springDisabled;

// Hover tips for icon buttons, in the shell's own tooltip style.
export class TipManager {
    constructor() {
        this._label = new St.Label({style_class: 'dash-label spring-tip', visible: false, opacity: 0});
        Main.layoutManager.uiGroup.add_child(this._label);
        this._timeout = 0;
        this._owner = null;
    }

    // text is a string, or a function returning one.
    attach(button, text) {
        button._springTip = text;
        button.connect('notify::hover', () => {
            if (button.hover)
                this._schedule(button);
            else if (this._owner === button)
                this.hide();
        });
        button.connect('clicked', () => this.hide());
        button.connect('destroy', () => {
            if (this._owner === button)
                this.hide();
        });
    }

    _schedule(button) {
        if (this._destroyed)
            return;
        this.hide();
        this._owner = button;
        this._timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._timeout = 0;
            this._show(button);
            return GLib.SOURCE_REMOVE;
        });
    }

    _show(button) {
        const tip = button._springTip;
        const text = typeof tip === 'function' ? tip() : tip;
        if (!text || !button.get_stage() || !button.mapped)
            return;
        this._label.text = text;
        this._label.get_parent().set_child_above_sibling(this._label, null);
        this._label.show();
        const [x, y] = button.get_transformed_position();
        const [w, h] = button.get_transformed_size();
        const [, lw] = this._label.get_preferred_width(-1);
        const [, lh] = this._label.get_preferred_height(-1);
        const monitor = Main.layoutManager.findMonitorForActor(button) ?? Main.layoutManager.primaryMonitor;
        let lx = Math.round(x + w / 2 - lw / 2);
        lx = Math.max(monitor.x + 4, Math.min(lx, monitor.x + monitor.width - lw - 4));
        let ly = Math.round(y + h + 6);
        if (ly + lh > monitor.y + monitor.height)
            ly = Math.round(y - lh - 6);
        this._label.set_position(lx, ly);
        this._label.remove_all_transitions();
        this._label.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    get shownText() {
        return this._label.visible ? this._label.text : null;
    }

    hide() {
        if (this._destroyed)
            return;
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = 0;
        this._owner = null;
        this._label.remove_all_transitions();
        this._label.opacity = 0;
        this._label.hide();
    }

    destroy() {
        this.hide();
        this._destroyed = true;
        this._label.destroy();
    }
}

function run(argv) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            resolve({ok: false, status: -1});
            return;
        }
        proc.wait_async(null, () => {
            const status = proc.get_if_exited() ? proc.get_exit_status() : -1;
            resolve({ok: proc.get_successful(), status});
        });
    });
}

// Sends TERM (end) or KILL (force quit) to one process. Processes of
// another user go through pkexec, which asks for the password.
// Resolves to {ok, cancelled}.
export async function signalProcess(pid, force, admin) {
    const signal = force ? 'KILL' : 'TERM';
    let argv = ['kill', '-s', signal, `${pid}`];
    if (admin) {
        argv = GLib.file_test(KILL_HELPER, GLib.FileTest.IS_EXECUTABLE)
            ? ['pkexec', KILL_HELPER, signal, `${pid}`]
            : ['pkexec', '/usr/bin/kill', '-s', signal, `${pid}`];
    }
    const {ok, status} = await run(argv);
    // pkexec exits with 126 when the password dialog is dismissed.
    return {ok, cancelled: admin && status === 126};
}

// Stops every process of an app at once: each of its own units through
// cgroup.kill, and any loose processes one by one.
export async function forceQuitApp(stats) {
    const jobs = [];
    for (const path of stats?.cgroups ?? [])
        jobs.push(run(['sh', '-c', 'printf 1 > "$1"', 'spring', `${path}/cgroup.kill`]));
    for (const pid of stats?.pids ?? [])
        jobs.push(run(['kill', '-s', 'KILL', `${pid}`]));
    const results = await Promise.all(jobs);
    return results.length > 0 && results.every(r => r.ok);
}

// Asks an app to quit the way closing it would: its own Quit action when it
// has one, otherwise by closing its windows. It may ask to save first.
export function endApp(app, stats) {
    try {
        if (app.request_quit())
            return true;
    } catch (e) {
        console.warn(`Spring: request_quit failed: ${e.message}`);
    }
    for (const pid of [...(stats?.pids ?? []), ...app.get_pids()])
        run(['kill', '-s', 'TERM', `${pid}`]);
    return true;
}
