# Codex mode localization

## Goal

Restore the Codex desktop Chinese labels in the DSH model menu:

- Speed: `标准`, `快速`
- Reasoning: `轻度`, `中`, `高`, `极高`, `最高`, including Chinese descriptions

## Verification

- Assert the adapter exposes the exact reasoning display names and descriptions.
- Render the speed preference in Chinese and assert its visible menu labels.
- Run focused tests, the full test suite, the build, and package verification.
- Pack and install the tarball into an isolated stock DSH profile for a UI GIF.
