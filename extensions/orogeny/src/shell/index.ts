import { Shell as StratumShell } from "@ys-raptor/stratum.pi";
import { Effect, Layer, Option, Predicate, Schema, pipe } from "effect";
import { Bridge } from "#o/bridge";

const OpenInput = Schema.Struct({
  command: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
});

const ListInput = Schema.Struct({
  isRunning: Schema.optionalKey(Schema.Boolean),
});

const ReadInput = Schema.Struct({
  id: Schema.String,
  lines: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const WriteInput = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
});

const SendKeysInput = Schema.Struct({
  id: Schema.String,
  keys: Schema.Array(Schema.String),
});

const IdInput = Schema.Struct({ id: Schema.String });

const WaitInput = Schema.Struct({
  id: Schema.String,
  timeout: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
});

const options = { onExcessProperty: "error" } as const;
const decodeOpen = Schema.decodeUnknownEffect(OpenInput, options);
const decodeList = Schema.decodeUnknownEffect(ListInput, options);
const decodeRead = Schema.decodeUnknownEffect(ReadInput, options);
const decodeWrite = Schema.decodeUnknownEffect(WriteInput, options);
const decodeSendKeys = Schema.decodeUnknownEffect(SendKeysInput, options);
const decodeId = Schema.decodeUnknownEffect(IdInput, options);
const decodeWait = Schema.decodeUnknownEffect(WaitInput, options);

const failed = (errorName: string, message: string) =>
  new Bridge.Failed({ errorName, message, data: Option.none() });

const invalid = (errorName: string, expected: string, cause: { readonly message: string }) =>
  failed(errorName, `Invalid input. Expected ${expected}. ${cause.message}`);

const messageFrom = (error: StratumShell.ShellError) =>
  Predicate.isTagged(error, "ResourceNotFound")
    ? `Shell resource ${JSON.stringify(error.id)} does not exist.`
    : error.message;

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bridge = yield* Bridge.Service;
    const shell = yield* StratumShell.Service;

    yield* bridge.register(
      "shell.open",
      Effect.fn("Orogeny.Shell.open")(function* (input) {
        const decoded = yield* pipe(
          decodeOpen(input),
          Effect.mapError((cause) =>
            invalid("ShellOpenError", "Shell.open({ command, cwd?, env? })", cause),
          ),
        );
        return yield* pipe(
          shell.open(new StratumShell.OpenInput(decoded)),
          Effect.mapError((error) => failed("ShellOpenError", messageFrom(error))),
        );
      }),
    );

    yield* bridge.register(
      "shell.list",
      Effect.fn("Orogeny.Shell.list")(function* (input) {
        const decoded = yield* pipe(
          decodeList(input),
          Effect.mapError((cause) =>
            invalid("ShellListError", "Shell.list({ isRunning? })", cause),
          ),
        );
        return yield* pipe(
          shell.list(new StratumShell.ListInput(decoded)),
          Effect.mapError((error) => failed("ShellListError", messageFrom(error))),
        );
      }),
    );

    yield* bridge.register(
      "shell.read",
      Effect.fn("Orogeny.Shell.read")(function* (input) {
        const decoded = yield* pipe(
          decodeRead(input),
          Effect.mapError((cause) =>
            invalid("ShellReadError", "shell.read({ lines?, offset? })", cause),
          ),
        );
        return yield* pipe(
          shell.read(new StratumShell.ReadInput(decoded)),
          Effect.mapError((error) => failed("ShellReadError", messageFrom(error))),
        );
      }),
    );

    yield* bridge.register(
      "shell.write",
      Effect.fn("Orogeny.Shell.write")(function* (input) {
        const decoded = yield* pipe(
          decodeWrite(input),
          Effect.mapError((cause) => invalid("ShellWriteError", "shell.write(text)", cause)),
        );
        return yield* pipe(
          shell.write(decoded.id, decoded.text),
          Effect.mapError((error) => failed("ShellWriteError", messageFrom(error))),
        );
      }),
    );

    yield* bridge.register(
      "shell.sendKeys",
      Effect.fn("Orogeny.Shell.sendKeys")(function* (input) {
        const decoded = yield* pipe(
          decodeSendKeys(input),
          Effect.mapError((cause) =>
            invalid("ShellSendKeysError", "shell.sendKeys(keys)", cause),
          ),
        );
        return yield* pipe(
          shell.sendKeys(decoded.id, decoded.keys),
          Effect.mapError((error) => failed("ShellSendKeysError", messageFrom(error))),
        );
      }),
    );

    yield* bridge.register(
      "shell.info",
      Effect.fn("Orogeny.Shell.info")(function* (input) {
        const decoded = yield* pipe(
          decodeId(input),
          Effect.mapError((cause) => invalid("ShellInfoError", "shell.info()", cause)),
        );
        return yield* pipe(
          shell.info(decoded.id),
          Effect.mapError((error) => failed("ShellInfoError", messageFrom(error))),
        );
      }),
    );

    yield* bridge.register(
      "shell.wait",
      Effect.fn("Orogeny.Shell.wait")(function* (input) {
        const decoded = yield* pipe(
          decodeWait(input),
          Effect.mapError((cause) => invalid("ShellWaitError", "shell.wait(timeout?)", cause)),
        );
        return yield* pipe(
          shell.wait(decoded.id, decoded.timeout),
          Effect.mapError((error) => failed("ShellWaitError", messageFrom(error))),
        );
      }),
    );

    yield* bridge.register(
      "shell.kill",
      Effect.fn("Orogeny.Shell.kill")(function* (input) {
        const decoded = yield* pipe(
          decodeId(input),
          Effect.mapError((cause) => invalid("ShellKillError", "shell.kill()", cause)),
        );
        return yield* pipe(
          shell.kill(decoded.id),
          Effect.mapError((error) => failed("ShellKillError", messageFrom(error))),
        );
      }),
    );
  }),
);

export * as Prelude from "./prelude.ts";
export * as Shell from "./index.ts";
