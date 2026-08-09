import { Layer } from "effect";
import * as CloseStdin from "./close-stdin.ts";
import * as Inspect from "./inspect.ts";
import * as List from "./list.ts";
import * as Open from "./open.ts";
import * as Signal from "./signal.ts";
import * as Snapshot from "./snapshot.ts";
import * as Wait from "./wait.ts";
import * as Write from "./write.ts";

export const layer = Layer.mergeAll(
  CloseStdin.layer,
  Inspect.layer,
  List.layer,
  Open.layer,
  Signal.layer,
  Snapshot.layer,
  Wait.layer,
  Write.layer,
);

export { CloseStdin, Inspect, List, Open, Signal, Snapshot, Wait, Write };
export * as Tools from "./index.ts";
