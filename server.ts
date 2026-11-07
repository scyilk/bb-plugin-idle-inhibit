// bb-plugin-idle-inhibit — inhibits idle on the machine running bb through
// D-Bus. Registered from the composer toggle in app.tsx.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { Message, sessionBus, type MessageBus } from "dbus-next";
import { z } from "zod";

const statusSchema = z.object({
  enabled: z.boolean(),
  backend: z.string().nullable(),
  error: z.string().nullable(),
});
export type InhibitStatus = z.infer<typeof statusSchema>;

export const rpcContract = defineRpcContract({
  idle_status: {
    input: z.null(),
    output: statusSchema,
  },
  idle_set_enabled: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: statusSchema,
  },
});

const CHANGED = "idle-inhibit-changed";
const APPLICATION = "bb-plugin-idle-inhibit";
const REASON = "bb is keeping this machine awake";

interface Backend {
  id: string;
  service: string;
  path: string;
  interface: string;
  inhibitSignature: string;
  inhibitArgs: unknown[];
  releaseMember: string;
}

// Tried in order. ScreenSaver covers KDE, Cinnamon and idle daemons such as
// hypridle/swayidle that expose the freedesktop interface; GNOME SessionManager
// and the freedesktop PowerManagement interface cover the remaining desktops.
const BACKENDS: readonly Backend[] = [
  {
    id: "ScreenSaver",
    service: "org.freedesktop.ScreenSaver",
    path: "/org/freedesktop/ScreenSaver",
    interface: "org.freedesktop.ScreenSaver",
    inhibitSignature: "ss",
    inhibitArgs: [APPLICATION, REASON],
    releaseMember: "UnInhibit",
  },
  {
    id: "GNOME",
    service: "org.gnome.SessionManager",
    path: "/org/gnome/SessionManager",
    interface: "org.gnome.SessionManager",
    // app id, toplevel xid, reason, flags (8 = inhibit idle)
    inhibitSignature: "susu",
    inhibitArgs: [APPLICATION, 0, REASON, 8],
    releaseMember: "Uninhibit",
  },
  {
    id: "PowerManagement",
    service: "org.freedesktop.PowerManagement",
    path: "/org/freedesktop/PowerManagement/Inhibit",
    interface: "org.freedesktop.PowerManagement.Inhibit",
    inhibitSignature: "ss",
    inhibitArgs: [APPLICATION, REASON],
    releaseMember: "UnInhibit",
  },
];

interface StoredState {
  enabled: boolean;
  backend: string | null;
  cookie: number | null;
}

const STATE_KEY = "state";

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function messageBody(reply: Message | null): unknown[] {
  if (reply === null) throw new Error("D-Bus method returned no reply");
  return reply.body;
}

export default async function plugin(bb: BbPluginApi) {
  let bus: MessageBus | null = null;
  let enabled = false;
  let backend: string | null = null;
  let cookie: number | null = null;
  let error: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  // One D-Bus call at a time: rapid toggles must not race an Inhibit against
  // an UnInhibit, or leave a cookie we no longer track.
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = chain.then(operation, operation);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function ensureBus(): MessageBus {
    if (bus === null) {
      const created = sessionBus();
      created.on("error", (cause: unknown) => {
        bb.log.warn(`session bus error: ${describe(cause)}`);
        if (bus === created) bus = null;
      });
      bus = created;
    }
    return bus;
  }

  async function call(
    target: Backend,
    member: string,
    signature: string,
    body: unknown[],
  ): Promise<unknown[]> {
    const reply = await ensureBus().call(
      new Message({
        destination: target.service,
        path: target.path,
        interface: target.interface,
        member,
        signature,
        body,
      }),
    );
    return messageBody(reply);
  }

  async function acquire(): Promise<{ backend: string; cookie: number }> {
    const failures: string[] = [];
    for (const target of BACKENDS) {
      try {
        const body = await call(
          target,
          "Inhibit",
          target.inhibitSignature,
          target.inhibitArgs,
        );
        const value = body[0];
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          throw new Error(`unexpected inhibit cookie ${String(value)}`);
        }
        return { backend: target.id, cookie: value };
      } catch (cause) {
        failures.push(`${target.id}: ${describe(cause)}`);
      }
    }
    throw new Error(
      `No idle-inhibit D-Bus service accepted the request (${failures.join("; ")})`,
    );
  }

  async function release(
    targetId: string | null,
    value: number,
  ): Promise<void> {
    const target = BACKENDS.find((candidate) => candidate.id === targetId);
    if (target === undefined) return;
    await call(target, target.releaseMember, "u", [value]);
  }

  async function persist(): Promise<void> {
    await bb.storage.kv.set(STATE_KEY, { enabled, backend, cookie } satisfies StoredState);
  }

  function snapshot(): InhibitStatus {
    return { enabled, backend, error };
  }

  // A cookie from an earlier generation (or a crashed server) may still hold
  // an inhibitor. Acquire the replacement first, then drop the old cookie, so
  // a reload never leaves a window without inhibition.
  const stored = await bb.storage.kv.get<StoredState>(STATE_KEY);
  await serialize(async () => {
    enabled = stored?.enabled === true;
    backend = stored?.backend ?? null;
    cookie = stored?.cookie ?? null;
    if (enabled) {
      try {
        const acquired = await acquire();
        const previous = cookie;
        const previousBackend = backend;
        backend = acquired.backend;
        cookie = acquired.cookie;
        error = null;
        if (previous !== null) {
          try {
            await release(previousBackend, previous);
          } catch (cause) {
            bb.log.warn(`could not release stale inhibitor: ${describe(cause)}`);
          }
        }
      } catch (cause) {
        error = describe(cause);
        bb.log.warn(`could not inhibit idle: ${error}`);
        if (cookie === null) {
          enabled = false;
          backend = null;
        }
      }
    }
    await persist();
  });

  bb.rpc.register(rpcContract, {
    idle_status: async () => snapshot(),
    idle_set_enabled: ({ enabled: next }) =>
      serialize(async () => {
        if (next) {
          if (!enabled || cookie === null) {
            try {
              const acquired = await acquire();
              enabled = true;
              backend = acquired.backend;
              cookie = acquired.cookie;
              error = null;
            } catch (cause) {
              enabled = false;
              backend = null;
              cookie = null;
              error = describe(cause);
            }
          }
        } else {
          if (cookie !== null) {
            try {
              await release(backend, cookie);
              cookie = null;
              backend = null;
              enabled = false;
              error = null;
            } catch (cause) {
              // The inhibitor is still held, so the toggle stays on and the
              // user can retry; dispose attempts the release again.
              error = describe(cause);
            }
          } else {
            enabled = false;
            backend = null;
            error = null;
          }
        }
        await persist();
        const status = snapshot();
        bb.realtime.publish(CHANGED, status);
        return status;
      }),
  });

  bb.onDispose(async () => {
    await serialize(async () => {
      if (cookie !== null) {
        try {
          await release(backend, cookie);
        } catch (cause) {
          bb.log.warn(`could not release inhibitor: ${describe(cause)}`);
        }
        cookie = null;
        backend = null;
        await persist();
      }
      if (bus !== null) {
        bus.disconnect();
        bus = null;
      }
    });
  });

  bb.log.info("idle inhibitor ready");
}
