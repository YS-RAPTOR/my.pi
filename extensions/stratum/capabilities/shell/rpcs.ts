import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { Session } from "#s/common/session";
import {
  CloseStdin,
  CloseStdinUnavailable,
  Inspect,
  List,
  ListSuccess,
  Open,
  OpenFailed,
  OpenSuccess,
  PtyUnavailable,
  ResourceNotFound,
  ResourceSummary,
  Signal,
  SignalFailed,
  Snapshot,
  SnapshotFailed,
  SnapshotUnavailable,
  StdinClosed,
  TerminalSnapshot,
  Write,
} from "./types.ts";

export const OpenRpc = Rpc.make("Shell.Open", {
  payload: Open,
  success: OpenSuccess,
  error: Schema.Union([OpenFailed, PtyUnavailable]),
});

export const SnapshotRpc = Rpc.make("Shell.Snapshot", {
  payload: Snapshot,
  success: TerminalSnapshot,
  error: Schema.Union([ResourceNotFound, SnapshotUnavailable, SnapshotFailed]),
});

export const ListRpc = Rpc.make("Shell.List", {
  payload: List,
  success: ListSuccess,
});

export const InspectRpc = Rpc.make("Shell.Inspect", {
  payload: Inspect,
  success: ResourceSummary,
  error: ResourceNotFound,
});

export const WriteRpc = Rpc.make("Shell.Write", {
  payload: Write,
  success: Schema.Void,
  error: Schema.Union([ResourceNotFound, StdinClosed]),
});

export const CloseStdinRpc = Rpc.make("Shell.CloseStdin", {
  payload: CloseStdin,
  success: Schema.Void,
  error: Schema.Union([ResourceNotFound, CloseStdinUnavailable]),
});

export const SignalRpc = Rpc.make("Shell.Signal", {
  payload: Signal,
  success: Schema.Void,
  error: Schema.Union([ResourceNotFound, SignalFailed]),
});

export const Rpcs = RpcGroup.make(
  OpenRpc,
  SnapshotRpc,
  ListRpc,
  InspectRpc,
  WriteRpc,
  CloseStdinRpc,
  SignalRpc,
).middleware(Session.Middleware);
