import { Schema } from "effect";

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const NotebookId = Schema.String.check(
  Schema.isPattern(new RegExp(`^nb_${UUID_PATTERN}$`)),
).pipe(Schema.brand("NotebookId"));
export type NotebookId = typeof NotebookId.Type;

export const CellId = Schema.String.check(
  Schema.isPattern(new RegExp(`^cell_${UUID_PATTERN}$`)),
).pipe(Schema.brand("CellId"));
export type CellId = typeof CellId.Type;
