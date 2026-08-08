import { Schema } from "effect";

export class Owner extends Schema.brand("Stratum.Owner")(
  Schema.TemplateLiteral([
    Schema.NonEmptyString,
    ":",
    Schema.NonEmptyString,
  ]),
) {}
