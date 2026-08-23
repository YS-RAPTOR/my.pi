import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Chunk, Effect, HashMap, Schema } from "effect";
import { Config } from "#o/config";
import { Syntax } from "#o/syntax";
import { PushCode } from "../src/tools/push.ts";

// SAFETY: PushCode and Code read only fg and getColorMode from the Pi theme.
const theme = {
  fg: (_color: string, text: string) => text,
  getColorMode: () => "truecolor" as const,
} as Theme;

test("publishes streaming syntax without reentering the host renderer", async () => {
  const frame = new Syntax.Frame({
    startIndex: 0,
    endIndex: 5,
    highlights: Chunk.of(
      new Syntax.Highlight({ style: 0xfca7ea, startIndex: 0, endIndex: 5 }),
    ),
    needsRender: false,
  });
  const highlighter: Syntax.Highlighter = {
    update: () => Effect.succeed(frame.highlights),
    updateFrame: () => Effect.succeed(frame),
    completeFrame: () =>
      Effect.succeed(
        new Syntax.Frame({
          startIndex: 5,
          endIndex: 5,
          highlights: Chunk.empty(),
          needsRender: false,
        }),
      ),
  };
  const syntax: Syntax.Interface = {
    languages: HashMap.empty(),
    tags: HashMap.empty(),
    highlighter: () => Effect.succeed(highlighter),
    highlight: () => Effect.succeed(Chunk.empty()),
  };
  const code = new PushCode(
    syntax,
    Schema.decodeUnknownSync(Config.schema)({}).syntax.theme,
    theme,
  );
  let invalidations = 0;
  let updating = true;
  let reentered = false;

  code.update({
    theme,
    source: "const",
    expanded: true,
    sealed: false,
    invalidate: () => {
      invalidations++;
      reentered ||= updating;
    },
  });
  updating = false;

  assert.equal(reentered, false);
  await setImmediate();
  assert.equal(invalidations, 1);
});
