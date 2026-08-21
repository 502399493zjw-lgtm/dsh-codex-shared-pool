# AGENTS.md

This repository is the single public project and installation boundary for the DSH Codex Shared Pool community plugin. It targets stock DeepSeek Harness through published Cordis extension points; do not add product code to a `deepseek-harness` fork.

## Task start

Before editing, inspect `git status --short --branch`, the relevant diff, and applicable instructions. Treat existing changes as user-owned. Fetch the existing remote and create each independent `codex/` task branch or Codex-managed worktree from the latest remote default branch unless the user names a release, tag, or commit; if the remote cannot be checked, report that the base may be stale. Do not edit `main` or `master` directly.

## Product boundaries

- One npm package contains the Host entry, browser entry, shared JSON-safe types, and `cordis.patch.yml`.
- Host code alone owns credentials, authentication files, Codex app-server access, subprocesses, and filesystem access.
- Browser code receives only typed, minimum-necessary projections over plugin-owned same-origin routes.
- Use documented Cordis services and DSH client slots. Do not patch DSH core, Web, Session, Remote, or generated catalogs from this repository.
- Pin compatibility to a verified DSH release. A wider version range requires stock-install evidence.

## Workflow

Write a focused failing test before behavior changes. Run focused tests, then `pnpm run build` and `pnpm run verify:package`. For installation changes, pack the plugin and install that tarball into an isolated `DSH_HOME` using the pinned published DSH CLI.

Do not commit credentials, `.env` contents, Codex authentication data, account data, or machine-specific paths. Preserve unrelated changes and never use destructive Git cleanup commands.

For this repository, a request to fix, optimize, implement, or otherwise change the project authorizes the normal GitHub delivery loop after validation: commit only the task-owned diff, push the `codex/` task branch, create or update its PR, include the user-visible change, validation results, media provenance when applicable, and unverified risks, then read the PR and CI status. Do not ask for a second confirmation before those steps. A local-only request overrides this default.

This standing authorization does not include merging the PR, publishing npm, creating a Release or remote repository, changing visibility, rewriting history, or other consequential follow-up actions. When the next useful step needs human review, credentials, a product decision, new authorization, merge, or release, proactively ask whether the user wants to proceed and state the exact action and impact.

## Handoff

Report the user-visible result, files changed, commands actually run, failures or unverified risks, and exact Git state. Distinguish a package-format check from a real stock-DSH installation smoke test.
