import { Data } from "effect";

export class Acquire extends Data.Class<{
  readonly id: string;
  readonly reason: string;
}> {}

export class Release extends Data.Class<{
  readonly id: string;
}> {}
