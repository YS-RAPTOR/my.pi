import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { Session } from "#s/common/session";
import { Activate, Claim, Release, Snapshot } from "./types.ts";

export const ActivatePayload = Activate.mapFields((fields) => ({
  id: fields.id,
  reason: fields.reason,
}));

export const ReleasePayload = Release.mapFields((fields) => ({
  id: fields.id,
}));

export const ActivateRpc = Rpc.make("Activity.Activate", {
  payload: ActivatePayload,
  success: Claim,
});

export const ReleaseRpc = Rpc.make("Activity.Release", {
  payload: ReleasePayload,
  success: Schema.Void,
});

export const ReleaseOwnerRpc = Rpc.make("Activity.ReleaseOwner", {
  success: Schema.Void,
});

export const SnapshotRpc = Rpc.make("Activity.Snapshot", {
  success: Snapshot,
});

export const Rpcs = RpcGroup.make(
  ActivateRpc,
  ReleaseRpc,
  ReleaseOwnerRpc,
  SnapshotRpc,
).middleware(Session.Middleware);
