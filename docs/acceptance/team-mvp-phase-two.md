# Team MVP Phase Two Acceptance Matrix

This matrix is the acceptance contract for the invitation-only Team MVP. It
keeps controlled tests, real PostgreSQL/Compose tests, real OpenAI requests,
and stock-DSH Browser evidence separate. A controlled or mocked result never
proves that a real provider account or model is available.

## Run Rules

- Active compatibility baseline: stock DSH `0.1.0-rc.8`, Cordis `4.0.1`,
  Node.js `^22.19.0 || >=24`, and pnpm `11.7.0`.
- Browser-facing stock DSH runs on `http://127.0.0.1:3181`. Private Team
  Edge, Broker, and PostgreSQL listeners may use their deployment ports.
- Live requests use two separately authorized contribution credential chains.
  Existing local Shared Pool profiles are not reused or imported.
- Status values are `pass`, `fail`, `blocked`, and `not-run`. A required
  external gate that has not run leaves the overall result incomplete.
- Evidence must not contain Team keys, invite tokens, device codes, OAuth
  credentials, account email addresses, prompts, model output, cookies,
  database URLs, or local authentication paths.

## Summary

| ID | Case | Layer | Provider | Initial status |
| --- | --- | --- | --- | --- |
| AC-TEAM-001 | Requester-owned account is selected first | controlled integration | mock | not-run |
| AC-TEAM-002 | Unavailable own account falls back to a healthy teammate | controlled integration | mock | not-run |
| AC-TEAM-003 | Session affinity survives normal requests and releases on hard unavailability | controlled integration | mock | not-run |
| AC-TEAM-004 | Reserve, daily Credits, model, RPM, concurrency, and circuit guards fail safely | controlled + PostgreSQL | mock | not-run |
| AC-TEAM-005 | Contribution OAuth wait, cancel, completion, reauthorization, and stale callback states are safe | controlled integration | mock | not-run |
| AC-TEAM-006 | Team pause and contribution revoke stop new admission and drain admitted work | controlled + PostgreSQL | mock | not-run |
| AC-TEAM-007 | Invites, member keys, roles, and tenant data remain isolated | controlled + Compose | mock | not-run |
| AC-TEAM-008 | Usage audit attributes requests, aggregate Token, versioned USD estimates, and internal Credits without retaining content | controlled integration | mock | not-run |
| AC-TEAM-009 | The packaged multi-Team stack works with real PostgreSQL and separated Host/Broker roles | Compose smoke | no OpenAI | not-run |
| AC-TEAM-010 | Two real contributors prove own-account priority, shared fallback, and stickiness | live integration | real OpenAI | not-run |
| AC-TEAM-011 | A packed plugin sends a Team-client Codex request from stock DSH on port 3181 | stock DSH smoke | real OpenAI | not-run |
| AC-TEAM-012 | Team Settings exposes the accepted states without secrets and the final GIF is independently reviewable | Browser acceptance | hybrid | not-run |

## Detailed Cases

### AC-TEAM-001 — Requester-owned account is selected first

- **Preconditions:** One active Team; Member A and Member B are active; both
  own active, model-compatible contributions with healthy quota.
- **Actions:** Admit a new-session request authenticated by Member B.
- **Assertions:** B's contribution is selected with source `own`; no provider
  attempt is made through A; the route lease belongs to B's account.
- **Claim:** The Team router prefers the requester's usable capacity over
  shared capacity under controlled quota inputs. This does not prove a live
  provider request.
- **Evidence:** Focused Vitest output from `tests/team-routing.spec.ts`,
  `tests/team-postgres-routing.spec.ts`, and
  `tests/team-request-service.spec.ts`.
- **Cleanup:** Settle every lease and dispose stores/pools created by the tests.
- **Resource budget:** No Browser, DSH Web, Docker, or external request.
- **Provenance:** Dirty worktree state, exact commit, Node/pnpm versions, and
  `execution = mock` in the aggregate result.

### AC-TEAM-002 — Unavailable own account falls back to a teammate

- **Preconditions:** B owns a paused, exhausted, reserve-blocked, or
  model-incompatible contribution; A owns healthy compatible capacity.
- **Actions:** Admit B's request in a new session for each unavailable-own
  reason.
- **Assertions:** The unavailable B account is skipped before forwarding; A is
  selected with source `shared`; if no shared account is usable, admission
  returns an explicit no-capacity error without a provider attempt.
- **Claim:** Controlled router inputs produce conservative shared fallback;
  this is not a claim that a real subscription has reached a limit.
- **Evidence:** Focused routing/capacity/service test output.
- **Cleanup:** Settle leases and clear in-memory or random-schema test state.
- **Resource budget:** No external request.
- **Provenance:** `execution = mock` with quota source described as controlled.

### AC-TEAM-003 — Session affinity and hard-unavailability release

- **Preconditions:** A request has bound a Team/member/session tuple to one
  active account; another compatible account is available.
- **Actions:** Admit another request in the same session, then simulate an
  explicit `401`, `403`, or `429` hard-unavailability response and retry.
- **Assertions:** The healthy bound account remains selected; hard
  unavailability unbinds only that member's session/account binding; retry is
  bounded and may select another eligible account; ordinary failures do not
  cause arbitrary switching.
- **Claim:** Stickiness and bounded hard-limit failover work in the controlled
  gateway/router path.
- **Evidence:** `tests/team-gateway.spec.ts`,
  `tests/team-postgres-routing.spec.ts`, and service tests.
- **Cleanup:** Abort/settle streams and release route and traffic leases.
- **Resource budget:** No external request.
- **Provenance:** `execution = mock`.

### AC-TEAM-004 — Contribution and traffic safety guards

- **Preconditions:** Controlled quota snapshots and two Host/store instances
  sharing one PostgreSQL schema.
- **Actions:** Exercise personal reserve, the contributor's daily Credits cap,
  model allow-list, shared concurrency, per-key RPM/concurrency, lease
  expiry/renewal, and automatic circuit opening/reset. Concurrent admissions
  reserve a configured per-request Credits ceiling before forwarding, then
  settle provider-reported usage and release the unused reservation.
- **Assertions:** Shared quota reads fail closed; contributor-owned requests may
  remain fail-open only where specified; the atomic daily bucket satisfies
  `settled_credits + reserved_credits <= daily_credit_limit`; failed or
  cancelled attempts settle reported usage or release the full reservation when
  the provider reports none; each retry acquires a separate reservation;
  distributed guards do not over-admit; retry timing and errors are bounded and
  secret-free.
- **Claim:** Guard logic and PostgreSQL atomicity hold for the tested scheduler
  interleavings. Credits are an internal weighted-token unit, not OpenAI money
  or a percentage of subscription quota.
- **Evidence:** `tests/team-capacity` coverage within routing suites,
  `tests/team-traffic-guard.spec.ts`, `tests/team-postgres.spec.ts`, and
  `tests/team-postgres.integration.spec.ts` on PostgreSQL 17.
- **Cleanup:** Drop only the validated random integration schema and close its
  pools/connections.
- **Resource budget:** PostgreSQL allowed; no Browser or OpenAI request.
- **Provenance:** `execution = hybrid` only after the real PostgreSQL gate runs;
  otherwise controlled pg-mem evidence remains `mock`.

### AC-TEAM-005 — Contribution OAuth lifecycle

- **Preconditions:** An authenticated contribution owner and an isolated
  Credential Broker; no imported local `auth.json`.
- **Actions:** Start OAuth, observe `authorizing`, cancel, complete a controlled
  authorization, force `reauth_required`, reauthorize in place, and deliver a
  stale completion after pause/revoke.
- **Assertions:** Waiting is visible and cancellable; only the owner can control
  the contribution; credentials stay Host/Broker-only; reauthorization keeps
  contribution identity/policy; stale completion cannot reactivate paused or
  revoked state; diagnostics are redacted.
- **Claim:** The lifecycle state machine and browser-safe projection work under
  controlled Broker responses. Real OAuth is proved only by AC-TEAM-010.
- **Evidence:** Credential, service, route, remote-Broker, management-client,
  and settings-contract test output.
- **Cleanup:** Cancel operations, remove isolated test credentials, and dispose
  Broker/store resources.
- **Resource budget:** No external OAuth in this case.
- **Provenance:** `execution = mock`.

### AC-TEAM-006 — Emergency pause, revoke, and drain

- **Preconditions:** An active Team with one admitted request held open and an
  active contribution.
- **Actions:** Pause the Team concurrently with usage admission; revoke the
  contribution while a request is in flight; attempt later admissions.
- **Assertions:** PostgreSQL ordering prevents a pause from returning before an
  earlier durable usage insert; after pause/revoke no new admission succeeds;
  admitted work may settle; credential deletion happens after drain and is
  retried on startup if interrupted.
- **Claim:** Control-plane stop semantics are linearizable for the tested real
  PostgreSQL interleaving and fail closed for cleanup.
- **Evidence:** Request-service, store, real PostgreSQL integration, and Broker
  lifecycle tests.
- **Cleanup:** Release advisory barriers, settle work, dispose pools, and drop
  only the random test schema.
- **Resource budget:** PostgreSQL allowed; no OpenAI request.
- **Provenance:** `execution = hybrid` after the PostgreSQL 17 gate.

### AC-TEAM-007 — Invitation, key, role, and tenant isolation

- **Preconditions:** Two independent Teams on one Host; Owner/Member identities,
  one active invitation, and distinct member-key material.
- **Actions:** Join once, retry an invite, authenticate with distinct member
  keys, transfer ownership, revoke a key, leave as a non-owner, and attempt
  cross-Team access.
- **Assertions:** Each invitation can join successfully only once and can be
  revoked; only the current Owner can explicitly re-reveal an eligible pending,
  unexpired, unrevoked invitation while list responses remain secretless and the
  reveal response is `no-store`; member keys are hashed at rest and returned only
  when issued; permissions follow the authenticated member; cross-Team data is
  never returned; an Owner cannot leave without transfer.
- **Claim:** Team control-plane isolation holds in memory, PostgreSQL, routes,
  and the packaged Compose smoke.
- **Evidence:** Team/store/route/management tests plus
  `deploy/host/smoke-multi-team.mjs` output.
- **Cleanup:** Revoke disposable keys/invites and remove only disposable Teams
  or the disposable database volume created for the run.
- **Resource budget:** Docker/PostgreSQL allowed; no OpenAI request.
- **Provenance:** `execution = hybrid` after Compose smoke.

### AC-TEAM-008 — Request, Token, and estimated-cost usage audit

- **Preconditions:** One admitted request and known consumer, upstream owner,
  account, model, and status.
- **Actions:** Begin and settle successful, failed, cancelled, streamed, and
  retried attempts; fetch one-day and seven-day aggregates as authorized and
  unauthorized members.
- **Assertions:** Host-only rows contain Team, consumer, upstream owner/account,
  model, `unit = request`, status, timestamps, settled internal Credits,
  aggregate `total_tokens`, nullable integer micro-USD estimate,
  `credits_formula_version`, and `pricing_catalog_version`. The gateway validates
  provider-reported numeric input, cached-input, and output token counts;
  `total_tokens = input + output`, while the versioned USD estimate prices
  uncached input, cached input, and output separately. Output includes reasoning.
  The individual Token counters remain transient and do not enter Browser
  projections. Rows contain no prompt, response, file content, credential,
  Team-key value, raw provider error, or Provider billing amount. Unknown pricing
  preserves Token while leaving cost null; historical estimates do not change
  when a later price catalog is installed. Formula `credits-v1` remains an
  internal admission guard and is not exposed as a user-facing amount.
- **Assertions:** The aggregate-only Browser DTO returns request, Token-measured,
  and priced counts plus nullable Token and estimated-cost subtotals. Owner gets
  Team total and their own included subset; a member gets only their own
  consumer-keyed total. It returns no per-request event, member/account/model
  field, Token breakdown, actual bill, or other-member details.
- **Claim:** The plugin can present a frozen API-price-equivalent estimate in USD
  and aggregate Token count without claiming Provider actual spend, subscription
  balance, member billing, or exact subscription-percentage consumption.
- **Evidence:** Gateway, service, management-route/client, safe-message, and
  usage tests.
- **Cleanup:** Complete in-progress fixtures and dispose stores.
- **Resource budget:** No external request.
- **Provenance:** `execution = mock`; real attribution is added by AC-TEAM-010.

### AC-TEAM-009 — Packaged multi-Team infrastructure

- **Preconditions:** Fresh generated ignored secrets and disposable PostgreSQL
  17 volume; package-built Host, migrator, Broker, and Edge images.
- **Actions:** Start Compose, wait for health, run the packaged multi-Team
  smoke, and inspect allowed/denied runtime role operations.
- **Assertions:** Migrations finish once; Host cannot read credential rows;
  Broker cannot read control-plane rows; Edge exposes only its allow-listed Team
  API; two Teams remain isolated; every service stops cleanly.
- **Claim:** The real local deployment topology works without contacting
  OpenAI. It does not prove OAuth or model availability.
- **Evidence:** Sanitized Compose state, health checks, multi-Team smoke output,
  and `result.json`/`provenance.json`.
- **Cleanup:** Stop services and remove only the run-owned disposable volume and
  generated secrets after evidence is sealed.
- **Resource budget:** Docker/PostgreSQL/network listeners allowed; no external
  model call.
- **Provenance:** `execution = real` for local infrastructure and `notProven`
  explicitly lists OpenAI OAuth/model behavior.

### AC-TEAM-010 — Two real contributors and routing

- **Preconditions:** AC-TEAM-001 through AC-TEAM-009 pass; a disposable Team;
  two consenting users/accounts can complete separate device-code OAuth; both
  accounts can use the selected low-volume Codex model.
- **Actions:** Authorize A and B separately; request as B in a new session;
  pause B's contribution; request as B in another new session; repeat in that
  session; pause the Team; attempt one rejected request.
- **Assertions:** First request uses B-owned capacity; the next uses A-shared
  capacity; the repeated session stays on A while healthy; Team pause rejects
  before provider forwarding; usage rows match consumer/upstream ownership and
  terminal status exactly.
- **Claim:** Real OpenAI credential chains and Responses traffic support the
  MVP own -> shared -> sticky flow at the observed time. It does not prove exact
  token cost, future authorization coexistence, or quota exhaustion behavior.
- **Evidence:** Sanitized machine result and metadata-only usage projection.
  Device codes, prompts, and model output are not evidence and are not saved.
- **Cleanup:** Pause Team, cancel unfinished OAuth, drain/revoke contributions,
  remove Pool credential copies, remove B, and revoke disposable Team keys.
- **Resource budget:** Exactly three successful fixed minimal Responses requests
  plus one rejection expected; two explicit human OAuth pauses.
- **Provenance:** `execution = real`, exact commit/dirty state, model id,
  transport, Provider attempt count, and retained-data limitations.

### AC-TEAM-011 — Stock DSH Team client on port 3181

- **Preconditions:** Exact plugin tarball installed in a fresh isolated
  `DSH_HOME`; trusted stock rc.8 `lib/bin.js` checksum matches the recorded
  release digest; one member Team key is in the Host credential provider.
- **Actions:** Start stock DSH on `127.0.0.1:3181`, inspect config/boot/client
  bundle, send one Codex model request in Team-client mode, and read its Team
  usage row.
- **Assertions:** Host and Browser entries load; Team Settings appears; the
  request goes to the Team gateway rather than the local profile allocator;
  usage identifies the selected upstream account; no key reaches Browser
  responses or logs; shutdown leaves no process or port.
- **Claim:** The packed plugin integrates with stock DSH rc.8 and performs one
  real Team-client request. Package-format validation alone cannot satisfy it.
- **Evidence:** Tarball checksum/list, DSH integrity match, config/routes,
  Browser assertions, sanitized request result, and evidence JSON pair.
- **Cleanup:** Stop DSH, remove only the run-owned temporary profile/workspace,
  and revoke/delete the disposable local Team-key reference.
- **Resource budget:** One Browser process and one real fixed model request.
- **Provenance:** `execution = real`; runtime DSH/Cordis versions and stable
  entry checksums come from the running isolated profile.

### AC-TEAM-012 — Team Settings and final GIF

- **Preconditions:** AC-TEAM-011's stock installation and one sanitized Team
  fixture or the disposable accepted Team; viewport and crop are fixed.
- **Actions:** Show personal sharing active, pause the Team, verify Owner/Member
  aggregate-only projection and the complete/partial/price-unknown/unmeasured/
  zero/unavailable usage states, exercise OAuth waiting/cancel, and encode the
  final short GIF.
- **Assertions:** Owner sees Team total plus their included personal subset;
  Member sees only their own aggregate; no response or frame exposes per-request
  activity or member/account/model metadata; every critical UI state has a
  DOM/API assertion; the GIF is readable and accurately scoped; it contains no
  account name/email/id, Team key, invite token, device code, prompt, response,
  path, or cookie; every encoded frame passes independent review.
- **Claim:** The UI communicates the accepted Team flow. The GIF alone does not
  prove provider routing; real claims require AC-TEAM-010/011 machine evidence.
- **Evidence:** Browser trace, final GIF checksum, `result.json`,
  `provenance.json`, `resources.json`, and independent `gif-review.md`.
- **Cleanup:** Stop Browser/server resources and delete source frames,
  duplicate media, and temporary profiles after final evidence is sealed.
- **Resource budget:** Reuse the accepted stock DSH run where practical; no
  additional provider request solely for visual polish.
- **Provenance:** `execution = hybrid` if real Team metadata is shown with a
  controlled UI transition; exceptions must name exactly what is mocked.

## Execution Order

1. Run AC-TEAM-001 through AC-TEAM-008 as the no-account automatic gate.
2. Run AC-TEAM-009 against disposable PostgreSQL/Compose infrastructure.
3. Implement and dry-run the guarded live runner without provider access.
4. Ask the user to complete the two AC-TEAM-010 device-code authorizations.
5. Reuse that disposable Team for AC-TEAM-011 and AC-TEAM-012, then clean up.
