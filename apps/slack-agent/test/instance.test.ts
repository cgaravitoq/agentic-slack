import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  generateAgentConfigModule,
  generateWranglerConfig,
  parseInstance,
  scaffoldFiles,
} from "../../../packages/core/src/instance.ts";

const outputDirectory = "/tmp/instance/.agentic-slack";
const migrationsDirectory =
  "/tmp/instance/node_modules/agentic-slack/apps/slack-agent/migrations";
const migrationsDirFromOutput =
  "../node_modules/agentic-slack/apps/slack-agent/migrations";

const environmentSchema = v.object({
  ai: v.optional(v.object({ binding: v.string() })),
  d1_databases: v.array(
    v.object({
      binding: v.string(),
      database_id: v.string(),
      database_name: v.string(),
      migrations_dir: v.string(),
    }),
  ),
  name: v.string(),
  preview_urls: v.boolean(),
  routes: v.array(
    v.object({ custom_domain: v.boolean(), pattern: v.string() }),
  ),
  services: v.optional(
    v.array(
      v.object({
        binding: v.string(),
        entrypoint: v.string(),
        service: v.string(),
      }),
    ),
  ),
  vars: v.record(v.string(), v.string()),
  workers_dev: v.boolean(),
});

const generatedWranglerSchema = v.object({
  env: v.record(v.string(), environmentSchema),
  name: v.string(),
});

const minimalEnvironment = `environments:
  staging:
    worker: instance-staging
    domain: instance-staging.example.com
    vars:
      SLACK_TEAM_ID: T0000000001
      SLACK_APP_ID: A0000000001
    d1:
      name: instance-staging
      id: 11111111-1111-1111-1111-111111111111
`;

const brokerInstance = `agent:
  name: Bloop
  description: A private, self-hosted assistant for Slack conversations.
  ownerInstructions: Answer with the instance configuration.
  model: broker/gpt-6-luna
  allowedUserIds:
    - U0000000001
  retention:
    channelDays: 15
    privateDays: 7
  progress:
    authSecret: SLACK_PROGRESS_BEARER
    labels:
      blocked: Blocked
      done: Done
      merged: Merged
      pr: Pull request
      progress: Progress
      review: Review
      started: Started
secrets:
  - SLACK_PROGRESS_BEARER
  - SLACK_BOT_TOKEN
  - SLACK_SIGNING_SECRET
environments:
  staging:
    worker: instance-staging
    domain: instance-staging.example.com
    vars:
      SLACK_TEAM_ID: T0000000001
      SLACK_APP_ID: A0000000001
    d1:
      name: instance-staging
      id: 11111111-1111-1111-1111-111111111111
    broker:
      service: orb-staging
      entrypoint: OrbCompletion
  prod:
    worker: instance
    domain: instance.example.com
    vars:
      SLACK_TEAM_ID: T0000000002
      SLACK_APP_ID: A0000000002
    d1:
      name: instance
      id: 22222222-2222-2222-2222-222222222222
    broker:
      service: orb
      entrypoint: OrbCompletion
`;

const environmentConfig = (
  worker: string,
  domain: string,
  vars: Record<string, string>,
  d1: { id: string; name: string },
  broker: string,
) => ({
  d1_databases: [
    {
      binding: "DB",
      database_id: d1.id,
      database_name: d1.name,
      migrations_dir: migrationsDirFromOutput,
    },
  ],
  name: worker,
  preview_urls: false,
  routes: [{ custom_domain: true, pattern: domain }],
  services: [
    { binding: "MODEL_BROKER", entrypoint: "OrbCompletion", service: broker },
  ],
  vars,
  workers_dev: false,
});

describe("parseInstance", () => {
  test("reports the YAML path of every problem", () => {
    const failures: readonly (readonly [string, string, RegExp])[] = [
      [
        "a missing field",
        `agent:
  description: A private assistant.
  ownerInstructions: Answer.
${minimalEnvironment}`,
        /^\s+agent\.name: /mu,
      ],
      [
        "an unknown field",
        `agent:
  name: Slack Agent
  description: A private assistant.
  ownerInstructions: Answer.
  retentions: {}
${minimalEnvironment}`,
        /^\s+agent\.retentions: /mu,
      ],
      [
        "a broker on the Workers AI provider",
        `agent:
  name: Slack Agent
  description: A private assistant.
  ownerInstructions: Answer.
${minimalEnvironment}    broker:
      service: orb-staging
      entrypoint: OrbCompletion
`,
        /^\s+environments\.staging\.broker: Only allowed/mu,
      ],
      [
        "a broker provider without a broker",
        `agent:
  name: Slack Agent
  description: A private assistant.
  ownerInstructions: Answer.
  model: broker/gpt-6-luna
${minimalEnvironment}`,
        /^\s+environments\.staging\.broker: Required/mu,
      ],
      [
        "an undeclared secret",
        `agent:
  name: Slack Agent
  description: A private assistant.
  ownerInstructions: Answer.
  progress:
    authSecret: SLACK_PROGRESS_BEARER
    labels:
      blocked: Blocked
      done: Done
      merged: Merged
      pr: Pull request
      progress: Progress
      review: Review
      started: Started
secrets:
  - SLACK_BOT_TOKEN
${minimalEnvironment}`,
        /^\s+agent\.progress\.authSecret: /mu,
      ],
      [
        "an unknown model provider",
        `agent:
  name: Slack Agent
  description: A private assistant.
  ownerInstructions: Answer.
  model: openai/gpt-6-luna
${minimalEnvironment}`,
        /^\s+agent\.model: /mu,
      ],
      [
        "a var that is not an environment variable name",
        `agent:
  name: Slack Agent
  description: A private assistant.
  ownerInstructions: Answer.
environments:
  staging:
    worker: instance-staging
    domain: instance-staging.example.com
    vars:
      teamId: T0000000001
    d1:
      name: instance-staging
      id: 11111111-1111-1111-1111-111111111111
`,
        /^\s+environments\.staging\.vars\.teamId: /mu,
      ],
    ];
    for (const [name, source, expected] of failures) {
      expect(() => parseInstance(source), name).toThrow(expected);
    }
  });

  test("rejects invalid YAML and an empty document", () => {
    expect(() => parseInstance("agent: [\n")).toThrow(
      /agent\.yaml is not valid YAML/mu,
    );
    expect(() => parseInstance("")).toThrow(
      /Expected Object but received null/u,
    );
  });
});

describe("generateWranglerConfig", () => {
  test("writes the instance environments in the self-hosted shape", () => {
    const generated = generateWranglerConfig(
      parseInstance(brokerInstance),
      migrationsDirectory,
      outputDirectory,
    );

    expect(JSON.parse(generated)).toEqual({
      compatibility_date: "2026-08-13",
      compatibility_flags: ["nodejs_compat"],
      env: {
        prod: environmentConfig(
          "instance",
          "instance.example.com",
          { SLACK_APP_ID: "A0000000002", SLACK_TEAM_ID: "T0000000002" },
          { id: "22222222-2222-2222-2222-222222222222", name: "instance" },
          "orb",
        ),
        staging: environmentConfig(
          "instance-staging",
          "instance-staging.example.com",
          { SLACK_APP_ID: "A0000000001", SLACK_TEAM_ID: "T0000000001" },
          {
            id: "11111111-1111-1111-1111-111111111111",
            name: "instance-staging",
          },
          "orb-staging",
        ),
      },
      limits: { cpu_ms: 30_000 },
      migrations: [
        {
          new_sqlite_classes: ["FlueSlackAgentAgent"],
          tag: "flue-class-FlueSlackAgentAgent",
        },
      ],
      name: "bloop",
      observability: {
        enabled: true,
        head_sampling_rate: 1,
        traces: { enabled: true },
      },
      preview_urls: false,
      workers_dev: false,
    });
  });

  test("binds Workers AI when the model runs on the cloudflare provider", () => {
    const generated = v.parse(
      generatedWranglerSchema,
      JSON.parse(
        generateWranglerConfig(
          parseInstance(`agent:
  name: Slack Agent
  description: A private assistant.
  ownerInstructions: Answer.
${minimalEnvironment}`),
          migrationsDirectory,
          outputDirectory,
        ),
      ),
    );

    expect(generated.name).toBe("slack-agent");
    expect(generated.env.staging.ai).toEqual({ binding: "AI" });
    expect(generated.env.staging.services).toBeUndefined();
  });
});

describe("generateAgentConfigModule", () => {
  test("imports each skill from its directory", () => {
    const module = generateAgentConfigModule(
      parseInstance(brokerInstance),
      [`/tmp/instance/skills/refunds/SKILL.md`],
      outputDirectory,
    );

    expect(module).toContain(
      'import skill0 from "../skills/refunds/SKILL.md";',
    );
    expect(module).toContain('"skills": [skill0]');
    expect(module).toContain(
      'import { defineAgentConfig } from "agentic-slack";',
    );
    expect(module).toContain('"ownerInstructions"');
  });

  test("keeps every agent field in the generated config", () => {
    const module = generateAgentConfigModule(
      parseInstance(brokerInstance),
      [],
      outputDirectory,
    );
    const body = module.slice(
      module.indexOf("({") + 1,
      module.lastIndexOf(");"),
    );

    expect(JSON.parse(body)).toEqual({
      allowedUserIds: ["U0000000001"],
      description: "A private, self-hosted assistant for Slack conversations.",
      model: "broker/gpt-6-luna",
      name: "Bloop",
      ownerInstructions: "Answer with the instance configuration.",
      progress: {
        authSecret: "SLACK_PROGRESS_BEARER",
        labels: {
          blocked: "Blocked",
          done: "Done",
          merged: "Merged",
          pr: "Pull request",
          progress: "Progress",
          review: "Review",
          started: "Started",
        },
      },
      retention: { channelDays: 15, privateDays: 7 },
    });
  });
});

describe("scaffoldFiles", () => {
  test("hands out a template that builds through the schema", () => {
    const files = scaffoldFiles("1.2.3");
    const template = files.find((file) => file.name === "agent.yaml");
    const manifest = files.find((file) => file.name === "package.json");
    const ignore = files.find((file) => file.name === ".gitignore");

    expect(manifest?.contents).toContain('"agentic-slack": "1.2.3"');
    expect(ignore?.contents).toBe("node_modules/\n.agentic-slack/\n");
    const instance = parseInstance(template?.contents ?? "");

    expect(instance.environments.staging?.worker).toBe("slack-agent-staging");
    expect(
      v.parse(
        generatedWranglerSchema,
        JSON.parse(
          generateWranglerConfig(
            instance,
            migrationsDirectory,
            outputDirectory,
          ),
        ),
      ).env.staging,
    ).toEqual({
      ai: { binding: "AI" },
      d1_databases: [
        {
          binding: "DB",
          database_id: "00000000-0000-0000-0000-000000000000",
          database_name: "slack-agent-staging",
          migrations_dir: migrationsDirFromOutput,
        },
      ],
      name: "slack-agent-staging",
      preview_urls: false,
      routes: [
        { custom_domain: true, pattern: "slack-agent-staging.example.com" },
      ],
      vars: { SLACK_APP_ID: "A00000000", SLACK_TEAM_ID: "T00000000" },
      workers_dev: false,
    });
  });
});
