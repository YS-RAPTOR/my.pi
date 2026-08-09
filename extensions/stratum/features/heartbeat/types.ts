import { Data } from "effect";

export class Start extends Data.Class<{
  readonly intervalSeconds: number;
  readonly instruction: string;
  readonly expiresAt: number | null;
}> {}

export class Entry extends Data.Class<{
  readonly intervalSeconds: number;
  readonly instruction: string;
  readonly startedAt: number;
  readonly nextRunAt: number;
  readonly lastRunAt: number | null;
  readonly expiresAt: number | null;
}> {}
