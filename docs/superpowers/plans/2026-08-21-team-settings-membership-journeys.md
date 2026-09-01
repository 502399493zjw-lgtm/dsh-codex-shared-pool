# Team Settings Membership Journeys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Team Settings a complete, recoverable membership control surface covering invitation creation, invitation preview, joining, pending-join recovery, roles, member removal, leaving, and device disconnection without exposing Team or OAuth credentials to the Browser.

**Architecture:** Keep the Browser on same-origin, typed management routes; keep raw Team keys in the local Host credential provider; and keep durable membership transitions in the central Team store. Invitation acceptance remains one-time and row-locked, while a Host-only pending credential makes joining recoverable if the remote commit or local credential promotion is interrupted.

**Tech Stack:** TypeScript, React, Cordis exact routes, DSH credential provider, PostgreSQL 17, Vitest, Testing Library, CSS Modules, DSH client UI primitives.

## Global Constraints

- Work only in the repository worktree on `codex/team-phase-two-split`.
- Treat every existing modified and untracked file as user-owned; preserve unrelated changes.
- Write a focused failing test before every behavior change.
- Host code alone owns raw Team keys, pending credentials, subprocesses, and filesystem access.
- The Browser receives only typed, minimum-necessary, JSON-safe projections over same-origin plugin routes.
- Invitation tokens are one-time bearer secrets: never put them in a URL, query string, log, screenshot, persisted Browser storage, or overview response.
- Joining always creates a `member`; only an active Owner can later promote that member to `admin`.
- No new dependency, email delivery system, public signup page, suspended-member workflow, or identity-provider integration is introduced.
- Do not commit, push, publish, or merge unless the user explicitly requests it.
- After focused tests, run `pnpm run build` and `pnpm run verify:package`; distinguish package verification from a stock-DSH tarball installation smoke test.

---

## Product and Interaction Contract

### Subject, audience, and single job

This is the membership console for a small, trusted group sharing Codex capacity through DSH. The audience is a Team Owner/Admin managing people and a member connecting one local DSH device. The page's single job is: **make it obvious who has access, how a new person gains access, and what each exit action revokes**.

### Information architecture

The account-sharing workspace remains the primary Team surface. The existing **Team Settings** action opens the secondary administration surface with three ordered sections:

1. **Team access** — active/paused state, server origin, current role, refresh, and device connection actions.
2. **People** — active members, role controls, ownership transfer, member removal, and self-leave.
3. **Invitations** — create a labeled one-time invitation and revoke pending invitations.

Usage remains in the existing activity section and is not mixed into the membership flow.

### Visual direction

- Reuse the current DSH semantic palette: Team blue `#3964fe`, success green `#168f61`, warning amber `#b76800`, danger red `#c83b50`, primary ink `#1f2329`, and the shell's layer/border variables.
- Reuse the shell typography; do not introduce a web font or a second visual system inside Settings.
- The signature element is a compact, meaningful three-stage **access rail** shown only while joining: `Invitation → This device → Team access`. It is a real sequence, not decorative numbering.
- Keep animation to one transition between invitation preview and confirmation; respect `prefers-reduced-motion`.
- Use sentence-case action copy with exact outcomes: “Check invitation”, “Join Team”, “Revoke invitation”, “Remove member”, “Disconnect this device”.

### Disconnected and recovery wireframe

```text
┌─ Join a Team ─────────────────────────────────────────────┐
│ Invitation ───── This device ───── Team access            │
│                                                           │
│ Invitation code  [ dsh_invite_•••••••••••••••••••• ]     │
│                                      [Check invitation]    │
└───────────────────────────────────────────────────────────┘

After a valid preview:
┌─ Friends Lab ─────────────────────────────────────────────┐
│ Invitation: “Mia · work laptop”     Expires Aug 28, 18:00 │
│ Your display name  [ Mia ]                                │
│                                      [Join Team]           │
└───────────────────────────────────────────────────────────┘

Secondary disclosure: “Connect this device with an existing Team key”
```

If a Host-only pending key exists, replace the normal form with a recovery notice:

```text
A join was started on this device but did not finish.
[Finish joining]  [Discard pending join]
```

### Connected People and Invitations wireframe

```text
People (3)                                      [Invite person]
┌ E  Edison                         Owner                    ┐
├ M  Mia                            Admin        [⋯]         ┤
└ Z  阿周                           Member       [⋯]         ┘

Pending invitations (2)
┌ Mia · work laptop       Expires in 6 days   [Revoke]       ┐
└ Design reviewer         Expires tomorrow    [Revoke]       ┘
```

The raw invitation token appears only in the creation result modal. Closing that modal destroys the Browser copy. The pending list shows label, inviter, creation time, and expiry, but never shows or reconstructs the token.

### Permission matrix

| Action | Owner | Admin | Member |
|---|---:|---:|---:|
| Create/revoke invitation | Yes | Yes | No |
| Pause/resume Team | Yes | Yes | No |
| Promote member to Admin | Yes | No | No |
| Demote Admin to Member | Yes | No | No |
| Remove Member | Yes | Yes | No |
| Remove Admin | Yes | No | No |
| Transfer ownership | Yes | No | No |
| Leave Team | After transfer | Yes | Yes |
| Disconnect this device | Yes | Yes | Yes |

An Admin cannot remove an Owner or another Admin. An Owner cannot demote or remove themself; ownership transfer is the only way to change the Owner.

### Invitation state machine

```text
create
  │
  ▼
pending ── accept (row lock) ──▶ accepted
  │  │
  │  └── expiresAt reached ───▶ expired (derived on read)
  └──── revoke ────────────────▶ revoked
```

- Preview is allowed only while the token maps to a pending, unexpired invitation.
- Preview never consumes the invitation.
- A paused Team can be previewed, but confirmation is disabled and acceptance returns `409` until the Team resumes.
- Accepted, expired, revoked, malformed, and unknown tokens use the same external error: `invitation is invalid or expired`.
- Acceptance is atomic: lock invitation, re-check state/expiry, lock Team, create active member, create supplied member key, mark invitation accepted, commit.

### Recoverable join state machine

```text
no local key
  │ generate strong dsh_team_ key
  ▼
pending key stored by local Host
  │
  ├─ remote accept succeeds ─▶ promote to configured key ─▶ connected
  │
  ├─ remote definitely rejects ─▶ discard pending key ─────▶ disconnected
  │
  └─ timeout/5xx/process interruption ─────────────────────▶ recovery available
                                                            │
                                    overview(pending key) ───┤
                                                            ├─ valid: promote
                                    retry same invite ───────┤
                                                            └─ invalid: keep or discard explicitly
```

The central Team Host accepts the Host-generated key only to hash and register it; the Browser never receives it. The local Host stores the pending key before consuming the invite, so a committed membership always has a recoverable credential.

### Exit semantics

- **Disconnect this device:** remove only the local configured key; optionally revoke exactly that remote key. Membership and other device keys remain.
- **Leave Team:** non-Owner only; atomically mark the member removed, revoke every member key and contribution, drain admitted work, delete broker credentials, then remove the local key.
- **Remove member:** same durable cleanup as leave, initiated by an authorized Owner/Admin. Historical metadata-only usage rows remain.
- **Transfer ownership:** atomically demote the former Owner to Admin and promote the selected active member. It does not move contributions or keys.

### Required error behavior

- Inline field errors preserve the invitation token and display name while the page remains mounted.
- A stale configured Team key produces a dedicated “This device's Team key is no longer valid” state; it must not silently fall through to the normal join form.
- A read-only credential source shows its source and disables join, recovery, disconnect, and key replacement.
- Duplicate display names are allowed; identity and authorization always use member IDs.
- All secret-bearing responses use `Cache-Control: no-store` and are projected before reaching React state.

---

### Task 1: Add labeled invitation preview end to end

**Files:**
- Modify: `src/team/types.ts`
- Modify: `src/team/store.ts`
- Modify: `src/team/postgres-store.ts`
- Modify: `src/team/routes.ts`
- Modify: `src/team/index.ts`
- Test: `tests/team.spec.ts`
- Test: `tests/team-postgres.spec.ts`
- Test: `tests/team-postgres.integration.spec.ts`
- Test: `tests/team-routes.spec.ts`

**Interfaces:**
- Produces:

```ts
export const TEAM_INVITES_PREVIEW_PATH = `${TEAM_INVITES_PATH}/preview`

export interface TeamInviteCreateInput {
  readonly label: string
  readonly expiresInMs: number
}

export interface TeamInviteSummary {
  // existing fields remain
  readonly label: string
}

export interface TeamInvitePreview {
  readonly team: Pick<TeamSummary, 'name' | 'status'>
  readonly invite: Pick<TeamInviteSummary, 'label' | 'expiresAt'>
}

interface TeamStore {
  createInvite(auth: TeamAuthContext, input: TeamInviteCreateInput): Promise<TeamInviteResult>
  previewInvite(token: string): Promise<TeamInvitePreview>
}
```

- PostgreSQL migration version `9` adds `team_invites.label text NOT NULL DEFAULT 'Team invitation'` and keeps the default for one rolling-compatibility window so older central writers can continue inserting invitations. Removing it requires a later contract migration after every older writer has retired.
- This phase uses a **central-first upgrade contract**: migrate PostgreSQL and upgrade every central Team service instance before upgrading client Hosts. A new Host may read pre-label invitation rows using the safe `Team invitation` fallback, but creating invitations and joining against an older central service is intentionally unsupported because the old protocol rejects the new `label` and Host-supplied `apiKey` fields.
- Invitation labels normalize internal whitespace, must be 1–80 characters, and are metadata rather than an email address or identity claim.

- [ ] **Step 1: Write failing memory-store tests**

Add tests proving label normalization, preview without consumption, paused-Team preview, generic invalid-token errors, and the 1–80 character bound:

```ts
const created = await store.createInvite(owner, { label: '  Mia   work laptop  ', expiresInMs: 60_000 })
await expect(store.previewInvite(created.inviteToken)).resolves.toEqual({
  team: { name: 'Friends', status: 'active' },
  invite: { label: 'Mia work laptop', expiresAt: 61_000 },
})
await expect(store.previewInvite(created.inviteToken)).resolves.toMatchObject({ invite: { label: 'Mia work laptop' } })
await expect(store.createInvite(owner, { label: ' '.repeat(81), expiresInMs: 60_000 })).rejects.toThrow(/label/iu)
```

- [ ] **Step 2: Run the memory-store test and verify RED**

Run: `pnpm exec vitest run tests/team.spec.ts`

Expected: FAIL because `TeamInviteSummary.label`, the object input, and `previewInvite` do not exist.

- [ ] **Step 3: Implement types and the memory-store behavior**

Use one `nonEmpty(input.label, 'invite label', 80)` normalization path. `previewInvite` must use the hashed lookup, derive expiry without mutating or returning the token, and return only Team name/status plus label/expiry.

- [ ] **Step 4: Add PostgreSQL migration and transactional tests**

Assert the migration sequence is `1..9`, the label round-trips after store recreation, preview does not update the row, and expired/revoked tokens return the same public error. Use `SELECT label, status, accepted_at FROM team_invites WHERE id = $1` as the secret-free assertion.

- [ ] **Step 5: Add the central preview route tests**

The exact route contract is:

```http
POST /plugins/dsh-codex-shared-pool/team/invites/preview
Content-Type: application/json

{"inviteToken":"dsh_invite_..."}
```

```json
{
  "team": { "name": "Friends", "status": "active" },
  "invite": { "label": "Mia work laptop", "expiresAt": 1788000000000 }
}
```

Assert the response has `Cache-Control: no-store`, contains no `teamId`, `inviteId`, inviter member ID, token hash, API key, or credential field, and rejects unknown request fields.

- [ ] **Step 6: Run focused Team control-plane tests and verify GREEN**

Run: `pnpm exec vitest run tests/team.spec.ts tests/team-postgres.spec.ts tests/team-routes.spec.ts`

Expected: PASS. If `DSH_TEAM_POSTGRES_TEST_URL` is available, also run `pnpm run test:postgres`; otherwise report the real PostgreSQL integration as not run.

- [ ] **Step 7: Inspect the focused diff without committing**

Run: `git diff --check && git status --short --branch`

Expected: no whitespace errors; only Task 1 files plus pre-existing user changes are present.

---

### Task 2: Make joining recoverable with a Host-only pending key

**Files:**
- Modify: `src/team/types.ts`
- Modify: `src/team/client.ts`
- Modify: `src/team/store.ts`
- Modify: `src/team/postgres-store.ts`
- Modify: `src/team/routes.ts`
- Modify: `src/shared/team-management.ts`
- Modify: `src/team/management-routes.ts`
- Modify: `src/client/team/api.ts`
- Test: `tests/team.spec.ts`
- Test: `tests/team-postgres.spec.ts`
- Test: `tests/team-routes.spec.ts`
- Test: `tests/team-management-routes.spec.ts`
- Test: `tests/team-management-client.spec.ts`

**Interfaces:**
- Consumes: `TeamInvitePreview` and labeled invitations from Task 1.
- Produces:

```ts
export const DEFAULT_TEAM_CLIENT_PENDING_API_KEY_REF = credentialRef(
  'DSH_CODEX_SHARED_POOL_TEAM_API_KEY_PENDING',
)

export const TEAM_MANAGEMENT_JOIN_RECOVER_PATH = `${TEAM_MANAGEMENT_JOIN_PATH}/recover`
export const TEAM_MANAGEMENT_JOIN_DISCARD_PATH = `${TEAM_MANAGEMENT_JOIN_PATH}/discard`

export interface TeamManagementStatus {
  readonly enabled: boolean
  readonly keyConfigured: boolean
  readonly keyWritable: boolean
  readonly pendingJoinConfigured: boolean
  readonly keySource?: string
  readonly serverOrigin?: string
}

export interface TeamJoinResult {
  readonly team: TeamSummary
  readonly member: TeamMemberSummary
  // apiKey is intentionally removed
}

interface TeamStore {
  acceptInvite(token: string, displayName: string, apiKey: string): Promise<TeamJoinResult>
}
```

- `TeamManagementProxy.join()` generates `dsh_team_${randomBytes(32).toString('base64url')}` in Host code, stores it under the pending ref, calls the central join route, promotes it to the configured ref, and then removes the pending ref.
- The central join route accepts `{ inviteToken, displayName, apiKey }`; the local same-origin Browser route continues to accept only `{ inviteToken, displayName }`.

- [ ] **Step 1: Write failing store tests for a supplied member key**

```ts
const invite = await store.createInvite(owner, { label: 'Mia laptop', expiresInMs: 60_000 })
const joined = await store.acceptInvite(invite.inviteToken, 'Mia', 'dsh_team_test-member-key-1234567890')
expect(joined).not.toHaveProperty('apiKey')
await expect(store.authenticateApiKey('dsh_team_test-member-key-1234567890'))
  .resolves.toMatchObject({ memberId: joined.member.id })
await expect(store.acceptInvite(invite.inviteToken, 'Other', 'dsh_team_other-member-key-123456789'))
  .rejects.toThrow(/invalid or expired/iu)
```

Also assert duplicate API-key hashes roll back the member and invitation mutation in both memory and PostgreSQL implementations.

- [ ] **Step 2: Run store tests and verify RED**

Run: `pnpm exec vitest run tests/team.spec.ts tests/team-postgres.spec.ts`

Expected: FAIL because acceptance still generates and returns the key centrally.

- [ ] **Step 3: Register the Host-supplied key atomically**

Validate the supplied key with one shared helper: exact `dsh_team_` prefix, 24–256 total characters, URL-safe payload, and no whitespace. Hash it with SHA-256, store only the hash plus the first 18-character prefix, and leave `issueApiKey`/bootstrap generation unchanged.

PostgreSQL must insert member, key, and accepted invitation in the same transaction. Memory store must check key-hash uniqueness before mutating any collection.

- [ ] **Step 4: Write failing local management recovery tests**

Cover these exact cases with `FakeCredentials` tracking both configured and pending refs:

1. pending key is written before the remote join request;
2. successful join promotes the exact pending value and unsets pending;
3. a remote `404` discards pending;
4. a timeout or `5xx` keeps pending and returns a bounded recovery message;
5. recovery validates pending via remote overview, promotes it, and returns secret-free Team/member summaries;
6. discard removes only pending and never touches a configured key;
7. no response body or Browser route contains `dsh_team_`.

Use the ordering assertion:

```ts
expect(events).toEqual([
  'set:pending',
  'fetch:join',
  'set:configured',
  'unset:pending',
])
```

- [ ] **Step 5: Implement pending-key recovery in the local Host**

Introduce internal error classes carrying only `kind: 'definitive' | 'ambiguous'`; do not classify by parsing display strings. A non-2xx remote response below `500` is definitive. Fetch failure, timeout, `429`, and `5xx` are ambiguous and preserve pending state.

`recoverJoin()` must call `overview(pendingKey)` before promotion. `discardPendingJoin()` must require a writable credential provider and unset only `DEFAULT_TEAM_CLIENT_PENDING_API_KEY_REF`.

- [ ] **Step 6: Update runtime validation and Browser API methods**

Add `pendingJoinConfigured` as a required boolean in `parseTeamManagementStatus`. Add:

```ts
previewInvite(inviteToken: string): Promise<TeamInvitePreview>
recoverJoin(): Promise<TeamManagementConnectionResult>
discardPendingJoin(): Promise<{ ok: true }>
```

All Browser calls remain same-origin JSON with `cache: 'no-store'` and `redirect: 'error'`.

- [ ] **Step 7: Run focused join tests and verify GREEN**

Run: `pnpm exec vitest run tests/team.spec.ts tests/team-postgres.spec.ts tests/team-routes.spec.ts tests/team-management-routes.spec.ts tests/team-management-client.spec.ts`

Expected: PASS, including the ordering and no-secret projection assertions.

- [ ] **Step 8: Inspect the focused diff without committing**

Run: `git diff --check && git status --short --branch`

Expected: no whitespace errors and no credential values in the diff.

---

### Task 3: Complete Owner/Admin member lifecycle controls

**Files:**
- Modify: `src/team/types.ts`
- Modify: `src/team/store.ts`
- Modify: `src/team/postgres-store.ts`
- Modify: `src/team/service.ts`
- Modify: `src/team/routes.ts`
- Modify: `src/shared/team-management.ts`
- Modify: `src/team/management-routes.ts`
- Modify: `src/client/team/api.ts`
- Modify: `src/client/team/team-settings-contract.ts`
- Test: `tests/team.spec.ts`
- Test: `tests/team-postgres.spec.ts`
- Test: `tests/team-request-service.spec.ts`
- Test: `tests/team-routes.spec.ts`
- Test: `tests/team-management-routes.spec.ts`
- Test: `tests/team-management-client.spec.ts`
- Test: `tests/team-settings-contract.spec.ts`

**Interfaces:**

```ts
export const TEAM_MEMBER_ROLE_PATH = `${TEAM_PATH_PREFIX}/members/role`
export const TEAM_MEMBER_REMOVE_PATH = `${TEAM_PATH_PREFIX}/members/remove`

interface TeamStore {
  setMemberRole(
    auth: TeamAuthContext,
    targetMemberId: string,
    role: 'admin' | 'member',
  ): Promise<TeamMemberSummary>
  removeMember(
    auth: TeamAuthContext,
    targetMemberId: string,
  ): Promise<TeamMemberDepartureResult>
}
```

- `TeamService.removeMember()` performs the same broker cleanup and route draining as `leaveTeam()` after the durable store transaction.
- Browser-safe management methods return only projected member/contribution summaries; they never return key summaries.

- [ ] **Step 1: Write failing permission and cleanup tests**

Cover the full matrix:

```ts
await expect(store.setMemberRole(owner, member.id, 'admin')).resolves.toMatchObject({ role: 'admin' })
await expect(store.setMemberRole(admin, member.id, 'admin')).rejects.toThrow(/only the owner/iu)
await expect(store.removeMember(admin, ordinaryMember.id)).resolves.toMatchObject({ member: { status: 'removed' } })
await expect(store.removeMember(admin, otherAdmin.id)).rejects.toThrow(/cannot remove an administrator/iu)
await expect(store.removeMember(owner, admin.id)).resolves.toMatchObject({ member: { status: 'removed' } })
await expect(store.removeMember(owner, owner.memberId)).rejects.toThrow(/cannot remove yourself/iu)
```

For every successful removal, assert all target keys are revoked, all target contributions are revoked, unrelated members are unchanged, and the target can no longer authenticate.

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `pnpm exec vitest run tests/team.spec.ts tests/team-postgres.spec.ts tests/team-request-service.spec.ts`

Expected: FAIL because role update and administrator-initiated removal do not exist.

- [ ] **Step 3: Implement one shared durable departure primitive**

Refactor store internals so `leaveTeam(auth)` and `removeMember(auth, targetMemberId)` call the same private member/key/contribution transition after their different permission checks. PostgreSQL must lock actor and target member rows in deterministic member-ID order before updates to avoid deadlocks.

- [ ] **Step 4: Implement service cleanup and exact routes**

The central and local contracts are:

```json
POST /members/role
{"targetMemberId":"member-2","role":"admin"}
```

```json
POST /members/remove
{"targetMemberId":"member-2"}
```

Map permission failures to `403`, state conflicts to `409`, missing same-Team targets to `404`, and authentication failures to `401`. Reject unknown fields.

- [ ] **Step 5: Add pure Browser permission helpers**

```ts
export function canChangeMemberRole(current: TeamMemberSummary, target: TeamMemberSummary): boolean {
  return current.role === 'owner'
    && current.status === 'active'
    && target.status === 'active'
    && target.teamId === current.teamId
    && target.id !== current.id
    && target.role !== 'owner'
}

export function canRemoveMember(current: TeamMemberSummary, target: TeamMemberSummary): boolean {
  if (current.status !== 'active' || target.status !== 'active') return false
  if (current.teamId !== target.teamId || current.id === target.id || target.role === 'owner') return false
  return current.role === 'owner' || (current.role === 'admin' && target.role === 'member')
}
```

Test cross-Team, self, Owner, Admin/Admin, Admin/Member, removed, and suspended cases.

- [ ] **Step 6: Run focused lifecycle tests and verify GREEN**

Run: `pnpm exec vitest run tests/team.spec.ts tests/team-postgres.spec.ts tests/team-request-service.spec.ts tests/team-routes.spec.ts tests/team-management-routes.spec.ts tests/team-management-client.spec.ts tests/team-settings-contract.spec.ts`

Expected: PASS.

- [ ] **Step 7: Inspect the focused diff without committing**

Run: `git diff --check && git status --short --branch`

Expected: no whitespace errors; existing ownership-transfer and self-leave tests remain green.

---

### Task 4: Build the invitation, join, recovery, and People UI

**Files:**
- Create: `src/client/team/TeamOnboarding.tsx`
- Create: `src/client/team/TeamPeopleSettings.tsx`
- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/TeamSettings.module.css`
- Modify: `src/client/team/locales.ts`
- Modify: `src/client/team/team-settings-contract.ts`
- Test: `tests/team-settings-workspace.client.spec.tsx`
- Test: `tests/team-settings-contract.spec.ts`
- Test: `tests/quota-browser-plugin.client.spec.tsx`

**Interfaces:**
- `TeamOnboarding` owns only invitation preview/confirmation, existing-key connection, pending-join recovery, and stale-key recovery UI.
- `TeamPeopleSettings` receives the current overview and callback props for invite, revoke, role change, removal, ownership transfer, and leave; it never imports or stores a raw Team key.
- `TeamSettings` continues to own API orchestration, refresh, secret-in-memory invitation result, and top-level error boundaries.

- [ ] **Step 1: Write failing onboarding interaction tests**

Add Testing Library cases for:

1. normal disconnected state shows invitation code first and hides display name until preview succeeds;
2. “Check invitation” calls `previewInvite` and renders Team name, label, status, and expiry;
3. paused preview disables “Join Team” with an actionable explanation;
4. join preserves inputs on error and clears the token after success;
5. pending state shows only finish/discard recovery actions;
6. stale configured key shows clear/disconnect recovery rather than the normal join form;
7. read-only credentials disable every local credential mutation.

Use accessible queries such as:

```ts
fireEvent.change(screen.getByLabelText(zh.inviteToken), { target: { value: 'dsh_invite_example' } })
fireEvent.click(screen.getByRole('button', { name: zh.checkInvitation }))
expect(await screen.findByRole('heading', { name: 'Friends' })).toBeDefined()
expect(screen.queryByLabelText(zh.displayName)).not.toBeNull()
```

- [ ] **Step 2: Run UI tests and verify RED**

Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx tests/team-settings-contract.spec.ts`

Expected: FAIL because preview, recovery, and extracted components do not exist.

- [ ] **Step 3: Implement `TeamOnboarding` and the access rail**

Use three explicit stages with `aria-current="step"`. Do not animate when `prefers-reduced-motion: reduce`. Validate only obvious local shape (`dsh_invite_` prefix and non-empty display name); server errors remain authoritative.

The existing-key path is visually secondary and named “Connect this device”. It validates remotely before saving, preserving current behavior.

- [ ] **Step 4: Write failing People and invitation interaction tests**

Cover:

- labeled invitation form with expiry choices `1 day`, `7 days`, and `30 days`;
- token result shown once and clipboard copy containing Team name, server origin, expiry, and token without a URL;
- pending rows identified by label instead of ordinal number;
- revoke confirmation and refresh;
- Owner promote/demote controls;
- Admin can remove a Member but not an Admin;
- Owner removal confirmation names the member and states that all keys/contributions are revoked;
- Owner self-leave remains disabled until ownership transfer.

- [ ] **Step 5: Implement `TeamPeopleSettings` and modals**

Use one action menu per member rather than a row of equally weighted destructive buttons. Keep role text visible outside the menu. The invitation form fields are:

```ts
interface InviteDraft {
  readonly label: string
  readonly expiresInMs: 86_400_000 | 604_800_000 | 2_592_000_000
}
```

After invitation creation, clear the draft and keep `{ token, label, expiresAt }` only in React memory until the result modal closes or the component unmounts.

- [ ] **Step 6: Add exact English and Chinese copy**

Required action strings include:

| Key | English | Chinese |
|---|---|---|
| `checkInvitation` | Check invitation | 检查邀请 |
| `joinTeam` | Join Team | 加入团队 |
| `finishJoining` | Finish joining | 完成加入 |
| `discardPendingJoin` | Discard pending join | 放弃未完成的加入 |
| `inviteLabel` | Invitation label | 邀请备注 |
| `promoteToAdmin` | Make Admin | 设为管理员 |
| `demoteToMember` | Make Member | 设为普通成员 |
| `removeMember` | Remove member | 移除成员 |
| `disconnectDevice` | Disconnect this device | 断开此设备 |

Errors must state the next action; do not use “Something went wrong”.

- [ ] **Step 7: Run UI and registration tests and verify GREEN**

Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx tests/team-settings-contract.spec.ts tests/quota-browser-plugin.client.spec.tsx`

Expected: PASS with no inaccessible button names or leaked secret values.

- [ ] **Step 8: Inspect the focused diff without committing**

Run: `git diff --check && git status --short --branch`

Expected: no whitespace errors. `TeamSettings.tsx` is smaller because disconnected and People flows moved to focused components.

---

### Task 5: Document and verify the complete membership journey

**Files:**
- Modify: `README.md`
- Modify: `docs/acceptance/team-mvp-phase-two.md`
- Modify if required by packaged exports: `scripts/verify-package.mjs`
- Verify: `package.json`

**Interfaces:**
- Consumes all Tasks 1–4.
- Produces operator documentation and machine-checkable acceptance coverage; no new runtime API.

- [ ] **Step 1: Update the README with exact user semantics**

Document:

- invitation label and expiry choices;
- one-time display and secret handling;
- preview before acceptance;
- pending-join recovery;
- Owner/Admin/Member permission matrix;
- disconnect-device versus leave-Team versus remove-member cleanup;
- paused Teams allow preview but reject join;
- Browser and Team Owner cannot read/export another member's key or OAuth credential.

- [ ] **Step 2: Extend the acceptance matrix**

Add cases proving:

1. invitation preview does not consume the token;
2. exactly one of two concurrent accepts succeeds;
3. interruption after pending-key creation is recoverable without a Browser-visible key;
4. Admin/Owner removal permissions match the matrix;
5. member removal drains/revokes contributions and keys;
6. stock DSH renders disconnected, preview, recovery, connected People, and destructive confirmation states.

Mark real PostgreSQL and stock-DSH evidence `not-run` until actually executed.

- [ ] **Step 3: Run the complete focused suite**

Run:

```bash
pnpm exec vitest run \
  tests/team.spec.ts \
  tests/team-postgres.spec.ts \
  tests/team-request-service.spec.ts \
  tests/team-routes.spec.ts \
  tests/team-management-routes.spec.ts \
  tests/team-management-client.spec.ts \
  tests/team-settings-contract.spec.ts \
  tests/team-settings-workspace.client.spec.tsx \
  tests/quota-browser-plugin.client.spec.tsx
```

Expected: PASS.

- [ ] **Step 4: Run repository build and package-format gates**

Run:

```bash
pnpm run build
pnpm run verify:package
git diff --check
```

Expected: all commands exit `0`. Report `verify:package` as a package-format gate, not as a real stock-DSH installation.

- [ ] **Step 5: Run a real PostgreSQL gate when configured**

Run: `DSH_TEAM_POSTGRES_TEST_URL=<redacted-url> pnpm run test:postgres`

Expected: PASS with invitation row-lock, migration 9, supplied-key registration, role changes, and member cleanup. If no disposable PostgreSQL URL is available, report this exact gate as not run rather than simulated.

- [ ] **Step 6: Perform a stock-DSH tarball smoke when authorized**

Pack the plugin into a fresh temporary directory, install the tarball into an isolated `DSH_HOME` using pinned `@deepseek-ai/dsh@0.1.0-rc.8`, and exercise invitation preview/join/recovery on `127.0.0.1:3181`. Never reuse live credentials or capture invitation/device codes in screenshots.

- [ ] **Step 7: Report exact final Git state without committing**

Run: `git status --short --branch && git diff --stat`

Report user-visible behavior, files changed, commands actually run, failures, skipped live gates, and the exact dirty branch/worktree state.

---

## Self-Review

- **Spec coverage:** invitation creation, preview, acceptance, recovery, role management, removal, ownership transfer, leaving, and device disconnection each have a UI state, typed route, permission rule, and focused test task.
- **Boundary check:** no raw Team key moves through the Browser; invitation tokens appear only in the creation response and join request; OAuth credentials remain Broker-owned.
- **Race check:** invitation acceptance is row-locked; pending local credentials cover interrupted joins; member removal shares the atomic departure primitive and deterministic PostgreSQL locks.
- **Scope check:** email delivery, public invite URLs, identity verification, suspended-member workflows, display-name editing, and usage/billing policy are deliberately excluded.
- **Design critique:** the access rail is specific to the real invitation/device/access sequence. The rest stays visually quiet and native to DSH Settings instead of introducing a generic dashboard aesthetic.
- **Repository check:** the plan requires TDD, build, package verification, optional real PostgreSQL, optional stock-DSH smoke, and no commit without explicit user approval.
