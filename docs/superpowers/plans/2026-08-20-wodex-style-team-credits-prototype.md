# Wodex-style Team Credits Prototype Implementation Plan

> **For Codex:** Execute this plan in the existing `codex/team-phase-two` worktree. Preserve all unrelated dirty files and do not commit.

**Goal:** Replace the prototype's inferred subscription-percentage consumption with gateway-settled Credits, while keeping request count as a separate exact metric and adding one simple contributor-side daily sharing cap.

**Architecture:** The Team gateway records provider-reported token usage for each request attempt and settles an immutable, versioned Credits value. The UI reads aggregates only; it never receives prompts, responses, credentials, or raw provider errors. Provider `remainingPercent` remains a routing reserve guard and is never used to apportion individual consumption.

**Tech Stack:** Static HTML/CSS/JavaScript prototype, Node.js built-in test runner, stock DSH visual language.

---

## Task 1: Lock the product contract with a failing prototype test

**Files:**
- Modify: `docs/prototypes/team-account-onboarding.prototype.test.mjs`

- [x] Replace assertions for estimated percentage change with assertions for exact request count, exact settled Credits, a daily Credits cap, and the immutable Credits formula.
- [x] Assert that the prototype explicitly separates Credits from subscription percentage and money.
- [x] Assert that seven-day member usage is rendered in Credits while preserving request counts as context.
- [x] Run `node --test docs/prototypes/team-account-onboarding.prototype.test.mjs` and confirm the new assertions fail before implementation.

## Task 2: Implement the accepted Team usage model in the prototype

**Files:**
- Modify: `docs/prototypes/team-account-onboarding.html`

- [x] Replace `quotaDelta` fixtures with per-member `credits` plus request counts.
- [x] Show the last-day request count and settled Credits in the account detail.
- [x] For contributor-owned accounts, show `today settled / daily sharing limit`, a progress bar, and the existing personal reserve semantics.
- [x] Change the seven-day chart to use Credits for bar height and show each day's request count as supporting text.
- [x] Add concise copy for the v1 formula: uncached input × 1 + cached input × 0.25 + output including reasoning × 4.
- [x] State that completion updates immediately, with one-minute polling as the fallback refresh cadence.

## Task 3: Update the phase-two acceptance contract

**Files:**
- Modify: `docs/acceptance/team-mvp-phase-two.md`

- [x] Extend contribution guards to cover atomic daily Credits reservation and settlement.
- [x] Extend usage audit assertions with provider-reported token counters, settled Credits, and formula version while preserving metadata-only content boundaries.
- [x] Document failure and retry semantics: reserve before forwarding; settle actual provider usage; release unused reservation; a retry is a new attempt.

## Task 4: Verify behavior and visual hierarchy

**Files:**
- Verify: `docs/prototypes/team-account-onboarding.html`
- Verify: `docs/prototypes/team-account-onboarding.prototype.test.mjs`

- [x] Run the focused Node test.
- [ ] Reload `http://[::1]:3181/team-account-onboarding.html`, open the Team tab, inspect an owned shared account, and open the seven-day dialog.
- [x] Confirm the UI has one primary metric model, no 30-day mode, no estimated subscription-percentage consumption, and no secret-bearing content.
- [ ] Record the exact dirty Git state in the handoff.
