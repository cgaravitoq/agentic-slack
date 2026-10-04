import type { Skill } from "@flue/runtime";

export const PRIVATE_RETENTION_DAYS = 7;
export const CHANNEL_RETENTION_DAYS = 15;
export const MODEL = "cloudflare/@cf/zai-org/glm-4.7-flash";
export const CLOUDFLARE_TRACING_CONTENT = false;
export const MAX_SUGGESTED_PROMPTS = 4;

export interface SuggestedPrompt {
  title: string;
  message: string;
}

interface McpServerConfig {
  name: string;
  url: string;
  authSecret?: string;
  tools?: string[];
  optional?: boolean;
  requireApproval?: readonly string[];
}

export interface AgentConfig {
  name: string;
  description: string;
  ownerInstructions: string;
  allowedUserIds?: readonly string[];
  suggestedPrompts?: readonly SuggestedPrompt[];
  retention?: {
    privateDays?: number;
    channelDays?: number;
  };
  model?: string;
  mcpServers?: readonly McpServerConfig[];
  skills?: readonly Skill[];
}

export interface ResolvedAgentConfig {
  name: string;
  description: string;
  ownerInstructions: string;
  allowedUserIds: readonly string[];
  suggestedPrompts: readonly SuggestedPrompt[];
  retention: {
    privateDays: number;
    channelDays: number;
  };
  model: string;
  mcpServers: readonly McpServerConfig[];
  skills: readonly Skill[];
}

const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]+$/u;

const resolveAllowedUserIds = (
  userIds: readonly string[],
): readonly string[] => {
  if (userIds.length === 0) {
    throw new Error("Agent config requires at least one allowedUserId");
  }
  const allowed = new Set<string>();
  for (const entry of userIds) {
    const userId = entry.trim();
    if (!SLACK_USER_ID_PATTERN.test(userId)) {
      throw new Error(
        `Agent config requires allowedUserIds entries to be Slack user ids, not ${entry}`,
      );
    }
    allowed.add(userId);
  }
  return Object.freeze([...allowed]);
};

const resolveSuggestedPrompt = (prompt: SuggestedPrompt): SuggestedPrompt => {
  const title = prompt.title.trim();
  const message = prompt.message.trim();
  if (!(title && message)) {
    throw new Error("Agent suggested prompt requires title and message");
  }
  return Object.freeze({ message, title });
};

const isHttpsUrl = (value: string): boolean =>
  URL.canParse(value) && new URL(value).protocol === "https:";

const resolveRequireApproval = (
  server: string,
  names: readonly string[],
  tools: readonly string[] | undefined,
): readonly string[] => {
  const required = new Set<string>();
  for (const entry of names) {
    const tool = entry.trim();
    if (!tool) {
      throw new Error(
        `Agent MCP server ${server} requires a tool name in requireApproval`,
      );
    }
    if (required.has(tool)) {
      throw new Error(
        `Agent MCP server ${server} requires approval for ${tool} twice`,
      );
    }
    if (tools !== undefined && !tools.includes(tool)) {
      throw new Error(
        `Agent MCP server ${server} requires approval for ${tool}, which its tools allowlist does not name`,
      );
    }
    required.add(tool);
  }
  return Object.freeze([...required]);
};

const resolveMcpServer = (server: McpServerConfig): McpServerConfig => {
  const name = server.name.trim();
  if (!name) {
    throw new Error("Agent MCP server requires name");
  }
  const url = server.url.trim();
  if (!isHttpsUrl(url)) {
    throw new Error(`Agent MCP server ${name} requires an HTTPS url`);
  }
  const resolved: McpServerConfig = { ...server, name, url };
  if (server.authSecret !== undefined) {
    const authSecret = server.authSecret.trim();
    if (!authSecret) {
      throw new Error(`Agent MCP server ${name} requires an authSecret`);
    }
    resolved.authSecret = authSecret;
  }
  if (server.requireApproval !== undefined) {
    resolved.requireApproval = resolveRequireApproval(
      name,
      server.requireApproval,
      server.tools,
    );
  }
  return Object.freeze(resolved);
};

const resolveMcpServers = (
  servers: readonly McpServerConfig[],
): readonly McpServerConfig[] => {
  const resolved = servers.map(resolveMcpServer);
  const names = new Set<string>();
  for (const { name } of resolved) {
    if (names.has(name)) {
      throw new Error(`Agent MCP server ${name} is configured twice`);
    }
    names.add(name);
  }
  return Object.freeze(resolved);
};

const resolveSkills = (skills: readonly Skill[]): readonly Skill[] => {
  const names = new Set<string>();
  for (const { name } of skills) {
    if (names.has(name)) {
      throw new Error(`Agent skill ${name} is configured twice`);
    }
    names.add(name);
  }
  return Object.freeze([...skills]);
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

// The one predicate that decides whether the deployment can ask a person to
// approve a call: the manifest enables interactivity on it, and the worker
// mounts the interactions route on it.
export const requiresApproval = (config: ResolvedAgentConfig): boolean =>
  config.mcpServers.some((server) => (server.requireApproval?.length ?? 0) > 0);

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
    allowedUserIds:
      config.allowedUserIds === undefined
        ? Object.freeze([])
        : resolveAllowedUserIds(config.allowedUserIds),
    description: config.description.trim(),
    mcpServers: resolveMcpServers(config.mcpServers ?? []),
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
    skills: resolveSkills(config.skills ?? []),
    suggestedPrompts: Object.freeze(suggestedPrompts),
  });
};
