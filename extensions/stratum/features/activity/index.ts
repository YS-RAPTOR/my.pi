import { Effect, Exit, Layer, Ref, Scope, Semaphore, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Config } from "#s/config";
import { Hooks } from "#s/pi/hooks";

type AgentState = "idle" | "running";

const reportAgentState = Effect.fn("Activity.__reportAgentState")(
  (state: AgentState, attention = false) =>
    Effect.sync(() => {
      if (!process.stdout.isTTY) return;
      const encoded = Buffer.from(state).toString("base64");
      process.stdout.write(
        `\x1b]1337;SetUserVar=STRATTY_AGENT_STATE=${encoded}\x07${attention ? "\x07" : ""}`,
      );
    }),
);

const runtime = Layer.effectDiscard(
  Effect.gen(function* () {
    const { activity: config } = yield* Config.Service;
    const barriers = yield* Hooks.Barriers.Service;
    const notifications = yield* Hooks.Notifications.Service;
    const rootScope = yield* Scope.Scope;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const inhibitor = yield* Ref.make<Scope.Closeable | null>(null);
    const mutex = yield* Semaphore.make(1);
    const report = config["terminal-reporting"]
      ? reportAgentState
      : () => Effect.void;

    const openInhibitor = Effect.fn("Activity.__openInhibitor")(function* () {
      const command = config["inhibit-command"];
      if (command.trim() === "") return null;

      const scope = yield* Scope.fork(rootScope, "sequential");
      return yield* pipe(
        spawner.spawn(
          ChildProcess.make("bash", ["-lc", command], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        ),
        Scope.provide(scope),
        Effect.as(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
    });

    const closeInhibitor = Effect.fn("Activity.__closeInhibitor")(
      function* () {
        const current = yield* Ref.getAndSet(inhibitor, null);
        if (current !== null) {
          yield* pipe(Scope.close(current, Exit.void), Effect.ignore);
        }
      },
    );

    const setIdle = (attention = false) =>
      pipe(
        closeInhibitor(),
        Effect.andThen(report("idle", attention)),
        mutex.withPermit,
      );

    yield* barriers.handle(
      "session_start",
      Effect.fn("Activity.sessionStarted")(function* () {
        yield* setIdle();
      }),
    );

    yield* barriers.handle(
      "session_shutdown",
      Effect.fn("Activity.sessionEnded")(function* () {
        yield* setIdle();
      }),
    );

    yield* notifications.listen(
      ["agent_start"],
      Effect.fn("Activity.agentStarted")(function* () {
        yield* mutex.withPermit(
          Effect.gen(function* () {
            yield* report("running");
            if ((yield* Ref.get(inhibitor)) !== null) return;
            const scope = yield* openInhibitor();
            if (scope !== null) yield* Ref.set(inhibitor, scope);
          }),
        );
      }),
    );

    yield* notifications.listen(
      ["agent_end"],
      Effect.fn("Activity.agentEnded")(function* () {
        yield* mutex.withPermit(closeInhibitor());
      }),
    );

    yield* notifications.listen(
      ["agent_settled"],
      Effect.fn("Activity.agentSettled")(function* () {
        yield* setIdle(true);
      }),
    );

    yield* Effect.addFinalizer(() => setIdle());
  }),
);

export const layer = pipe(
  Effect.map(Config.Service, ({ activity }) =>
    activity.enabled ? runtime : Layer.empty,
  ),
  Layer.unwrap,
);

export * as Activity from "./index.ts";
