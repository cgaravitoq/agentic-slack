export {
  CHANNEL_RETENTION_DAYS,
  CLOUDFLARE_TRACING_CONTENT,
  CORE_REPLY_TOOL_NAME,
  defineAgentConfig,
  MODEL,
  PRIVATE_RETENTION_DAYS,
} from "./config.ts";
export type {
  AgentAddon,
  AgentConfig,
  AgentPlugin,
  ExtensionToolFactory,
  ResolvedAgentConfig,
  ResolvedExtension,
} from "./config.ts";
export { claimAndRun, claimEvent, releaseEvent } from "./dedup.ts";
export {
  createReplyTool,
  extractAssistantText,
  MAX_SLACK_MESSAGE_LENGTH,
  sanitizeReply,
  SLACK_DELIVERY_FALLBACK,
} from "./delivery.ts";
export type { SlackDestination } from "./delivery.ts";
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
  RoutedSlackTurn,
  SlackCoreBindings,
  SlackCoreEnv,
  TrustedSlackConfig,
} from "./slack.ts";
