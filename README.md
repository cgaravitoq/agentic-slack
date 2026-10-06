# Agentic Slack

Agentic Slack is a self-hosted agent runtime for Slack on Cloudflare Workers.

Mention the agent in a channel or send it a direct message to receive a streamed reply in Slack.
Channel threads have separate durable conversations; messages in the same DM channel share one conversation, including messages in different DM threads.
Replies always go to the requesting thread.

The agent has no built-in business integrations or external tools.
Business tools live in an MCP server you operate, and procedures ship as Agent Skills; both are declared in `apps/slack-agent/agent.config.ts`.
It receives admitted mentions and DMs, not the complete history of a Slack channel; with the opt-in `read` option it can also read a thread or a channel's recent messages it is allowed to see.
Configure its name, instructions, suggested prompts, allowed users, retention, model, MCP servers, skills, read tools, and progress reporting in `apps/slack-agent/agent.config.ts`.

This Bun monorepo separates reusable Slack admission and delivery code from the deployed application.
The current runtime uses Flue, Cloudflare Workers, Durable Objects, and D1, and runs the model on Workers AI or through a credential broker you operate; see [Model providers](#model-providers).
It is self-hosted in your Cloudflare account; it is not a cloud-independent runtime or a locally hosted model.

![A real Slack thread where Bloop turns a fictional release plan into a checklist, then keeps the task owners while moving the release to Monday.](assets/slack-demo.png)

Live conversation with the deployed agent, using a fictional release plan.
Personal identity and channel details have been redacted from the screenshot.
The follow-up changes the deadline without repeating the task owners, demonstrating context retained within the thread.

```mermaid
flowchart LR
    Slack[Slack mention or DM] --> Ingress[Worker: verify signature and workspace]
    Ingress --> Dedup[D1: deduplicate event]
    Dedup --> Agent[Durable Object: conversation and delivery]
    Agent --> Model[Workers AI or a credential broker]
    Model --> Agent
    Agent --> Reply[Slack: stream to the requesting thread]
```

## Architecture

The core owns Slack admission and delivery, deduplication, retention helpers, instruction composition, the opt-in Slack read tools, and the opt-in progress endpoint.
The application selects the provider the model prefix names and connects the Flue agent lifecycle to durable delivery, retention, and the read tools' delivery-bound scope.

The operator surface is `apps/slack-agent/agent.config.ts`: name, description, owner instructions, allowed users, suggested prompts, retention, model, MCP servers, skills, the opt-in `read` tools, and the opt-in `progress` endpoint.
An operator repository that pins this one can keep that file outside it; see [Consume a pinned copy](#consume-a-pinned-copy).

The Worker claims the event in D1 and dispatches the turn to the Durable Object before it acknowledges, so an event Slack is told to stop retrying is already admitted durably.
The claimed turn refreshes retention and fires a best-effort `:eyes:` reaction on channel mentions before the dispatch.
A failed claim or dispatch answers Slack with a non-2xx response so it retries the delivery; a duplicate delivery of an already-claimed event is answered `200` and ignored.
The model turn and Slack delivery run later on the Durable Object from durable state, including on its alarm path when the live stream handle is gone.
The stream destination rides in each dispatched message's attributes, set by the Worker and read back with `useDelivery()`, so the model cannot influence it and every DM reply reaches its own thread.
Flue answers a message that arrives while the conversation is busy inside the running response, so one response can carry several requesting threads.
The delivery record keeps every one of those destinations and delivers the reply to each, which is what keeps a burst of DMs from leaving all but the first unanswered.
A tool the operator gates with `requireApproval` is stopped inside its MCP connection: the Worker records the request in D1 and posts the Approve/Reject card, and only the approved call is forwarded to the server.

## Model providers

`model` is `provider-id/model-id`, and its prefix selects one of two providers:

- `cloudflare/...` runs the model on Workers AI through the `AI` binding, which is what the shipped configuration and `wrangler.jsonc` use.
- `broker/...` runs a Codex model on the Responses API through a service binding named `MODEL_BROKER`, so the deployment holds no model credential.

Leaving `model` unset is the same as a `cloudflare/...` model, and any other prefix fails when the configuration is defined.
`/health` lists exactly the binding the prefix needs: `AI` for `cloudflare`, `MODEL_BROKER` for `broker`, and never both.

### Run on Workers AI

The default, `cloudflare/@cf/zai-org/glm-4.7-flash`, is served by the Workers AI binding your Wrangler configuration binds as `AI`.
Any `@cf/...` id works after the prefix, whether or not the pinned runtime's catalog declares it; an id it does not know resolves without model metadata.

### Run through a credential broker

`broker/gpt-6-luna` runs the model on a credential broker you operate: a Worker entrypoint that adds the credential, calls the model, and streams the answer back.
This repository never holds that credential, and neither its code nor its configuration names the Worker that does; the deployment only names the binding.
Bind the entrypoint as a service binding called `MODEL_BROKER`:

```jsonc
{
  "services": [
    {
      "binding": "MODEL_BROKER",
      "service": "your-broker-worker",
      "entrypoint": "YourBrokerEntrypoint"
    }
  ]
}
```

The broker contract is one route:

- `POST /codex/responses` receives the Responses API request body with the `authorization` and `chatgpt-account-id` headers the app sends, and answers with the upstream SSE stream.
- The broker overwrites both of those headers with the credential it holds, strips `cf-*` and `x-forwarded-*` request headers before calling the model, and never lets the credential reach the caller.
- The app sends a well-formed placeholder bearer; the provider protocol reads the account id out of it before every request, and the broker replaces it.

Requests are SSE only: the model protocol's WebSocket transport ignores an injected fetch, so a broker can carry requests only over SSE.
The model ids available after `broker/` are the Codex Responses models the pinned `@earendil-works/pi-ai` release declares, `gpt-6-luna` among them.
A brokered turn streams the same way a Workers AI turn does, including tool calls and compaction.

## Delivery

The sanitizer withholds a bounded tail of `STREAM_TAIL_LENGTH` (512) characters before sending text to Slack.
It removes Slack broadcast syntax, escapes mention controls, rewrites Slack's own link syntax into the markdown links a stream renders, redacts Slack token patterns, and redacts assignments whose names contain terms such as `TOKEN`, `SECRET`, `PASSWORD`, or `API_KEY`.
Slack renders neither a mention nor its own link syntax inside streamed markdown, so the tags and links trusted code owes a reply close the message as one section block on `chat.stopStream`: a progress milestone's `mentions` and `url`, and every member the model tagged with `mention_member`.
This is pattern-based output filtering, not a guarantee that arbitrary credentials or confidential content cannot appear in a reply.
Appends are coalesced at `COALESCE_CHARS` (1024) characters and on a `COALESCE_MS` (300) millisecond timer.
Retryable Slack failures use bounded backoff or `Retry-After`, capped at `MAX_RETRY_AFTER_MS` (2000) milliseconds per attempt and `MAX_RETRY_WAIT_MS` (4000) milliseconds across attempts.
A reply longer than `MAX_SLACK_MESSAGE_LENGTH` (3900) characters is truncated in place with a `(truncated)` notice instead of being split.
A turn that completes without text receives `SLACK_DELIVERY_FALLBACK`, and a turn that failed receives `SLACK_STREAM_FAILURE_NOTICE` instead.

## Retention

Retention is a sliding TTL refreshed on every turn: 7 days for DMs (`privateDays`) and 15 days for channels (`channelDays`).
Expiry is scheduled at that many days times 86400 seconds, then prior `expireConversation` schedules are cancelled.
When the latest expiry fires, the Durable Object is destroyed.
That destroy is the product's only conversation deletion mechanism.
An active conversation can therefore remain stored longer than 7 or 15 calendar days.
Delivery events and reply text are persisted before output sanitization; closing a delivery does not erase that record.
Expiry deletes the application's Durable Object state, not messages already sent to Slack or data subject to external service retention policies.

## Business tools and skills

This repository stays business-neutral: your tools live in an MCP server you operate, and your procedures ship as Agent Skills.
Both are declared in `apps/slack-agent/agent.config.ts`, so extending the agent never means editing agent code.

### Connect your MCP server

```ts
export default defineAgentConfig({
  // ...the rest of your configuration
  mcpServers: [
    {
      authSecret: "CRM_MCP_TOKEN",
      name: "crm",
      requireApproval: ["create_organization"],
      tools: ["create_organization", "find_organization"],
      url: "https://mcp.internal.example.com/mcp",
    },
  ],
});
```

Each entry takes these fields:

- `name` (required): the identifier every tool of that server carries.
- `url` (required): the server endpoint, which must be HTTPS.
- `authSecret` (optional): the name of a Worker secret holding the bearer token, read on each request so a rotated token needs no redeploy.
- `tools` (optional): an allowlist of tool names to mount; the connection fails if the server does not expose one of them.
- `optional` (optional): when `true`, an unreachable server leaves the turn running without its tools instead of failing it.
- `requireApproval` (optional): tool names whose calls wait for a person's Approve/Reject in the Slack thread; every name must appear in `tools` when that allowlist is set.

The model sees a mounted tool as `mcp__<name>__<tool>`, so the `crm` entry above exposes `mcp__crm__create_organization`.
Store the token as a Worker secret rather than in the config file:

```sh
bunx wrangler secret put CRM_MCP_TOKEN --config apps/slack-agent/wrangler.deploy.json --env staging
```

Enter the token at Wrangler's prompt.
An MCP server you connect influences your agent: its tool descriptions enter the prompt and its tool results enter the conversation.
Treat a server you do not control like any other third-party dependency, and use `tools` to bound what it exposes.

### Approve a call before it runs

A tool named in `requireApproval` still mounts, so the model can call it, but the call is stopped on its way to the MCP server.
The bot posts an Approve/Reject card carrying that exact tool and its arguments into the thread that asked, and answers the model that nothing has been executed.
Only the person who asked can decide, only from that thread, and only within ten minutes.
Approving runs the call once, when the model repeats it with the same arguments; a second click, an expired request, a rejection, and a call with different arguments never run it.
An approval gives the model ten minutes from the click to repeat the call.
Rejecting tells the model the call was rejected so it can tell the user.
The same call stays refused until ten minutes after it was requested; repeating it after that posts a new card.
Slack interactivity has to be enabled for the app: `bun run manifest` enables it at `/channels/slack/interactions` as soon as one server requires approval.

### Add a skill

A skill is a directory containing a `SKILL.md` file: frontmatter names it, and the body carries the procedure.
Create the directory next to the config, then import it and mount it.

```text
apps/slack-agent/skills/refunds/
└─ SKILL.md
```

```markdown
---
name: refunds
description: Process a customer refund request end to end. Use when a customer asks for a refund or disputes a charge.
---

1. Confirm the order ID and the reason for the refund.
2. Issue the refund with the `mcp__crm__create_refund` tool.
```

```ts
import refunds from "./skills/refunds/SKILL.md";

export default defineAgentConfig({
  // ...the rest of your configuration
  skills: [refunds],
});
```

The `name` must match the directory name.
Only the description is always in context, so it carries the routing decision: state what the skill does and when to use it.
The instructions load when the model activates the skill, and any other file in the directory, such as a `POLICY.md`, is packaged and read only on demand.
The build packages the whole directory into the Worker, so a skill directory must contain no secrets or private keys.
Two skills that share a name are rejected when the config is defined.

## Reading Slack conversations

Reading Slack is opt-in, with the `read` option in `apps/slack-agent/agent.config.ts`:

```ts
export default defineAgentConfig({
  // ...the rest of your configuration
  read: {
    lookbackSeconds: 86_400,
    maxMessages: 200,
  },
});
```

`read` mounts two read tools for the model, and a third in a channel conversation:

- `read_thread` pages `conversations.replies` to the end of one thread.
- `read_channel_since` reads the messages posted in one channel after a cursor, oldest first, and expands the parents whose `latest_reply` is after that cursor, because `conversations.history` returns top-level messages only.
- `mention_member` tags a member of the conversation's channel, named by user ID, display or real name, or one word of it.
  It refuses anyone outside the channel and a name several members share, and the tag closes the reply instead of riding in the model's text.

Both return compact records - author display name, timestamp, permalink, text - plus a coverage block, and both are bounded by `maxMessages` per call.
`lookbackSeconds` bounds how far before the cursor `read_channel_since` scans for thread parents.
The defaults are 86400 seconds and 200 messages.

### The coverage contract

A result carries `coverage: { oldest, latest, lookback, parentsExpanded, truncated, nextCursor }`.
`oldest` is the earliest point the call looked at and `latest` the newest it reached, `parentsExpanded` counts the threads it expanded, and `truncated` says the `maxMessages` bound cut the returned messages short, in which case `nextCursor` names the last message returned.
A truncated result is resumable: call the tool again with `oldest` set to `nextCursor`, and continue until `truncated` is false and `nextCursor` is null.
A reply under a parent older than the lookback is outside the scan, so it is not returned; `oldest` names that boundary, which is what makes the gap visible instead of silent.

### The read bound comes from trusted code

The model never chooses which conversation a read may touch.
In a channel conversation the tools read only the channel and thread of the delivered message, taken from the delivery binding, and any other channel argument is refused.
In the owner's DM the model may name a channel, and the read happens only if that channel carries the admission an allowlisted user's invitation wrote.
An owner is a user named in `allowedUserIds`; any other DM, and every DM while `allowedUserIds` is unset, reads only its own conversation.

The per-channel watermark in D1 (`slack_read_cursors`, migration `0004_slack_read_cursors.sql`) records how far `read_channel_since` has covered a channel.
It advances only as far as coverage is complete: to the last returned message of a truncated page, or to the moment of a read that reached the end of its window, and never past an `oldest` that skips ahead of the stored cursor.
Slack stays the source of truth: that cursor is the only thing stored, no message is mirrored, and the tools use the bot token you already configured.
The admission in D1 (`slack_channel_admissions`, migration `0005_slack_channel_admissions.sql`) records which allowlisted user invited the bot to a channel and when, and every read checks it before its first Slack call.

The option adds four more bot token scopes: `channels:history` and `groups:history` to read public and private channels, `mpim:history` to read group DMs, and `users:read` to resolve author display names, cached per call, and the members a tag names.
Add them in your Slack app and reinstall it; `bun run manifest` includes them as soon as `read` is set.

## Reporting task progress

An orchestrator you operate can report a task's milestones to a channel, and the bot keeps one thread per task: a root message showing the task's title and current status, and every milestone as a reply in that thread.
The option is opt-in, with the `progress` block in `apps/slack-agent/agent.config.ts`:

```ts
export default defineAgentConfig({
  // ...the rest of your configuration
  progress: {
    authSecret: "SLACK_PROGRESS_BEARER",
    labels: {
      started: "Started",
      progress: "In progress",
      blocked: "Blocked",
      pr: "Pull request",
      review: "In review",
      merged: "Merged",
      done: "Done",
    },
    narration:
      "Write in Spanish, warm and brief, as one or two sentences for the team.",
  },
});
```

`authSecret` names the Worker secret holding the bearer token the sender presents, and `labels` names the word each status kind shows in the root message.
`narration` is optional and names the voice the replies are written in.
With it, each milestone is a short agent turn in that task's thread instead of the curated line posted as given: the turn rewrites the milestone in that voice, sees the earlier milestones of the thread as context, and answers with one or two sentences that restate only what those milestones say.
Without it, milestones are posted exactly as the sender wrote them.
Either way the thread owes the milestone an answer: when a narrated turn cannot deliver, the thread gets the curated line rather than the generic failure notice, and a milestone is never silently dropped.
Store the token as a Worker secret rather than in the config file:

```sh
bunx wrangler secret put SLACK_PROGRESS_BEARER --config apps/slack-agent/wrangler.deploy.json --env staging
```

It mounts `POST /progress` and `GET /progress/channels`; without the block neither route exists and nothing else changes.
The sender posts one milestone per event:

```sh
curl --fail https://your-worker.example.com/progress \
  --request POST \
  --header "authorization: Bearer $SLACK_PROGRESS_BEARER" \
  --header "content-type: application/json" \
  --data '{"id":"evt-9f2c","task":"release-42","title":"Release 42","channel":"C0123456789","kind":"pr","text":"Opened the release pull request","url":"https://github.com/you/repo/pull/7"}'
```

A success answers `200 {"ok":true}`; a refusal answers a 4xx with `{"ok":false,"error":"..."}` and calls Slack not at all.

A client that would rather not store an id lists the channels the bot may post to:

```sh
curl --fail --header "authorization: Bearer $SLACK_PROGRESS_BEARER" \
  https://your-worker.example.com/progress/channels
```

It answers `{"ok":true,"channels":[{"id":"C0123456789","name":"sandbox","kind":"channel"}]}`: one entry per admitted channel, where `kind` is `channel`, `private`, or `group` (a group DM) and `name` is the channel's name, or `null` for a channel Slack will not describe.
It takes the same bearer and answers `401` without it.

- `id` identifies the event: a retry with an id that already posted is a no-op that still answers success.
- `task` identifies the task inside the channel; its first event posts the root and stores the root timestamp in D1 (`slack_progress_roots`, migration `0006_slack_progress_roots.sql`), and later events reply in that thread.
- `kind` is one of `started`, `progress`, `blocked`, `pr`, `review`, `merged`, `done`; the root reads `<title> · <label of the kind>` and is edited whenever that text changes, so the root always shows the task's current status.
  A root Slack refuses to edit is logged and the milestone still gets its reply; when Slack answers that the root is gone, the next milestone posts a fresh one.
- `text` and its optional `url` are the milestone: without `narration` they post as the reply, with `url` on the line below `text`, and with it `text` is what the turn rewrites and what the thread falls back to when that turn cannot deliver.
  A narrated reply carries `url` the same way: trusted code closes it with the link, so the model never retypes it.
- `mentions` is an optional list of up to 10 members of the destination channel to tag, each a user ID, a display or real name, or one word of it.
  The tags close the reply next to `url`, whether the reply is narrated or posted as given.
  Resolving them reads `users.list`, so it needs the `users:read` scope the `read` option adds.
- `title`, `text`, `id`, `task`, `channel` and `url` are bounded, `url` must be HTTPS, and `channel` names the destination as an id or as a name.
  A name may carry its leading `#` and is compared case-insensitively against the admitted channels, so either form must already carry the admission an allowlisted user's invitation wrote.

The refusals are `401` for a missing or wrong bearer, `400` for a body that is not a milestone, `403` for a channel the admission does not cover, and `409` for a name several admitted channels answer to.
A mention no channel member matches answers `422` `unknown_mention`, and one several members share answers `409` `ambiguous_mention` with their `candidates`; both name the `mention` and post nothing.
A Slack failure answers `500` so the sender can retry, and the retry is deduplicated by `id` once a request has succeeded.
`chat:write` covers both `chat.postMessage` and `chat.update`, so the option adds no scope.
Milestone content arrives curated: without `narration` it is posted as given, and with it the bot only restates what the milestone and the thread's earlier milestones already say.

## Who can talk to the agent

By default any eligible human in the workspace can mention the agent or DM it.
Set `allowedUserIds` to the Slack user ids that may start a turn or an assistant thread, and the app ignores everyone else:

```ts
export default defineAgentConfig({
  // ...the rest of your configuration
  allowedUserIds: ["U0123ABCDEF"],
});
```

Each entry must be a Slack user id, such as `U...` or the `W...` of a migrated account; a blank entry, a name, an email address, or an empty list fails when the configuration is defined.
An event from a user who is not listed is answered `2xx` before it reaches the database, so Slack stops retrying it and it produces no reaction, no reply, and no model call.
The option is admission only: an admitted user can still ask for anything the configuration allows.
It is also what puts the bot in a channel at all: the bot acts only where an allowlisted user invited it, and any other invitation, a missing `inviter` included, is answered by leaving the channel at once, reading nothing there, and DMing every user in `allowedUserIds` the channel it left and who added it.
Joins by other members are ignored, and while `allowedUserIds` is unset any user's invitation admits the channel, while a join with no `inviter` still leaves it.

## Self-hosting

You need Git, Bun **1.3.14**, a Cloudflare account with Workers AI enabled for the default model, and permission to create and install a Slack app in your workspace.
Workers, Durable Objects, D1, and Workers AI inference use your Cloudflare account's quotas and billing; a brokered model spends the credential your broker holds instead.
One deployment serves one Slack app in one workspace.
Run the commands below from the repository root.

### 1. Install and verify

```sh
git clone https://github.com/cgaravitoq/agentic-slack.git
cd agentic-slack
bun install --frozen-lockfile
bun run verify
```

Verification builds a neutral Worker without deploying or requiring your Cloudflare credentials.

### 2. Configure your database

```sh
cp apps/slack-agent/wrangler.jsonc apps/slack-agent/wrangler.deploy.json
bunx wrangler login
bunx wrangler d1 create agentic-slack-staging --config apps/slack-agent/wrangler.deploy.json --env staging
```

Keep `wrangler.deploy.json` local: Git ignores it, along with `.env*` and `.dev.vars*` files except explicitly named examples.
In that file, set the `database_name` and `database_id` returned by Wrangler on `env.staging.d1_databases[0]`.
For an existing deployment, use its existing database rather than creating a replacement.
Keep the `flue-class-FlueSlackAgentAgent` SQLite migration: Flue injects the Durable Object binding at build time, but does not inject this migration.

```sh
bun run db:migrate:staging
```

This applies the checked-in deduplication, approval, channel admission, Slack read cursor, and progress root schemas to the database in your local deployment configuration.
`bun run db:migrate:local` only migrates the local development store.

### 3. Create the Slack app

At [Slack apps](https://api.slack.com/apps), create an app **From scratch** in your intended workspace.
Under **OAuth & Permissions**, add these bot token scopes and install the app to your workspace:

- `app_mentions:read`
- `assistant:write`
- `channels:manage`
- `channels:read`
- `chat:write`
- `groups:read`
- `groups:write`
- `im:history`
- `mpim:read`
- `mpim:write`
- `reactions:write`

The bot token scopes are the neutral default.
`channels:read` and `groups:read` are what deliver a join in a public or private channel, and `channels:manage` and `groups:write` are what let the bot leave one.
`mpim:read` and `mpim:write` do the same for a group DM.
An agent configuration with the `read` option also needs `channels:history`, `groups:history`, `mpim:history`, and `users:read`; `bun run manifest` generates them with the rest.

Copy the bot token from **OAuth & Permissions** and the signing secret and app ID from **Basic Information**.
Open Slack in a browser; the workspace ID is the `T...` segment in `https://app.slack.com/client/T.../C...`.
See [Slack's workspace ID guide](https://slack.com/help/articles/221769328-Locate-your-Slack-URL-or-ID) for details.
In `wrangler.deploy.json`, add `env.staging.vars` with `SLACK_TEAM_ID` and `SLACK_APP_ID` set to those IDs.
Only these two identifiers belong in `vars`; the bot token and signing secret are Worker secrets.

### 4. Deploy and connect Slack

```sh
bun run deploy:staging
bunx wrangler secret put SLACK_SIGNING_SECRET --config apps/slack-agent/wrangler.deploy.json --env staging
bunx wrangler secret put SLACK_BOT_TOKEN --config apps/slack-agent/wrangler.deploy.json --env staging
```

Enter each secret at Wrangler's prompt.
Do not put secret values in shell commands or configuration files.
The first deployment remains unready until all four Slack settings are present.
The deploy command preserves dashboard-managed variables with `--keep-vars`.

Use the HTTPS URL printed by deployment:

```sh
bun run manifest https://your-worker.example.com
curl --fail https://your-worker.example.com/health
```

Replace the example URL with your deployed Worker URL in both commands.
Paste the generated JSON into the existing Slack app's **App Manifest** and save it.
If Slack requests reinstallation or URL verification, complete it after the Worker secrets and IDs are configured.
The event endpoint is `/channels/slack/events`.
The manifest enables the Messages tab, agent messaging, mentions, DMs, assistant thread events, and channel joins; it enables interactivity at `/channels/slack/interactions` as soon as one MCP server requires approval.
Org deploy, socket mode, and token rotation remain disabled.
A ready health response is `{"status":"ready"}`; HTTP 503 lists missing binding names without revealing values.

### 5. Check the first conversation

Invite the app to a test channel from a user listed in `allowedUserIds`, then send `@Slack Agent Reply with: hello`.
An invitation from anyone else is answered with a leave and a DM instead; that is the guard working, not a failure to diagnose.
Confirm that it acknowledges the mention and streams its reply into that thread.
Send a follow-up mention in the same thread, then a DM to check both conversation surfaces.
A successful `/health` response checks configuration presence; it does not prove Slack delivery or model inference.

If nothing arrives, check the app's installation, channel membership, workspace/app IDs, and Event Subscriptions URL verification.
Use Cloudflare's Worker logs to inspect failed event handling.
Do not include message contents or credentials in public bug reports.

## Automated deployment

`.github/workflows/ci.yml` verifies pull requests against `staging` and `main`, including dependency advisories.
`.github/workflows/deploy.yml` verifies and deploys pushes to `staging`.
Before enabling deployments in your fork, configure its GitHub `staging` environment:

- Secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, scoped to your own account and required resources.
- Variable: `WRANGLER_CONFIG_JSON`, containing your complete local `wrangler.deploy.json` configuration, without Slack tokens or signing secrets.

The workflow writes that operator configuration to an ignored file only after verification, then migrates D1, deploys, and checks health.
It fails before migration when the configuration variable is missing.
Existing operators must preserve their current Worker name, D1 ID, and Durable Object migration when populating it.
The Slack secrets stay on the Worker and are provisioned separately.

Protect your integration branch with the `verify` status check and restrict the `staging` environment to deployments from `staging`.
This repository currently develops on `staging`; there is no tagged stable release yet.
Do not use `main` as a substitute for a tested release without comparing its revision.

## Consume a pinned copy

An operator repository can pin this repository, for example as a git submodule, and keep its own agent configuration, skills, and deployment configuration outside it.
That way a deployment consumes a commit of this repository instead of forking it, and never edits a file inside it.

```text
operator-repo/
├─ agentic-slack/          # this repository, pinned to a commit
├─ skills/
│  └─ refunds/SKILL.md
├─ agent.config.ts
└─ wrangler.deploy.json
```

Build with `AGENT_CONFIG` set to your configuration file, from the root of the pinned repository:

```sh
AGENT_CONFIG="$HOME/operator-repo/agent.config.ts" bun run deploy:dry
```

`AGENT_CONFIG` takes an absolute path or a path relative to the working directory, and it defaults to `apps/slack-agent/agent.config.ts`, so the in-repo configuration stays in effect when the variable is unset.
The development server reads it the same way.
Reach `defineAgentConfig` and your skills through the pinned tree, so your configuration typechecks against `AgentConfig` from `@agentic-slack/core` and the build packages each skill's `SKILL.md` and supporting files:

```ts
import { defineAgentConfig } from "./agentic-slack/packages/core/src/index.ts";
import refunds from "./skills/refunds/SKILL.md";

export default defineAgentConfig({
  // ...the rest of your configuration
  skills: [refunds],
});
```

A dependency that resolves `@agentic-slack/core` through your own `node_modules` works too.
`bun run manifest` and the `db:migrate:*` scripts still read the in-repo configuration and the in-repo Wrangler files.

## Security and support

Slack requests pass signature verification and must match the configured workspace and app before a turn is admitted.
When `allowedUserIds` is set, only those users can start a turn or an assistant thread; everyone else's event is answered `2xx` and dropped before it reaches the database.
When the option is unset, any eligible human in that workspace who can reach the installed app can interact with it or invite it to a channel.
Delivery destinations come from trusted event data, not model output.
The Slack read tools read only the conversation the delivered message came from and the channels an allowlisted user invited the bot to; with the `read` option unset the agent has no way to read a conversation it was not addressed in.
The `progress` routes exist only when the configuration names them, every request must carry its bearer secret, the channel listing describes only the channels an allowlisted user's invitation admitted, and a milestone posts only into one of them.
A tool the operator gates with `requireApproval` reaches its MCP server only after the person who asked approves that exact call in the thread it came from.
Instructions and output filtering reduce accidental disclosure but do not make untrusted prompts safe to receive credentials.
Conversation data is processed by Slack, by Cloudflare, and by the model provider your configuration selects.
Tracing is enabled with model content capture disabled in the application configuration.

For a suspected vulnerability, use GitHub's **Report a vulnerability** option on the repository's Security tab when it is enabled.
If that option is unavailable, request a private contact channel from the maintainer without including vulnerability details.
Do not disclose credentials, exploit details, or private conversations in public issues.
For ordinary bugs, include your revision, Bun version, sanitized configuration, reproduction steps, and expected versus actual behavior.
Contributions should stay focused and pass `bun run verify`; external integrations and new agent behavior require an agreed scope.

Licensed under [Apache-2.0](LICENSE).

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
