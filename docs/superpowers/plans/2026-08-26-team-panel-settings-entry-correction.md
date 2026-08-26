# Team Panel Settings Entry Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the joined-Team account panel as the Team tab's default view and open the management workspace only after the panel's “团队设置” button is clicked.

**Architecture:** `TeamSettings` continues to own the same-origin Team API and dialog state. Its connected default branch becomes the account-oriented Team panel, while `teamSettingsOpen` exclusively controls the management workspace containing usage, members, invitations, and Team lifecycle actions. Account authorization and protection controls remain in the Team panel instead of being duplicated inside management settings.

**Tech Stack:** React 19, TypeScript, CSS Modules, Vitest, Testing Library, stock DeepSeek Harness `0.1.0-rc.8`.

## Global Constraints

- Preserve the Host-only credential and same-origin Browser projection boundary.
- Do not modify stock DSH core or generated catalogs.
- Keep the existing Team overview, OAuth, contribution-protection, usage, membership, invitation, and lifecycle APIs unchanged.
- The default joined-Team screen must be the Team account panel; the management workspace must not be present before the panel trigger is clicked.
- Use focused failing tests before implementation, then run the full test/build/package gates.

---

### Task 1: Lock the corrected screen hierarchy

**Files:**
- Modify: `tests/team-settings-workspace.client.spec.tsx`

**Interfaces:**
- Consumes: `TeamSettings({ t, embedded })` and the existing mocked `overviewState`.
- Produces: an interaction contract for the default `region` named by `teamPanelTitle` and the post-click `region` named by `teamSettingsTitle`.

- [x] **Step 1: Write the failing hierarchy test**

```tsx
render(<TeamSettings t={translate} embedded />)
const panel = await screen.findByRole('region', { name: zh.teamPanelTitle })
expect(screen.queryByRole('region', { name: zh.teamSettingsTitle })).toBeNull()
expect(within(panel).getByRole('button', { name: zh.teamSettings })).toBeDefined()
expect(within(panel).getByRole('region', { name: zh.accountsNavigation })).toBeDefined()
fireEvent.click(within(panel).getByRole('button', { name: zh.teamSettings }))
const settings = await screen.findByRole('region', { name: zh.teamSettingsTitle })
expect(within(settings).queryByRole('button', { name: zh.accountsNavigation })).toBeNull()
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx -t "opens management only from the Team panel"`

Expected: FAIL because the current default branch is a simplified landing card and account management is inside the settings workspace.

- [x] **Step 3: Add focus-return and account-control assertions**

```tsx
fireEvent.click(within(settings).getByRole('button', { name: zh.backToTeam }))
expect(await screen.findByRole('region', { name: zh.teamPanelTitle })).toBeDefined()
expect(document.activeElement).toBe(screen.getByRole('button', { name: zh.teamSettings }))
expect(screen.getByRole('button', { name: zh.addAccount })).toBeDefined()
```

- [x] **Step 4: Keep the test failing until Task 2**

Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx -t "opens management only from the Team panel"`

Expected: FAIL on the missing Team panel contract.

### Task 2: Move account management back to the Team panel

**Files:**
- Modify: `src/client/team/TeamSettings.tsx`
- Modify: `src/client/team/TeamSettings.module.css`
- Modify: `src/client/team/locales.ts`
- Test: `tests/team-settings-workspace.client.spec.tsx`

**Interfaces:**
- Consumes: `overview.contributions`, `usageProjection.ownedAccounts`, `api.startOAuth`, `api.updateContribution`, and existing modal state.
- Produces: `teamPanelTitle` locale copy, a default Team panel containing the current-Team context and account controls, and a management workspace reached only through `setTeamSettingsOpen(true)`.

- [x] **Step 1: Add the Team panel accessible name**

```ts
// en
teamPanelTitle: 'Team account panel',
// zh
teamPanelTitle: '团队面板',
```

- [x] **Step 2: Change the default workspace task back to usage**

```tsx
type TeamWorkspaceView = 'usage' | 'members' | 'invitations'
const [workspaceView, setWorkspaceView] = useState<TeamWorkspaceView>('usage')
```

- [x] **Step 3: Render account controls in the closed/default branch**

```tsx
<section className={styles.teamPanel} role="region" aria-label={t('teamPanelTitle')}>
  <header className={styles.teamContext}>
    <div>{/* Team name, status, role, member count */}</div>
    <button ref={teamSettingsTriggerRef} type="button" onClick={() => setTeamSettingsOpen(true)}>
      {t('teamSettings')}
    </button>
  </header>
  <section role="region" aria-labelledby="team-accounts-title">
    {/* existing owned contribution cards, add-account action, weekly protection, recent usage */}
  </section>
</section>
```

- [x] **Step 4: Remove the accounts entry and account section from management settings**

```tsx
<nav aria-label={t('workspaceNavigation')}>
  <button aria-current={workspaceView === 'usage' ? 'page'}>{t('usageSectionTitle')}</button>
  <button aria-current={workspaceView === 'members' ? 'page'}>{t('membersTitle')}</button>
  {overview.viewerRole === 'owner' ? <button>{t('invitationsTitle')}</button> : null}
</nav>
```

- [x] **Step 5: Replace landing-card CSS with Team panel structure**

Define `teamPanel`, `teamContext`, `teamContextCopy`, and `teamAccounts` using the existing DSH tokens; keep the trigger at least 44px high and stack the context below 640px without horizontal overflow.

- [x] **Step 6: Run focused component and responsive tests**

Run: `pnpm exec vitest run tests/team-settings-workspace.client.spec.tsx tests/team-settings-responsive-css.spec.ts`

Expected: PASS.

### Task 3: Verify the real stock-DSH interaction

**Files:**
- Modify: `DESIGN_REVIEW.md`
- Replace: `screenshots/team-settings-rework-runtime-desktop.png`
- Replace: `screenshots/team-settings-rework-runtime-tablet.png`
- Replace: `screenshots/team-settings-rework-runtime-mobile.png`

**Interfaces:**
- Consumes: the packed plugin, isolated current-protocol Team Host, and stock DSH `0.1.0-rc.8`.
- Produces: persistent evidence of the Team panel before click and the management workspace after click.

- [x] **Step 1: Run repository gates**

Run: `pnpm test && pnpm run build && pnpm run verify:package && git diff --check`

Expected: all commands exit 0.

- [x] **Step 2: Pack and install into isolated Host and Client homes**

Use the pinned published DSH CLI and the exact tarball produced from this worktree; bootstrap a memory Team whose overview includes `lifecycleRevision: 1`.

- [x] **Step 3: Verify the browser transition**

In stock DSH, open `设置 → Codex 订阅池 → 团队`; assert the Team panel and its account region are visible, the management workspace is absent, click the panel's “团队设置”, then assert usage/members/invitations navigation appears and the account panel disappears.

- [x] **Step 4: Verify responsive behavior and save evidence**

Capture 1280×800, 768×1024, and 375×812 states. For every viewport assert `document.documentElement.scrollWidth === window.innerWidth` and no console warning/error.

- [x] **Step 5: Update the review and report exact Git state**

Document which paths are real-browser proven and explicitly retain the limitation that account mutation needs a contributed-account fixture. Do not commit or push unless the user explicitly asks.
