import { Schema } from "effect";

const AgentMessage = Schema.Unknown;
const BranchEntry = Schema.Unknown;
const CompactionPreparation = Schema.Unknown;
const ImageContent = Schema.Unknown;
const SourceInfo = Schema.Struct({
  path: Schema.String,
  source: Schema.String,
  scope: Schema.Literals(["user", "project", "temporary"]),
  origin: Schema.Literals(["package", "top-level"]),
  baseDir: Schema.optionalKey(Schema.String),
});
const Skill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  filePath: Schema.String,
  baseDir: Schema.String,
  sourceInfo: SourceInfo,
  disableModelInvocation: Schema.Boolean,
});
const SystemPromptOptions = Schema.Struct({
  customPrompt: Schema.optionalKey(Schema.String),
  selectedTools: Schema.optionalKey(Schema.Array(Schema.String)),
  toolSnippets: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  promptGuidelines: Schema.optionalKey(Schema.Array(Schema.String)),
  appendSystemPrompt: Schema.optionalKey(Schema.String),
  cwd: Schema.String,
  contextFiles: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        content: Schema.String,
      }),
    ),
  ),
  skills: Schema.optionalKey(Schema.Array(Skill)),
});
const TreePreparation = Schema.Unknown;
const Usage = Schema.Unknown;

export class ProjectTrustEvent extends Schema.Opaque<ProjectTrustEvent>()(
  Schema.Struct({
    type: Schema.Literal("project_trust"),
    cwd: Schema.String,
  }),
) {}

export class ResourcesDiscoverEvent extends Schema.Opaque<ResourcesDiscoverEvent>()(
  Schema.Struct({
    type: Schema.Literal("resources_discover"),
    cwd: Schema.String,
    reason: Schema.Literals(["startup", "reload"]),
  }),
) {}

export class SessionBeforeSwitchEvent extends Schema.Opaque<SessionBeforeSwitchEvent>()(
  Schema.Struct({
    type: Schema.Literal("session_before_switch"),
    reason: Schema.Literals(["new", "resume"]),
    targetSessionFile: Schema.optionalKey(Schema.String),
  }),
) {}

export class SessionBeforeForkEvent extends Schema.Opaque<SessionBeforeForkEvent>()(
  Schema.Struct({
    type: Schema.Literal("session_before_fork"),
    entryId: Schema.String,
    position: Schema.Literals(["before", "at"]),
  }),
) {}

export class SessionBeforeCompactEvent extends Schema.Opaque<SessionBeforeCompactEvent>()(
  Schema.Struct({
    type: Schema.Literal("session_before_compact"),
    preparation: CompactionPreparation,
    branchEntries: Schema.Array(BranchEntry),
    customInstructions: Schema.optionalKey(Schema.String),
    reason: Schema.Literals(["manual", "threshold", "overflow"]),
    willRetry: Schema.Boolean,
    signal: Schema.Unknown,
  }),
) {}

export class SessionBeforeTreeEvent extends Schema.Opaque<SessionBeforeTreeEvent>()(
  Schema.Struct({
    type: Schema.Literal("session_before_tree"),
    preparation: TreePreparation,
    signal: Schema.Unknown,
  }),
) {}

export class ContextEvent extends Schema.Opaque<ContextEvent>()(
  Schema.Struct({
    type: Schema.Literal("context"),
    messages: Schema.Array(AgentMessage),
  }),
) {}

export class BeforeProviderRequestEvent extends Schema.Opaque<BeforeProviderRequestEvent>()(
  Schema.Struct({
    type: Schema.Literal("before_provider_request"),
    payload: Schema.Unknown,
  }),
) {}

export class BeforeProviderHeadersEvent extends Schema.Opaque<BeforeProviderHeadersEvent>()(
  Schema.Struct({
    type: Schema.Literal("before_provider_headers"),
    headers: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Null]),
    ),
  }),
) {}

export class BeforeAgentStartEvent extends Schema.Opaque<BeforeAgentStartEvent>()(
  Schema.Struct({
    type: Schema.Literal("before_agent_start"),
    prompt: Schema.String,
    images: Schema.optionalKey(Schema.Array(ImageContent)),
    systemPrompt: Schema.String,
    systemPromptOptions: SystemPromptOptions,
  }),
) {}

export class MessageEndEvent extends Schema.Opaque<MessageEndEvent>()(
  Schema.Struct({
    type: Schema.Literal("message_end"),
    message: AgentMessage,
  }),
) {}

export class ToolCallEvent extends Schema.Opaque<ToolCallEvent>()(
  Schema.Struct({
    type: Schema.Literal("tool_call"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    input: Schema.Record(Schema.String, Schema.Unknown),
  }),
) {}

export class ToolResultEvent extends Schema.Opaque<ToolResultEvent>()(
  Schema.Struct({
    type: Schema.Literal("tool_result"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    input: Schema.Record(Schema.String, Schema.Unknown),
    content: Schema.Array(Schema.Unknown),
    details: Schema.Unknown,
    isError: Schema.Boolean,
    usage: Schema.optionalKey(Usage),
  }),
) {}

export class UserBashEvent extends Schema.Opaque<UserBashEvent>()(
  Schema.Struct({
    type: Schema.Literal("user_bash"),
    command: Schema.String,
    excludeFromContext: Schema.Boolean,
    cwd: Schema.String,
  }),
) {}

export class InputEvent extends Schema.Opaque<InputEvent>()(
  Schema.Struct({
    type: Schema.Literal("input"),
    text: Schema.String,
    images: Schema.optionalKey(Schema.Array(ImageContent)),
    source: Schema.Literals(["interactive", "rpc", "extension"]),
    streamingBehavior: Schema.optionalKey(
      Schema.Literals(["steer", "followUp"]),
    ),
  }),
) {}

export class ProjectTrustEventResult extends Schema.Opaque<ProjectTrustEventResult>()(
  Schema.Struct({
    trusted: Schema.Literals(["yes", "no", "undecided"]),
    remember: Schema.optionalKey(Schema.Boolean),
  }),
) {}

export class ResourcesDiscoverResult extends Schema.Opaque<ResourcesDiscoverResult>()(
  Schema.Struct({
    skillPaths: Schema.optionalKey(Schema.Array(Schema.String)),
    promptPaths: Schema.optionalKey(Schema.Array(Schema.String)),
    themePaths: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
) {}

export class SessionBeforeSwitchResult extends Schema.Opaque<SessionBeforeSwitchResult>()(
  Schema.Struct({
    cancel: Schema.optionalKey(Schema.Boolean),
  }),
) {}

export class SessionBeforeForkResult extends Schema.Opaque<SessionBeforeForkResult>()(
  Schema.Struct({
    cancel: Schema.optionalKey(Schema.Boolean),
    skipConversationRestore: Schema.optionalKey(Schema.Boolean),
  }),
) {}

export class SessionBeforeCompactResult extends Schema.Opaque<SessionBeforeCompactResult>()(
  Schema.Struct({
    cancel: Schema.optionalKey(Schema.Boolean),
    compaction: Schema.optionalKey(Schema.Unknown),
  }),
) {}

export class SessionBeforeTreeResult extends Schema.Opaque<SessionBeforeTreeResult>()(
  Schema.Struct({
    cancel: Schema.optionalKey(Schema.Boolean),
    summary: Schema.optionalKey(
      Schema.Struct({
        summary: Schema.String,
        details: Schema.optionalKey(Schema.Unknown),
        usage: Schema.optionalKey(Usage),
      }),
    ),
    customInstructions: Schema.optionalKey(Schema.String),
    replaceInstructions: Schema.optionalKey(Schema.Boolean),
    label: Schema.optionalKey(Schema.String),
  }),
) {}

export class ContextEventResult extends Schema.Opaque<ContextEventResult>()(
  Schema.Struct({
    messages: Schema.optionalKey(Schema.Array(AgentMessage)),
  }),
) {}

export class BeforeProviderRequestEventResult extends Schema.Opaque<BeforeProviderRequestEventResult>()(
  Schema.Unknown,
) {}

export class BeforeAgentStartEventResult extends Schema.Opaque<BeforeAgentStartEventResult>()(
  Schema.Struct({
    message: Schema.optionalKey(Schema.Unknown),
    systemPrompt: Schema.optionalKey(Schema.String),
  }),
) {}

export class MessageEndEventResult extends Schema.Opaque<MessageEndEventResult>()(
  Schema.Struct({
    message: Schema.optionalKey(AgentMessage),
  }),
) {}

export class ToolCallEventResult extends Schema.Opaque<ToolCallEventResult>()(
  Schema.Struct({
    block: Schema.optionalKey(Schema.Boolean),
    reason: Schema.optionalKey(Schema.String),
  }),
) {}

export class ToolResultEventResult extends Schema.Opaque<ToolResultEventResult>()(
  Schema.Struct({
    content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    details: Schema.optionalKey(Schema.Unknown),
    isError: Schema.optionalKey(Schema.Boolean),
    usage: Schema.optionalKey(Usage),
  }),
) {}

export class UserBashEventResult extends Schema.Opaque<UserBashEventResult>()(
  Schema.Struct({
    operations: Schema.optionalKey(Schema.Unknown),
    result: Schema.optionalKey(Schema.Unknown),
  }),
) {}

class InputContinueResult extends Schema.Opaque<InputContinueResult>()(
  Schema.Struct({ action: Schema.Literal("continue") }),
) {}

class InputTransformResult extends Schema.Opaque<InputTransformResult>()(
  Schema.Struct({
    action: Schema.Literal("transform"),
    text: Schema.String,
    images: Schema.optionalKey(Schema.Array(ImageContent)),
  }),
) {}

class InputHandledResult extends Schema.Opaque<InputHandledResult>()(
  Schema.Struct({ action: Schema.Literal("handled") }),
) {}

export const InputEventResult = Schema.Union([
  InputContinueResult,
  InputTransformResult,
  InputHandledResult,
]);

export const Interceptor = Schema.Union([
  ProjectTrustEvent,
  ResourcesDiscoverEvent,
  SessionBeforeSwitchEvent,
  SessionBeforeForkEvent,
  SessionBeforeCompactEvent,
  SessionBeforeTreeEvent,
  ContextEvent,
  BeforeProviderRequestEvent,
  BeforeProviderHeadersEvent,
  BeforeAgentStartEvent,
  MessageEndEvent,
  ToolCallEvent,
  ToolResultEvent,
  UserBashEvent,
  InputEvent,
]);

export const ResultByType = {
  project_trust: ProjectTrustEventResult,
  resources_discover: ResourcesDiscoverResult,
  session_before_switch: SessionBeforeSwitchResult,
  session_before_fork: SessionBeforeForkResult,
  session_before_compact: SessionBeforeCompactResult,
  session_before_tree: SessionBeforeTreeResult,
  context: ContextEventResult,
  before_provider_request: BeforeProviderRequestEventResult,
  before_provider_headers: Schema.Void,
  before_agent_start: BeforeAgentStartEventResult,
  message_end: MessageEndEventResult,
  tool_call: ToolCallEventResult,
  tool_result: ToolResultEventResult,
  user_bash: UserBashEventResult,
  input: InputEventResult,
} as const satisfies Record<(typeof Interceptor.Type)["type"], Schema.Top>;
