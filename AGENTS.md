# Agent Instructions

## Scope

Keep this repository provider-neutral and self-hosted.
Add product behavior only when a task explicitly requires it.
Do not add resource identifiers, tokens, secrets, or generated deployment configuration.

## Code

Do not comment unless the comment states a non-obvious why the code cannot express.
Do not add speculative abstraction.
A deleted extra-package hook is why that rule exists.
Use English for code, comments, documentation, commits, branches, issues, and pull requests.

## Development

Use Bun and preserve exact dependency versions in `bun.lock`.
Keep `trustedDependencies` empty.
Use strict TypeScript and the existing formatter and linter.

The pull request CI gate is `.github/workflows/ci.yml`.
It runs these commands in this order:

1. `bun install --frozen-lockfile`
2. `bun run format:check`
3. `bun run lint`
4. `bun run typecheck`
5. `bun test`
6. `bun run knip`
7. `bun run deploy:dry`
8. `bun audit`

Run `bun run verify` before publishing changes.
That script is the same sequence after install.
`.github/workflows/deploy.yml` runs `bun run verify` on every push to `staging`.

## Git

Use conventional commit messages.
Stage only files changed for the current task.
Do not commit, push, or open pull requests without explicit authorization.
