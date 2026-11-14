#!/usr/bin/gjs -m
// Spring's sampler. It runs as its own small process while the Spring panel
// is open, so the hundreds of /proc and cgroup reads a process list needs
// never happen inside GNOME Shell. It quits when its input closes.
//
// Input, one JSON line whenever something changes:
//   {"interval": 2, "procs": false, "shellPid": 1234,
//    "apps": [{"id": "org.gnome.Nautilus.desktop", "pids": [5678]}]}
// Output, one JSON line per update:
//   {"apps": {"<id>": {"cpu", "mem", "count", "cgroups": [...], "pids": [...]}},
//    "procs": [[pid, cpu, mem, appId], ...]      only while "procs" is true
//    "info": {"<pid>": [name, uid, user, command, kind, admin]}
//                                                 new or changed processes
//    "reset": true}                               first output with "info"
//
// cpu is in cores: 1 means one core fully busy. It is null until there is an
// earlier reading to compare with. mem is in bytes and leaves out file cache.
// kind is "app", "session" (part of the desktop session), "system" or
// "protected" (pid 1, the shell, the user's service manager).

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

const TICKS = 100;              // USER_HZ, the unit of utime and stime
const PF_KTHREAD = 0x200000;    // kernel threads are left out
const YOUNG_US = 20 * 1e6;      // a new process can still be moved to its app's scope
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function read(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch {
        return null;
    }
}

function listDir(path) {
    const names = [];
    let dir;
    try {
        dir = GLib.Dir.open(path, 0);
    } catch {
        return names;
    }
    for (let name; (name = dir.read_name()) !== null;)
        names.push(name);
    dir.close();
    return names;
}

const MY_UID = new Gio.Credentials().get_unix_user();
const MY_PID = new Gio.Credentials().get_unix_pid();
const USER_ROOT = `/sys/fs/cgroup/user.slice/user-${MY_UID}.slice/user@${MY_UID}.service`;
const APP_SLICE = `${USER_ROOT}/app.slice`;
const MY_SLICE = `/sys/fs/cgroup/user.slice/user-${MY_UID}.slice/`;

// statm counts pages; VmRSS in status is the same number in kB.
const PAGE = (() => {
    const pages = Number(read('/proc/self/statm')?.split(' ')[1]);
    const rss = /^VmRSS:\s+(\d+)/m.exec(read('/proc/self/status') ?? '');
    if (pages > 0 && rss) {
        const guess = Number(rss[1]) * 1024 / pages;
        for (const size of [4096, 16384, 65536]) {
            if (Math.abs(guess - size) / size < 0.25)
                return size;
        }
    }
    return 4096;
})();

const USERS = new Map();
for (const line of (read('/etc/passwd') ?? '').split('\n')) {
    const [name, , uid] = line.split(':');
    if (name && uid !== undefined)
        USERS.set(Number(uid), name);
}
const userName = uid => USERS.get(uid) ?? `${uid}`;

// The app id in a systemd unit name, lower case, or null. Desktop launchers
// name units after the app (see the XDG systemd integration spec):
//   app-gnome-org.gnome.Nautilus-1234.scope   app-flatpak-<id>-<n>.scope
//   app-<id>-<n>.scope   app-gnome-<id>@autostart.service
//   snap.<snap>.<app>-<uuid>.scope            (desktop id <snap>_<app>)
//   dbus-:1.2-org.gnome.Nautilus@0.service    (D-Bus activated)
// A dash inside the id is written \x2d.
function unitAppId(name) {
    const unescape = s => s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    let m = /^snap\.([^.]+)\.([^.]+?)(-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.(scope|service)$/.exec(name);
    if (m)
        return `${m[1]}_${m[2]}`.toLowerCase();
    m = /^dbus-:[\d.]+-(.+?)(@\d+)?\.service$/.exec(name);
    if (m)
        return unescape(m[1]).toLowerCase();
    m = /^app-(.+)\.(scope|service)$/.exec(name);
    if (!m)
        return null;
    let [, base] = m;
    const kind = m[2];
    if (kind === 'service')
        base = base.replace(/@[^@]*$/, '');
    const parts = base.split('-');
    if (kind === 'scope' && parts.length > 1)
        parts.pop();    // the launcher's random part
    const id = parts[parts.length - 1];
    return id ? unescape(id).toLowerCase() : null;
}

const normId = id => id.replace(/\.desktop$/, '').toLowerCase();
const baseName = path => path.slice(path.lastIndexOf('/') + 1);

function appUnits() {
    const units = [];
    const walk = (dir, depth) => {
        for (const name of listDir(dir)) {
            if (name.endsWith('.scope') || name.endsWith('.service'))
                units.push({path: `${dir}/${name}`, id: unitAppId(name)});
            else if (name.endsWith('.slice') && depth < 2)
                walk(`${dir}/${name}`, depth + 1);
        }
    };
    walk(APP_SLICE, 0);
    return units;
}

function cgroupOf(pid) {
    const text = read(`/proc/${pid}/cgroup`);
    const m = /^0::(.*)$/m.exec(text ?? '');
    return m ? `/sys/fs/cgroup${m[1]}` : null;
}

// ---- processes -------------------------------------------------------------

const procs = new Map();    // pid -> what we know about it

function scanProcs(now) {
    const seen = new Set();
    for (const name of listDir('/proc')) {
        const c = name.charCodeAt(0);
        if (c < 48 || c > 57)
            continue;
        const pid = Number(name);
        if (pid === MY_PID)
            continue;   // the sampler itself
        const text = read(`/proc/${pid}/stat`);
        if (!text)
            continue;
        const close = text.lastIndexOf(')');
        const comm = text.slice(text.indexOf('(') + 1, close);
        // Fields after the name, counted from 3: state, ppid, ... flags (9),
        // utime (14), stime (15) ... starttime (22).
        const f = text.slice(close + 2).split(' ');
        if (Number(f[6]) & PF_KTHREAD)
            continue;
        const start = f[19];
        let p = procs.get(pid);
        if (!p || p.start !== start) {
            p = {pid, start, born: now};
            procs.set(pid, p);
        }
        const ticks = Number(f[11]) + Number(f[12]);
        p.cpu = p.ticks !== undefined && now > p.at
            ? Math.max(0, (ticks - p.ticks) / TICKS / ((now - p.at) / 1e6)) : null;
        p.ticks = ticks;
        p.at = now;
        p.ppid = Number(f[1]);
        if (p.comm !== comm) {
            p.comm = comm;
            p.name = null;  // it ran something new: read its command again
        }
        const statm = read(`/proc/${pid}/statm`)?.split(' ');
        // Resident minus shared: the memory this process holds by itself.
        p.mem = statm ? Math.max(0, Number(statm[1]) - Number(statm[2])) * PAGE : 0;
        seen.add(pid);
    }
    for (const pid of procs.keys()) {
        if (!seen.has(pid))
            procs.delete(pid);
    }
}

function details(p, now) {
    if (p.name === null || p.name === undefined) {
        const args = (read(`/proc/${p.pid}/cmdline`) ?? '').split('\0').filter(Boolean);
        p.cmd = args.join(' ').slice(0, 300);
        // The kernel cuts names at 15 characters; the command has the rest.
        const base = args[0] ? baseName(args[0]) : '';
        p.name = p.comm.length >= 15 && base.startsWith(p.comm) ? base : p.comm;
        const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(read(`/proc/${p.pid}/status`) ?? '');
        p.uid = uids ? Number(uids[1]) : -1;
        // A signal needs our uid to match the target's real or saved uid.
        p.admin = uids ? Number(uids[1]) !== MY_UID && Number(uids[3]) !== MY_UID : true;
    }
    if (p.cgroup === undefined || now - p.born < YOUNG_US)
        p.cgroup = cgroupOf(p.pid);
}

function kindOf(p, shellPid) {
    const cg = p.cgroup ?? '';
    if (p.pid === 1 || p.pid === shellPid || cg === `${USER_ROOT}/init.scope`)
        return 'protected';
    if (cg.startsWith(`${APP_SLICE}/`))
        return 'app';
    if (cg.startsWith(`${USER_ROOT}/session.slice/`) || cg.startsWith(MY_SLICE) && !cg.startsWith(`${USER_ROOT}/`))
        return 'session';
    return 'system';
}

// ---- cgroups ---------------------------------------------------------------

const cgroupCpu = new Map();    // path -> {usec, at}

function readCgroup(path, now) {
    const usec = Number(/^usage_usec (\d+)/m.exec(read(`${path}/cpu.stat`) ?? '')?.[1]);
    const prev = cgroupCpu.get(path);
    let cpu = null;
    if (Number.isFinite(usec)) {
        if (prev && now > prev.at)
            cpu = Math.max(0, (usec - prev.usec) / (now - prev.at));
        cgroupCpu.set(path, {usec, at: now});
    }
    const pids = (read(`${path}/cgroup.procs`) ?? '').split('\n').filter(Boolean).map(Number);
    let mem = 0;
    const current = Number(read(`${path}/memory.current`));
    if (Number.isFinite(current) && current > 0) {
        // Leave out the file cache: it is shared and the kernel frees it
        // when memory runs short. Shared memory stays counted.
        const stat = read(`${path}/memory.stat`) ?? '';
        const field = key => Number(new RegExp(`^${key} (\\d+)`, 'm').exec(stat)?.[1] ?? 0);
        mem = Math.max(0, current - field('active_file') - field('inactive_file'));
    } else {
        for (const pid of pids) {
            const statm = read(`/proc/${pid}/statm`)?.split(' ');
            if (statm)
                mem += Math.max(0, Number(statm[1]) - Number(statm[2])) * PAGE;
        }
    }
    return {cpu, mem, pids};
}

// ---- one update ------------------------------------------------------------

let config = {interval: 2, procs: false, apps: [], shellPid: 0};
let sentInfo = new Map();   // pid -> info line last sent
let fresh = true;

function sample() {
    const now = GLib.get_monotonic_time();
    const wanted = new Map(config.apps.map(a => [normId(a.id), a.id]));

    // Each app owns the units named after it, and the unit its windows run
    // in when that unit is an app's own but no other open app's.
    const owner = new Map();    // cgroup path -> app id
    for (const unit of appUnits()) {
        if (unit.id && wanted.has(unit.id))
            owner.set(unit.path, wanted.get(unit.id));
    }
    const loose = new Map();    // app id -> window pids outside its own units
    for (const app of config.apps) {
        for (const pid of app.pids) {
            const cg = cgroupOf(pid);
            if (!cg)
                continue;
            const has = owner.get(cg);
            if (has === app.id)
                continue;
            const unitId = unitAppId(baseName(cg));
            if (!has && cg.startsWith(`${APP_SLICE}/`) && unitId && !wanted.has(unitId)) {
                owner.set(cg, app.id);
                continue;
            }
            if (!loose.has(app.id))
                loose.set(app.id, []);
            loose.get(app.id).push(pid);
        }
    }

    const apps = {};
    const total = id => (apps[id] ??= {cpu: null, mem: 0, count: 0, cgroups: [], pids: []});
    const addCpu = (entry, cpu) => {
        if (cpu !== null)
            entry.cpu = (entry.cpu ?? 0) + cpu;
    };
    const cgroupPids = new Map();   // pid -> app id, for processes in owned units
    for (const [path, id] of owner) {
        const cg = readCgroup(path, now);
        const entry = total(id);
        addCpu(entry, cg.cpu);
        entry.mem += cg.mem;
        entry.count += cg.pids.length;
        entry.cgroups.push(path);
        for (const pid of cg.pids)
            cgroupPids.set(pid, id);
    }
    for (const app of config.apps)
        total(app.id);
    for (const path of cgroupCpu.keys()) {
        if (!owner.has(path))
            cgroupCpu.delete(path);
    }

    const scan = config.procs || loose.size > 0;
    if (scan)
        scanProcs(now);

    // Windows outside their app's own unit, for example an app started
    // from a terminal: count the process and everything it started.
    const loosePids = new Map();    // pid -> app id
    if (loose.size > 0) {
        const children = new Map();
        for (const p of procs.values()) {
            if (!children.has(p.ppid))
                children.set(p.ppid, []);
            children.get(p.ppid).push(p.pid);
        }
        for (const [id, roots] of loose) {
            const entry = total(id);
            const queue = [...roots];
            while (queue.length > 0) {
                const pid = queue.shift();
                const p = procs.get(pid);
                if (!p || loosePids.has(pid) || cgroupPids.has(pid))
                    continue;
                loosePids.set(pid, id);
                addCpu(entry, p.cpu);
                entry.mem += p.mem;
                entry.count++;
                entry.pids.push(pid);
                queue.push(...(children.get(pid) ?? []));
            }
        }
    }

    const out = {apps};
    if (config.procs) {
        const rows = [];
        const info = {};
        const alive = new Set();
        for (const p of procs.values()) {
            details(p, now);
            const kind = kindOf(p, config.shellPid);
            const line = [p.name, p.uid, userName(p.uid), p.cmd, kind, p.admin ? 1 : 0];
            const key = JSON.stringify(line);
            if (sentInfo.get(p.pid) !== key) {
                sentInfo.set(p.pid, key);
                info[p.pid] = line;
            }
            alive.add(p.pid);
            const app = cgroupPids.get(p.pid) ?? loosePids.get(p.pid) ?? null;
            rows.push([p.pid, p.cpu === null ? null : Math.round(p.cpu * 10000) / 10000, p.mem, app]);
        }
        for (const pid of sentInfo.keys()) {
            if (!alive.has(pid))
                sentInfo.delete(pid);
        }
        out.procs = rows;
        out.info = info;
    }
    return out;
}

// ---- input and output ------------------------------------------------------

const loop = new GLib.MainLoop(null, false);
const stdout = new GioUnix.OutputStream({fd: 1, close_fd: false});
let timer = 0;
let resetPending = true;

function schedule(ms) {
    if (timer)
        GLib.source_remove(timer);
    timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        timer = 0;
        tick();
        return GLib.SOURCE_REMOVE;
    });
}

function tick() {
    const out = sample();
    if (resetPending && out.info) {
        out.reset = true;
        resetPending = false;
    }
    try {
        stdout.write_all(encoder.encode(`${JSON.stringify(out)}\n`), null);
    } catch {
        loop.quit();
        return;
    }
    // The first reading only sets the baseline, so the next comes soon.
    const soon = fresh;
    fresh = false;
    schedule(soon ? 500 : Math.round(Math.max(0.5, config.interval) * 1000));
}

const input = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0, close_fd: false})});
let started = false;

function readInput() {
    input.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
        let line;
        try {
            [line] = stream.read_line_finish_utf8(res);
        } catch {
            loop.quit();
            return;
        }
        if (line === null) {
            loop.quit();
            return;
        }
        let next;
        try {
            next = JSON.parse(line);
        } catch (e) {
            printerr(`spring-sampler: ${e.message}`);
            readInput();
            return;
        }
        const procsOn = next.procs && !config.procs;
        const intervalChanged = next.interval !== undefined && next.interval !== config.interval;
        config = {...config, ...next};
        if (procsOn) {
            sentInfo = new Map();
            resetPending = true;
        }
        if (!started || procsOn) {
            started = true;
            fresh = true;
            tick();
        } else if (intervalChanged) {
            schedule(Math.round(Math.max(0.5, config.interval) * 1000));
        }
        readInput();
    });
}

readInput();
loop.run();
