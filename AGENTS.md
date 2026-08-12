# Agent Instructions

## Scope

Keep this repository provider-neutral and self-hosted.
Add product behavior only when a task explicitly requires it.
Do not add resource identifiers, tokens, secrets, or generated deployment configuration.

## Development

Use Bun and preserve exact dependency versions in `bun.lock`.
Keep `trustedDependencies` empty.
Use strict TypeScript and the existing formatter and linter.
Run every root verification command before publishing changes.

## Git

Use English for code, documentation, commits, branches, issues, and pull requests.
Use conventional commit messages.
Stage only files changed for the current task.
Do not commit, push, or open pull requests without explicit authorization.
