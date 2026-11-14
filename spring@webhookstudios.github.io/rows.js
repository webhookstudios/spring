// The pieces of Spring's panel: the top bar bars, the two usage cards, and
// the rows for apps and processes with their End and Force quit buttons.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {HISTORY} from './monitor.js';
import {
    cpuPercent, endApp, forceQuitApp, formatBytes, formatPercent, iconButton,
    isButtonEnabled, setButtonEnabled, signalProcess,
} from './util.js';

const clamp01 = v => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

function label(styleClass, props = {}) {
    const l = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function wrapLabel(styleClass) {
    const l = new St.Label({style_class: styleClass, x_expand: true});
    l.clutter_text.line_wrap = true;
    l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return l;
}

// ---- top bar -----------------------------------------------------------------

function bar(kind) {
    const track = new St.Widget({
        style_class: `spring-bar spring-bar-${kind}`,
        layout_manager: new Clutter.BinLayout(),
        y_align: Clutter.ActorAlign.CENTER,
    });
    const fill = new St.Widget({
        style_class: 'spring-bar-fill',
        x_expand: true,
        y_expand: true,
        pivot_point: new Graphene.Point({x: 0.5, y: 1}),
        scale_y: 0,
    });
    track.add_child(fill);
    return [track, fill];
}

// Two thin bars next to the icon: processor, then memory.
export const TopBarMeter = GObject.registerClass(
class SpringTopBarMeter extends St.BoxLayout {
    _init() {
        super._init({style_class: 'spring-bars', y_align: Clutter.ActorAlign.CENTER});
        let track;
        [track, this._cpuFill] = bar('cpu');
        this.add_child(track);
        [track, this._memFill] = bar('mem');
        this.add_child(track);
    }

    set(cpu, mem) {
        // A sliver stays visible so an idle bar does not look missing.
        this._cpuFill.scale_y = Math.max(0.08, clamp01(cpu));
        this._memFill.scale_y = Math.max(0.08, clamp01(mem));
    }
});

// ---- usage cards ---------------------------------------------------------------

export const UsageCard = GObject.registerClass(
class SpringUsageCard extends St.BoxLayout {
    _init(title, kind) {
        super._init({
            style_class: `spring-card spring-card-${kind}`,
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const head = new St.BoxLayout({x_expand: true});
        head.add_child(label('spring-card-title', {text: title, x_expand: true}));
        this.value = label('spring-card-value');
        head.add_child(this.value);
        this.add_child(head);
        this.detail = label('spring-card-detail', {text: ' '});
        this.add_child(this.detail);
        this._graph = new St.DrawingArea({style_class: 'spring-graph', x_expand: true});
        this._graph.connect('repaint', area => this._draw(area));
        this.add_child(this._graph);
        this._history = [];
    }

    set(value, detail, history) {
        this.value.text = value;
        this.detail.text = detail || ' ';
        this._history = history ?? [];
        this._graph.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const color = area.get_theme_node().get_foreground_color();
        const hist = this._history;
        if (hist.length >= 2) {
            const step = w / (HISTORY - 1);
            const x0 = w - (hist.length - 1) * step;
            const y = v => 1 + (h - 2) * (1 - clamp01(v));
            cr.moveTo(x0, h);
            hist.forEach((v, i) => cr.lineTo(x0 + i * step, y(v)));
            cr.lineTo(w, h);
            cr.closePath();
            const c = colorFloats(color);
            cr.setSourceRGBA(c[0], c[1], c[2], 0.22);
            cr.fill();
            hist.forEach((v, i) => (i === 0 ? cr.moveTo(x0, y(v)) : cr.lineTo(x0 + i * step, y(v))));
            cr.setSourceRGBA(c[0], c[1], c[2], 1);
            cr.setLineWidth(1.5);
            cr.setLineJoin(1); // round
            cr.stroke();
        }
        cr.$dispose();
    }
});

// Cogl colors have 0-255 channels.
function colorFloats(color) {
    const f = v => (v > 1 ? v / 255 : v);
    return [f(color.red), f(color.green), f(color.blue)];
}

// ---- confirmation ----------------------------------------------------------------

const ConfirmStrip = GObject.registerClass(
class SpringConfirmStrip extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'spring-confirm',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });
        this.title = wrapLabel('spring-confirm-title');
        this.note = wrapLabel('spring-confirm-note');
        this.add_child(this.title);
        this.add_child(this.note);
        const buttons = new St.BoxLayout({
            style_class: 'spring-confirm-buttons',
            x_align: Clutter.ActorAlign.END,
        });
        this.cancelButton = new St.Button({label: 'Cancel', style_class: 'spring-confirm-button', can_focus: true});
        this.okButton = new St.Button({label: 'End', style_class: 'spring-confirm-button spring-confirm-ok', can_focus: true});
        buttons.add_child(this.cancelButton);
        buttons.add_child(this.okButton);
        this.add_child(buttons);
        this.cancelButton.connect('clicked', () => this.close());
        this.okButton.connect('clicked', () => {
            const onOk = this._onOk;
            this.close();
            onOk?.();
        });
        this._onOk = null;
    }

    ask({title, note, ok, danger}, onOk) {
        this.title.text = title;
        this.note.text = note;
        this.note.visible = !!note;
        this.okButton.label = ok;
        if (danger)
            this.okButton.add_style_class_name('spring-danger');
        else
            this.okButton.remove_style_class_name('spring-danger');
        this._onOk = onOk;
        this.show();
        this.okButton.grab_key_focus();
    }

    close() {
        this._onOk = null;
        this.hide();
    }
});

// ---- rows ------------------------------------------------------------------------

// Sets a label's text only when it changed: setting it always relays out.
function setText(lbl, text) {
    if (lbl.text !== text)
        lbl.text = text;
}

// ctx: {tips, settings, appSystem, fmt, forceQuitIcon}
const BaseRow = GObject.registerClass(
class SpringBaseRow extends St.BoxLayout {
    _init(ctx) {
        super._init({
            style_class: 'spring-row',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            reactive: true,
            track_hover: true,
        });
        this._ctx = ctx;
        const line = new St.BoxLayout({style_class: 'spring-row-line', x_expand: true});
        this.add_child(line);
        this._iconBin = new St.Bin({style_class: 'spring-row-icon', y_align: Clutter.ActorAlign.CENTER});
        line.add_child(this._iconBin);
        const names = new St.BoxLayout({
            style_class: 'spring-row-names',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.nameLabel = label('spring-row-name');
        this.subLabel = label('spring-row-sub');
        names.add_child(this.nameLabel);
        names.add_child(this.subLabel);
        line.add_child(names);
        this.cpuLabel = label('spring-num spring-num-cpu');
        this.memLabel = label('spring-num spring-num-mem');
        line.add_child(this.cpuLabel);
        line.add_child(this.memLabel);

        this._actions = new St.BoxLayout({style_class: 'spring-row-actions', y_align: Clutter.ActorAlign.CENTER});
        this.endButton = iconButton('window-close-symbolic', 'End');
        this.killButton = iconButton(ctx.forceQuitIcon, 'Force quit', 'spring-kill-button');
        this._actions.add_child(this.endButton);
        this._actions.add_child(this.killButton);
        line.add_child(this._actions);
        ctx.tips.attach(this.endButton, () => this._tip(false));
        ctx.tips.attach(this.killButton, () => this._tip(true));
        this.endButton.connect('clicked', () => this._request(false));
        this.killButton.connect('clicked', () => this._request(true));

        // The buttons stay faint until the row is pointed at or focused,
        // so a long list does not read as a wall of buttons.
        this.connect('notify::hover', () => this._syncActions());
        for (const button of [this.endButton, this.killButton]) {
            button.connect('key-focus-in', () => this._syncActions());
            button.connect('key-focus-out', () => this._syncActions());
        }
        this.confirm = null;    // made when first needed
        this._syncActions();
    }

    _syncActions() {
        const focus = global.stage.key_focus;
        const active = this.hover || this.confirming ||
            focus === this.endButton || focus === this.killButton;
        this._actions.opacity = active ? 255 : 110;
    }

    get confirming() {
        return !!this.confirm?.visible;
    }

    closeConfirm() {
        if (this.confirming) {
            this.confirm.close();
            this._syncActions();
        }
    }

    _request(force) {
        const button = force ? this.killButton : this.endButton;
        if (!isButtonEnabled(button))
            return;
        if (!this._ctx.settings.get_boolean('confirm-end')) {
            this._act(force);
            return;
        }
        if (!this.confirm) {
            this.confirm = new ConfirmStrip();
            this.confirm.connect('notify::visible', () => this._syncActions());
            this.add_child(this.confirm);
        }
        this.confirm.ask(this._question(force), () => this._act(force));
    }

    setNumbers(cpu, mem, fmt) {
        setText(this.cpuLabel, formatPercent(cpuPercent(cpu, fmt.ncpu, fmt.perCore)));
        setText(this.memLabel, Number.isFinite(mem) ? formatBytes(mem) : '–');
    }
});

export const AppRow = GObject.registerClass(
class SpringAppRow extends BaseRow {
    _init(ctx, app) {
        super._init(ctx);
        this.app = app;
        this.stats = null;
        this._iconBin.set_child(app.create_icon_texture(28));
        this.nameLabel.text = app.get_name() ?? app.get_id();
        this.endButton.accessible_name = `End ${this.nameLabel.text}`;
        this.killButton.accessible_name = `Force quit ${this.nameLabel.text}`;
        this._endingSince = 0;
        this.cpuLabel.text = '–';
        this.memLabel.text = '–';
    }

    get name() {
        return this.nameLabel.text;
    }

    update(stats, fmt) {
        this.stats = stats ?? null;
        if (stats)
            this.setNumbers(stats.cpu, stats.mem, fmt);
        let sub = '';
        if (this._endingSince) {
            const waited = (Date.now() - this._endingSince) / 1000;
            sub = waited < 8 ? 'Ending…' : 'Still open. Force quit stops it at once.';
        } else if (stats?.count > 1) {
            sub = `${stats.count} processes`;
        } else if (stats?.count === 1) {
            sub = '1 process';
        }
        setText(this.subLabel, sub);
        this.subLabel.visible = sub !== '';
    }

    _tip(force) {
        return force ? `Force quit ${this.name}` : `End ${this.name}`;
    }

    _question(force) {
        const count = this.stats?.count ?? 0;
        if (!force) {
            return {
                title: `End ${this.name}?`,
                note: `${this.name} is asked to quit, as if you closed it. It may ask you to save your work first.`,
                ok: 'End',
            };
        }
        const what = count > 1 ? `All ${count} of its processes stop` : 'It stops';
        return {
            title: `Force quit ${this.name}?`,
            note: `${what} at once. Unsaved work is lost.`,
            ok: 'Force Quit',
            danger: true,
        };
    }

    async _act(force) {
        if (force) {
            const stats = this.stats?.cgroups?.length || this.stats?.pids?.length
                ? this.stats : {cgroups: [], pids: this.app.get_pids()};
            const ok = await forceQuitApp(stats);
            if (!ok)
                Main.notify('Spring', `Could not force quit ${this.name}.`);
        } else {
            endApp(this.app, this.stats);
            this._endingSince = Date.now();
            this.update(this.stats, this._ctx.fmt());
        }
    }
});

export const ProcRow = GObject.registerClass(
class SpringProcRow extends BaseRow {
    _init(ctx, pid) {
        super._init(ctx);
        this.add_style_class_name('spring-proc-row');
        this.pid = pid;
        this.info = null;
        this._app = undefined;
        this.gone = false;
    }

    // proc: {pid, cpu, mem, app, info: [name, uid, user, cmd, kind, admin]}
    // visible: false for a row scrolled out of view. Writing a label costs
    // the shell a relayout, so its numbers wait until it is scrolled to.
    update(proc, fmt, myUid, visible = true) {
        // The sampler sends a process's details again only when they change.
        if (this.info !== proc.info) {
            const [name, uid, user, cmd, kind] = proc.info;
            this.info = proc.info;
            setText(this.nameLabel, name);
            const parts = [`${proc.pid}`];
            if (uid !== myUid)
                parts.push(user);
            if (cmd)
                parts.push(cmd);
            setText(this.subLabel, parts.join(' · '));
            // No buttons for what cannot be ended, but the space stays so
            // the columns line up.
            this.endButton.visible = this.killButton.visible = kind !== 'protected';
        }
        this._numbers = [proc.cpu, proc.mem, fmt];
        if (visible)
            this.showNumbers();
        if (this._app !== proc.app) {
            this._app = proc.app;
            const app = proc.app ? this._ctx.appSystem.lookup_app(proc.app) : null;
            this._iconBin.set_child(app ? app.create_icon_texture(16) : null);
        }
        this.setGone(false);
    }

    showNumbers() {
        if (this._numbers && !this.gone)
            this.setNumbers(...this._numbers);
        this._numbers = null;
    }

    setGone(gone) {
        if (gone === this.gone)
            return;
        this.gone = gone;
        this.opacity = gone ? 120 : 255;
        setButtonEnabled(this.endButton, !gone);
        setButtonEnabled(this.killButton, !gone);
        if (gone) {
            setText(this.cpuLabel, '–');
            this.closeConfirm();
        }
    }

    get name() {
        return this.info?.[0] ?? `${this.pid}`;
    }

    _tip(force) {
        if (this.gone)
            return 'This process has already stopped';
        return force ? `Force quit ${this.name}` : `End ${this.name}`;
    }

    _question(force) {
        const [, , user, , kind, admin] = this.info ?? [];
        const notes = [force
            ? 'It stops at once. Unsaved work is lost.'
            : 'It is asked to stop, so it can save and close first.'];
        if (kind === 'session')
            notes.push('It is part of your desktop session: ending it can close other apps or log you out.');
        if (admin)
            notes.push(`It belongs to ${user}, so you will be asked for your password.`);
        return {
            title: `${force ? 'Force quit' : 'End'} “${this.name}” (${this.pid})?`,
            note: notes.join(' '),
            ok: force ? 'Force Quit' : 'End',
            danger: force || kind === 'session',
        };
    }

    async _act(force) {
        const admin = !!this.info?.[5];
        const name = this.name;
        const {ok, cancelled} = await signalProcess(this.pid, force, admin);
        if (!ok && !cancelled)
            Main.notify('Spring', `Could not end “${name}” (${this.pid}).`);
    }
});
