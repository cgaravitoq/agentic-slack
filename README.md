# Agentic Slack

Agentic Slack is a self-hosted agent runtime for Slack on Cloudflare Workers.

This Bun monorepo contains a provider-neutral Slack agent core and a Cloudflare Worker composition.
The core admits signed mentions and private messages, keeps one durable conversation per Slack thread, deduplicates events in D1, and binds safe terminal delivery to the originating conversation.

## Architecture

The core owns Slack admission and delivery, conversation state, deduplication, retention, the fixed Workers AI model, and immutable security instructions.

Plugins integrate external systems through instructions and tools registered in `apps/slack-agent/agent.config.ts`.
They are optional and must keep credentials in runtime closures.
The included `@agentic-slack/plugin-llms-docs` package reads a same-origin `llms.txt` documentation source, while `@agentic-slack/plugin-posthog` runs bounded aggregate event queries and requires an operator-provided PostHog personal API key with Query Read access.

Addons are optional domain behavior such as triage, routing, or evaluation.
They use the same static composition seam but remain distinct from external-system plugins.

## Self-hosting

Create one D1 database, then add its `database_name` and `database_id` to the `DB` binding in `apps/slack-agent/wrangler.jsonc`.
Apply `apps/slack-agent/migrations/0001_seen_events.sql` with `wrangler d1 execute <database-name> --remote --file apps/slack-agent/migrations/0001_seen_events.sql` before accepting Slack events.

Configure these Worker bindings:

- Secrets: `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`
- Plain variables: `SLACK_TEAM_ID` and `SLACK_APP_ID`

The Slack Events API requires an HTTP 200 acknowledgement within 3 seconds.
Accepted events are acknowledged before agent work, which continues through `ctx.waitUntil()` for at most 30 seconds after the response.
Enabled plugins must complete their work within that window.

Deploy the Worker with `bunx wrangler deploy --config apps/slack-agent/dist/agentic_slack/wrangler.json` after `bun run build`.
Generate the Slack manifest with the deployed URL, create a Slack app from that manifest, and install it into the workspace represented by the configured team and app IDs.
One deployment represents one Slack app in one workspace.

Configure the agent name, description, owner instructions, plugins, and addons in `apps/slack-agent/agent.config.ts`.
Optional integrations stay disabled when they are absent from that file.

To enable an included plugin, import it and add it to `plugins` in that config file.
Its workspace dependency must also remain declared in `apps/slack-agent/package.json`; add the equivalent dependency there for any other plugin and refresh `bun.lock` with Bun.
Configure every binding used by its resolver before deployment.
For PostHog, keep `POSTHOG_PERSONAL_API_KEY` in a Worker secret and expose non-secret `POSTHOG_HOST` and `POSTHOG_PROJECT_ID` as plain variables.
The resolver receives Worker bindings as runtime context and closes over credentials when it creates tools; credentials must never appear in instructions, tool names, descriptions, or input schemas.

For example, an operator can add this plugin definition to `agent.config.ts` while leaving credentials out of static configuration:

```ts
import { defineAgentConfig } from "@agentic-slack/core";
import { createPostHogPlugin } from "@agentic-slack/plugin-posthog";

interface RuntimeContext {
  bindings: {
    POSTHOG_HOST: string;
    POSTHOG_PROJECT_ID: string;
    POSTHOG_PERSONAL_API_KEY: string;
  };
}

const posthog = createPostHogPlugin<RuntimeContext>({
  resolve: ({ bindings }) => ({
    host: bindings.POSTHOG_HOST,
    projectId: bindings.POSTHOG_PROJECT_ID,
    personalApiKey: bindings.POSTHOG_PERSONAL_API_KEY,
  }),
});

export default defineAgentConfig<RuntimeContext>({
  name: "Slack Agent",
  description: "A private, self-hosted assistant for Slack conversations.",
  ownerInstructions: "Help with clear, accurate, concise answers.",
  plugins: [posthog],
});
```

## Development

Install dependencies with Bun:

```sh
bun install --frozen-lockfile
```

Run the verification suite:

```sh
bun run verify
```

Generate a Slack manifest from the neutral agent configuration and a deployed Worker URL:

```sh
bun run manifest https://agent.example.com
```
