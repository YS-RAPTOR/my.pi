import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ServerEntry = Readonly<{
  directTools?: boolean | string[];
  lifecycle?: "lazy" | "eager" | "keep-alive" | "lazy-keep-alive";
  protocolVersion?: "legacy" | "auto" | "2026-07-28";
  [key: string]: Json | undefined;
}>;

export type McpServerRegistration = Readonly<{
  dispose(): Promise<void>;
}>;

export function createMcpAdapter(options: {
  config: {
    mcpServers: Record<string, ServerEntry>;
    settings: Record<string, Json>;
  };
}): (pi: ExtensionAPI) => void;

export function registerMcpServer(options: {
  pi: ExtensionAPI;
  name: string;
  definition: ServerEntry;
}): McpServerRegistration;

export function loadMcpConfig(
  overridePath?: string,
  cwd?: string,
): {
  mcpServers: Record<string, ServerEntry>;
  settings?: Record<string, Json>;
};
