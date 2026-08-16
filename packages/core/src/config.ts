import type { ToolDefinition } from "@flue/runtime";

export const PRIVATE_RETENTION_DAYS = 7;
export const CHANNEL_RETENTION_DAYS = 15;
export const MODEL = "cloudflare/@cf/zai-org/glm-4.7-flash";
export const CLOUDFLARE_TRACING_CONTENT = false;
export const CORE_REPLY_TOOL_NAME = "reply_in_slack";

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

export interface AgentConfig<RuntimeContext = unknown> {
  name: string;
  description: string;
  ownerInstructions: string;
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
  plugins: readonly ResolvedExtension<"plugin", RuntimeContext>[];
  addons: readonly ResolvedExtension<"addon", RuntimeContext>[];
  retention: {
    privateDays: number;
    channelDays: number;
  };
}

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
  });
};
