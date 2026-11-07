Keep this Linux machine awake while bb is working.

## What you get

- A **Stay awake** toggle in the composer action row of thread and new-thread
  prompts. Pressed means the machine is currently inhibited from going idle.
- Inhibition through the desktop's D-Bus interface: `org.freedesktop.ScreenSaver`
  first, then GNOME's `org.gnome.SessionManager`, then the freedesktop
  `org.freedesktop.PowerManagement` interface.

## Notes

- The toggle applies to the machine running the bb server.
- The state persists across bb restarts. Disabling the plugin, reloading it, or
  shutting bb down releases the inhibitor.
