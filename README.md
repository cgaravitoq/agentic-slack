# Agentic Slack

Agentic Slack is a self-hosted agent runtime for Slack on Cloudflare Workers.

This Bun monorepo contains a provider-neutral Slack agent core and a Cloudflare Worker composition.
The core admits signed mentions and private messages, keeps one durable conversation per Slack thread, deduplicates events in D1, and binds safe terminal delivery to the originating conversation.

## Architecture

The core owns Slack admission and delivery, conversation state, deduplication, retention, the configured Workers AI model, and immutable security instructions.

The operator surface is `apps/slack-agent/agent.config.ts`: name, description, owner instructions, suggested prompts, retention, and model.

## Self-hosting

Create one D1 database, then add its `database_name` and `database_id` to the `DB` binding in `apps/slack-agent/wrangler.jsonc`.
Apply `apps/slack-agent/migrations/0001_seen_events.sql` with `wrangler d1 execute <database-name> --remote --file apps/slack-agent/migrations/0001_seen_events.sql` before accepting Slack events.

Configure these Worker bindings:

- Secrets: `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`
- Plain variables: `SLACK_TEAM_ID` and `SLACK_APP_ID`

The Slack Events API requires an HTTP 200 acknowledgement within 3 seconds.
Accepted events are acknowledged before agent work, which continues through `ctx.waitUntil()` for at most 30 seconds after the response.

Deploy the Worker with `bunx wrangler deploy --config apps/slack-agent/dist/agentic_slack/wrangler.json` after `bun run build`.
Generate the Slack manifest with the deployed URL, create a Slack app from that manifest, and install it into the workspace represented by the configured team and app IDs.
One deployment represents one Slack app in one workspace.

Configure the agent name, description, owner instructions, suggested prompts, retention, and model in `apps/slack-agent/agent.config.ts`.

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
