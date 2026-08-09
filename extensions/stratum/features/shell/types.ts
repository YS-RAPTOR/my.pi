import { Data } from "effect";

export class ResourceId extends Data.Class<{
  readonly value: string;
}> {}

export type Lifecycle = Data.TaggedEnum<{
  running: {};
  draining: {
    readonly exitCode: number | null;
    readonly signal: string | null;
  };
  completed: {
    readonly exitCode: number | null;
    readonly signal: string | null;
  };
  failed: {
    readonly message: string;
  };
}>;

export const Lifecycle = Data.taggedEnum<Lifecycle>();

export class ResourceSummary extends Data.Class<{
  readonly resourceId: ResourceId;
  readonly cmd: string;
  readonly cwd: string;
  readonly workspace?: string;
  readonly lifecycle: Lifecycle;
  readonly outputFile?: string;
  readonly startedAt: number;
}> {}

export class ResourceNotFound extends Data.TaggedError("ResourceNotFound")<{
  readonly resourceId: ResourceId;
}> {}

export class Open extends Data.Class<{
  readonly cmd: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | null>>;
  readonly pty?: boolean;
}> {}

export class Opened extends Data.Class<{
  readonly resourceId: ResourceId;
  readonly outputFile?: string;
}> {}

export class OpenFailed extends Data.TaggedError("OpenFailed")<{
  readonly message: string;
}> {}

export class PtyUnavailable extends Data.TaggedError("PtyUnavailable")<{
  readonly message: string;
}> {}

export class TerminalSnapshot extends Data.Class<{
  readonly resourceId: ResourceId;
  readonly text: string;
  readonly revision: number;
  readonly truncated: boolean;
  readonly lifecycle: Lifecycle;
}> {}

export class SnapshotUnavailable extends Data.TaggedError(
  "SnapshotUnavailable",
)<{
  readonly resourceId: ResourceId;
}> {}

export class SnapshotFailed extends Data.TaggedError("SnapshotFailed")<{
  readonly resourceId: ResourceId;
  readonly message: string;
}> {}

export class StdinClosed extends Data.TaggedError("StdinClosed")<{
  readonly resourceId: ResourceId;
}> {}

export class CloseStdinUnavailable extends Data.TaggedError(
  "CloseStdinUnavailable",
)<{
  readonly resourceId: ResourceId;
}> {}

export class SignalFailed extends Data.TaggedError("SignalFailed")<{
  readonly resourceId: ResourceId;
  readonly message: string;
}> {}
