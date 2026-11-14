// Where Spring's numbers come from.
//
// SystemSampler reads the overall processor and memory use for the top bar
// and the panel's two cards. That is two small files, read asynchronously,
// so it never blocks the shell.
//
// HelperSampler runs sampler.js as its own process while the panel is open,
// for the per-app and per-process figures, and reads its updates line by line.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
export const HISTORY = 60;

function loadText(path, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(cancellable, (file, res) => {
            try {
                const [, bytes] = file.load_contents_finish(res);
                resolve(decoder.decode(bytes));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class SystemSampler {
    constructor(onUpdate) {
        this._onUpdate = onUpdate;
        this._cancel = new Gio.Cancellable();
        this._timer = 0;
        this._soon = 0;
        this._prev = null;
        this.interval = 0;
        this.latest = null;
        this.cpuHistory = [];
        this.memHistory = [];
    }

    get running() {
        return this._timer !== 0;
    }

    start(interval) {
        this.stop();
        this.interval = interval;
        this._tick();
        // The first reading is only a baseline for the processor figure.
        if (this._prev === null) {
            this._soon = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._soon = 0;
                this._tick();
                return GLib.SOURCE_REMOVE;
            });
        }
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(interval * 1000), () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timer)
            GLib.source_remove(this._timer);
        if (this._soon)
            GLib.source_remove(this._soon);
        this._timer = 0;
        this._soon = 0;
        // After a pause, the next figure starts from a fresh baseline.
        this._prev = null;
    }

    async _tick() {
        if (this._busy)
            return;
        this._busy = true;
        try {
            const [stat, meminfo] = await Promise.all([
                loadText('/proc/stat', this._cancel),
                loadText('/proc/meminfo', this._cancel),
            ]);
            this._parse(stat, meminfo);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`Spring: cannot read usage: ${e.message}`);
        } finally {
            this._busy = false;
        }
    }

    _parse(stat, meminfo) {
        // cpu  user nice system idle iowait irq softirq steal guest guest_nice
        const f = stat.slice(0, stat.indexOf('\n')).trim().split(/\s+/).slice(1, 9).map(Number);
        const idle = f[3] + (f[4] || 0);
        const all = f.reduce((sum, n) => sum + (n || 0), 0);
        const ncpu = (stat.match(/^cpu\d+ /gm) ?? []).length || 1;
        let cpu = null;
        if (this._prev && all > this._prev.all)
            cpu = Math.min(1, Math.max(0, 1 - (idle - this._prev.idle) / (all - this._prev.all)));
        this._prev = {idle, all};

        const kb = key => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] ?? 0) * 1024;
        const memTotal = kb('MemTotal');
        const memUsed = Math.max(0, memTotal - kb('MemAvailable'));
        const swapTotal = kb('SwapTotal');
        const swapUsed = Math.max(0, swapTotal - kb('SwapFree'));

        this.latest = {cpu, ncpu, memTotal, memUsed, swapTotal, swapUsed};
        if (cpu !== null) {
            this.cpuHistory.push(cpu);
            this.memHistory.push(memTotal > 0 ? memUsed / memTotal : 0);
            if (this.cpuHistory.length > HISTORY) {
                this.cpuHistory.shift();
                this.memHistory.shift();
            }
        }
        this._onUpdate(this.latest);
    }

    destroy() {
        this.stop();
        this._cancel.cancel();
    }
}

export class HelperSampler {
    constructor(path, onSample) {
        this._path = path;
        this._onSample = onSample;
        this._proc = null;
        this._lastConfig = null;
        this._pending = null;
        this._writing = false;
    }

    get running() {
        return this._proc !== null;
    }

    start() {
        if (this._proc)
            return;
        let proc;
        try {
            proc = Gio.Subprocess.new(['gjs', '-m', this._path],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
        } catch (e) {
            console.warn(`Spring: cannot start the sampler: ${e.message}`);
            return;
        }
        this._proc = proc;
        this._in = proc.get_stdin_pipe();
        this._out = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        this._cancel = new Gio.Cancellable();
        this._lastConfig = null;
        proc.wait_async(null, () => {
            if (this._proc === proc)
                this.stop();
        });
        this._read();
    }

    // Sends the sampler what to measure. Only changes are sent.
    configure(config) {
        if (!this._proc)
            return;
        const line = JSON.stringify(config);
        if (line === this._lastConfig)
            return;
        this._lastConfig = line;
        this._pending = line;
        this._flush();
    }

    _flush() {
        const stream = this._in;
        if (!stream || this._writing || this._pending === null)
            return;
        const bytes = encoder.encode(`${this._pending}\n`);
        this._pending = null;
        this._writing = true;
        stream.write_all_async(bytes, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                s.write_all_finish(res);
            } catch {}
            // Stopped while writing: the pipe could not be closed then.
            if (stream !== this._in) {
                try {
                    s.close(null);
                } catch {}
                return;
            }
            this._writing = false;
            this._flush();
        });
    }

    _read() {
        const out = this._out;
        out.read_line_async(GLib.PRIORITY_DEFAULT, this._cancel, (stream, res) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(res);
            } catch {
                return;
            }
            if (line === null || out !== this._out)
                return;
            let data = null;
            try {
                data = JSON.parse(line);
            } catch (e) {
                console.warn(`Spring: bad sampler output: ${e.message}`);
            }
            if (data)
                this._onSample(data);
            this._read();
        });
    }

    stop() {
        const proc = this._proc;
        this._proc = null;
        this._cancel?.cancel();
        this._out = null;
        this._pending = null;
        // Closing its input makes the sampler quit by itself. A write in
        // progress closes it when done.
        const input = this._in;
        this._in = null;
        if (input && !this._writing) {
            try {
                input.close(null);
            } catch {}
        }
        this._writing = false;
        if (proc) {
            let id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                id = 0;
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            proc.wait_async(null, () => {
                if (id)
                    GLib.source_remove(id);
            });
        }
    }
}
