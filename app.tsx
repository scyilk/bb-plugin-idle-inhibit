// bb-plugin-idle-inhibit — puts a suspend toggle in the thread and new-thread
// composer action rows. The server holds a systemd-logind sleep inhibitor.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

function SuspendInhibitToggle() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<{
    enabled: boolean;
    backend: string | null;
    error: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    rpc.call("suspend_status").then(setStatus, (cause: unknown) => {
      setStatus({
        enabled: false,
        backend: null,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });
  }, [rpc]);

  useEffect(refresh, [refresh]);
  // Another window can change the same machine-wide inhibitor.
  useRealtime("suspend-inhibit-changed", refresh);

  const enabled = status?.enabled === true;
  const error = status?.error ?? null;
  const label = error
    ? `Suspend inhibition failed: ${error}`
    : enabled
      ? `System suspend is blocked (${status?.backend ?? "logind"}). Screens may still turn off. Turn it off.`
      : "Block system suspend while bb works. Screens may still turn off.";

  async function toggle() {
    setBusy(true);
    try {
      setStatus(await rpc.call("suspend_set_enabled", { enabled: !enabled }));
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
        <span>Prevent sleep</span>
        {error ? (
          <Icon name="AlertTriangle" className="size-3.5 text-destructive" />
        ) : null}
      </Button>
    </span>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "suspend-inhibit",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "toggle", component: SuspendInhibitToggle }],
  });
});
