import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {applyToWindow as applySedge} from './sedge/sedge.js';

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, step) {
    // The allowed range comes from the schema, so it is defined once.
    const [, [lower, upper]] = settings.settings_schema.get_key(key)
        .get_range().recursiveUnpack();
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function choiceRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const show = () => {
        const index = choices.findIndex(([value]) => value === settings.get_string(key));
        if (index >= 0 && row.selected !== index)
            row.selected = index;
    };
    show();
    settings.connect(`changed::${key}`, show);
    row.connect('notify::selected', () => {
        const [value] = choices[row.selected] ?? [];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    return row;
}

const INTERVALS = [1, 1.5, 2, 3, 5, 10];
const intervalLabel = v => (v === 1 ? 'Every second' : `Every ${v} seconds`);

// How often Spring updates, as a short list of choices. A value set some
// other way is added to the list.
function intervalRow(settings) {
    const key = 'refresh-interval';
    const values = [...INTERVALS];
    const current = settings.get_double(key);
    if (!values.includes(current))
        values.push(current);
    values.sort((a, b) => a - b);
    const row = new Adw.ComboRow({
        title: 'Refresh rate',
        subtitle: 'Apps and processes are only read while the panel is open',
        model: Gtk.StringList.new(values.map(intervalLabel)),
    });
    const show = () => {
        const index = values.indexOf(settings.get_double(key));
        if (index >= 0 && row.selected !== index)
            row.selected = index;
    };
    show();
    settings.connect(`changed::${key}`, show);
    row.connect('notify::selected', () => {
        const value = values[row.selected];
        if (value !== undefined && value !== settings.get_double(key))
            settings.set_double(key, value);
    });
    return row;
}

function generalPage(settings) {
    const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

    const bar = new Adw.PreferencesGroup({title: 'Top bar'});
    bar.add(switchRow(settings, 'show-bars', 'Usage bars',
        'Two small bars next to the icon: processor, then memory'));
    bar.add(switchRow(settings, 'show-numbers', 'Numbers',
        'Processor and memory use as figures next to the icon'));
    const memory = choiceRow(settings, 'memory-format', 'Memory shown as',
        'How the memory figure reads in the top bar', [
            ['percent', 'Percentage'],
            ['amount', 'Amount used'],
        ]);
    settings.bind('show-numbers', memory, 'sensitive', Gio.SettingsBindFlags.GET);
    bar.add(memory);
    bar.add(choiceRow(settings, 'panel-position', 'Position',
        'Which side of the system menu the icon sits on', [
            ['left', 'Left'],
            ['right', 'Right'],
        ]));
    page.add(bar);

    const panel = new Adw.PreferencesGroup({title: 'Panel'});
    panel.add(intervalRow(settings));
    panel.add(switchRow(settings, 'cpu-per-core', 'Processor use per core',
        'Off: 100% is the whole processor. On: 100% is one core, so busy apps can show more.'));
    panel.add(switchRow(settings, 'show-other-users', 'Show system processes',
        'Also list processes that belong to the system and other users'));
    panel.add(spinRow(settings, 'process-limit', 'Processes listed',
        'The most shown at once. Search to find the rest.', 10));
    panel.add(choiceRow(settings, 'process-sort', 'Sort processes by',
        'You can also click a column name in the list', [
            ['cpu', 'Processor use'],
            ['memory', 'Memory use'],
            ['name', 'Name'],
        ]));
    panel.add(switchRow(settings, 'confirm-end', 'Ask before ending',
        'Confirm before an app or process is ended or force quit'));
    page.add(panel);

    return page;
}

export default class SpringPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        applySedge(window, `${this.path}/sedge`);
        window.set_title('Spring');
        window.set_default_size(620, 760);
        window.add(generalPage(this.getSettings()));
    }
}
