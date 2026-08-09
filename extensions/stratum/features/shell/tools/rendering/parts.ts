import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Mode, ResultSource } from "./types.ts";

export type StyledText = Readonly<{
  text: string;
  tone?: ThemeColor;
}>;

export const modeFromResourceId = (
  resourceId: string | undefined,
): Mode | undefined => {
  if (resourceId === undefined || resourceId === "") return;
  return resourceId.startsWith("shell:stdio:") ? "stdio" : "pty";
};

export const age = (startedAt: number) => {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s ago`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m ago`;
};

type ProcessDetails = Readonly<{
  phase: "waiting" | "completed" | "yielded";
  remainingSeconds: number;
  durationSeconds: number;
}>;

export const processStatus = <Input, Details extends ProcessDetails>(
  source: ResultSource<Input, Details>,
): StyledText => {
  if (source.isError || source.details === undefined) {
    return { text: "failed", tone: "error" };
  }
  if (source.details.phase === "waiting") {
    return {
      text: `running · yield in ${source.details.remainingSeconds}s`,
      tone: "muted",
    };
  }
  if (source.details.phase === "yielded") {
    return {
      text: `yielded after ${source.details.durationSeconds.toFixed(1)}s · process still running`,
      tone: "warning",
    };
  }
  return {
    text: `completed before yield · took ${source.details.durationSeconds.toFixed(1)}s`,
    tone: "success",
  };
};

type LifecycleDetails = Readonly<{
  lifecycle: "running" | "draining" | "completed" | "failed";
  message?: string;
  exitCode?: number | null;
  signal?: string | null;
}>;

export const lifecycleStatus = <Input, Details extends LifecycleDetails>(
  source: ResultSource<Input, Details>,
): StyledText => {
  if (source.isError || source.details === undefined) {
    return { text: "failed", tone: "error" };
  }
  switch (source.details.lifecycle) {
    case "running":
      return { text: "running", tone: "success" };
    case "draining":
      return { text: "draining", tone: "warning" };
    case "completed":
      return { text: "completed", tone: "success" };
    case "failed":
      return { text: "failed", tone: "error" };
  }
};

export const exitOutcome = <Input, Details extends LifecycleDetails>(
  source: ResultSource<Input, Details>,
): StyledText | undefined => {
  const details = source.details;
  if (details === undefined) return;
  if (details.signal !== undefined && details.signal !== null) {
    return { text: `signal ${details.signal}`, tone: "error" };
  }
  if (details.exitCode === undefined || details.exitCode === null) return;
  return {
    text: `exit ${details.exitCode}`,
    tone: details.exitCode === 0 ? "success" : "error",
  };
};

export const failureMessage = <Input, Details extends LifecycleDetails>(
  source: ResultSource<Input, Details>,
): StyledText | undefined => {
  const message = source.details?.message;
  if (message === undefined) return;
  const lines = message.split("\n");
  const normalized: Array<string> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed !== "") normalized.push(trimmed);
  }
  return {
    text: normalized.join(" "),
    tone: "error",
  };
};
