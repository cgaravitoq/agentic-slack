export { setSuggestedPrompts } from "./assistant.ts";
export {
  CHANNEL_RETENTION_DAYS,
  CLOUDFLARE_TRACING_CONTENT,
  defineAgentConfig,
  MAX_SUGGESTED_PROMPTS,
  MODEL,
  PRIVATE_RETENTION_DAYS,
  RESERVED_TOOL_NAMES,
} from "./config.ts";
export type {
  AgentAddon,
  AgentConfig,
  AgentPlugin,
  ExtensionToolFactory,
  ResolvedAgentConfig,
  ResolvedExtension,
  SuggestedPrompt,
} from "./config.ts";
export { claimAndRun, claimEvent, releaseEvent } from "./dedup.ts";
export {
  createSlackStream,
  createStreamSanitizer,
  MAX_SLACK_APPEND_LENGTH,
  MAX_SLACK_MESSAGE_LENGTH,
  MAX_SLACK_TASK_CHUNK_LENGTH,
  sanitizeReply,
  sanitizeTaskText,
  SLACK_DELIVERY_FALLBACK,
  SLACK_STREAM_FAILURE_NOTICE,
  SLACK_TASK_FALLBACK_TITLE,
  streamTargetFor,
} from "./delivery.ts";
export type {
  SlackStream,
  SlackStreamTarget,
  SlackTaskStatus,
  SlackTaskUpdate,
  StreamSanitizer,
} from "./delivery.ts";
export { generateSlackManifest } from "./manifest.ts";
export {
  composeInstructions,
  composeTools,
  CORE_INSTRUCTIONS,
} from "./prompt.ts";
export {
  expireLatest,
  refreshRetention,
  replaceRetention,
} from "./retention.ts";
export type {
  ConversationLifecycleAgent,
  ConversationSurface,
  ExpiryPayload,
  ExpirySchedule,
} from "./retention.ts";
export {
  createSlackIngress,
  missingReadiness,
  routeSlackEvent,
} from "./slack.ts";
export type {
  RoutedSlackEvent,
  RoutedSlackLifecycle,
  RoutedSlackTurn,
  SlackCoreBindings,
  SlackCoreEnv,
  TrustedSlackConfig,
} from "./slack.ts";
