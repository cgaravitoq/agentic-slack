import type { ToolDefinition } from "@flue/runtime";

export const PRIVATE_RETENTION_DAYS = 7;
export const CHANNEL_RETENTION_DAYS = 15;
export const MODEL = "cloudflare/@cf/zai-org/glm-4.7-flash";
export const CLOUDFLARE_TRACING_CONTENT = false;
// The retired delivery tool name stays reserved so no extension can pose as
// the delivery boundary the model was taught to trust.
export const RESERVED_TOOL_NAMES: readonly string[] = Object.freeze([
  "reply_in_slack",
]);
export const MAX_SUGGESTED_PROMPTS = 4;

export type ExtensionToolFactory<RuntimeContext> = (
  context: RuntimeContext,
) => readonly ToolDefinition[];

interface ExtensionDefinition<Kind extends "plugin" | "addon", RuntimeContext> {
  readonly id: string;
  readonly kind: Kind;
  readonly instructions?: readonly string[];
  readonly createTools?: ExtensionToolFactory<RuntimeContext>;
}

export type AgentPlugin<RuntimeContext = unknown> = ExtensionDefinition<
  "plugin",
  RuntimeContext
>;
export type AgentAddon<RuntimeContext = unknown> = ExtensionDefinition<
  "addon",
  RuntimeContext
>;

export interface ResolvedExtension<
  Kind extends "plugin" | "addon",
  RuntimeContext,
> {
  readonly id: string;
  readonly kind: Kind;
  readonly instructions: readonly string[];
  readonly createTools?: ExtensionToolFactory<RuntimeContext>;
}

export interface SuggestedPrompt {
  title: string;
  message: string;
}

export interface AgentConfig<RuntimeContext = unknown> {
  name: string;
  description: string;
  ownerInstructions: string;
  suggestedPrompts?: readonly SuggestedPrompt[];
  plugins?: readonly AgentPlugin<RuntimeContext>[];
  addons?: readonly AgentAddon<RuntimeContext>[];
  retention?: {
    privateDays?: number;
    channelDays?: number;
  };
}

export interface ResolvedAgentConfig<RuntimeContext = unknown> {
  name: string;
  description: string;
  ownerInstructions: string;
  suggestedPrompts: readonly SuggestedPrompt[];
  plugins: readonly ResolvedExtension<"plugin", RuntimeContext>[];
  addons: readonly ResolvedExtension<"addon", RuntimeContext>[];
  retention: {
    privateDays: number;
    channelDays: number;
  };
}

const resolveSuggestedPrompt = (prompt: SuggestedPrompt): SuggestedPrompt => {
  const title = prompt.title.trim();
  const message = prompt.message.trim();
  if (!(title && message)) {
    throw new Error("Agent suggested prompt requires title and message");
  }
  return Object.freeze({ message, title });
};

const resolveExtension = <Kind extends "plugin" | "addon", RuntimeContext>(
  extension: ExtensionDefinition<Kind, RuntimeContext>,
): ResolvedExtension<Kind, RuntimeContext> => {
  const id = extension.id.trim();
  if (!id) {
    throw new Error(`Agent ${extension.kind} requires id`);
  }
  const instructions = (extension.instructions ?? []).map((instruction) => {
    const resolved = instruction.trim();
    if (!resolved) {
      throw new Error(`Agent extension ${id} requires non-empty instructions`);
    }
    return resolved;
  });
  return Object.freeze({
    createTools: extension.createTools,
    id,
    instructions: Object.freeze(instructions),
    kind: extension.kind,
  });
};

export const defineAgentConfig = <RuntimeContext>(
  config: AgentConfig<RuntimeContext>,
): ResolvedAgentConfig<RuntimeContext> => {
  for (const [field, value] of Object.entries({
    description: config.description,
    name: config.name,
    ownerInstructions: config.ownerInstructions,
  })) {
    if (!value.trim()) {
      throw new Error(`Agent config requires ${field}`);
    }
  }
  const suggestedPrompts = (config.suggestedPrompts ?? []).map(
    resolveSuggestedPrompt,
  );
  if (suggestedPrompts.length > MAX_SUGGESTED_PROMPTS) {
    throw new Error(
      `Agent config allows at most ${MAX_SUGGESTED_PROMPTS} suggested prompts`,
    );
  }
  const plugins = (config.plugins ?? []).map(resolveExtension);
  const addons = (config.addons ?? []).map(resolveExtension);
  const extensionIds = new Set<string>();
  for (const extension of [...plugins, ...addons]) {
    if (extensionIds.has(extension.id)) {
      throw new Error(`Duplicate agent extension id: ${extension.id}`);
    }
    extensionIds.add(extension.id);
  }
  return Object.freeze({
    addons: Object.freeze(addons),
    description: config.description.trim(),
    name: config.name.trim(),
    ownerInstructions: config.ownerInstructions.trim(),
    plugins: Object.freeze(plugins),
    retention: Object.freeze({
      channelDays: config.retention?.channelDays ?? CHANNEL_RETENTION_DAYS,
      privateDays: config.retention?.privateDays ?? PRIVATE_RETENTION_DAYS,
    }),
    suggestedPrompts: Object.freeze(suggestedPrompts),
  });
};
