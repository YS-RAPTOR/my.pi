import { Predicate } from "effect";

export const messageFrom = (cause: unknown): string =>
  Predicate.hasProperty(cause, "message") &&
  Predicate.isString(cause.message)
    ? cause.message
    : String(cause);
