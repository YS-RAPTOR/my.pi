import { Effect, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const run = Effect.fn("Features.BetterSkills.Shell.run")(function* (
  processes: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  cwd: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* processes.spawn(
        ChildProcess.make("bash", ["-lc", command], {
          cwd,
          extendEnv: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      return yield* Effect.all(
        [
          pipe(handle.all, Stream.decodeText, Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
    }),
  );
});

export * as Shell from "./index.ts";
