export const PRIVATE_RETENTION_DAYS = 7;
export const CHANNEL_RETENTION_DAYS = 15;
export const MODEL = "cloudflare/@cf/zai-org/glm-4.7-flash";
export const CLOUDFLARE_TRACING_CONTENT = false;

export interface AgentConfig {
  name: string;
  description: string;
  ownerInstructions: string;
  retention?: {
    privateDays?: number;
    channelDays?: number;
  };
}

export interface ResolvedAgentConfig {
  name: string;
  description: string;
  ownerInstructions: string;
  retention: {
    privateDays: number;
    channelDays: number;
  };
}

export function defineAgentConfig(config: AgentConfig): ResolvedAgentConfig {
  for (const [field, value] of Object.entries({
    name: config.name,
    description: config.description,
    ownerInstructions: config.ownerInstructions,
  })) {
    if (!value.trim()) throw new Error(`Agent config requires ${field}`);
  }
  return Object.freeze({
    name: config.name.trim(),
    description: config.description.trim(),
    ownerInstructions: config.ownerInstructions.trim(),
    retention: Object.freeze({
      privateDays: config.retention?.privateDays ?? PRIVATE_RETENTION_DAYS,
      channelDays: config.retention?.channelDays ?? CHANNEL_RETENTION_DAYS,
    }),
  });
}
