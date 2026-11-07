// bb-plugin-idle-inhibit — blocks system suspend through systemd-logind while
// the composer toggle is on. Screen blanking is untouched: the inhibitor lock
// is `sleep`, not `idle`.
import { spawn, type ChildProcess } from "node:child_process";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const statusSchema = z.object({
  enabled: z.boolean(),
  backend: z.string().nullable(),
  error: z.string().nullable(),
});
export type InhibitStatus = z.infer<typeof statusSchema>;

export const rpcContract = defineRpcContract({
  suspend_status: {
    input: z.null(),
    output: statusSchema,
  },
  suspend_set_enabled: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: statusSchema,
  },
});

const CHANGED = "suspend-inhibit-changed";
const WHO = "bb-plugin-idle-inhibit";
const WHY = "bb is keeping this machine awake";
/** Time systemd-inhibit gets to acquire the lock before we call it running. */
const READY_MS = 300;
/** Grace periods when stopping the lock holder. */
const END_STDIN_MS = 2_000;
const TERM_MS = 1_000;
const KILL_MS = 1_000;

interface Inhibitor {
  child: ChildProcess;
  exited: Promise<void>;
}

const STATE_KEY = "state";

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitFor(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  const { promise: settled, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => resolve(false), milliseconds);
  void promise.then(() => {
    clearTimeout(timer);
    resolve(true);
  });
  return settled;
}

export default async function plugin(bb: BbPluginApi) {
  let enabled = false;
  let inhibitor: Inhibitor | null = null;
  let error: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  // One transition at a time: a toggle must never race a reload's stop.
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = chain.then(operation, operation);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function persist(): Promise<void> {
    await bb.storage.kv.set(STATE_KEY, { enabled } satisfies { enabled: boolean });
  }

  function snapshot(): InhibitStatus {
    return { enabled, backend: enabled ? "logind" : null, error };
  }

  async function start(): Promise<Inhibitor> {
    // `cat` inherits a pipe held by this process. Holding the pipe open holds
    // the lock; ending it (or this process dying) closes the pipe, cat exits,
    // and logind releases the inhibitor.
    const child = spawn(
      "systemd-inhibit",
      [
        "--what=sleep",
        `--who=${WHO}`,
        `--why=${WHY}`,
        "--mode=block",
        "cat",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    const exitState = Promise.withResolvers<void>();
    const exited = exitState.promise;
    child.once("exit", () => exitState.resolve());

    const ready = Promise.withResolvers<string | null>();
    let settled = false;
    const settle = (message: string | null) => {
      if (settled) return;
      settled = true;
      ready.resolve(message);
    };
    child.once("error", (cause) => settle(describe(cause)));
    child.once("exit", (code, signal) =>
      settle(
        stderr.trim() ||
          `systemd-inhibit exited (${code ?? signal ?? "unknown"})`,
      ),
    );
    setTimeout(() => settle(null), READY_MS);
    const failure = await ready.promise;

    if (failure !== null) {
      if (isRunning(child)) child.kill("SIGKILL");
      await exited;
      throw new Error(`cannot block suspend: ${failure}`);
    }

    // A lock that dies outside a toggle must not leave the UI reporting on.
    const current: Inhibitor = { child, exited };
    void exited.then(() => {
      if (inhibitor !== current) return;
      inhibitor = null;
      enabled = false;
      error = stderr.trim() || "systemd-inhibit stopped unexpectedly";
      bb.log.warn(error);
      void persist().then(() => bb.realtime.publish(CHANGED, snapshot()));
    });
    return current;
  }

  async function stop(current: Inhibitor): Promise<void> {
    const { child, exited } = current;
    if (!isRunning(child)) return;
    // Graceful path: EOF on cat's stdin makes systemd-inhibit exit and drop
    // the lock without a signal.
    child.stdin?.end();
    if (await waitFor(exited, END_STDIN_MS)) return;
    child.kill("SIGTERM");
    if (await waitFor(exited, TERM_MS)) return;
    child.kill("SIGKILL");
    if (await waitFor(exited, KILL_MS)) return;
    throw new Error("systemd-inhibit did not stop; the sleep lock may persist");
  }

  const stored = await bb.storage.kv.get<{ enabled?: boolean }>(STATE_KEY);
  await serialize(async () => {
    enabled = stored?.enabled === true;
    if (!enabled) return;
    try {
      inhibitor = await start();
      error = null;
    } catch (cause) {
      // The intent stays stored: the next load or toggle retries it.
      enabled = false;
      inhibitor = null;
      error = describe(cause);
      bb.log.warn(error);
    }
  });

  bb.rpc.register(rpcContract, {
    suspend_status: async () => snapshot(),
    suspend_set_enabled: ({ enabled: next }) =>
      serialize(async () => {
        if (next) {
          if (!enabled || inhibitor === null) {
            try {
              inhibitor = await start();
              enabled = true;
              error = null;
            } catch (cause) {
              inhibitor = null;
              enabled = false;
              error = describe(cause);
            }
          }
        } else if (inhibitor !== null) {
          const current = inhibitor;
          inhibitor = null;
          try {
            await stop(current);
            enabled = false;
            error = null;
          } catch (cause) {
            // Still holding the lock: report on so the user can retry.
            inhibitor = current;
            enabled = true;
            error = describe(cause);
          }
        } else {
          enabled = false;
          error = null;
        }
        await persist();
        const status = snapshot();
        bb.realtime.publish(CHANGED, status);
        return status;
      }),
  });

  bb.onDispose(async () => {
    await serialize(async () => {
      if (inhibitor === null) return;
      const current = inhibitor;
      inhibitor = null;
      try {
        await stop(current);
      } catch (cause) {
        bb.log.warn(describe(cause));
      }
    });
  });

  bb.log.info("suspend inhibitor ready");
}
