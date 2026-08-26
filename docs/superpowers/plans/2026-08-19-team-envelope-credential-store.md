# Team PostgreSQL envelope credential store implementation plan

> **Goal:** Replace the PostgreSQL Team runtime's Host-local OAuth files with a shared, envelope-encrypted credential store while keeping every provider credential behind the Host broker boundary.

**Architecture:** Keep the existing broker API secret-free and introduce a small Host-only profile-store backend seam. The PostgreSQL backend stores one encrypted credential document per contribution. A fresh 256-bit DEK is generated per account, the document is encrypted with AES-256-GCM and Team/account-bound AAD, and the DEK is wrapped by a pluggable key-encryption provider. The bundled provider reads a 32-byte KEK from the DSH credential service; managed KMS adapters can implement the same interface without changing OAuth or routing code. Credential mutations hold a PostgreSQL row lock for the full read/decrypt/refresh/encrypt/write transaction so refresh-token rotation is serialized across Host replicas.

**Security invariants**

- OAuth access/refresh tokens and decrypted documents remain Host-only and never enter JSON-safe Team types, routes, logs, or Browser code.
- PostgreSQL contains only ciphertext, non-secret key identifiers, IVs/tags, timestamps, and contribution foreign keys.
- Each contribution has an independent random DEK; authenticated encryption binds both the wrapped DEK and document to its Team/account identity.
- Wrong keys, swapped rows, tampered ciphertext, malformed documents, and unsupported envelope versions fail closed without quoting plaintext or key material.
- Revocation deletes the encrypted credential row only after admission has stopped and in-flight work has drained, preserving the existing lifecycle semantics.
- Encryption at rest does not imply zero knowledge: a compromised broker process or operator with runtime decrypt authority can still use the credential. README must state this boundary.

## Task 1: Generalize the Host-only profile-store seam

**Files:** `src/store.ts`, `src/auth.ts`, `src/team/credentials.ts`, `tests/team-credentials.spec.ts`

- [x] Add a minimal `OpenAICodexProfileStore` interface extending pi-ai `CredentialStore` with secret-free `listProfiles`, `addProfile`, and `removeProfile` operations.
- [x] Make the existing file-backed store implement the interface and make profile OAuth accept the interface instead of the concrete file class.
- [x] Add a broker storage-backend interface that opens/deletes one validated Team credential reference; retain the file backend as the memory/development default.
- [x] Prove the broker can operate through an injected backend and that delete/restart target only the requested Team/account.

## Task 2: Implement envelope encryption and strict document handling test-first

**Files:** `src/team/envelope-credentials.ts`, `tests/team-envelope-credentials.spec.ts`

- [x] First add failing tests for ciphertext-only persistence, independent per-account DEKs, OAuth profile round-trip, atomic refresh mutation, deletion isolation, tenant-bound AAD, ciphertext/tag tampering, wrong KEK, malformed master-key input, and secret-free errors.
- [x] Define a pluggable async `TeamKeyEncryptionProvider` and wrapped-key value object.
- [x] Implement the bundled AES-256-GCM KEK adapter and strict base64/base64url 32-byte key decoder.
- [x] Implement the single-profile PostgreSQL credential backend with fresh IVs, per-account DEKs, authenticated context, strict versioned plaintext parsing, buffer cleanup where practical, and `SELECT ... FOR UPDATE` mutation serialization.
- [x] Do not log SQL parameters, plaintext documents, token-shaped values, or raw cryptographic failures.

## Task 3: Add and validate the durable schema

**Files:** `src/team/postgres-store.ts`, `tests/team-postgres.spec.ts`, `tests/team-envelope-credentials.spec.ts`

- [x] Add a versioned migration for `team_contribution_credentials` with cascade deletion, strict envelope metadata constraints, and no plaintext/token columns.
- [x] Keep migration coordination under the existing PostgreSQL advisory transaction lock.
- [x] Verify pg-mem behavior and SQL shape without claiming it proves PostgreSQL lock scheduling.

## Task 4: Wire PostgreSQL runtime configuration fail-closed

**Files:** `src/team/config.ts`, `src/team/runtime.ts`, `src/team/index.ts`, `src/index.ts`, `tests/team-runtime.spec.ts`

- [x] Add a credential-reference configuration for the envelope master key; the key value itself must never appear in plugin JSON.
- [x] For the real PostgreSQL store, construct the encrypted backend and broker after migrations; preserve explicit broker/KMS injection seams for tests and external managed-KMS adapters.
- [x] Fail startup when PostgreSQL credential storage lacks a valid key, and dispose partially initialized pools on every failure path.
- [x] Keep memory mode on isolated owner-only files for local development.

## Task 5: Document the deployment boundary

**Files:** `README.md`, `docs/superpowers/plans/2026-08-19-team-control-plane.md`

- [x] Document key generation/configuration, startup failure behavior, key-rotation limitation, backup requirements, and the distinction between database-at-rest protection and zero knowledge.
- [x] Mark shared envelope credential storage complete while leaving a managed cloud-KMS adapter and the then-separate distributed traffic-guard plan as explicit follow-ups.
- [x] Do not claim OpenAI-side token/session revocation when only the encrypted Pool row is deleted.

## Task 6: Verify the package and stock DSH boundary

- [x] Run focused credential, PostgreSQL, runtime, route, and security tests.
- [x] Run `pnpm test`, `pnpm run build`, and `pnpm run verify:package`.
- [x] Run `DSH_TEAM_POSTGRES_TEST_URL=postgres://… pnpm run test:postgres` when a real PostgreSQL URL is available; otherwise report the unverified lock-scheduler evidence precisely.
- [x] Pack the plugin and install the tarball into an isolated `DSH_HOME` against pinned stock DSH `0.1.0-rc.7` because Host configuration changes.
- [x] Confirm no credential, generated auth file, machine path, or temporary installation artifact enters the package/worktree.

Local verification on 2026-08-20 passed all five real PostgreSQL 17 cases. The
credential case proved that a second Host waits on the encrypted credential row
and observes the first Host's committed refresh-token mutation.
