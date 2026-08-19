import { Chunk, Data, Option } from "effect";
import { Kernel } from "#o/jupyter/kernel";
import type { CellId, NotebookId } from "#o/notebook/schema";

export type NotebookCloseReason =
  | "manual"
  | "crashed"
  | "startup_failed"
  | "storage_failure"
  | "unresponsive";

export type NotebookStatus = Data.TaggedEnum<{
  idle: {
    readonly updatedAt: string;
  };
  busy: {
    readonly activeCellId: CellId;
    readonly updatedAt: string;
  };
  closed: {
    readonly reason: NotebookCloseReason;
    readonly updatedAt: string;
  };
}>;

export const NotebookStatus = Data.taggedEnum<NotebookStatus>();

export type CellStatus = Data.TaggedEnum<{
  running: {
    readonly startedAt: string;
  };
  succeeded: {
    readonly completedAt: string;
  };
  failed: {
    readonly completedAt: string;
    readonly message: Option.Option<string>;
  };
  interrupted: {
    readonly completedAt: string;
  };
}>;

export const CellStatus = Data.taggedEnum<CellStatus>();

export class CreateInput extends Data.Class<{
  readonly name: Option.Option<string>;
}> {
  static unnamed = new CreateInput({ name: Option.none() });
}

export class StartInput extends Data.Class<{
  readonly code: string;
  readonly notebookId: Option.Option<NotebookId>;
}> {}

export class WaitInput extends Data.Class<{
  readonly cellId: CellId;
  readonly timeoutMillis: number;
}> {}

export class NotebookSummary extends Data.Class<{
  readonly id: NotebookId;
  readonly name: Option.Option<string>;
  readonly status: "idle" | "busy" | "closed";
  readonly current: boolean;
  readonly artifactPath: string;
  readonly activeCellId: Option.Option<CellId>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closeReason: Option.Option<NotebookCloseReason>;
}> {}

export class CellSnapshot extends Data.Class<{
  readonly id: CellId;
  readonly notebookId: NotebookId;
  readonly status: "running" | "succeeded" | "failed" | "interrupted";
  readonly outputs: Chunk.Chunk<Kernel.Output>;
  readonly startedAt: string;
  readonly completedAt: Option.Option<string>;
  readonly message: Option.Option<string>;
}> {}

export * as Model from "./model.ts";
