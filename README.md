# Agentic Slack

Agentic Slack is a self-hosted agent runtime for Slack on Cloudflare Workers.

This Bun monorepo contains a provider-neutral Slack agent core and a Cloudflare Worker composition.
The core admits signed mentions and private messages, keeps one durable conversation per Slack thread, deduplicates events in D1, and binds safe terminal delivery to the originating conversation.

## Architecture

The core owns Slack admission and delivery, conversation state, deduplication, retention, the fixed Workers AI model, and immutable security instructions.

Plugins integrate external systems through instructions and tools registered in `apps/slack-agent/agent.config.ts`.
They are optional and must keep credentials in runtime closures.
The included `@agentic-slack/plugin-llms-docs` package reads a same-origin `llms.txt` documentation source, while `@agentic-slack/plugin-posthog` runs bounded aggregate event queries and requires an operator-provided PostHog personal API key limited to `query:read`.

Addons are optional domain behavior such as triage, routing, or evaluation.
They use the same static composition seam but remain distinct from external-system plugins.

## Self-hosting

Create one D1 database, then add its `database_name` and `database_id` to the `DB` binding in `apps/slack-agent/wrangler.jsonc`.
Apply `apps/slack-agent/migrations/0001_seen_events.sql` with `wrangler d1 execute <database-name> --remote --file apps/slack-agent/migrations/0001_seen_events.sql` before accepting Slack events.

Configure these Worker bindings:

- Secrets: `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`
- Plain variables: `SLACK_TEAM_ID` and `SLACK_APP_ID`

Deploy the Worker with `bunx wrangler deploy --config apps/slack-agent/dist/agentic_slack/wrangler.json` after `bun run build`.
Generate the Slack manifest with the deployed URL, create a Slack app from that manifest, and install it into the workspace represented by the configured team and app IDs.
One deployment represents one Slack app in one workspace.

Configure the agent name, description, owner instructions, plugins, and addons in `apps/slack-agent/agent.config.ts`.
Optional integrations stay disabled when they are absent from that file.

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
