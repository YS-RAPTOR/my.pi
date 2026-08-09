import { Type, type Static } from "typebox";
import type { Entry } from "../types.ts";

export const entryDetailsSchema = Type.Object({
  intervalSeconds: Type.Integer({ minimum: 1 }),
  instruction: Type.String({ minLength: 1 }),
  startedAt: Type.Number(),
  nextRunAt: Type.Number(),
  lastRunAt: Type.Union([Type.Number(), Type.Null()]),
  expiresAt: Type.Union([Type.Number(), Type.Null()]),
});

export type EntryDetails = Static<typeof entryDetailsSchema>;

export const detailsFromEntry = (entry: Entry): EntryDetails => ({
  intervalSeconds: entry.intervalSeconds,
  instruction: entry.instruction,
  startedAt: entry.startedAt,
  nextRunAt: entry.nextRunAt,
  lastRunAt: entry.lastRunAt,
  expiresAt: entry.expiresAt,
});

export const modelContent = (entry: EntryDetails) =>
  [
    "Heartbeat active.",
    `Instruction: ${entry.instruction}`,
    `Interval: ${entry.intervalSeconds} seconds`,
    `Started at: ${new Date(entry.startedAt).toISOString()}`,
    `Next run at: ${new Date(entry.nextRunAt).toISOString()}`,
    `Last run at: ${entry.lastRunAt === null ? "never" : new Date(entry.lastRunAt).toISOString()}`,
    `Expires at: ${entry.expiresAt === null ? "never" : new Date(entry.expiresAt).toISOString()}`,
  ].join("\n");

const duration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

export const elapsed = (timestamp: number) =>
  `${duration(Date.now() - timestamp)} ago`;

export const remaining = (timestamp: number) =>
  `in ${duration(timestamp - Date.now())}`;

export const nextRun = (entry: EntryDetails) => {
  const seconds = Math.max(
    0,
    Math.ceil((entry.nextRunAt - Date.now()) / 1_000),
  );
  return `next in ${seconds}s`;
};
