import path from "node:path";
import * as v from "valibot";
import type { IssuePathItem } from "valibot";
import {
  MODEL,
  MODEL_PROVIDER_BROKER,
  MODEL_PROVIDER_CLOUDFLARE,
  modelProviderOf,
} from "./config.ts";
import type { InstanceLock } from "./lock.ts";

const text = v.pipe(v.string(), v.minLength(1, "Expected a non-empty string"));

const secretName = v.pipe(
  v.string(),
  v.regex(/^[A-Z][A-Z0-9_]*$/u, "Expected a name like SLACK_BOT_TOKEN"),
);

const headerName = v.pipe(
  v.string(),
  v.regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u, "Expected an HTTP header name"),
);

const workerName = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9][a-z0-9-]{0,62}$/u, "Expected a lower-case Worker name"),
);

const hostName = v.pipe(
  v.string(),
  v.regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u,
    "Expected a host name like agent.example.com",
  ),
);

const environmentName = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9_-]+$/u, "Expected a name of letters, digits or dashes"),
);

const positiveInteger = v.pipe(
  v.number(),
  v.integer("Expected an integer"),
  v.minValue(1, "Expected a positive integer"),
);

const suggestedPromptSchema = v.strictObject({ message: text, title: text });

const retentionSchema = v.strictObject({
  channelDays: v.optional(positiveInteger),
  privateDays: v.optional(positiveInteger),
});

const readSchema = v.strictObject({
  lookbackSeconds: v.optional(positiveInteger),
  maxMessages: v.optional(positiveInteger),
});

const progressSchema = v.strictObject({
  authSecret: secretName,
  labels: v.strictObject({
    blocked: text,
    done: text,
    merged: text,
    pr: text,
    progress: text,
    review: text,
    started: text,
  }),
  narration: v.optional(text),
});

const delegationSchema = v.strictObject({
  authSecret: secretName,
  labels: v.optional(
    v.strictObject({
      failed: v.optional(text),
      running: v.optional(text),
      unknown: v.optional(text),
    }),
  ),
  repos: v.array(text),
  runnerHeaders: v.optional(v.record(headerName, secretName)),
});

const mcpServerSchema = v.strictObject({
  authSecret: v.optional(secretName),
  name: text,
  optional: v.optional(v.boolean()),
  requireApproval: v.optional(v.array(text)),
  tools: v.optional(v.array(text)),
  url: text,
});

const agentSchema = v.strictObject({
  allowedUserIds: v.optional(v.array(text)),
  delegation: v.optional(delegationSchema),
  description: text,
  mcpServers: v.optional(v.array(mcpServerSchema)),
  model: v.optional(text),
  name: text,
  ownerInstructions: text,
  progress: v.optional(progressSchema),
  read: v.optional(readSchema),
  retention: v.optional(retentionSchema),
  skills: v.optional(v.array(text)),
  suggestedPrompts: v.optional(v.array(suggestedPromptSchema)),
});

const environmentSchema = v.strictObject({
  broker: v.optional(v.strictObject({ entrypoint: text, service: text })),
  d1: v.strictObject({ id: v.optional(text), name: workerName }),
  domain: hostName,
  vars: v.record(secretName, v.string()),
  worker: workerName,
});

const instanceSchema = v.strictObject({
  agent: agentSchema,
  environments: v.pipe(
    v.record(environmentName, environmentSchema),
    v.check(
      (environments) => Object.keys(environments).length > 0,
      "Expected at least one environment",
    ),
  ),
  secrets: v.optional(v.array(secretName), []),
});

export type AgentInstance = v.InferOutput<typeof instanceSchema>;

type InstanceEnvironment = AgentInstance["environments"][string];

interface InstanceProblem {
  message: string;
  path: string;
}

export const issuePath = (
  items: readonly IssuePathItem[] | undefined,
): string => {
  let dotPath = "";
  for (const item of items ?? []) {
    if (item.type === "array") {
      dotPath += `[${item.key}]`;
    } else if (item.type === "object") {
      dotPath = dotPath === "" ? item.key : `${dotPath}.${item.key}`;
    }
  }
  return dotPath;
};

const invalidInstance = (problems: readonly InstanceProblem[]): Error =>
  new Error(
    `agent.yaml is invalid:\n${problems
      .map((problem) =>
        problem.path === ""
          ? `  ${problem.message}`
          : `  ${problem.path}: ${problem.message}`,
      )
      .join("\n")}`,
  );

const secretReferences = (
  instance: AgentInstance,
): readonly { name: string; path: string }[] => {
  const { delegation, mcpServers, progress } = instance.agent;
  const references: { name: string; path: string }[] = [];
  if (progress !== undefined) {
    references.push({
      name: progress.authSecret,
      path: "agent.progress.authSecret",
    });
  }
  if (delegation !== undefined) {
    references.push({
      name: delegation.authSecret,
      path: "agent.delegation.authSecret",
    });
    for (const [header, secret] of Object.entries(
      delegation.runnerHeaders ?? {},
    )) {
      references.push({
        name: secret,
        path: `agent.delegation.runnerHeaders.${header}`,
      });
    }
  }
  for (const [index, server] of (mcpServers ?? []).entries()) {
    if (server.authSecret !== undefined) {
      references.push({
        name: server.authSecret,
        path: `agent.mcpServers[${index}].authSecret`,
      });
    }
  }
  return references;
};

const workerNameFrom = (name: string): string =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");

const instanceProblems = (
  instance: AgentInstance,
): readonly InstanceProblem[] => {
  const problems: InstanceProblem[] = [];
  const provider = modelProviderOf(instance.agent.model ?? MODEL);
  if (
    provider !== MODEL_PROVIDER_BROKER &&
    provider !== MODEL_PROVIDER_CLOUDFLARE
  ) {
    problems.push({
      message: `Expected a known provider (${MODEL_PROVIDER_CLOUDFLARE}, ${MODEL_PROVIDER_BROKER}) before the slash`,
      path: "agent.model",
    });
  }
  if (workerNameFrom(instance.agent.name) === "") {
    problems.push({
      message: "Expected a name with letters or digits to name the Worker",
      path: "agent.name",
    });
  }
  for (const [name, environment] of Object.entries(instance.environments)) {
    if (
      provider === MODEL_PROVIDER_BROKER &&
      environment.broker === undefined
    ) {
      problems.push({
        message: `Required because agent.model uses the ${MODEL_PROVIDER_BROKER} provider`,
        path: `environments.${name}.broker`,
      });
    }
    if (
      provider !== MODEL_PROVIDER_BROKER &&
      environment.broker !== undefined
    ) {
      problems.push({
        message: `Only allowed when agent.model uses the ${MODEL_PROVIDER_BROKER} provider`,
        path: `environments.${name}.broker`,
      });
    }
  }
  const declared = new Set(instance.secrets);
  for (const reference of secretReferences(instance)) {
    if (!declared.has(reference.name)) {
      problems.push({
        message: `Named ${reference.name}, which secrets does not declare`,
        path: reference.path,
      });
    }
  }
  return problems;
};

export const parseInstance = (source: string): AgentInstance => {
  let data: unknown;
  try {
    data = Bun.YAML.parse(source);
  } catch (error) {
    throw new Error(
      `agent.yaml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const result = v.safeParse(instanceSchema, data);
  if (!result.success) {
    throw invalidInstance(
      result.issues.map((issue) => ({
        message: issue.message,
        path: issuePath(issue.path),
      })),
    );
  }
  const problems = instanceProblems(result.output);
  if (problems.length > 0) {
    throw invalidInstance(problems);
  }
  return result.output;
};

export const readInstance = async (
  directory: string,
): Promise<AgentInstance> => {
  const source = path.join(directory, "agent.yaml");
  if (!(await Bun.file(source).exists())) {
    throw new Error(`${source} not found: run agentic-slack init ${directory}`);
  }
  return parseInstance(await Bun.file(source).text());
};

const relativePath = (from: string, to: string): string => {
  const relative = path.relative(from, to).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
};

export const generateAgentConfigModule = (
  instance: AgentInstance,
  skillFiles: readonly string[],
  outputDirectory: string,
): string => {
  const { agent } = instance;
  const entries: readonly (readonly [string, unknown])[] = [
    ["name", agent.name],
    ["description", agent.description],
    ["ownerInstructions", agent.ownerInstructions],
    ["allowedUserIds", agent.allowedUserIds],
    ["suggestedPrompts", agent.suggestedPrompts],
    ["retention", agent.retention],
    ["read", agent.read],
    ["progress", agent.progress],
    ["delegation", agent.delegation],
    ["model", agent.model],
    ["mcpServers", agent.mcpServers],
  ];
  const properties = entries.flatMap(([key, value]) =>
    value === undefined
      ? []
      : [
          `  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replaceAll("\n", "\n  ")}`,
        ],
  );
  if (skillFiles.length > 0) {
    properties.push(
      `  "skills": [${skillFiles.map((_, index) => `skill${index}`).join(", ")}]`,
    );
  }
  return [
    'import { defineAgentConfig } from "agentic-slack";',
    ...skillFiles.map(
      (file, index) =>
        `import skill${index} from ${JSON.stringify(relativePath(outputDirectory, file))};`,
    ),
    "",
    "export default defineAgentConfig({",
    properties.join(",\n"),
    "});",
    "",
  ].join("\n");
};

// Flue injects the Durable Object binding at build time, not the SQLite class
// migration; without this tag a deploy creates a Durable Object without storage.
const durableObjectMigration = {
  new_sqlite_classes: ["FlueSlackAgentAgent"],
  tag: "flue-class-FlueSlackAgentAgent",
};

const environmentConfig = (
  environment: InstanceEnvironment,
  databaseId: string,
  migrationsDirectory: string,
  outputDirectory: string,
) => ({
  d1_databases: [
    {
      binding: "DB",
      database_id: databaseId,
      database_name: environment.d1.name,
      migrations_dir: relativePath(outputDirectory, migrationsDirectory),
    },
  ],
  name: environment.worker,
  preview_urls: false,
  routes: [{ custom_domain: true, pattern: environment.domain }],
  vars: environment.vars,
  workers_dev: false,
  ...(environment.broker === undefined
    ? { ai: { binding: "AI" } }
    : {
        services: [
          {
            binding: "MODEL_BROKER",
            entrypoint: environment.broker.entrypoint,
            service: environment.broker.service,
          },
        ],
      }),
});

const present = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

// Adopted IDs in the lock win over the agent.yaml placeholder: a missing D1 id
// stops the build, and the Slack app id the Slack phase creates is added to the
// vars only once it exists.
const resolvedEnvironment = (
  name: string,
  environment: InstanceEnvironment,
  lock: InstanceLock,
) => {
  const entry = lock.environments[name];
  const databaseId = present(entry?.d1.id) ?? present(environment.d1.id);
  if (databaseId === undefined) {
    throw new Error(
      `agent.yaml has no environments.${name}.d1.id and agentic-slack.lock.json has none: run agentic-slack adopt --dir . --env ${name} --d1-id <id>`,
    );
  }
  const appId =
    present(entry?.slack?.appId) ?? present(environment.vars.SLACK_APP_ID);
  return {
    databaseId,
    environment:
      appId === undefined
        ? environment
        : {
            ...environment,
            vars: { ...environment.vars, SLACK_APP_ID: appId },
          },
  };
};

const noLock: InstanceLock = { environments: {}, version: 1 };

export const generateWranglerConfig = (
  instance: AgentInstance,
  environment: string,
  migrationsDirectory: string,
  outputDirectory: string,
  lock: InstanceLock = noLock,
): string => {
  const requested = instance.environments[environment];
  if (requested === undefined) {
    throw new Error(`agent.yaml has no environment ${environment}`);
  }
  const resolved = resolvedEnvironment(environment, requested, lock);
  const config = {
    compatibility_date: "2026-08-13",
    compatibility_flags: ["nodejs_compat"],
    env: {
      [environment]: environmentConfig(
        resolved.environment,
        resolved.databaseId,
        migrationsDirectory,
        outputDirectory,
      ),
    },
    limits: { cpu_ms: 30_000 },
    migrations: [durableObjectMigration],
    name: workerNameFrom(instance.agent.name),
    observability: {
      enabled: true,
      head_sampling_rate: 1,
      traces: { enabled: true },
    },
    preview_urls: false,
    workers_dev: false,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
};

const agentYamlTemplate = `# The single input of an agentic-slack instance: \`agent\` is the behavior,
# \`environments\` is the infrastructure and \`secrets\` names the Worker secrets
# you set with \`wrangler secret put <name>\`.
# Build one environment with: bunx agentic-slack build --dir . --env staging

agent:
  name: Slack Agent
  description: A private, self-hosted assistant for Slack conversations.
  ownerInstructions: Help the owner and their teammates with clear, accurate, concise answers.
  # cloudflare/<model> runs on Workers AI. broker/<model> binds a service that
  # holds the model credential, and then every environment needs its own broker.
  model: cloudflare/@cf/zai-org/glm-4.7-flash
  retention:
    channelDays: 15
    privateDays: 7
  suggestedPrompts:
    - title: Summarize
      message: Summarize this conversation and list the decisions and next steps.
    - title: Draft a reply
      message: Draft a concise reply I can send in this thread.
  # allowedUserIds: [U00000000]
  # read: {}
  # skills: [skills/refunds]
  # progress:
  #   authSecret: SLACK_PROGRESS_BEARER
  #   labels:
  #     blocked: Blocked
  #     done: Done
  #     merged: Merged
  #     pr: Pull request
  #     progress: Progress
  #     review: Review
  #     started: Started
  # delegation:
  #   authSecret: DELEGATION_BEARER
  #   repos: [owner/repository]

secrets:
  - SLACK_BOT_TOKEN
  - SLACK_SIGNING_SECRET

environments:
  staging:
    worker: slack-agent-staging
    domain: slack-agent-staging.example.com
    vars:
      SLACK_TEAM_ID: T00000000
    d1:
      name: slack-agent-staging
      id: "00000000-0000-0000-0000-000000000000"
    # broker:
    #   service: orb-staging
    #   entrypoint: OrbCompletion
`;

export interface ScaffoldFile {
  append: boolean;
  contents: string;
  name: string;
}

export const scaffoldFiles = (version: string): readonly ScaffoldFile[] => [
  { append: false, contents: agentYamlTemplate, name: "agent.yaml" },
  {
    append: false,
    contents: `${JSON.stringify(
      {
        dependencies: { "agentic-slack": version },
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
    name: "package.json",
  },
  {
    append: true,
    contents: "node_modules/\n.agentic-slack/\n",
    name: ".gitignore",
  },
];
