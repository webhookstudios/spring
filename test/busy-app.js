#!/usr/bin/gjs -m
// A test app for Spring's checks: one window, about 200 MB of memory in use,
// and a child process that keeps one core busy (the program in SPRING_BURN).

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const app = new Adw.Application({application_id: 'spring.test.Busy'});
let child = null;
let ballast = null;

app.connect('activate', () => {
    ballast = new Uint8Array(200 * 1024 * 1024).fill(7);
    const burner = GLib.getenv('SPRING_BURN');
    if (burner)
        child = Gio.Subprocess.new([burner], Gio.SubprocessFlags.STDOUT_SILENCE);
    const window = new Adw.ApplicationWindow({
        application: app,
        title: 'Busy Test App',
        default_width: 360,
        default_height: 220,
        content: new Adw.StatusPage({title: 'Busy Test App', description: `Holding ${ballast.length >> 20} MB`}),
    });
    window.present();
});

// The Quit action Spring's End uses when an app has one.
const quit = new Gio.SimpleAction({name: 'quit'});
quit.connect('activate', () => {
    print('busy-app: quit action');
    app.quit();
});
app.add_action(quit);
app.connect('shutdown', () => child?.force_exit());
void Gtk;
app.run([]);
