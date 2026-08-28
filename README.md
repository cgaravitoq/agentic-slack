# Agentic Slack

Agentic Slack is a self-hosted agent runtime for Slack on Cloudflare Workers.

This Bun monorepo contains a provider-neutral Slack agent core and a Cloudflare Worker composition.
The core admits signed mentions and private messages, keeps one durable conversation per Slack thread, deduplicates events in D1, and binds safe terminal delivery to the originating conversation.

## Architecture

The core owns Slack admission and delivery, conversation state, deduplication, retention, the configured Workers AI model, and immutable security instructions.

The operator surface is `apps/slack-agent/agent.config.ts`: name, description, owner instructions, suggested prompts, retention, and model.

The Worker acknowledges an accepted event and hands the turn to `executionCtx.waitUntil`, so the response never waits for the deferred work that `waitUntil` keeps alive.
The deferred work refreshes retention, fires a best-effort `:eyes:` reaction on channel mentions, and dispatches the turn to the Durable Object.
The model turn and Slack delivery run later on the Durable Object from durable state, including on its alarm path when the live stream handle is gone.
The stream destination is passed as `initialData` that the model cannot influence.

## Delivery

The sanitizer withholds a bounded tail of `STREAM_TAIL_LENGTH` (512) characters and redacts secrets before any text reaches Slack.
Appends are coalesced at `COALESCE_CHARS` (1024) characters and on a `COALESCE_MS` (300) millisecond timer.
Retryable Slack failures are retried with `Retry-After` capped at `MAX_RETRY_AFTER_MS` (2000) milliseconds per attempt and `MAX_RETRY_WAIT_MS` (4000) milliseconds across attempts.
A reply longer than `MAX_SLACK_MESSAGE_LENGTH` (3900) characters is truncated in place with a `(truncated)` notice instead of being split.
A turn that completes without text receives `SLACK_DELIVERY_FALLBACK`, and a turn that failed receives `SLACK_STREAM_FAILURE_NOTICE` instead.

## Retention

Retention is a sliding TTL refreshed on every turn: 7 days for DMs (`privateDays`) and 15 days for channels (`channelDays`).
Expiry is scheduled at that many days times 86400 seconds, then prior `expireConversation` schedules are cancelled.
When the latest expiry fires, the Durable Object is destroyed.
That destroy is the product's only conversation deletion mechanism.

## Self-hosting

Create one D1 database, then add its `database_name` and `database_id` to the `DB` binding in `apps/slack-agent/wrangler.jsonc`.
Apply `apps/slack-agent/migrations` to that database with `bunx wrangler d1 migrations apply DB --config apps/slack-agent/wrangler.jsonc --remote` before accepting Slack events.
`bun run db:migrate:local` passes `--local` and writes only the local store, and `bun run db:migrate:staging` passes `--env staging --remote` and writes this repository's own staging database.

Configure these Worker bindings:

- Secrets: `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`
- Plain variables: `SLACK_TEAM_ID` and `SLACK_APP_ID`
- D1: `DB`
- Workers AI: `AI`

Flue injects the Durable Object binding `FLUE_SLACK_AGENT_AGENT` at build time.

Build with `bun run build`, then deploy the Worker with `bunx wrangler deploy --config apps/slack-agent/dist/agentic_slack/wrangler.json`.
`bun run deploy:staging` and `bun run deploy:dry` build with `CLOUDFLARE_ENV=staging`, which resolves the `env.staging` bindings of this repository instead of yours.
`.github/workflows/deploy.yml` runs `bun run deploy:staging` on pushes to `staging`.
Generate the Slack manifest with `bun run manifest <deployed-url>`, create a Slack app from that manifest, and install it into the workspace represented by the configured team and app IDs.
The manifest uses the deployed URL origin, pins bot scopes, and disables interactivity, org deploy, socket mode, and token rotation.
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
