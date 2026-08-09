import {
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  PlatformError,
  Ref,
  Scope,
  Semaphore,
  Stream,
  pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Herdr } from "#s/features/shell/herdr";
import { Acquire, Release } from "./types.ts";

type Lease = Readonly<{
  scope: Scope.Closeable;
}>;

type State = Readonly<{
  leases: ReadonlyMap<string, Lease>;
  agentRuns: number;
}>;

export type Interface = Readonly<{
  acquire: (
    request: Acquire,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
  release: (request: Release) => Effect.Effect<void>;
  agentStarted: Effect.Effect<void, PlatformError.PlatformError>;
  agentEnded: Effect.Effect<void>;
}>;

export class Service extends Context.Service<Service, Interface>()(
  "stratum/Features.Activity",
) {}

const agentID = "agent";
const agentReason = "Pi agent turn active";
const herdrSource = "stratum:activity";
const herdrAgent = "pi";

export const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* Herdr.Repo.Service;
    const rootScope = yield* Scope.Scope;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const state = yield* Ref.make<State>({ leases: new Map(), agentRuns: 0 });
    const mutex = yield* Semaphore.make(1);
    const herdr =
      process.env.HERDR_ENV === "1" &&
      process.env.HERDR_SOCKET_PATH !== undefined &&
      process.env.HERDR_SOCKET_PATH.length > 0 &&
      process.env.HERDR_PANE_ID !== undefined &&
      process.env.HERDR_PANE_ID.length > 0
        ? {
            socketPath: process.env.HERDR_SOCKET_PATH,
            paneId: process.env.HERDR_PANE_ID,
          }
        : undefined;

    const setState = Effect.fn("Activity.__setState")(function* (
      current: State,
      next: State,
      forceReport = false,
    ) {
      yield* Ref.set(state, next);
      if (
        herdr !== undefined &&
        (forceReport ||
          (current.leases.size > 0) !== (next.leases.size > 0))
      ) {
        yield* pipe(
          repo.reportAgent(
            herdr.socketPath,
            herdr.paneId,
            herdrSource,
            herdrAgent,
            next.leases.size > 0 ? "working" : "idle",
          ),
          Effect.ignore,
        );
      }
    });

    const openLease = Effect.fn("Activity.__openLease")(function* (
      request: Acquire,
    ) {
      const leaseScope = yield* Scope.fork(rootScope, "sequential");
      return yield* pipe(
        spawner.spawn(
          ChildProcess.make(
            "systemd-inhibit",
            [
              "--what=sleep",
              "--mode=block",
              "--who=Stratum Pi",
              `--why=${request.reason}`,
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
        Scope.provide(leaseScope),
        Effect.tap((handle) =>
          pipe(
            Stream.runHead(handle.stdout),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.die(
                    "systemd-inhibit exited before acquiring the lease",
                  ),
                onSome: () => Effect.void,
              }),
            ),
          ),
        ),
        Effect.as({ scope: leaseScope } satisfies Lease),
        Effect.onError(() => Scope.close(leaseScope, Exit.void)),
      );
    });

    const closeLease = (lease: Lease | undefined) =>
      lease === undefined
        ? Effect.void
        : pipe(Scope.close(lease.scope, Exit.void), Effect.ignore);

    const acquire: Interface["acquire"] = Effect.fn("Activity.acquire")(
      function* (request) {
        yield* mutex.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            if (current.leases.has(request.id)) return;
            const lease = yield* openLease(request);
            const leases = new Map(current.leases);
            leases.set(request.id, lease);
            yield* setState(current, { ...current, leases });
          }),
        );
      },
    );

    const release: Interface["release"] = Effect.fn("Activity.release")(
      function* (request) {
        yield* mutex.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const lease = current.leases.get(request.id);
            if (lease === undefined) return;
            const leases = new Map(current.leases);
            leases.delete(request.id);
            yield* closeLease(lease);
            yield* setState(current, { ...current, leases });
          }),
        );
      },
    );

    const agentStarted: Interface["agentStarted"] = mutex
      .withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const agentRuns = current.agentRuns + 1;
          if (current.agentRuns > 0) {
            yield* Ref.set(state, { ...current, agentRuns });
            return;
          }
          const lease = yield* openLease(
            new Acquire({ id: agentID, reason: agentReason }),
          );
          const leases = new Map(current.leases);
          leases.set(agentID, lease);
          yield* setState(current, { leases, agentRuns });
        }),
      )
      .pipe(Effect.withSpan("Activity.agentStarted"));

    const agentEnded: Interface["agentEnded"] = mutex
      .withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.agentRuns === 0) {
            yield* setState(current, current, true);
            return;
          }
          const agentRuns = current.agentRuns - 1;
          if (agentRuns > 0) {
            yield* Ref.set(state, { ...current, agentRuns });
            return;
          }
          const lease = current.leases.get(agentID);
          const leases = new Map(current.leases);
          leases.delete(agentID);
          yield* closeLease(lease);
          yield* setState(current, { leases, agentRuns });
        }),
      )
      .pipe(Effect.withSpan("Activity.agentEnded"));

    if (herdr !== undefined) {
      yield* pipe(
        repo.reportAgent(
          herdr.socketPath,
          herdr.paneId,
          herdrSource,
          herdrAgent,
          "idle",
        ),
        Effect.ignore,
      );
      yield* Effect.addFinalizer(() =>
        pipe(
          repo.releaseAgent(
            herdr.socketPath,
            herdr.paneId,
            herdrSource,
            herdrAgent,
          ),
          Effect.ignore,
        ),
      );
    }

    return Service.of({ acquire, release, agentStarted, agentEnded });
  }),
);
