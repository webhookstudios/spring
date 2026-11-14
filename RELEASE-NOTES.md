# Spring 1.0.0

The first release of Spring, a task manager in the GNOME top bar.

- Processor and memory use at a glance: two thin bars next to the icon, and figures if you want them.
- A panel with processor and memory graphs, and every open app with the processor and memory it uses, busiest first.
- End asks an app to quit, so it can save your work. Force quit stops it and all of its processes at once.
- A list of all processes with search and sorting, each with End and Force quit. Processes of the system or another user ask for your password.
- Spring asks before it ends anything, and stays light: apps and processes are only read while the panel is open.

Install:

```bash
sudo apt install ./spring-monitor_1.0.0_all.deb
```

Then log out and back in, and open Spring from the apps menu.
