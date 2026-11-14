// Spring: a task manager in the top bar.
//
// The top bar shows processor and memory use. The panel shows both over the
// last minutes, every open app with its processor and memory use, and a
// list of all processes, each with End and Force quit.
//
// Nothing heavy runs in the shell: the overall figures are two small files
// read asynchronously, and the per-app and per-process figures come from a
// helper process (sampler.js) that runs only while the panel is open.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {HISTORY, HelperSampler, SystemSampler} from './monitor.js';
import {AppRow, ProcRow, TopBarMeter, UsageCard} from './rows.js';
import {TipManager, formatBytes, iconButton} from './util.js';

const byCpu = (a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || b.mem - a.mem || a.pid - b.pid;
const SORTS = {
    cpu: byCpu,
    memory: (a, b) => b.mem - a.mem || byCpu(a, b),
    name: (a, b) => a.info[0].localeCompare(b.info[0]) || a.pid - b.pid,
};

const esc = text => GLib.markup_escape_text(text, -1);

function scrollList() {
    const scroll = new St.ScrollView({
        style_class: 'spring-scroll',
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        overlay_scrollbars: true,
        x_expand: true,
        reactive: true,
        track_hover: true,
    });
    const list = new St.BoxLayout({
        style_class: 'spring-list',
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
    });
    scroll.set_child(list);
    return [scroll, list];
}

function columnLabel(text, styleClass) {
    return new St.Label({text, style_class: `spring-column ${styleClass}`, y_align: Clutter.ActorAlign.CENTER});
}

const SpringButton = GObject.registerClass(
class SpringButton extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Spring', false);
        this._ext = ext;
        this._settings = ext.getSettings();
        const creds = new Gio.Credentials();
        this._myUid = creds.get_unix_user();
        this._shellPid = creds.get_unix_pid();
        this._appSystem = Shell.AppSystem.get_default();
        this._tips = new TipManager();
        this._ctx = {
            tips: this._tips,
            settings: this._settings,
            appSystem: this._appSystem,
            fmt: () => this._fmt(),
            forceQuitIcon: Gio.FileIcon.new(Gio.File.new_for_path(
                GLib.build_filenamev([ext.path, 'icons', 'spring-force-quit-symbolic.svg']))),
        };

        // Top bar: the icon, two small bars and, if wanted, the figures.
        const box = new St.BoxLayout({style_class: 'spring-panel-box'});
        this._icon = new St.Icon({
            gicon: Gio.FileIcon.new(Gio.File.new_for_path(
                GLib.build_filenamev([ext.path, 'icons', 'spring-symbolic.svg']))),
            style_class: 'system-status-icon',
        });
        box.add_child(this._icon);
        this._bars = new TopBarMeter();
        box.add_child(this._bars);
        this._figures = new St.Label({style_class: 'spring-figures', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._figures);
        this.add_child(box);

        this._system = new SystemSampler(() => this._onSystem());
        this._helper = new HelperSampler(GLib.build_filenamev([ext.path, 'sampler.js']),
            data => this._onSample(data));
        this._sample = null;
        this._procInfo = new Map();
        this._appRows = new Map();
        this._procRows = new Map();
        this._view = 'apps';

        this._buildMenu();

        this._settings.connectObject('changed', (_s, key) => this._onSetting(key), this);
        this.menu.connect('open-state-changed', (_m, open) => this._onOpenChanged(open));
        this._appSystem.connectObject('app-state-changed', () => {
            if (!this.menu.isOpen)
                return;
            this._sendConfig();
            this._syncApps();
        }, this);

        this._syncTopBar();
        this._syncSampling();
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('spring-menu');
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'spring-item'});
        this.menu.addMenuItem(item);
        const root = new St.BoxLayout({style_class: 'spring-root', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        item.add_child(root);

        const cards = new St.BoxLayout({style_class: 'spring-cards', x_expand: true});
        this._cpuCard = new UsageCard('CPU', 'cpu');
        this._memCard = new UsageCard('Memory', 'mem');
        cards.add_child(this._cpuCard);
        cards.add_child(this._memCard);
        root.add_child(cards);

        // Apps.
        this._appsPage = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const appsHead = new St.BoxLayout({style_class: 'spring-head', x_expand: true});
        appsHead.add_child(new St.Label({text: 'Apps', style_class: 'spring-heading', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        appsHead.add_child(columnLabel('CPU', 'spring-num-cpu'));
        appsHead.add_child(columnLabel('Memory', 'spring-num-mem'));
        this._procsButton = iconButton('view-list-symbolic', 'All processes', 'spring-head-button');
        this._tips.attach(this._procsButton, 'All processes');
        this._procsButton.connect('clicked', () => this._setView('procs'));
        appsHead.add_child(this._procsButton);
        this._appsPage.add_child(appsHead);
        [this._appScroll, this._appList] = scrollList();
        this._appsPage.add_child(this._appScroll);
        this._appsEmpty = new St.Label({text: 'No apps are open', style_class: 'spring-empty', x_align: Clutter.ActorAlign.CENTER});
        this._appsPage.add_child(this._appsEmpty);
        root.add_child(this._appsPage);

        // Processes.
        this._procsPage = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, visible: false});
        const procsHead = new St.BoxLayout({style_class: 'spring-head', x_expand: true});
        this._backButton = iconButton('go-previous-symbolic', 'Back to apps', 'spring-head-button');
        this._tips.attach(this._backButton, 'Back to apps');
        this._backButton.connect('clicked', () => this._setView('apps'));
        procsHead.add_child(this._backButton);
        this._search = new St.Entry({
            style_class: 'spring-search',
            hint_text: 'Search processes',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'spring-search-icon'}),
        });
        this._search.clutter_text.connect('text-changed', () => this._syncProcs(true));
        procsHead.add_child(this._search);
        this._procsPage.add_child(procsHead);

        const columns = new St.BoxLayout({style_class: 'spring-columns', x_expand: true});
        this._sortButtons = {};
        for (const [key, text, cls] of [
            ['name', 'Name', 'spring-col-name'],
            ['cpu', 'CPU', 'spring-num-cpu'],
            ['memory', 'Memory', 'spring-num-mem'],
        ]) {
            const inner = new St.BoxLayout({x_expand: true, x_align: key === 'name' ? Clutter.ActorAlign.START : Clutter.ActorAlign.END});
            inner.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
            const arrow = new St.Icon({icon_name: 'pan-down-symbolic', style_class: 'spring-sort-arrow'});
            inner.add_child(arrow);
            const button = new St.Button({
                style_class: `spring-column spring-sort ${cls}`,
                child: inner,
                can_focus: true,
                x_expand: key === 'name',
                accessible_name: `Sort by ${text}`,
            });
            button.connect('clicked', () => this._settings.set_string('process-sort', key));
            this._sortButtons[key] = {button, arrow};
            columns.add_child(button);
        }
        columns.add_child(new St.Widget({style_class: 'spring-actions-spacer'}));
        this._procsPage.add_child(columns);
        [this._procScroll, this._procList] = scrollList();
        this._procScroll.add_style_class_name('spring-proc-scroll');
        this._procScroll.vadjustment.connect('notify::value', () => this._showVisibleNumbers());
        this._procsPage.add_child(this._procScroll);
        this._procNote = new St.Label({style_class: 'spring-note', x_align: Clutter.ActorAlign.CENTER});
        this._procsPage.add_child(this._procNote);
        root.add_child(this._procsPage);
        this._syncSortButtons();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Spring Settings', () => this._ext.openPreferences());
    }

    // ---- sampling ----------------------------------------------------------------

    get _interval() {
        return this._settings.get_double('refresh-interval');
    }

    _fmt() {
        return {
            ncpu: this._system.latest?.ncpu ?? 1,
            perCore: this._settings.get_boolean('cpu-per-core'),
        };
    }

    _syncSampling() {
        const interval = this._interval;
        const want = this.menu.isOpen || this._settings.get_boolean('show-bars') ||
            this._settings.get_boolean('show-numbers');
        if (!want)
            this._system.stop();
        else if (!this._system.running || this._system.interval !== interval)
            this._system.start(interval);

        if (this.menu.isOpen) {
            this._helper.start();
            this._sendConfig();
        } else {
            this._helper.stop();
        }
    }

    _runningApps() {
        return this._appSystem.get_running().filter(app => app.get_state() !== Shell.AppState.STOPPED);
    }

    _sendConfig() {
        if (!this._helper.running)
            return;
        const apps = this._runningApps().map(app => ({
            id: app.get_id(),
            pids: app.get_pids().filter(pid => pid > 0 && pid !== this._shellPid),
        }));
        this._helper.configure({
            interval: this._interval,
            procs: this._view === 'procs',
            shellPid: this._shellPid,
            apps,
        });
    }

    _onSystem() {
        this._syncTopBar();
        if (this.menu.isOpen)
            this._syncCards();
    }

    _onSample(data) {
        if (!this.menu.isOpen)
            return;
        if (data.reset)
            this._procInfo.clear();
        for (const [pid, info] of Object.entries(data.info ?? {}))
            this._procInfo.set(Number(pid), info);
        this._sample = data;
        this._syncApps();
        if (this._view === 'procs')
            this._syncProcs(false);
        // Apps open new windows, so their process ids change.
        this._sendConfig();
    }

    _onSetting(key) {
        switch (key) {
        case 'refresh-interval':
        case 'show-bars':
        case 'show-numbers':
            this._syncSampling();
            this._syncTopBar();
            break;
        case 'memory-format':
            this._syncTopBar();
            break;
        case 'cpu-per-core':
            this._syncApps();
            this._syncProcs(true);
            break;
        case 'process-sort':
            this._syncSortButtons();
            this._syncProcs(true);
            break;
        case 'show-other-users':
        case 'process-limit':
            this._syncProcs(true);
            break;
        }
    }

    // ---- top bar and cards -------------------------------------------------------

    _syncTopBar() {
        const showBars = this._settings.get_boolean('show-bars');
        const showNumbers = this._settings.get_boolean('show-numbers');
        this._bars.visible = showBars;
        this._figures.visible = showNumbers;
        const s = this._system.latest;
        if (!s) {
            this._figures.text = '';
            this._bars.set(0, 0);
            return;
        }
        const memShare = s.memTotal > 0 ? s.memUsed / s.memTotal : 0;
        this._bars.set(s.cpu ?? 0, memShare);
        const cpu = s.cpu === null ? '–' : `${Math.round(s.cpu * 100)}%`;
        const mem = this._settings.get_string('memory-format') === 'amount'
            ? formatBytes(s.memUsed) : `${Math.round(memShare * 100)}%`;
        if (showNumbers) {
            this._figures.clutter_text.set_markup(
                `<span alpha="60%">CPU</span> ${esc(cpu)}  <span alpha="60%">MEM</span> ${esc(mem)}`);
        }
        this.accessible_name = `Spring: processor ${cpu}, memory ${mem}`;
    }

    _syncCards() {
        const s = this._system.latest;
        if (!s)
            return;
        const span = Math.round(HISTORY * this._interval / 60);
        this._cpuCard.set(s.cpu === null ? '–' : `${Math.round(s.cpu * 100)}%`,
            `${s.ncpu} threads · last ${span} min`, this._system.cpuHistory);
        let detail = `of ${formatBytes(s.memTotal)}`;
        if (s.swapUsed > 0)
            detail += ` · swap ${formatBytes(s.swapUsed)}`;
        this._memCard.set(formatBytes(s.memUsed), detail, this._system.memHistory);
    }

    // ---- views -------------------------------------------------------------------

    _onOpenChanged(open) {
        if (this._destroying)
            return;
        if (open) {
            this._sample = null;
            this._syncSampling();
            this._syncCards();
            this._syncApps();
            return;
        }
        this._tips.hide();
        this._setView('apps');
        this._search.text = '';
        this._syncSampling();
        this._sample = null;
        for (const row of this._appRows.values())
            row.closeConfirm();
    }

    _setView(view) {
        if (this._view === view)
            return;
        this._view = view;
        this._tips.hide();
        this._appsPage.visible = view === 'apps';
        this._procsPage.visible = view === 'procs';
        if (view === 'procs') {
            for (const row of this._appRows.values())
                row.closeConfirm();
            this._syncProcs(true);
            this._search.grab_key_focus();
        } else {
            for (const row of this._procRows.values())
                row.destroy();
            this._procRows.clear();
            this._procInfo.clear();
            if (this._sample)
                delete this._sample.procs;
            this._syncApps();
        }
        this._sendConfig();
    }

    _syncApps() {
        if (!this.menu.isOpen)
            return;
        const apps = this._runningApps();
        const stats = this._sample?.apps ?? {};
        const fmt = this._fmt();
        const ids = new Set(apps.map(app => app.get_id()));
        for (const [id, row] of this._appRows) {
            if (!ids.has(id)) {
                row.destroy();
                this._appRows.delete(id);
            }
        }
        for (const app of apps) {
            const id = app.get_id();
            let row = this._appRows.get(id);
            if (!row) {
                row = new AppRow(this._ctx, app);
                this._appRows.set(id, row);
                this._appList.add_child(row);
            }
            row.update(stats[id], fmt);
        }
        // Rows keep still while the pointer is on the list, so a button
        // does not move away just before it is clicked.
        const rows = [...this._appRows.values()];
        if (!this._appScroll.hover && !rows.some(row => row.confirming)) {
            rows.sort((a, b) => (b.stats?.cpu ?? -1) - (a.stats?.cpu ?? -1) ||
                (b.stats?.mem ?? 0) - (a.stats?.mem ?? 0) || a.name.localeCompare(b.name));
            rows.forEach((row, i) => {
                if (this._appList.get_child_at_index(i) !== row)
                    this._appList.set_child_at_index(row, i);
            });
        }
        this._appsEmpty.visible = apps.length === 0;
        this._appScroll.visible = apps.length > 0;
    }

    _syncSortButtons() {
        const sort = this._settings.get_string('process-sort');
        for (const [key, {button, arrow}] of Object.entries(this._sortButtons)) {
            if (key === sort)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
            arrow.opacity = key === sort ? 255 : 0;
        }
    }

    // force: the search, sort or settings changed, so redraw even while
    // the pointer is on the list.
    _syncProcs(force) {
        if (!this.menu.isOpen || this._view !== 'procs')
            return;
        const data = this._sample?.procs;
        if (!data) {
            this._procNote.text = 'Reading processes…';
            return;
        }
        const fmt = this._fmt();
        const query = this._search.text.trim().toLowerCase();
        const others = this._settings.get_boolean('show-other-users');
        const limit = this._settings.get_int('process-limit');
        const sort = SORTS[this._settings.get_string('process-sort')] ?? SORTS.cpu;

        const alive = new Map();
        const list = [];
        for (const [pid, cpu, mem, app] of data) {
            const info = this._procInfo.get(pid);
            if (!info)
                continue;
            const proc = {pid, cpu, mem, app, info};
            alive.set(pid, proc);
            if (!others && info[1] !== this._myUid)
                continue;
            if (query && !`${pid}`.startsWith(query) &&
                !info[0].toLowerCase().includes(query) &&
                !info[2].toLowerCase().includes(query) &&
                !info[3].toLowerCase().includes(query))
                continue;
            list.push(proc);
        }
        for (const pid of this._procInfo.keys()) {
            if (!alive.has(pid))
                this._procInfo.delete(pid);
        }
        list.sort(sort);
        const shown = list.slice(0, limit);

        const visible = this._visibleRange();
        const frozen = !force && (this._procScroll.hover ||
            [...this._procRows.values()].some(row => row.confirming));
        if (frozen) {
            this._procList.get_children().forEach((row, i) => {
                const proc = alive.get(row.pid);
                if (proc)
                    row.update(proc, fmt, this._myUid, visible(i));
                else
                    row.setGone(true);
            });
        } else {
            const keep = new Set(shown.map(p => p.pid));
            for (const [pid, row] of this._procRows) {
                if (!keep.has(pid)) {
                    row.destroy();
                    this._procRows.delete(pid);
                }
            }
            shown.forEach((proc, i) => {
                let row = this._procRows.get(proc.pid);
                if (!row) {
                    row = new ProcRow(this._ctx, proc.pid);
                    this._procRows.set(proc.pid, row);
                    this._procList.add_child(row);
                }
                row.update(proc, fmt, this._myUid, visible(i));
                if (this._procList.get_child_at_index(i) !== row)
                    this._procList.set_child_at_index(row, i);
            });
        }

        if (list.length === 0)
            this._procNote.text = query ? `Nothing matches “${this._search.text.trim()}”` : 'No processes';
        else if (list.length > shown.length)
            this._procNote.text = `Showing ${shown.length} of ${list.length}. Search to find the rest.`;
        else
            this._procNote.text = list.length === 1 ? '1 process' : `${list.length} processes`;
    }

    // Which list positions are in view, give or take a row: a function of
    // the position.
    _visibleRange() {
        const adj = this._procScroll.vadjustment;
        const first = this._procList.get_first_child();
        const rowHeight = first?.height > 0 ? first.height : 40;
        const page = adj.page_size > 0 ? adj.page_size : 400;
        const top = adj.value - rowHeight;
        const bottom = adj.value + page + rowHeight;
        return i => (i + 1) * rowHeight > top && i * rowHeight < bottom;
    }

    _showVisibleNumbers() {
        const visible = this._visibleRange();
        this._procList.get_children().forEach((row, i) => {
            if (visible(i))
                row.showNumbers();
        });
    }

    destroy() {
        // Destroying the menu closes it, which must not touch what is gone.
        this._destroying = true;
        this._helper.stop();
        this._system.destroy();
        this._tips.destroy();
        this._settings.disconnectObject(this);
        this._appSystem.disconnectObject(this);
        this._appRows.clear();
        this._procRows.clear();
        super.destroy();
    }
});

export default class SpringExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settings.connectObject('changed::panel-position', () => {
            this._removeButton();
            this._addButton();
        }, this);
        this._addButton();
    }

    _addButton() {
        this._button = new SpringButton(this);
        const right = Main.panel._rightBox;
        // The system menu (quickSettings) is the last item on the right.
        const qs = Main.panel.statusArea.quickSettings?.container;
        let index = right.get_n_children();
        if (this._settings.get_string('panel-position') === 'left' && qs && qs.get_parent() === right)
            index = right.get_children().indexOf(qs);
        Main.panel.addToStatusArea(this.uuid, this._button, index, 'right');
    }

    _removeButton() {
        this._button?.destroy();
        this._button = null;
    }

    disable() {
        this._settings?.disconnectObject(this);
        this._removeButton();
        this._settings = null;
    }
}
