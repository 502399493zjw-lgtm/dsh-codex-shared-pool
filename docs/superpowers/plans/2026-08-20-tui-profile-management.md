# Codex TUI Profile Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/codex` expose the same essential multi-profile lifecycle already available through Host HTTP routes: list, add, cancel, prioritize, rename, and remove.

**Architecture:** Keep OAuth and credentials inside the existing Host-owned `OpenAICodexService` and `OpenAICodexCredentialStore`. Extend the service with profile-safe operations, then have the existing TUI controller own one cancellable login operation for either initial login or profile addition. Command output contains only profile ids, labels, timestamps, and bounded/redacted errors.

**Tech Stack:** TypeScript 6, Cordis public `commands`/`tuiCommandTrees` services, Vitest, existing pi-ai OAuth lifecycle.

## Global Constraints

- Target stock DSH `0.1.0-rc.7`; use only published Cordis/DSH extension points.
- Host code alone may access OAuth credentials and the profile document.
- Do not expose access tokens, refresh tokens, auth files, or raw provider errors through command results.
- Preserve current ordered-profile allocation semantics: the first profile is global priority.
- Do not commit, push, or publish without explicit user authorization.

---

### Task 1: Host service profile facade

**Files:**
- Modify: `src/service.ts`
- Test: `tests/tui.spec.ts`

**Interfaces:**
- Consumes: `loginOpenAICodexProfile(interaction, store)`, `OpenAICodexCredentialStore.listProfiles()`, `prioritizeProfile()`, `renameProfile()`, and `removeProfile()`.
- Produces: `loginProfile(interaction)`, `listProfiles()`, `prioritizeProfile(profileId)`, `renameProfile(profileId, label)`, and `removeProfile(profileId)` on `OpenAICodexService`.

- [x] **Step 1: Write the failing command test**

Create a fake `commands` Cordis surface that captures the registered `codex` handler and a fake service whose profile operations are spies. Assert that `profiles`, `activate`, `rename`, and `remove` invoke only the corresponding secret-free service methods.

```ts
expect(await run('activate profile-2')).toEqual({ kind: 'success', text: 'Codex profile profile-2 now has global priority.' })
expect(service.prioritizeProfile).toHaveBeenCalledWith('profile-2')
```

- [x] **Step 2: Run the focused test and confirm failure**

Run: `pnpm exec vitest run tests/tui.spec.ts`

Expected: FAIL because the command currently returns the legacy help text and the service facade is absent.

- [x] **Step 3: Add the minimal service methods**

Delegate to the existing store without returning credentials:

```ts
loginProfile(interaction: AuthInteraction): Promise<CodexProfileSummary> {
  return loginOpenAICodexProfile(interaction, this.credentials)
}

listProfiles(): Promise<readonly CodexProfileSummary[]> {
  return this.credentials.listProfiles()
}
```

Add equivalent one-line delegates for prioritize, rename, and remove.

- [x] **Step 4: Re-run the focused test**

Run: `pnpm exec vitest run tests/tui.spec.ts`

Expected: profile facade assertions advance to the TUI implementation failures.

### Task 2: Cancellable multi-profile TUI commands

**Files:**
- Modify: `src/tui.ts`
- Test: `tests/tui.spec.ts`

**Interfaces:**
- Consumes: the `OpenAICodexService` profile facade from Task 1.
- Produces: `/codex profiles`, `/codex add`, `/codex cancel`, `/codex activate <profile-id>`, `/codex rename <profile-id> <label>`, and `/codex remove <profile-id>` plus matching completion nodes.

- [x] **Step 1: Complete failing behavior coverage**

Cover profile formatting, multi-word rename labels, exact argument validation, concurrent add/login reuse, cancellation, and secret redaction:

```ts
expect(await run('rename profile-2 Work Account')).toMatchObject({ kind: 'success' })
expect(service.renameProfile).toHaveBeenCalledWith('profile-2', 'Work Account')
expect((await run('remove')).kind).toBe('error')
```

- [x] **Step 2: Run the focused test and confirm failure**

Run: `pnpm exec vitest run tests/tui.spec.ts`

Expected: FAIL for every new subcommand while the existing status/config behavior remains green.

- [x] **Step 3: Implement the command/controller changes**

Generalize the login controller to start either an initial login or isolated profile addition, add an explicit cancel method, and extend the command switch. Keep the profile list projection metadata-only:

```ts
const profiles = await service.listProfiles()
return success(profiles.length === 0
  ? 'No OpenAI Codex profiles are stored.'
  : profiles.map((profile, index) => `${index === 0 ? '*' : '-'} ${profile.id}: ${profile.label}`).join('\n'))
```

- [x] **Step 4: Run focused tests**

Run: `pnpm exec vitest run tests/tui.spec.ts tests/safe-message.spec.ts`

Expected: PASS.

### Task 3: Documentation and delivery gates

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-19-full-dsh-codex-independent-packaging.md`
- Modify: `docs/superpowers/plans/2026-08-20-tui-profile-management.md`

**Interfaces:**
- Consumes: verified command behavior from Tasks 1–2.
- Produces: an accurate user command reference and evidence-linked acceptance status.

- [x] **Step 1: Document the command surface**

Add the exact `/codex` profile commands and state that token refresh remains provider-driven and automatic on request.

- [x] **Step 2: Run complete verification**

Run:

```bash
pnpm test
pnpm run build
pnpm exec tsc --noEmit
pnpm run verify:package
pnpm pack
git diff --check
```

Expected: all commands exit 0; real PostgreSQL tests may remain skipped locally when no integration URL is configured.

- [x] **Step 3: Update plan evidence without overclaiming**

Mark this plan complete and mark the older HTTP/TUI lifecycle item with exact
source/test evidence. Keep its separate Browser UI item unchecked until
Settings rename wiring and refreshed visual evidence are finished.

- [x] **Step 4: Report exact state**

Report changed files, actual commands/results, package-format versus stock-DSH evidence, remaining Settings rename gap, and `git status --short --branch`. Do not create a commit.
