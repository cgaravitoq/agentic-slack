export const PRIVATE_RETENTION_DAYS = 7;
export const CHANNEL_RETENTION_DAYS = 15;
export const MODEL = "cloudflare/@cf/zai-org/glm-4.7-flash";
export const CLOUDFLARE_TRACING_CONTENT = false;
export const MAX_SUGGESTED_PROMPTS = 4;

export interface SuggestedPrompt {
  title: string;
  message: string;
}

export interface AgentConfig {
  name: string;
  description: string;
  ownerInstructions: string;
  suggestedPrompts?: readonly SuggestedPrompt[];
  retention?: {
    privateDays?: number;
    channelDays?: number;
  };
  model?: string;
}

export interface ResolvedAgentConfig {
  name: string;
  description: string;
  ownerInstructions: string;
  suggestedPrompts: readonly SuggestedPrompt[];
  retention: {
    privateDays: number;
    channelDays: number;
  };
  model: string;
}

const resolveSuggestedPrompt = (prompt: SuggestedPrompt): SuggestedPrompt => {
  const title = prompt.title.trim();
  const message = prompt.message.trim();
  if (!(title && message)) {
    throw new Error("Agent suggested prompt requires title and message");
  }
  return Object.freeze({ message, title });
};

const resolveRetentionDays = (
  field: string,
  value: number | undefined,
  fallback: number,
): number => {
  const days = value ?? fallback;
  if (!(Number.isInteger(days) && days > 0)) {
    throw new Error(`Agent config requires positive integer ${field}`);
  }
  return days;
};

export const defineAgentConfig = (config: AgentConfig): ResolvedAgentConfig => {
  const model = (config.model ?? MODEL).trim();
  for (const [field, value] of Object.entries({
    description: config.description,
    model,
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
  return Object.freeze({
    description: config.description.trim(),
    model,
    name: config.name.trim(),
    ownerInstructions: config.ownerInstructions.trim(),
    retention: Object.freeze({
      channelDays: resolveRetentionDays(
        "channelDays",
        config.retention?.channelDays,
        CHANNEL_RETENTION_DAYS,
      ),
      privateDays: resolveRetentionDays(
        "privateDays",
        config.retention?.privateDays,
        PRIVATE_RETENTION_DAYS,
      ),
    }),
    suggestedPrompts: Object.freeze(suggestedPrompts),
  });
};
