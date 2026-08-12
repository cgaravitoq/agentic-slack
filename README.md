# Agentic Slack

Agentic Slack is a self-hosted agent runtime for Slack on Cloudflare Workers.

This Bun monorepo contains a provider-neutral Slack agent core and a Cloudflare Worker composition.
The core admits signed mentions and private messages, keeps one durable conversation per Slack thread, deduplicates events in D1, and binds safe terminal delivery to the originating conversation.

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
