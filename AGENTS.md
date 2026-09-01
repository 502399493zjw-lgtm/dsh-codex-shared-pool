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

Do not commit credentials, `.env` contents, Codex authentication data, account data, or machine-specific paths. Preserve unrelated changes and never use destructive Git cleanup commands.

## Git and pull request workflow

After the required tests and verification checks pass, the agent should by default create focused commits, push the task branch, and open a draft pull request. Do not include unrelated user-owned changes in the commits. Do not create a remote repository, rewrite history, publish packages, or deploy to shared environments unless the user explicitly authorizes that action.

Every agent-created pull request must receive an independent subagent review before it is presented for merge approval. The review must focus on the changes introduced by the pull request relative to its target branch: the changed behavior and implementation, tests added or modified for the change, affected interfaces and security boundaries, and compatibility risks. Read adjacent code only where necessary to understand the impact of the diff; this review is not a general audit of the entire repository. Pre-existing issues outside the changed scope should not block the pull request unless the change introduces, exposes, or materially worsens them.

Fix blocking findings in the same pull request and request another change-scoped subagent review. Once the review has no blocking findings and the required checks pass, report the pull request, verification evidence, review conclusion, and remaining risks to the user. Never merge without the user's explicit confirmation.

Task-specific instructions override this default workflow. In a designated multi-worktree integration workflow, worker tasks should create focused commits and hand them off with test evidence and integration notes. Only the integration task should combine the worker changes, push the integration branch, open the final pull request, and request the final change-scoped subagent review.

## Shared environments

Do not install into or restart shared DSH instances, including ports 3181 and 3197, unless the task explicitly authorizes it. Never restart a service that may hold in-memory state without warning. When multiple worktrees are active, deployment and real OAuth or visual acceptance testing belong to the designated integration task.

## Handoff

Report the user-visible result, files changed, commands actually run, failures or unverified risks, and exact Git state. When a pull request exists, also report its target branch, verification status, subagent review conclusion, fixes made in response to review, and whether it is waiting for user merge approval.

Distinguish unit or DOM tests, package-format verification, isolated stock-DSH installation smoke tests, shared target-environment verification, and real provider OAuth verification. Do not present one level of evidence as proof of another.
