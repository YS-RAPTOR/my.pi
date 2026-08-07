export type Options = Readonly<{
  socketPath: string;
  clientToken: string;
}>;

export * as Connection from "./connection.ts";
