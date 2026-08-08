import { Schema } from "effect";

const AgentMessage = Schema.Unknown;
const AssistantMessageEvent = Schema.Unknown;
const BranchSummaryEntry = Schema.Unknown;
const CompactionEntry = Schema.Unknown;
const Model = Schema.Unknown;
const ToolResultMessage = Schema.Unknown;

export class SessionInfoChangedEvent extends Schema.Opaque<SessionInfoChangedEvent>()(
  Schema.Struct({
    type: Schema.Literal("session_info_changed"),
    name: Schema.UndefinedOr(Schema.String),
  }),
) {}

export class SessionCompactEvent extends Schema.Opaque<SessionCompactEvent>()(
  Schema.Struct({
    type: Schema.Literal("session_compact"),
    compactionEntry: CompactionEntry,
    fromExtension: Schema.Boolean,
    reason: Schema.Literals(["manual", "threshold", "overflow"]),
    willRetry: Schema.Boolean,
  }),
) {}

export class SessionTreeEvent extends Schema.Opaque<SessionTreeEvent>()(
  Schema.Struct({
    type: Schema.Literal("session_tree"),
    newLeafId: Schema.NullOr(Schema.String),
    oldLeafId: Schema.NullOr(Schema.String),
    summaryEntry: Schema.optionalKey(BranchSummaryEntry),
    fromExtension: Schema.optionalKey(Schema.Boolean),
  }),
) {}

export class AgentStartEvent extends Schema.Opaque<AgentStartEvent>()(
  Schema.Struct({
    type: Schema.Literal("agent_start"),
  }),
) {}

export class AgentEndEvent extends Schema.Opaque<AgentEndEvent>()(
  Schema.Struct({
    type: Schema.Literal("agent_end"),
    messages: Schema.Array(AgentMessage),
  }),
) {}

export class AgentSettledEvent extends Schema.Opaque<AgentSettledEvent>()(
  Schema.Struct({
    type: Schema.Literal("agent_settled"),
  }),
) {}

export class TurnStartEvent extends Schema.Opaque<TurnStartEvent>()(
  Schema.Struct({
    type: Schema.Literal("turn_start"),
    turnIndex: Schema.Finite,
    timestamp: Schema.Finite,
  }),
) {}

export class TurnEndEvent extends Schema.Opaque<TurnEndEvent>()(
  Schema.Struct({
    type: Schema.Literal("turn_end"),
    turnIndex: Schema.Finite,
    message: AgentMessage,
    toolResults: Schema.Array(ToolResultMessage),
  }),
) {}

export class MessageStartEvent extends Schema.Opaque<MessageStartEvent>()(
  Schema.Struct({
    type: Schema.Literal("message_start"),
    message: AgentMessage,
  }),
) {}

export class MessageUpdateEvent extends Schema.Opaque<MessageUpdateEvent>()(
  Schema.Struct({
    type: Schema.Literal("message_update"),
    message: AgentMessage,
    assistantMessageEvent: AssistantMessageEvent,
  }),
) {}

export class ToolExecutionStartEvent extends Schema.Opaque<ToolExecutionStartEvent>()(
  Schema.Struct({
    type: Schema.Literal("tool_execution_start"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
  }),
) {}

export class ToolExecutionUpdateEvent extends Schema.Opaque<ToolExecutionUpdateEvent>()(
  Schema.Struct({
    type: Schema.Literal("tool_execution_update"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
    partialResult: Schema.Unknown,
  }),
) {}

export class ToolExecutionEndEvent extends Schema.Opaque<ToolExecutionEndEvent>()(
  Schema.Struct({
    type: Schema.Literal("tool_execution_end"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    result: Schema.Unknown,
    isError: Schema.Boolean,
  }),
) {}

export class ModelSelectEvent extends Schema.Opaque<ModelSelectEvent>()(
  Schema.Struct({
    type: Schema.Literal("model_select"),
    model: Model,
    previousModel: Schema.UndefinedOr(Model),
    source: Schema.Literals(["set", "cycle", "restore"]),
  }),
) {}

const ThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export class ThinkingLevelSelectEvent extends Schema.Opaque<ThinkingLevelSelectEvent>()(
  Schema.Struct({
    type: Schema.Literal("thinking_level_select"),
    level: ThinkingLevel,
    previousLevel: ThinkingLevel,
  }),
) {}

export const Notification = Schema.Union([
  SessionInfoChangedEvent,
  SessionCompactEvent,
  SessionTreeEvent,
  AgentStartEvent,
  AgentEndEvent,
  AgentSettledEvent,
  TurnStartEvent,
  TurnEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  ToolExecutionEndEvent,
  ModelSelectEvent,
  ThinkingLevelSelectEvent,
]);
