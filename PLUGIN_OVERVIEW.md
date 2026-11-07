Block system suspend while bb is working.

## What you get

- A **Prevent sleep** toggle in the composer action row of thread and
  new-thread prompts. Pressed means a systemd-logind `sleep` block inhibitor is
  held, so suspend and hibernation are refused.
- Screen blanking and the screen saver keep working; only sleep is blocked.

## Notes

- Uses `systemd-inhibit --what=sleep --mode=block`, which talks to
  systemd-logind over D-Bus. It does not use the ScreenSaver idle interface.
- The toggle applies to the machine running the bb server.
- The state persists across bb restarts. Disabling the plugin, reloading it, or
  shutting bb down releases the lock; a crashed server closes the pipe that
  holds it, so no stale lock survives.
