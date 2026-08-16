import {
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Scope,
  Semaphore,
  Stream,
  pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
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

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const barriers = yield* Hooks.Barriers.Service;
    const notifications = yield* Hooks.Notifications.Service;
    const rootScope = yield* Scope.Scope;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const inhibitor = yield* Ref.make<Scope.Closeable | null>(null);
    const mutex = yield* Semaphore.make(1);

    const openInhibitor = Effect.fn("Activity.__openInhibitor")(function* () {
      const scope = yield* Scope.fork(rootScope, "sequential");
      return yield* pipe(
        spawner.spawn(
          ChildProcess.make(
            "systemd-inhibit",
            [
              "--what=sleep",
              "--mode=block",
              "--who=Stratum Pi",
              "--why=Pi agent active",
              "sh",
              "-c",
              "printf ready; exec sleep infinity",
            ],
            {
              stdin: "ignore",
              stderr: "ignore",
            },
          ),
        ),
        Scope.provide(scope),
        Effect.tap((handle) =>
          pipe(
            Stream.runHead(handle.stdout),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.die(
                    "systemd-inhibit exited before acquiring the inhibitor",
                  ),
                onSome: () => Effect.void,
              }),
            ),
          ),
        ),
        Effect.as(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
    });

    const closeInhibitor = Effect.fn("Activity.__closeInhibitor")(function* () {
      const current = yield* Ref.getAndSet(inhibitor, null);
      if (current !== null) {
        yield* pipe(Scope.close(current, Exit.void), Effect.ignore);
      }
    });

    const setIdle = (attention = false) =>
      pipe(
        closeInhibitor(),
        Effect.andThen(reportAgentState("idle", attention)),
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
            yield* reportAgentState("running");
            if ((yield* Ref.get(inhibitor)) !== null) return;
            const scope = yield* openInhibitor();
            yield* Ref.set(inhibitor, scope);
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

export * as Activity from "./index.ts";
