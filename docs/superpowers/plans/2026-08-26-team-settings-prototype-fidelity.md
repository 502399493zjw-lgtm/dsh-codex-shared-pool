# Team Settings Prototype Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan task-by-task with focused test gates. Do not commit unless the user explicitly requests it.

**Goal:** Restore the visual hierarchy and workspace structure of the approved Team prototype in the management view opened from the Team panel's “团队设置” button.

**Architecture:** Keep the confirmed information architecture: the default Team panel owns account sharing, while the post-click management workspace owns only 用量 / 成员 / 邀请码. Reintroduce the prototype's compact internal rail and data-led content hierarchy, adapted to the real DSH settings-slot width through container queries.

**Tech Stack:** React, TypeScript, CSS Modules, Vitest, Testing Library, stock DSH Cordis settings slot.

## Task 1: Lock prototype fidelity

- [x] Require the compact two-column workspace rail at usable embedded widths.
- [x] Require SETTINGS / Team branding and reject obsolete account-management entries.
- [x] Require the original usage hierarchy: large cost, then token and request rows.
- [x] Run focused tests and confirm failure before implementation.

## Task 2: Restore the workspace composition

- [x] Move 用量 / 成员 / 邀请码 into the internal workspace rail.
- [x] Keep the Team context and management actions at the top of the content canvas.
- [x] Restyle usage groups as a shared ruled data surface instead of equal metric cards.
- [x] Preserve keyboard semantics, focus restoration, and all existing API behavior.

## Task 3: Adapt the prototype to the DSH slot

- [x] Use a 132–152px rail where the container permits it.
- [x] Collapse the rail to a horizontal navigation only below 460px container width.
- [x] Stack usage groups below 520px while preserving their hierarchy.
- [x] Keep 44px interactive targets and visible focus states.

## Task 4: Verify in stock DSH

- [x] Run focused and full tests, build, and package verification.
- [x] Pack and install in isolated stock DSH 0.1.0-rc.8.
- [x] Capture desktop, tablet, and mobile screenshots.
- [x] Update the design review and report exact Git state.
