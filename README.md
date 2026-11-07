# bb-plugin-idle-inhibit

Keeps the Linux machine running bb awake while toggled on. The toggle lives in
the thread and new-thread composer action rows, below the prompt.

## How it works

`server.ts` registers two RPC methods and owns a D-Bus inhibitor cookie.
Enabling tries, in order:

1. `org.freedesktop.ScreenSaver` (`Inhibit`/`UnInhibit`) — KDE, Cinnamon, and
   idle daemons such as hypridle or swayidle that expose the freedesktop
   interface.
2. `org.gnome.SessionManager` (`Inhibit`/`Uninhibit`, flags `8` = idle) — GNOME.
3. `org.freedesktop.PowerManagement` (`Inhibit`/`UnInhibit`) — the freedesktop
   power-management interface.

The first service that answers owns the inhibitor. Releasing calls that
service's uninhibit method with the stored cookie. The enabled state and cookie
are persisted in the plugin's key-value storage; on load the plugin acquires a
fresh cookie and releases the previous one, so a reload never stacks
inhibitors. `onDispose` releases the cookie when the plugin is disabled, the
server shuts down, or the plugin reloads.

The toggle acts on the machine running the bb server, not on a remote client.

## Files

- `server.ts` — D-Bus inhibition, RPC contract, persistence, disposal.
- `app.tsx` — composer customization registering the toggle action.
- `components/ui/` — vendored Button and Icon used by the action.

## Build and install

```
npm install --include=dev
bb plugin build
bb plugin install . --yes
bb plugin enable idle-inhibit
```

For live development, `bb plugin dev` rebuilds and reloads on save.
