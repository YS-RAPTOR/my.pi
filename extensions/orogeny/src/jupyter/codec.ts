import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Chunk, Data, Effect, pipe, Schema } from "effect";
import { messageFrom } from "#o/error";
import {
  JupyterEnvelopeFrames,
  JupyterHeader,
  JupyterMessage,
  type JupyterRequestContent,
} from "#o/jupyter/schema";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const delimiter = encoder.encode("<IDS|MSG>");
const PROTOCOL_VERSION = "5.3";
const USERNAME = "orogeny";

const HeaderJson = Schema.fromJsonString(JupyterHeader);
const JsonFrame = Schema.fromJsonString(Schema.Json);
const decodeEnvelopeFrames = Schema.decodeUnknownEffect(JupyterEnvelopeFrames);
const decodeHeader = Schema.decodeUnknownEffect(HeaderJson);
const decodeJson = Schema.decodeUnknownEffect(JsonFrame);
const encodeHeader = Schema.encodeEffect(HeaderJson);
const encodeJson = Schema.encodeEffect(JsonFrame);

export class RequestInput extends Data.Class<{
  readonly type: string;
  readonly content: JupyterRequestContent;
  readonly session: string;
}> {}

export class DecodeFailed extends Data.TaggedError("JupyterCodecFailed")<{
  readonly operation: string;
  readonly message: string;
}> {}

class SignedFrames extends Data.Class<{
  readonly header: Uint8Array;
  readonly parentHeader: Uint8Array;
  readonly metadata: Uint8Array;
  readonly content: Uint8Array;
}> {}

class ParsedEnvelope extends Data.Class<{
  readonly identities: Chunk.Chunk<Uint8Array>;
  readonly signature: Uint8Array;
  readonly signed: SignedFrames;
  readonly buffers: Chunk.Chunk<Uint8Array>;
}> {}

const mapFailure =
  (operation: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, DecodeFailed, R> =>
    self.pipe(
      Effect.mapError(
        (cause) => new DecodeFailed({ operation, message: messageFrom(cause) }),
      ),
    );

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && timingSafeEqual(left, right);

const toSignedChunk = (frames: SignedFrames): Chunk.Chunk<Uint8Array> =>
  Chunk.make(
    frames.header,
    frames.parentHeader,
    frames.metadata,
    frames.content,
  );

const signature = (parts: Iterable<Uint8Array>, key: string): Uint8Array => {
  const hmac = createHmac("sha256", key);
  for (const part of parts) hmac.update(part);
  return encoder.encode(hmac.digest("hex"));
};

const parseEnvelope = Effect.fn("Jupyter.Codec.__parseEnvelope")(function* (
  frames: Chunk.Chunk<Uint8Array>,
) {
  const [identities, envelope] = Chunk.splitWhere(frames, (frame) =>
    bytesEqual(frame, delimiter),
  );
  if (Chunk.isEmpty(envelope)) {
    return yield* new DecodeFailed({
      operation: "decode Jupyter envelope",
      message: "The message delimiter is missing",
    });
  }

  const values = yield* decodeEnvelopeFrames(
    Chunk.toReadonlyArray(Chunk.drop(envelope, 1)),
  ).pipe(mapFailure("decode Jupyter envelope"));
  const [supplied, header, parentHeader, metadata, content, ...buffers] =
    values;
  return new ParsedEnvelope({
    identities,
    signature: supplied,
    signed: new SignedFrames({ header, parentHeader, metadata, content }),
    buffers: Chunk.fromIterable(buffers),
  });
});

const verifyEnvelope = Effect.fn("Jupyter.Codec.__verifyEnvelope")(function* (
  envelope: ParsedEnvelope,
  key: string,
) {
  const expected = signature(toSignedChunk(envelope.signed), key);
  if (bytesEqual(envelope.signature, expected)) return;
  return yield* new DecodeFailed({
    operation: "verify Jupyter message",
    message: "The message signature is invalid",
  });
});

export const createRequest = Effect.fn("Jupyter.Codec.createRequest")(
  function* (input: RequestInput) {
    return yield* Schema.decodeUnknownEffect(JupyterMessage)({
      identities: [],
      header: {
        msg_id: randomUUID(),
        session: input.session,
        username: USERNAME,
        date: new Date().toISOString(),
        msg_type: input.type,
        version: PROTOCOL_VERSION,
      },
      parentHeader: {},
      metadata: {},
      content: input.content,
      buffers: [],
    }).pipe(mapFailure("validate outgoing Jupyter message"));
  },
);

export const encode = Effect.fn("Jupyter.Codec.encode")(function* (
  message: JupyterMessage,
  key: string,
) {
  const signed = new SignedFrames({
    header: encoder.encode(
      yield* encodeHeader(message.header).pipe(
        mapFailure("encode Jupyter header"),
      ),
    ),
    parentHeader: encoder.encode(
      yield* encodeJson(message.parentHeader).pipe(
        mapFailure("encode Jupyter parent header"),
      ),
    ),
    metadata: encoder.encode(
      yield* encodeJson(message.metadata).pipe(
        mapFailure("encode Jupyter metadata"),
      ),
    ),
    content: encoder.encode(
      yield* encodeJson(message.content).pipe(
        mapFailure("encode Jupyter content"),
      ),
    ),
  });
  const parts = toSignedChunk(signed);
  return pipe(
    Chunk.fromIterable<Uint8Array>(message.identities),
    Chunk.append(delimiter),
    Chunk.append(signature(parts, key)),
    Chunk.appendAll(parts),
    Chunk.appendAll(Chunk.fromIterable(message.buffers)),
  );
});

export const decode = Effect.fn("Jupyter.Codec.decode")(function* (
  frames: Chunk.Chunk<Uint8Array>,
  key: string,
) {
  const envelope = yield* parseEnvelope(frames);
  yield* verifyEnvelope(envelope, key);

  const value = {
    identities: Chunk.toReadonlyArray(envelope.identities),
    header: yield* decodeHeader(decoder.decode(envelope.signed.header)).pipe(
      mapFailure("decode Jupyter header"),
    ),
    parentHeader: yield* decodeJson(
      decoder.decode(envelope.signed.parentHeader),
    ).pipe(mapFailure("decode Jupyter parent header")),
    metadata: yield* decodeJson(decoder.decode(envelope.signed.metadata)).pipe(
      mapFailure("decode Jupyter metadata"),
    ),
    content: yield* decodeJson(decoder.decode(envelope.signed.content)).pipe(
      mapFailure("decode Jupyter content"),
    ),
    buffers: Chunk.toReadonlyArray(envelope.buffers),
  };
  return yield* Schema.decodeUnknownEffect(JupyterMessage)(value).pipe(
    mapFailure("validate incoming Jupyter message"),
  );
});

export * as Codec from "./codec.ts";
