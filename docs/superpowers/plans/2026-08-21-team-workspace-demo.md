# Team Workspace Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, clickable Chinese Team workspace demo with three clear top-level tasks—usage, members, and Owner-only invitations—while keeping personal sharing inside usage and role-aware membership actions in the Team header.

**Architecture:** Add one self-contained HTML prototype with inline CSS and JavaScript so it can open directly or through a static server without touching the production React or Host implementation. Add a Node contract test that locks the role-aware navigation, page separation, lifecycle copy, and core interaction hooks before visual implementation.

**Tech Stack:** Semantic HTML, modern CSS, dependency-free browser JavaScript, Node.js built-in test runner.

## Global Constraints

- Work only on branch `codex/team-phase-two-split` in the repository worktree.
- Preserve every existing tracked and untracked user-owned change; do not commit, push, publish, or rewrite history.
- Exactly two roles are visible: `Team Owner` and `成员`; do not display avatars, email, presence, or last-active data.
- The joined workspace has only `用量`, `成员`, and Owner-only `邀请码` in its primary navigation. Ordinary members must not see a disabled or empty invitation view, and there is no separate personal navigation group.
- `用量` shows only role-shaped aggregate data for cross-member shared attempts: `预估费用（USD）`, aggregate `Token 用量`, `请求次数`, a compact completeness state, and an explicit admission-time window. Credits stay Host-internal; the Browser does not convert them to money or receive per-request or input/cache/output breakdowns.
- `我的共享` is a distinct settings section inside `用量`; it controls only the current member's own connected account and must not expose another member's source count, credentials, or Provider quota.
- Team-level actions live in a grouped header menu: `Team 运行`, `所有权`, and `Team 生命周期`.
- The Team header always shows the current role. The role-aware Team menu exposes only `退出 Team` to a member, while the Owner sees pause/resume, transfer, and dissolution plus the direct-leave restriction. Local-device cleanup remains a terminal follow-up rather than a mixed danger action.
- Invitation joining is a standalone onboarding state, not part of the joined Team settings workspace.
- Do not mix routing tutorials, request history, raw server addresses, Team keys, or OAuth details into member or invitation views.
- Pause is a reversible low-resource state; dissolution is irreversible and must require explicit typed confirmation.
- Demo data is illustrative and must not be presented as live production data.

---

### Task 1: Lock the Demo Information Architecture

**Files:**
- Create: `docs/prototypes/team-workspace-demo.prototype.test.mjs`
- Test: `docs/prototypes/team-workspace-demo.prototype.test.mjs`

**Interfaces:**
- Consumes: Frozen behavior in `docs/acceptance/team-owner-member-product-spec.zh-CN.md`, especially sections 7, 8, 11–14, 19, and 20.
- Produces: Static HTML contract selectors `data-workspace-view`, `data-demo-role`, `data-team-status`, and `data-action` used by the prototype and browser walkthrough.

- [x] **Step 1: Write the failing contract test**

```js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const prototypeUrl = new URL('./team-workspace-demo.html', import.meta.url)

test('separates Team workspace concerns and exposes role-aware demo states', async () => {
  const html = await readFile(prototypeUrl, 'utf8')
  for (const view of ['usage', 'members', 'invites', 'join']) {
    assert.match(html, new RegExp(`data-workspace-view=["']${view}["']`, 'u'))
  }
  assert.doesNotMatch(html, /data-workspace-view=["'](?:sharing|identity)["']/u)
  for (const role of ['owner', 'member']) {
    assert.match(html, new RegExp(`data-demo-role=["']${role}["']`, 'u'))
  }
  for (const status of ['active', 'paused']) {
    assert.match(html, new RegExp(`data-team-status=["']${status}["']`, 'u'))
  }
})
```

- [x] **Step 2: Run the focused test and verify it fails because the prototype does not exist**

Run: `node --test docs/prototypes/team-workspace-demo.prototype.test.mjs`

Expected: FAIL with `ENOENT` for `team-workspace-demo.html`.

- [x] **Step 3: Add contract assertions for forbidden mixed concerns and high-risk actions**

```js
assert.doesNotMatch(html, /一次请求如何路由/u)
assert.doesNotMatch(html, /http:\/\/127\.0\.0\.1:3099/u)
assert.match(html, /data-action=["']pause-team["']/u)
assert.match(html, /data-action=["']transfer-owner["']/u)
assert.match(html, /data-action=["']dissolve-team["']/u)
assert.match(html, /data-action=["']create-invite["']/u)
assert.match(html, /data-action=["']leave-team["']/u)
```

- [x] **Step 4: Re-run the focused test and keep the expected failure before implementation**

Run: `node --test docs/prototypes/team-workspace-demo.prototype.test.mjs`

Expected: FAIL with `ENOENT`.

### Task 2: Build the Clickable Team Workspace Prototype

**Files:**
- Create: `docs/prototypes/team-workspace-demo.html`
- Test: `docs/prototypes/team-workspace-demo.prototype.test.mjs`

**Interfaces:**
- Consumes: The selectors defined in Task 1.
- Produces: A self-contained `render()` state machine and clickable demo actions for role, lifecycle, workspace navigation, invitations, membership, ownership transfer, member removal, and joining.

- [x] **Step 1: Create the semantic page shell and state model**

```js
const state = {
  role: 'owner',
  status: 'active',
  view: 'usage',
  overlay: null,
  invites: [{ id: 'invite-product', label: '产品设计协作', expires: '8 月 28 日 18:00' }],
  pendingTransfer: null,
  currentMemberId: 'member-owner',
  usageMode: 'complete',
  personalByMemberId: {
    'member-owner': { sharingEnabled: true, usage: { estimatedCost: 'US$ 5.88', tokens: '3.9M', requests: '39' } },
    'member-lin': { sharingEnabled: false, usage: { estimatedCost: 'US$ 2.14', tokens: '1.5M', requests: '18' } },
  },
}

function setState(patch) {
  Object.assign(state, patch)
  render()
}
```

- [x] **Step 2: Implement the visual system and responsive layout**

Use a quiet charcoal DSH settings shell, a 232px navigation rail, a persistent Team header, one accent color, plain dividers instead of repeated floating cards, 14–16px body text, 44px minimum hit targets, and a single centered dialog only when explicit confirmation is required.

- [x] **Step 3: Implement role-aware navigation, usage, personal sharing, and member rows**

Render `用量` and `成员` for both roles; render `邀请码` only when `state.role === 'owner'`; do not render a personal navigation group. Put `预估费用（USD）` in the strongest visual position, with aggregate Token and request count beneath it; remove the standalone number-definition module and use only a compact completeness state. The Owner sees `Team 总用量` plus their own included subset, while a member sees only their own consumer-keyed totals. Keep `我的共享` as a clearly separated section below the usage summary. Keep the Owner first, show only display name plus `Team Owner · 我` or `成员`, expose only `移出 Team` in an ordinary member row menu, and label the member-page invitation entry `邀请成员`.

- [x] **Step 4: Implement Owner invitation management**

Add a single-use-code creation flow with description and expiry inputs, a success view that shows and copies the generated code, explicit re-reveal/copy actions for each active invitation, and revocation of pending invitations. Keep full codes out of the list itself. When paused, keep reveal and revocation available, disable creation, and explain that existing codes resume only if still valid.

- [x] **Step 5: Implement Team-level management actions**

Group pause/resume, two-stage ownership transfer, and irreversible dissolution in the Team header menu. Require the exact Team name `周末造物局` before enabling `永久解散 Team`; pause copy must state that members/settings remain and in-flight requests are not interrupted.

- [x] **Step 6: Implement role-aware membership actions and join onboarding**

Show the current role in the Team header. In the header menu, Owners see why they cannot directly leave and members see only `退出 Team`. The standalone join view must progress through invite input, safe preview, display-name confirmation, and successful member connection without placing the raw code in the URL or joined workspace.

- [x] **Step 7: Add a clearly labeled prototype scenario controller**

Provide compact controls for `Owner`, `成员`, `运行中`, `已暂停`, the six usage modes (`完整数据 / 部分数据 / 价格未知 / 无计量 / 零请求 / 获取失败`), and the join scenarios. The controller changes only local demo state and must be visually separated from product navigation with the label `原型场景`; on narrow screens it participates in document flow instead of covering product content.

- [x] **Step 8: Run the focused contract test**

Run: `node --test docs/prototypes/team-workspace-demo.prototype.test.mjs`

Expected: PASS.

### Task 3: Verify the Demo in the Browser

**Files:**
- Verify: `docs/prototypes/team-workspace-demo.html`
- Verify: `docs/prototypes/team-workspace-demo.prototype.test.mjs`

**Interfaces:**
- Consumes: The standalone prototype and its stable selectors.
- Produces: A browser-verified Owner screenshot, member-state screenshot, and interaction result with zero page errors.

- [x] **Step 1: Run all prototype contract tests**

Run: `pnpm run test:prototype`

Expected: PASS for both prototype test files.

- [x] **Step 2: Start a local static server without changing repository files**

Run from the repository root: `python3 -m http.server 4177 --bind 127.0.0.1 --directory .`

Expected: `http://127.0.0.1:4177/docs/prototypes/team-workspace-demo.html` responds with the prototype.

- [x] **Step 3: Walk through the Owner flow in the in-app browser**

Open the prototype, switch `成员 → 邀请码`, create an invitation, close the result, reveal and copy the same invitation again from its row, then open the Team menu, pause the Team, and verify the paused header, disabled invite creation, and still-available reveal action.

- [x] **Step 4: Walk through the member and join flows**

Switch to the member role, verify the invitation tab and member action menus disappear, open the Team header menu, verify that only `退出 Team` is available, then open `加入演示` and complete preview plus join.

- [x] **Step 5: Capture visual evidence and check errors**

Capture 1440×900 screenshots for the Owner member view and invitation view. Confirm no horizontal overflow at 1024px width and no browser `pageerror` events.

- [x] **Step 6: Run repository hygiene checks**

Run: `git diff --check -- docs/prototypes/team-workspace-demo.html docs/prototypes/team-workspace-demo.prototype.test.mjs docs/superpowers/plans/2026-08-21-team-workspace-demo.md`

Expected: no output and exit code 0.

### Task 4: Allow the Owner to Reopen Active Invitation Codes

**Files:**
- Modify: `docs/acceptance/team-owner-member-product-spec.zh-CN.md`
- Modify: `docs/prototypes/team-workspace-demo.prototype.test.mjs`
- Modify: `docs/prototypes/team-workspace-demo.html`

**Interfaces:**
- Consumes: The updated product decision that a current Owner may re-view any pending, unexpired, unretracted invitation after closing the generation result.
- Produces: A secretless invitation list plus an explicit `data-action="reveal-invite"` dialog flow whose plaintext exists only while the dialog is open.

- [x] **Step 1: Write the failing contract test**

Require an Owner-only `查看邀请码` action, a dedicated reveal overlay, repeat-copy wording, and the absence of old one-time-display wording or Browser persistence.

- [x] **Step 2: Update the Chinese product and security contract**

Define active-only re-reveal, AEAD ciphertext plus digest storage, Owner reauthorization, non-cacheable single-resource responses, terminal-state cryptographic erasure, Team-first concurrency, and a truthful legacy hash-only migration state.

- [x] **Step 3: Implement the reveal interaction in the standalone Demo**

Keep complete codes out of list rows. Let the Owner open, copy, close, and reopen the same active invitation; allow reveal while paused, and remove access after revocation.

- [x] **Step 4: Run focused, browser, and hygiene verification**

Run the contract suite, exercise close/reopen/copy and paused behavior in the in-app browser, check mobile layout and page errors, then run whitespace and inline-script syntax checks.
