// bb-plugin-idle-inhibit — puts a toggle in the thread and new-thread
// composer action rows. The server owns the D-Bus inhibitor.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

function IdleInhibitToggle() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<{
    enabled: boolean;
    backend: string | null;
    error: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    rpc.call("idle_status").then(setStatus, (cause: unknown) => {
      setStatus({
        enabled: false,
        backend: null,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });
  }, [rpc]);

  useEffect(refresh, [refresh]);
  // Another window or the CLI can change the same machine-wide inhibitor.
  useRealtime("idle-inhibit-changed", refresh);

  const enabled = status?.enabled === true;
  const error = status?.error ?? null;
  const label = error
    ? `Idle inhibition failed: ${error}`
    : enabled
      ? `Idle inhibition is on${status?.backend ? ` (${status.backend})` : ""}. Turn it off.`
      : "Keep this computer awake. Turn idle inhibition on.";

  async function toggle() {
    setBusy(true);
    try {
      setStatus(await rpc.call("idle_set_enabled", { enabled: !enabled }));
    } catch (cause) {
      setStatus({
        enabled,
        backend: status?.backend ?? null,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex" title={label}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        aria-label={label}
        aria-pressed={enabled}
        aria-busy={busy || status === null}
        disabled={busy || status === null}
        onClick={toggle}
      >
        <Icon name="Coffee" />
        <span>Stay awake</span>
        {error ? (
          <Icon name="AlertTriangle" className="size-3.5 text-destructive" />
        ) : null}
      </Button>
    </span>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "idle-inhibit",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "toggle", component: IdleInhibitToggle }],
  });
});
