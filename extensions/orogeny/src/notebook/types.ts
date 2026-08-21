import { Schema, pipe } from "effect";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const NotebookId = pipe(
  Schema.String.check(Schema.isPattern(new RegExp(`^nb_${UUID}$`))),
  Schema.brand("NotebookId"),
);

export type NotebookId = typeof NotebookId.Type;

export const CellId = pipe(
  Schema.String.check(Schema.isPattern(new RegExp(`^cell_${UUID}$`))),
  Schema.brand("CellId"),
);

export type CellId = typeof CellId.Type;
