import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { Session } from "#s/common/session";
import { Entry, Start } from "./types.ts";

export const StartPayload = Start.mapFields((fields) => ({
  interval_seconds: fields.interval_seconds,
  instruction: fields.instruction,
  expires_at: fields.expires_at,
}));

export const StartRpc = Rpc.make("Heartbeat.Start", {
  payload: StartPayload,
  success: Entry,
});

export const GetRpc = Rpc.make("Heartbeat.Get", {
  success: Schema.NullOr(Entry),
});

export const StopRpc = Rpc.make("Heartbeat.Stop", {
  success: Schema.Void,
});

export const Rpcs = RpcGroup.make(StartRpc, GetRpc, StopRpc).middleware(
  Session.Middleware,
);
