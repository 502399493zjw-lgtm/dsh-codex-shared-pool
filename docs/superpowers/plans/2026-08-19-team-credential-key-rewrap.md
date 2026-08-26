# Online Team Credential Key-Rewrap Plan

**Goal:** Let a hosted multi-Team deployment rotate the key-encryption key (KEK) that protects per-account DEKs without decrypting or rewriting OAuth documents, stopping request traffic, or exposing credentials outside Host code.

**Architecture:** Add a Host-only operation to `PostgresTeamEnvelopeCredentialBackend`. It enumerates credential-envelope identities using keyset pagination, then handles each row in its own transaction under the same `FOR UPDATE` lock used by OAuth refresh mutations. The configured runtime provider unwraps the existing DEK, a target provider wraps it, and the configured provider must also prove it can unwrap the replacement before the row is updated. Only `key_id`, wrapped-DEK ciphertext/optional provider metadata, and `updated_at` change; the encrypted OAuth document remains byte-for-byte unchanged. Wrapped-key storage accepts both the bundled AES-GCM shape and bounded opaque managed-KMS ciphertext without requiring nonce/tag columns. Completed rows commit independently, so a failed or interrupted run can be resumed. All live Host replicas must use a provider/keyring that can unwrap both old and new key IDs for the duration of the operation.

**Scope:** This slice provides the provider-neutral online operation and public Host API. It does not choose AWS, GCP, or Azure for the project, add a Browser/admin HTTP endpoint, accept raw keys over HTTP, or claim that a provider-specific managed-KMS adapter exists.

---

## Task 1: Specify failing behavior

**Files:**
- Modify: `tests/team-envelope-credentials.spec.ts`
- Modify: `tests/team-postgres.integration.spec.ts`

- [x] Prove two account envelopes move to the target wrapping key while their encrypted documents and document nonces/tags remain unchanged.
- [x] Prove already-current rows are reported as unchanged on a resumed run.
- [x] Prove a target key that the active backend cannot read fails closed and leaves the row on the old wrapping key.
- [x] Prove an opaque managed-KMS ciphertext can omit AES nonce/tag metadata and remain readable after rewrap.
- [x] Prove rewrap and an OAuth credential mutation serialize on the same PostgreSQL row lock in the real-database gate.

## Task 2: Implement the Host-only rewrap engine

**Files:**
- Modify: `src/team/envelope-credentials.ts`
- Modify: `src/team/index.ts`
- Modify: `src/index.ts`

- [x] Add JSON-safe progress/result types containing counts only; never include plaintext keys or credential fields.
- [x] Enumerate identities in stable keyset order with a bounded batch size.
- [x] Re-read and lock each row in a transaction before unwrapping it.
- [x] Wrap the DEK with the target provider, verify the active provider can unwrap the new envelope and that the plaintext DEK matches, then update only wrapped-key columns.
- [x] Zero every plaintext DEK buffer, including verification copies, on success and failure.
- [x] Commit each row independently; retain already-committed progress if a later row fails.
- [x] Skip a row when the target provider returns the same `keyId` unless `force` is explicitly requested.
- [x] Migrate wrapped-key columns from the bundled AES provider's fixed lengths to bounded opaque provider ciphertext and optional metadata.

## Task 3: Document safe rotation choreography

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-19-team-control-plane.md`

- [x] Document the required deployment sequence: make every Host able to read both keys, switch the target wrapping key, run/resume rewrap, verify zero legacy rows, then remove the old key.
- [x] State that the operation is Host-only and provider-neutral, and that cloud-specific adapters remain separate.
- [x] Replace the inaccurate “no online rewrap” warning without overstating managed-KMS support.

## Task 4: Verification

- [x] Run focused envelope and runtime tests.
- [x] Run the real-PostgreSQL test command with `DSH_TEAM_POSTGRES_TEST_URL`.
- [x] Run `pnpm test`.
- [x] Run `pnpm run build`.
- [x] Run `pnpm run verify:package`.
- [x] Pack and install the tarball into an isolated `DSH_HOME` against pinned stock DSH when the exported package surface changes.

Local verification on 2026-08-20 passed all five cases in the real PostgreSQL
17 suite, including serialization between online key rewrap and a live
credential mutation on the same row. The earlier package verification and
packed `0.1.0-alpha.0` installation into a fresh pinned stock DSH
`0.1.0-rc.7` Web profile also passed; the isolated smoke directory was moved
to the system trash after the check.
