# bb-plugin-idle-inhibit

Blocks **system suspend** while toggled on. The toggle lives in the thread and
new-thread composer action rows, below the prompt. Screen blanking and the
screen saver are intentionally left alone: the inhibitor is the logind `sleep`
lock, not `idle`.

## How it works

The plugin spawns:

```
systemd-inhibit --what=sleep --who=bb-plugin-idle-inhibit \
  --why="bb is keeping this machine awake" --mode=block cat
```

`cat` inherits a pipe held by the bb server. Holding that pipe open holds a
`block` inhibitor on suspend and hibernation. Ending the pipe — or the bb
server exiting — closes it, `cat` sees EOF, and systemd-logind releases the
lock. No cookie or file descriptor needs to survive a crash.

The enabled state persists in the plugin's key-value storage. On load with the
toggle on, the plugin acquires a fresh lock; `onDispose` releases it on plugin
disable, reload, or server shutdown. A lock that dies unexpectedly flips the
toggle back off and reports the reason.

`org.freedesktop.ScreenSaver.Inhibit` is deliberately not used: it inhibits
idle/screen blanking, which is not the same guarantee as blocking suspend.

The toggle acts on the machine running the bb server, not on a remote client.

## Files

- `server.ts` — systemd-inhibit lifecycle, RPC contract, persistence, disposal.
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
