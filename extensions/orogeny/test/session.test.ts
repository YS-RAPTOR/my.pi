import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Chunk, Effect, Layer, Option, pipe, Schema } from "effect";
import { Pi } from "@ys-raptor/pi-effect";
import { Config } from "#o/config";
import { Notebook } from "#o/notebook";
import { Session } from "#o/session";

const runtimeLayer = pipe(
  Session.layer,
  Layer.provide(
    Layer.succeed(
      Config.Service,
      Config.Service.of({
        "max-live-notebooks": 5,
        "max-wait-ms": 5 * 60 * 1_000,
        "interrupt-grace-ms": 5_000,
      }),
    ),
  ),
  Layer.provide(Pi.Hooks.Barriers.layer),
  Layer.provide(NodeServices.layer),
);

const decodeEvent = Schema.decodeUnknownSync(Pi.Hooks.Barriers.SessionStartEvent);
const event = (reason: Session.StartEvent["reason"], previousSessionFile?: string) =>
  decodeEvent(
    previousSessionFile === undefined
      ? { type: "session_start", reason }
      : { type: "session_start", reason, previousSessionFile },
  );

const sessionFile = (root: string, name: string) => {
  const file = join(root, `${name}.jsonl`);
  writeFileSync(file, "");
  return file;
};

const sidecar = (file: string) => `${file}.orogeny`;

const run = <A, E>(effect: Effect.Effect<A, E, Session.Service>) =>
  Effect.runPromise(pipe(effect, Effect.provide(runtimeLayer)));

test("persisted sessions place notebooks in their sidecar and reload them closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "orogeny-session-test-"));
  const file = sessionFile(root, "persisted");

  try {
    await run(
      Effect.gen(function* () {
        const session = yield* Session.Service;
        yield* session.start(event("startup"), Option.some(file));
        const notebooks = yield* session.notebook;
        const created = yield* notebooks.create();
        assert.equal(created.artifactPath, join(sidecar(file), created.id));

        yield* session.stop;
        yield* session.start(event("reload"), Option.some(file));
        const restored = yield* (yield* session.notebook).list;
        assert.equal(Chunk.size(restored), 1);
        assert.equal(Chunk.headUnsafe(restored).id, created.id);
        assert.equal(Chunk.headUnsafe(restored).status, "closed");
        assert.equal(Chunk.headUnsafe(restored).current, false);
      }),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("fork and clone snapshots use flattened relative links", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "orogeny-fork-test-"));
  const parentFile = sessionFile(root, "parent");
  const childFile = sessionFile(root, "child");
  const grandchildFile = sessionFile(root, "grandchild");
  const newFile = sessionFile(root, "new");

  try {
    await run(
      Effect.gen(function* () {
        const session = yield* Session.Service;
        yield* session.start(event("startup"), Option.some(parentFile));
        const first = yield* (yield* session.notebook).create();
        const canonical = first.artifactPath;
        yield* session.stop;

        const danglingId = yield* Schema.decodeUnknownEffect(Notebook.NotebookId)(
          `nb_${crypto.randomUUID()}`,
        );
        symlinkSync("missing", join(sidecar(parentFile), danglingId));

        yield* session.start(event("fork", parentFile), Option.some(childFile));
        const inherited = yield* (yield* session.notebook).list;
        assert.deepEqual(Chunk.toReadonlyArray(Chunk.map(inherited, (value) => value.id)), [
          first.id,
        ]);
        const childLink = join(sidecar(childFile), first.id);
        const childTarget = readlinkSync(childLink);
        assert.equal(lstatSync(childLink).isSymbolicLink(), true);
        assert.equal(isAbsolute(childTarget), false);
        assert.equal(resolve(sidecar(childFile), childTarget), canonical);
        assert.equal(Chunk.headUnsafe(inherited).artifactPath, childLink);
        yield* session.stop;

        yield* session.start(event("fork", parentFile), Option.some(childFile));
        assert.equal(Chunk.size(yield* (yield* session.notebook).list), 1);
        yield* session.stop;

        yield* session.start(event("resume"), Option.some(parentFile));
        const second = yield* (yield* session.notebook).create();
        yield* session.stop;

        yield* session.start(event("reload"), Option.some(childFile));
        const snapshot = yield* (yield* session.notebook).list;
        assert.equal(
          Chunk.some(snapshot, (value) => value.id === first.id),
          true,
        );
        assert.equal(
          Chunk.some(snapshot, (value) => value.id === second.id),
          false,
        );
        yield* session.stop;

        yield* session.start(event("fork", childFile), Option.some(grandchildFile));
        const grandchildLink = join(sidecar(grandchildFile), first.id);
        const grandchildTarget = readlinkSync(grandchildLink);
        assert.equal(isAbsolute(grandchildTarget), false);
        assert.equal(resolve(sidecar(grandchildFile), grandchildTarget), canonical);
        yield* session.stop;

        yield* session.start(event("new", parentFile), Option.some(newFile));
        assert.equal(Chunk.isEmpty(yield* (yield* session.notebook).list), true);
      }),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("fork inheritance never overwrites a conflicting child entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "orogeny-conflict-test-"));
  const parentFile = sessionFile(root, "parent");
  const childFile = sessionFile(root, "child");

  try {
    await run(
      Effect.gen(function* () {
        const session = yield* Session.Service;
        yield* session.start(event("startup"), Option.some(parentFile));
        const notebook = yield* (yield* session.notebook).create();
        yield* session.stop;

        const conflict = join(sidecar(childFile), notebook.id);
        mkdirSync(dirname(conflict), { recursive: true });
        writeFileSync(conflict, "conflict");

        yield* Effect.flip(session.start(event("fork", parentFile), Option.some(childFile)));
        assert.equal(lstatSync(conflict).isSymbolicLink(), false);
      }),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("ephemeral session storage is removed when its scope closes", async () => {
  let temporary = "";

  await run(
    Effect.gen(function* () {
      const session = yield* Session.Service;
      yield* session.start(event("startup"), Option.none());
      const notebook = yield* (yield* session.notebook).create();
      temporary = dirname(notebook.artifactPath);
      assert.equal(existsSync(temporary), true);
      yield* session.stop;
      assert.equal(existsSync(temporary), false);
      yield* Effect.flip(session.notebook);
    }),
  );
});
