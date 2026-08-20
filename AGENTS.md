# AGENTS.md

This repository is the single public project and installation boundary for the DSH Codex Shared Pool community plugin. It targets stock DeepSeek Harness through published Cordis extension points; do not add product code to a `deepseek-harness` fork.

## Task start

Before editing, inspect `git status --short --branch`, the relevant diff, and applicable instructions. Treat existing changes as user-owned. Keep each independent task on a `codex/` branch or Codex-managed worktree; do not edit `main` or `master` directly.

## Product boundaries

- One npm package contains the Host entry, browser entry, shared JSON-safe types, and `cordis.patch.yml`.
- Host code alone owns credentials, authentication files, Codex app-server access, subprocesses, and filesystem access.
- Browser code receives only typed, minimum-necessary projections over plugin-owned same-origin routes.
- Use documented Cordis services and DSH client slots. Do not patch DSH core, Web, Session, Remote, or generated catalogs from this repository.
- Pin compatibility to a verified DSH release. A wider version range requires stock-install evidence.

## Workflow

Write a focused failing test before behavior changes. Run focused tests, then `pnpm run build` and `pnpm run verify:package`. For installation changes, pack the plugin and install that tarball into an isolated `DSH_HOME` using the pinned published DSH CLI.

Do not commit credentials, `.env` contents, Codex authentication data, account data, or machine-specific paths. Do not commit, push, publish, create a remote repository, or rewrite history unless the user explicitly requests it. Preserve unrelated changes and never use destructive Git cleanup commands.

## Handoff

Report the user-visible result, files changed, commands actually run, failures or unverified risks, and exact Git state. Distinguish a package-format check from a real stock-DSH installation smoke test.
