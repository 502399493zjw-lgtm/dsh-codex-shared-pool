import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  MemoryTeamStore,
  TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS,
  TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS,
  TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS,
  TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS,
  TeamDissolutionRecoveryRateLimitError,
  TeamInviteRevealRateLimitError,
} from '../src/team/store.ts'
import { TeamService } from '../src/team/service.ts'
import type { TeamCredentialBroker, TeamCredentialRef } from '../src/team/credentials.ts'
import type { TeamCredentialHandoffEnvelope } from '../src/team/oauth-handoff.ts'
import type { TeamOAuthMethod } from '../src/team/types.ts'
import { TeamRequestRouter } from '../src/team/routing.ts'
import { TeamInviteCipher } from '../src/team/invite-cipher.ts'
import type { TeamInviteKeyEncryptionProvider } from '../src/team/invite-cipher.ts'
import { Aes256GcmTeamInviteKeyEncryptionProvider } from '../src/team/invite-key-encryption.ts'
import { TEAM_AUTHORIZATION_FAILED_CODE } from '../src/shared/team-management.ts'

function blockingRevealCipher(): {
  cipher: TeamInviteCipher
  decryptStarted: Promise<void>
  releaseDecrypt: () => void
} {
  const delegate = new Aes256GcmTeamInviteKeyEncryptionProvider(Buffer.alloc(32, 0x5a))
  let signalDecryptStarted!: () => void
  let releaseDecrypt!: () => void
  const decryptStarted = new Promise<void>(resolve => { signalDecryptStarted = resolve })
  const decryptReleased = new Promise<void>(resolve => { releaseDecrypt = resolve })
  const keyEncryptionProvider: TeamInviteKeyEncryptionProvider = {
    wrapKey: (context, plaintextKey) => delegate.wrapKey(context, plaintextKey),
    unwrapKey: async (context, wrappedKey) => {
      signalDecryptStarted()
      await decryptReleased
      return delegate.unwrapKey(context, wrappedKey)
    },
  }
  return {
    cipher: new TeamInviteCipher({ keyEncryptionProvider }),
    decryptStarted,
    releaseDecrypt,
  }
}

function seedLegacyAdmin(store: MemoryTeamStore, memberId: string): void {
  const members = (store as unknown as {
    members: Map<string, { role: 'owner' | 'admin' | 'member' }>
  }).members
  const member = members.get(memberId)
  if (member === undefined) throw new Error('legacy admin fixture member should exist')
  member.role = 'admin'
}

type TestTeamAuthContext = NonNullable<Awaited<ReturnType<MemoryTeamStore['authenticateApiKey']>>>

interface TestTeamLifecycleSummary {
  readonly id: string
  readonly name: string
  readonly status: 'active' | 'paused' | 'dissolved'
  readonly lifecycleRevision: number
  readonly createdAt: number
}

interface TestTeamLifecycleTransitionInput {
  readonly operationId: string
  readonly expectedLifecycleRevision: number
  readonly status: 'active' | 'paused'
}

interface TestTeamDissolutionInput {
  readonly operationId: string
  readonly expectedLifecycleRevision: number
  readonly confirmationName: string
  readonly recoverySecretHash: string
}

interface TestTeamDissolutionResult {
  readonly operationId: string
  readonly teamId: string
  readonly teamName: string
  readonly status: 'dissolved'
  readonly lifecycleRevision: number
  readonly dissolvedAt: number
  readonly terminatedMemberCount: number
  readonly revokedInviteCount: number
  readonly revokedKeyCount: number
  readonly revokedContributionCount: number
}

interface TestMemoryTeamLifecycleStore {
  setTeamStatus(
    auth: TestTeamAuthContext,
    input: TestTeamLifecycleTransitionInput,
  ): Promise<TestTeamLifecycleSummary>
  dissolveTeam(
    auth: TestTeamAuthContext,
    input: TestTeamDissolutionInput,
  ): Promise<TestTeamDissolutionResult>
  recoverTeamDissolution(operationId: string, recoverySecret: string): Promise<TestTeamDissolutionResult>
  ackTeamDissolution(operationId: string, recoverySecret: string): Promise<void>
  diagnoseApiKey(token: string): Promise<{
    readonly code: 'member_removed' | 'member_left' | 'team_dissolved' | 'device_revoked'
  } | undefined>
}

const TEST_ONLY_RECOVERY_SECRET = 'test-only-recovery-secret-000000000000000000000000000000000000000000000000'
const TEST_ONLY_WRONG_RECOVERY_SECRET = 'test-only-recovery-secret-100000000000000000000000000000000000000000000000'
const TEST_ONLY_RECOVERY_SECRET_HASH = createHash('sha256').update(TEST_ONLY_RECOVERY_SECRET).digest('hex')

function lifecycleStore(store: MemoryTeamStore): TestMemoryTeamLifecycleStore {
  return store as unknown as TestMemoryTeamLifecycleStore
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => { throw new Error('expected operation to reject') },
    (error: unknown) => {
      if (!(error instanceof Error)) throw new Error('expected rejection to be an Error')
      return error
    },
  )
}

function errorFingerprint(error: Error): {
  readonly name: string
  readonly message: string
  readonly status?: unknown
  readonly code?: unknown
} {
  const detailed = error as Error & { readonly status?: unknown; readonly code?: unknown }
  return {
    name: detailed.name,
    message: detailed.message,
    ...(detailed.status === undefined ? {} : { status: detailed.status }),
    ...(detailed.code === undefined ? {} : { code: detailed.code }),
  }
}

class FakeCredentialBroker implements TeamCredentialBroker {
  readonly started: TeamCredentialRef[] = []
  readonly restarted: TeamCredentialRef[] = []
  readonly cancelled: TeamCredentialRef[] = []
  readonly revoked: TeamCredentialRef[] = []
  readonly inspected: TeamCredentialRef[] = []
  readonly completed: Array<{ ref: TeamCredentialRef; envelope: TeamCredentialHandoffEnvelope }> = []
  readonly methods: TeamOAuthMethod[] = []

  constructor(
    private readonly onCancel: (ref: TeamCredentialRef) => Promise<void> = async () => undefined,
    private readonly authorizationStatus: 'active' | 'reauth_required' = 'active',
    private readonly onRevoke: (ref: TeamCredentialRef) => Promise<void> = async () => undefined,
  ) {}

  startOAuth(ref: TeamCredentialRef, method: TeamOAuthMethod = 'device_code'): ReturnType<TeamCredentialBroker['startOAuth']> {
    this.started.push(ref)
    this.methods.push(method)
    if (method === 'browser') {
      return Promise.resolve({
        method: 'browser_handoff',
        handoff: {
          version: 1,
          sessionId: '00000000-0000-4000-8000-000000000001',
          serverPublicKey: 'test-public-key',
          expiresAt: 1_800_000,
        },
      })
    }
    return Promise.resolve({
      method: 'device_code',
      verificationUrl: 'https://auth.example.test/codex/device',
      userCode: 'ABCD-EFGH',
      expiresAt: 1_800_000,
    })
  }

  restartOAuth(ref: TeamCredentialRef, method: TeamOAuthMethod = 'device_code'): ReturnType<TeamCredentialBroker['restartOAuth']> {
    this.restarted.push(ref)
    return this.startOAuth(ref, method)
  }

  completeOAuthHandoff(
    ref: TeamCredentialRef,
    envelope: TeamCredentialHandoffEnvelope,
  ): ReturnType<TeamCredentialBroker['completeOAuthHandoff']> {
    this.completed.push({ ref, envelope })
    return Promise.resolve({ status: 'active', accountLabel: 'Owner Codex' })
  }

  async cancelOAuth(ref: TeamCredentialRef): Promise<void> {
    this.cancelled.push(ref)
    await this.onCancel(ref)
  }

  inspectAuthorization(ref: TeamCredentialRef): Promise<{ status: 'active' | 'reauth_required' }> {
    this.inspected.push(ref)
    return Promise.resolve({ status: this.authorizationStatus })
  }

  readUsage(): Promise<{ rateLimits: [] }> {
    return Promise.resolve({ rateLimits: [] })
  }

  forwardResponses(): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 204 }))
  }

  async revoke(ref: TeamCredentialRef): Promise<void> {
    this.revoked.push(ref)
    await this.onRevoke(ref)
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }
}

describe('Team control plane', () => {
  it('bootstraps a Team and only returns the API key once', async () => {
    const store = new MemoryTeamStore({ id: (() => { let i = 0; return () => `id-${++i}` })() })
    const result = await store.bootstrap('Friends', 'Owner')

    expect(result.team.name).toBe('Friends')
    expect(result.team).toMatchObject({ status: 'active', lifecycleRevision: 1 })
    expect(result.member.role).toBe('owner')
    expect(result.apiKey).toMatch(/^dsh_team_/u)
    expect((await store.overview(await store.authenticateApiKey(result.apiKey)!)).apiKeys[0]).not.toHaveProperty('token')
  })

  it('serializes lifecycle transitions, replays one operation idempotently, and rejects an ABA write with 409', async () => {
    const store = new MemoryTeamStore()
    const lifecycle = lifecycleStore(store)
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const pauseInput = {
      operationId: '00000000-0000-4000-8000-000000000101',
      expectedLifecycleRevision: 1,
      status: 'paused',
    } as const

    const paused = await lifecycle.setTeamStatus(owner, pauseInput)
    expect(paused).toMatchObject({ status: 'paused', lifecycleRevision: 2 })
    await expect(lifecycle.setTeamStatus(owner, pauseInput)).resolves.toEqual(paused)

    await expect(lifecycle.setTeamStatus(owner, {
      ...pauseInput,
      status: 'active',
    })).rejects.toMatchObject({ status: 409 })

    await expect(lifecycle.setTeamStatus(owner, {
      operationId: '00000000-0000-4000-8000-000000000102',
      expectedLifecycleRevision: 2,
      status: 'active',
    })).resolves.toMatchObject({ status: 'active', lifecycleRevision: 3 })

    await expect(lifecycle.setTeamStatus(owner, {
      operationId: '00000000-0000-4000-8000-000000000103',
      expectedLifecycleRevision: 1,
      status: 'paused',
    })).rejects.toMatchObject({ status: 409 })
    await expect(store.overview(owner)).resolves.toMatchObject({
      team: { status: 'active', lifecycleRevision: 3 },
    })
  })

  it('allows only the current owner to dissolve and requires an exact Team-name confirmation', async () => {
    const store = new MemoryTeamStore()
    const lifecycle = lifecycleStore(store)
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000, 'Member')
    const joined = await store.acceptInvite(invite.inviteToken, 'Member')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')

    await expect(lifecycle.dissolveTeam(member, {
      operationId: '00000000-0000-4000-8000-000000000201',
      expectedLifecycleRevision: 1,
      confirmationName: 'Friends',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    })).rejects.toThrow(/only.*owner/iu)
    await expect(lifecycle.dissolveTeam(owner, {
      operationId: '00000000-0000-4000-8000-000000000202',
      expectedLifecycleRevision: 1,
      confirmationName: 'friends',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    })).rejects.toThrow(/confirmation|match|name/iu)
    await expect(lifecycle.dissolveTeam(owner, {
      operationId: '00000000-0000-4000-8000-000000000203',
      expectedLifecycleRevision: 1,
      confirmationName: 'Friends ',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    })).rejects.toThrow(/confirmation|match|name/iu)
    await expect(store.overview(owner)).resolves.toMatchObject({
      team: { status: 'active', lifecycleRevision: 1 },
    })
  })

  it('allows a paused Team to be permanently dissolved', async () => {
    const store = new MemoryTeamStore({ now: () => 2_000 })
    const lifecycle = lifecycleStore(store)
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    await lifecycle.setTeamStatus(owner, {
      operationId: '00000000-0000-4000-8000-000000000301',
      expectedLifecycleRevision: 1,
      status: 'paused',
    })

    await expect(lifecycle.dissolveTeam(owner, {
      operationId: '00000000-0000-4000-8000-000000000302',
      expectedLifecycleRevision: 2,
      confirmationName: 'Friends',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    })).resolves.toMatchObject({
      operationId: '00000000-0000-4000-8000-000000000302',
      teamId: owner.teamId,
      teamName: 'Friends',
      status: 'dissolved',
      lifecycleRevision: 3,
      dissolvedAt: 2_000,
    })
    await expect(store.authenticateApiKey(boot.apiKey)).resolves.toBeUndefined()
  })

  it('atomically invalidates members, invitations, keys, and contributions when an active Team is dissolved', async () => {
    let now = 1_000
    const store = new MemoryTeamStore({ now: () => now })
    const lifecycle = lifecycleStore(store)
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const joiningInvite = await store.createInvite(owner, 60_000, 'Member')
    const joined = await store.acceptInvite(joiningInvite.inviteToken, 'Member')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const memberSecondKey = await store.issueApiKey(member, 'Member test device')
    const pendingInvite = await store.createInvite(owner, 60_000, 'Pending')
    const ownerContribution = await store.createContributionAccount(owner, 'Owner test contribution')
    const memberContribution = await store.createContributionAccount(member, 'Member test contribution')
    await store.setContributionAccountStatus(owner.teamId, ownerContribution.id, 'active')
    await store.setContributionAccountStatus(owner.teamId, memberContribution.id, 'active')
    now = 2_000

    const dissolved = await lifecycle.dissolveTeam(owner, {
      operationId: '00000000-0000-4000-8000-000000000401',
      expectedLifecycleRevision: 1,
      confirmationName: 'Friends',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    })

    expect(dissolved).toMatchObject({
      operationId: '00000000-0000-4000-8000-000000000401',
      teamId: owner.teamId,
      teamName: 'Friends',
      status: 'dissolved',
      lifecycleRevision: 2,
      dissolvedAt: 2_000,
      terminatedMemberCount: 2,
      revokedInviteCount: 1,
      revokedKeyCount: 3,
      revokedContributionCount: 2,
    })
    expect(JSON.stringify(dissolved)).not.toContain(TEST_ONLY_RECOVERY_SECRET)
    expect(JSON.stringify(dissolved)).not.toContain(TEST_ONLY_RECOVERY_SECRET_HASH)
    await expect(store.authenticateApiKey(boot.apiKey)).resolves.toBeUndefined()
    await expect(store.authenticateApiKey(joined.apiKey)).resolves.toBeUndefined()
    await expect(store.authenticateApiKey(memberSecondKey.token)).resolves.toBeUndefined()
    await expect(store.overview(owner)).rejects.toBeInstanceOf(Error)
    await expect(store.overview(member)).rejects.toBeInstanceOf(Error)
    await expect(store.previewInvite(pendingInvite.inviteToken)).rejects.toBeInstanceOf(Error)
    await expect(store.acceptInvite(pendingInvite.inviteToken, 'Late member')).rejects.toBeInstanceOf(Error)
    await expect(store.listContributionAccountsByStatus('revoked')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ownerContribution.id, status: 'revoked' }),
      expect.objectContaining({ id: memberContribution.id, status: 'revoked' }),
    ]))
    await expect(store.setContributionAccountStatus(owner.teamId, ownerContribution.id, 'active'))
      .resolves.toMatchObject({ status: 'revoked' })
  })

  it('recovers one secret-free dissolution result, uniformly rejects bad recovery credentials, and ACKs repeatedly', async () => {
    const store = new MemoryTeamStore({ now: () => 3_000 })
    const lifecycle = lifecycleStore(store)
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const operationId = '00000000-0000-4000-8000-000000000501'
    const dissolved = await lifecycle.dissolveTeam(owner, {
      operationId,
      expectedLifecycleRevision: 1,
      confirmationName: 'Friends',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    })

    const recovered = { operationType: 'team_dissolution', status: 'dissolved' }
    await expect(lifecycle.recoverTeamDissolution(operationId, TEST_ONLY_RECOVERY_SECRET)).resolves.toEqual(recovered)
    await expect(lifecycle.recoverTeamDissolution(operationId, TEST_ONLY_RECOVERY_SECRET)).resolves.toEqual(recovered)

    const wrongSecretError = await rejectedError(
      lifecycle.recoverTeamDissolution(operationId, TEST_ONLY_WRONG_RECOVERY_SECRET),
    )
    const unknownOperationError = await rejectedError(lifecycle.recoverTeamDissolution(
      '00000000-0000-4000-8000-000000000599',
      TEST_ONLY_RECOVERY_SECRET,
    ))
    expect(errorFingerprint(wrongSecretError)).toEqual(errorFingerprint(unknownOperationError))
    expect(JSON.stringify(errorFingerprint(wrongSecretError))).not.toContain(TEST_ONLY_WRONG_RECOVERY_SECRET)
    expect(JSON.stringify(errorFingerprint(unknownOperationError))).not.toContain('00000000-0000-4000-8000-000000000599')

    await expect(lifecycle.ackTeamDissolution(operationId, TEST_ONLY_RECOVERY_SECRET)).resolves.toBeUndefined()
    await expect(lifecycle.ackTeamDissolution(operationId, TEST_ONLY_RECOVERY_SECRET)).resolves.toBeUndefined()
    await expect(lifecycle.recoverTeamDissolution(operationId, TEST_ONLY_RECOVERY_SECRET)).resolves.toEqual(recovered)
    await expect(lifecycle.setTeamStatus(owner, {
      operationId: '00000000-0000-4000-8000-000000000502',
      expectedLifecycleRevision: 2,
      status: 'active',
    })).rejects.toBeInstanceOf(Error)
    await expect(lifecycle.recoverTeamDissolution(operationId, TEST_ONLY_RECOVERY_SECRET)).resolves.toEqual(recovered)
  })

  it('rate-limits dissolution recovery per source while reserving an independent ACK bucket', async () => {
    let now = 120_000
    const store = new MemoryTeamStore({ now: () => now })
    const sourceDigest = 'a'.repeat(64)

    for (let attempt = 0; attempt < TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      await expect(store.consumeDissolutionRecoveryAttempt(sourceDigest, 'result')).resolves.toBeUndefined()
    }

    const limited = await store.consumeDissolutionRecoveryAttempt(sourceDigest, 'result')
      .catch((error: unknown) => error)
    expect(limited).toBeInstanceOf(TeamDissolutionRecoveryRateLimitError)
    expect(limited).toMatchObject({
      message: 'Team dissolution recovery rate limit exceeded',
      retryAfterSeconds: TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS / 1_000,
    })
    await expect(store.consumeDissolutionRecoveryAttempt(sourceDigest, 'ack')).resolves.toBeUndefined()
    await expect(store.consumeDissolutionRecoveryAttempt('b'.repeat(64), 'result')).resolves.toBeUndefined()

    now += TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS
    await expect(store.consumeDissolutionRecoveryAttempt(sourceDigest, 'result')).resolves.toBeUndefined()
  })

  it('diagnoses an old Team key with only its coarse terminal reason', async () => {
    const store = new MemoryTeamStore()
    const lifecycle = lifecycleStore(store)
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const replacement = await store.issueApiKey(owner, 'Owner replacement')
    const replacementOwner = await store.authenticateApiKey(replacement.token)
    if (replacementOwner === undefined) throw new Error('replacement owner key should authenticate')
    await store.revokeApiKey(replacementOwner, owner.keyId)

    const leavingInvite = await store.createInvite(replacementOwner, 60_000)
    const leaving = await store.acceptInvite(leavingInvite.inviteToken, 'Leaving member')
    const leavingMember = await store.authenticateApiKey(leaving.apiKey)
    if (leavingMember === undefined) throw new Error('leaving member key should authenticate')
    await store.leaveTeam(leavingMember)

    const removedInvite = await store.createInvite(replacementOwner, 60_000)
    const removed = await store.acceptInvite(removedInvite.inviteToken, 'Removed member')
    await store.removeMember(replacementOwner, removed.member.id)

    await lifecycle.dissolveTeam(replacementOwner, {
      operationId: '00000000-0000-4000-8000-000000000601',
      expectedLifecycleRevision: 1,
      confirmationName: 'Friends',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    })

    await expect(lifecycle.diagnoseApiKey(boot.apiKey)).resolves.toEqual({ code: 'device_revoked' })
    await expect(lifecycle.diagnoseApiKey(leaving.apiKey)).resolves.toEqual({ code: 'member_left' })
    await expect(lifecycle.diagnoseApiKey(removed.apiKey)).resolves.toEqual({ code: 'member_removed' })
    await expect(lifecycle.diagnoseApiKey(replacement.token)).resolves.toEqual({ code: 'team_dissolved' })
    await expect(lifecycle.diagnoseApiKey('dsh_team_test-only-unknown-key-000000000000'))
      .resolves.toBeUndefined()
  })

  it('accepts an invite once and rejects it after use', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)

    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    expect(joined.member.role).toBe('member')
    await expect(store.acceptInvite(invite.inviteToken, 'Second')).rejects.toThrow(/invalid or expired/u)
  })

  it('normalizes member names, rejects an active NFKC_Casefold collision, and leaves the losing invite unused', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', '\u3000Ｏｗｎｅｒ\u3000')
    expect(boot.member.displayName).toBe('Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const firstInvite = await store.createInvite(owner, 60_000, 'First')
    const secondInvite = await store.createInvite(owner, 60_000, 'Second')

    await expect(store.acceptInvite(firstInvite.inviteToken, 'Straße')).resolves.toMatchObject({
      member: { displayName: 'Straße', role: 'member' },
    })
    await expect(store.acceptInvite(secondInvite.inviteToken, 'STRASSE'))
      .rejects.toThrow(/display name.+already in use/iu)

    await expect(store.previewInvite(secondInvite.inviteToken)).resolves.toMatchObject({
      teamName: 'Friends',
      label: 'Second',
    })
    await expect(store.acceptInvite(secondInvite.inviteToken, 'Unique member')).resolves.toMatchObject({
      member: { displayName: 'Unique member', role: 'member' },
    })
  })

  it('previews a labeled invitation without consuming it', async () => {
    const store = new MemoryTeamStore({ now: () => 1_000 })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000, 'Mia · work laptop')

    await expect(store.previewInvite(invite.inviteToken)).resolves.toEqual({
      teamName: 'Friends',
      label: 'Mia · work laptop',
      expiresAt: 61_000,
      teamStatus: 'active',
    })
    await expect(store.previewInvite(invite.inviteToken)).resolves.toMatchObject({ label: 'Mia · work laptop' })
    await expect(store.acceptInvite(invite.inviteToken, 'Mia')).resolves.toMatchObject({
      member: { displayName: 'Mia', role: 'member' },
    })
  })

  it('lets only the current owner explicitly reveal a pending invitation without exposing it in overview', async () => {
    const store = new MemoryTeamStore({ now: () => 1_000 })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const created = await store.createInvite(owner, 60_000, 'Design reviewer')

    expect(created.invite).toMatchObject({ status: 'pending', revealable: true })
    expect(JSON.stringify(await store.overview(owner))).not.toContain(created.inviteToken)
    await expect(store.revealInvite(owner, created.invite.id)).resolves.toEqual({
      inviteId: created.invite.id,
      inviteToken: created.inviteToken,
      expiresAt: 61_000,
    })
    const revealAudit = await store.listInviteRevealAuditEvents(owner, 10)
    expect(revealAudit).toEqual([{
      id: expect.any(String),
      teamId: owner.teamId,
      actorMemberId: owner.memberId,
      inviteId: created.invite.id,
      createdAt: 1_000,
    }])
    expect(JSON.stringify(revealAudit)).not.toContain(created.inviteToken)

    const memberInvite = await store.createInvite(owner, 60_000, 'Member')
    const joined = await store.acceptInvite(memberInvite.inviteToken, 'Member')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    await expect(store.revealInvite(member, created.invite.id)).rejects.toThrow(/only the owner/iu)
    await expect(store.listInviteRevealAuditEvents(member, 10)).rejects.toThrow(/only the owner/iu)
    await expect(store.listInviteRevealAuditEvents(owner, 10)).resolves.toHaveLength(1)
  })

  it('rate-limits invitation reveal per Owner and invite for one fixed window', async () => {
    let now = 120_000
    const store = new MemoryTeamStore({ now: () => now })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const target = await store.createInvite(owner, 2 * TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS, 'Target')
    const other = await store.createInvite(owner, 2 * TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS, 'Other')

    for (let attempt = 0; attempt < TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      await expect(store.revealInvite(owner, target.invite.id)).resolves.toMatchObject({
        inviteId: target.invite.id,
        inviteToken: target.inviteToken,
      })
    }

    const limited = await store.revealInvite(owner, target.invite.id).catch((error: unknown) => error)
    expect(limited).toBeInstanceOf(TeamInviteRevealRateLimitError)
    expect(limited).toMatchObject({
      message: 'Team invitation reveal rate limit exceeded',
      retryAfterSeconds: TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS / 1_000,
    })
    expect(JSON.stringify(limited)).not.toContain(target.invite.id)
    expect(JSON.stringify(limited)).not.toContain(target.inviteToken)
    await expect(store.revealInvite(owner, other.invite.id)).resolves.toMatchObject({ inviteId: other.invite.id })

    now += TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS
    await expect(store.revealInvite(owner, target.invite.id)).resolves.toMatchObject({ inviteId: target.invite.id })
  })

  it('allows reveal while paused but rejects creating or accepting invitations', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000, 'Design reviewer')

    await lifecycleStore(store).setTeamStatus(owner, {
      operationId: '00000000-0000-4000-8000-000000000701',
      expectedLifecycleRevision: 1,
      status: 'paused',
    })

    await expect(store.revealInvite(owner, invite.invite.id)).resolves.toMatchObject({
      inviteId: invite.invite.id,
      inviteToken: invite.inviteToken,
    })
    await expect(store.createInvite(owner, 60_000, 'Another')).rejects.toThrow(/paused/iu)
    await expect(store.acceptInvite(invite.inviteToken, 'Reviewer')).rejects.toThrow(/paused/u)
  })

  it('does not audit an in-memory reveal that loses to a concurrent terminal mutation', async () => {
    const controlled = blockingRevealCipher()
    const store = new MemoryTeamStore({ inviteCipher: controlled.cipher })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const created = await store.createInvite(owner, 60_000, 'Race target')

    const reveal = store.revealInvite(owner, created.invite.id)
    await controlled.decryptStarted
    await store.revokeInvite(owner, created.invite.id)
    controlled.releaseDecrypt()

    await expect(reveal).rejects.toThrow(/no longer available/iu)
    await expect(store.listInviteRevealAuditEvents(owner, 10)).resolves.toEqual([])
  })

  it('destroys invitation ciphertext when it is accepted or revoked', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const accepted = await store.createInvite(owner, 60_000, 'Accepted')
    const revoked = await store.createInvite(owner, 60_000, 'Revoked')

    await store.acceptInvite(accepted.inviteToken, 'Member')
    await store.revokeInvite(owner, revoked.invite.id)

    await expect(store.revealInvite(owner, accepted.invite.id)).rejects.toThrow(/not found|no longer available/iu)
    await expect(store.revealInvite(owner, revoked.invite.id)).rejects.toThrow(/not found|no longer available/iu)
    expect((store as unknown as { invites: Map<string, { envelope?: unknown }> }).invites.get(accepted.invite.id))
      .not.toHaveProperty('envelope')
    expect((store as unknown as { invites: Map<string, { envelope?: unknown }> }).invites.get(revoked.invite.id))
      .not.toHaveProperty('envelope')
  })

  it('sweeps only expired invitation envelopes while retaining invitation records', async () => {
    let now = 1_000
    const store = new MemoryTeamStore({ now: () => now })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const expired = await store.createInvite(owner, 60_000, 'Expired')
    const future = await store.createInvite(owner, 120_000, 'Future')
    const records = (store as unknown as {
      invites: Map<string, { status: string; label: string; tokenHash: string; envelope?: unknown }>
    }).invites
    const expiredHash = records.get(expired.invite.id)?.tokenHash

    now = expired.invite.expiresAt

    await expect(store.sweepExpiredInviteEnvelopes()).resolves.toBe(1)
    expect(records.get(expired.invite.id)).toMatchObject({
      status: 'pending',
      label: 'Expired',
      tokenHash: expiredHash,
    })
    expect(records.get(expired.invite.id)).not.toHaveProperty('envelope')
    expect(records.get(future.invite.id)).toHaveProperty('envelope')
    await expect(store.sweepExpiredInviteEnvelopes()).resolves.toBe(0)
  })

  it('lazily expires and destroys invitation ciphertext when an owner list touches it', async () => {
    let now = 1_000
    const store = new MemoryTeamStore({ now: () => now })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const created = await store.createInvite(owner, 60_000, 'Expired')

    now = created.invite.expiresAt
    expect((await store.overview(owner)).invites).toEqual([])

    const stored = (store as unknown as {
      invites: Map<string, { status: string; envelope?: unknown }>
    }).invites.get(created.invite.id)
    expect(stored).toMatchObject({ status: 'expired' })
    expect(stored).not.toHaveProperty('envelope')
    await expect(store.revealInvite(owner, created.invite.id)).rejects.toThrow('invite is no longer available')
    await expect(store.previewInvite(created.inviteToken)).rejects.toThrow(/invalid or expired/u)
  })

  it('uses the same unavailable error when a reveal envelope cannot be decrypted', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const created = await store.createInvite(owner, 60_000, 'Corrupted')
    const stored = (store as unknown as {
      invites: Map<string, { envelope?: { tag: string } }>
    }).invites.get(created.invite.id)
    if (stored?.envelope === undefined) throw new Error('invite envelope should exist')
    const replacement = stored.envelope.tag.startsWith('A') ? 'B' : 'A'
    stored.envelope = { ...stored.envelope, tag: `${replacement}${stored.envelope.tag.slice(1)}` }

    await expect(store.revealInvite(owner, created.invite.id)).rejects.toThrow('invite is no longer available')
  })

  it('revokes every pending invitation when ownership is transferred', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const memberInvite = await store.createInvite(owner, 60_000, 'Member')
    const joined = await store.acceptInvite(memberInvite.inviteToken, 'Member')
    const pending = await store.createInvite(owner, 60_000, 'Pending')

    const target = await store.authenticateApiKey(joined.apiKey)
    if (target === undefined) throw new Error('member key should authenticate')
    const requested = await store.requestOwnershipTransfer(owner, joined.member.id)
    await store.acceptOwnershipTransfer(target, requested.id)
    const currentOwner = await store.authenticateApiKey(joined.apiKey)
    if (currentOwner === undefined) throw new Error('new owner key should authenticate')

    await expect(store.previewInvite(pending.inviteToken)).rejects.toThrow(/invalid or expired/u)
    await expect(store.revealInvite(currentOwner, pending.invite.id)).rejects.toThrow(/not found|no longer available/iu)
    expect((await store.overview(currentOwner)).invites).toEqual([])
  })

  it('allows previewing a paused Team but rejects accepting its invitation', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000, 'Design reviewer')
    await lifecycleStore(store).setTeamStatus(owner, {
      operationId: '00000000-0000-4000-8000-000000000702',
      expectedLifecycleRevision: 1,
      status: 'paused',
    })

    await expect(store.previewInvite(invite.inviteToken)).resolves.toMatchObject({
      teamName: 'Friends',
      label: 'Design reviewer',
      teamStatus: 'paused',
    })
    await expect(store.acceptInvite(invite.inviteToken, 'Reviewer')).rejects.toThrow(/paused/u)
  })

  it('registers a Host-supplied Team key while accepting an invitation', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000, 'Mia')
    const suppliedKey = 'dsh_team_host-generated-secret-1234567890'

    const joined = await store.acceptInviteWithApiKey(invite.inviteToken, 'Mia', suppliedKey)

    expect(joined).toEqual({
      team: expect.objectContaining({ name: 'Friends' }),
      member: expect.objectContaining({ displayName: 'Mia', role: 'member' }),
    })
    expect(JSON.stringify(joined)).not.toContain(suppliedKey)
    await expect(store.authenticateApiKey(suppliedKey)).resolves.toMatchObject({
      teamId: joined.team.id,
      memberId: joined.member.id,
      role: 'member',
    })
  })

  it.each([
    ['an invalid', 'invalid'],
    ['a duplicate', 'owner-key'],
  ])('does not consume an invitation when %s Host-supplied key is rejected', async (_label, rejectedKey) => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000, 'Mia')
    const suppliedKey = rejectedKey === 'owner-key' ? boot.apiKey : rejectedKey

    await expect(store.acceptInviteWithApiKey(invite.inviteToken, 'Mia', suppliedKey)).rejects.toThrow(/Team API key/u)

    await expect(store.previewInvite(invite.inviteToken)).resolves.toMatchObject({
      teamName: 'Friends',
      label: 'Mia',
    })
    expect((await store.overview(owner)).members).toHaveLength(1)

    const replacementKey = `dsh_team_replacement-${rejectedKey}-1234567890`
    await expect(store.acceptInviteWithApiKey(invite.inviteToken, 'Mia', replacementKey)).resolves.toMatchObject({
      member: { displayName: 'Mia' },
    })
    await expect(store.authenticateApiKey(replacementKey)).resolves.toMatchObject({ role: 'member' })
  })

  it('grants legacy admins only member permissions and never writes a new role-change audit', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const adminInvite = await store.createInvite(owner, 60_000, 'Admin')
    const adminJoin = await store.acceptInvite(adminInvite.inviteToken, 'Admin')
    seedLegacyAdmin(store, adminJoin.member.id)
    const admin = await store.authenticateApiKey(adminJoin.apiKey)
    if (admin === undefined || admin.role !== 'admin') throw new Error('legacy admin key should authenticate')

    const memberInvite = await store.createInvite(owner, 60_000, 'Member')
    const memberJoin = await store.acceptInvite(memberInvite.inviteToken, 'Member')
    const member = await store.authenticateApiKey(memberJoin.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const memberKey = await store.issueApiKey(member, 'Member secondary')
    const adminKey = await store.issueApiKey(admin, 'Legacy admin secondary')
    const roleAuditCountBefore = (await store.listMembershipAuditEvents(owner, 100))
      .filter(event => event.action === 'role_changed').length
    expect(store).not.toHaveProperty('updateMemberRole')

    await expect(store.removeMember(admin, member.memberId)).rejects.toThrow(/only the owner/iu)
    await expect(store.revokeApiKey(admin, memberKey.summary.id)).rejects.toThrow(/only the key owner or the Team owner/iu)
    await expect(store.listMembershipAuditEvents(admin, 10)).rejects.toThrow(/only the owner/iu)
    await expect(store.revokeApiKey(admin, adminKey.summary.id)).resolves.toBeUndefined()

    await expect(store.removeMember(owner, member.memberId)).resolves.toMatchObject({
      member: { id: member.memberId, status: 'removed' },
    })
    await expect(store.authenticateApiKey(memberJoin.apiKey)).resolves.toBeUndefined()

    const auditEvents = await store.listMembershipAuditEvents(owner, 100)
    expect(auditEvents.filter(event => event.action === 'role_changed')).toHaveLength(roleAuditCountBefore)
    expect(auditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorMemberId: owner.memberId,
        targetMemberId: member.memberId,
        action: 'member_removed',
        previousRole: 'member',
        result: 'succeeded',
      }),
    ]))
  })

  it('keeps legacy admins out of invitation and Team status management', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const adminInvite = await store.createInvite(owner, 60_000, 'Legacy admin')
    const adminJoin = await store.acceptInvite(adminInvite.inviteToken, 'Legacy admin')
    seedLegacyAdmin(store, adminJoin.member.id)
    const admin = await store.authenticateApiKey(adminJoin.apiKey)
    if (admin === undefined || admin.role !== 'admin') throw new Error('legacy admin key should authenticate')
    const pending = await store.createInvite(owner, 60_000, 'Pending')

    await expect(store.createInvite(admin, 60_000, 'Forbidden')).rejects.toThrow(/only the owner/iu)
    await expect(store.revokeInvite(admin, pending.invite.id)).rejects.toThrow(/only the owner/iu)
    await expect(lifecycleStore(store).setTeamStatus(admin, {
      operationId: '00000000-0000-4000-8000-000000000703',
      expectedLifecycleRevision: 1,
      status: 'paused',
    })).rejects.toThrow(/only the owner/iu)
    await expect(store.overview(owner)).resolves.toMatchObject({
      team: { status: 'active' },
      invites: expect.arrayContaining([expect.objectContaining({ id: pending.invite.id, status: 'pending' })]),
    })
  })

  it('lets an operator revoke an unused invite immediately and idempotently', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const memberInvite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(memberInvite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const pending = await store.createInvite(owner, 60_000)

    await expect(store.revokeInvite(member, pending.invite.id)).rejects.toThrow(/only the owner/iu)
    await expect(store.revokeInvite(owner, pending.invite.id)).resolves.toMatchObject({ status: 'revoked' })
    await expect(store.revokeInvite(owner, pending.invite.id)).resolves.toMatchObject({ status: 'revoked' })
    await expect(store.acceptInvite(pending.inviteToken, 'Outsider')).rejects.toThrow(/invalid or expired/u)
    expect((await store.overview(owner)).invites).not.toContainEqual(expect.objectContaining({ id: pending.invite.id }))
  })

  it('enforces tenant isolation and revocation', async () => {
    const store = new MemoryTeamStore()
    const first = await store.bootstrap('First', 'Alice')
    const second = await store.bootstrap('Second', 'Bob')
    const firstAuth = await store.authenticateApiKey(first.apiKey)
    if (firstAuth === undefined) throw new Error('first key should authenticate')

    expect((await store.overview(firstAuth)).team.name).toBe('First')
    expect(await store.authenticateApiKey(second.apiKey)).not.toBeUndefined()
    await expect(store.revokeApiKey(firstAuth, firstAuth.keyId)).rejects.toThrow(/current Owner API key/iu)
    await expect(store.authenticateApiKey(first.apiKey)).resolves.toMatchObject({ role: 'owner' })
    const replacement = await store.issueApiKey(firstAuth, 'Owner replacement')
    const replacementAuth = await store.authenticateApiKey(replacement.token)
    if (replacementAuth === undefined) throw new Error('replacement owner key should authenticate')
    await store.revokeApiKey(replacementAuth, firstAuth.keyId)
    expect(await store.authenticateApiKey(first.apiKey)).toBeUndefined()
    await expect(store.overview(replacementAuth)).resolves.toMatchObject({ team: { name: 'First' } })
  })

  it('keeps member keys scoped to their Team', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')

    const key = await store.issueApiKey(member, 'laptop')
    expect(key.summary.teamId).toBe(owner.teamId)
    expect(key.summary.memberId).toBe(member.memberId)
    await expect(store.createInvite(member, 60_000)).rejects.toThrow(/only the owner/iu)
  })

  it('requires the target member to accept an ownership transfer before swapping roles', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const observerInvite = await store.createInvite(owner, 60_000, 'Observer')
    const observerJoin = await store.acceptInvite(observerInvite.inviteToken, 'Observer')
    const observer = await store.authenticateApiKey(observerJoin.apiKey)
    if (observer === undefined) throw new Error('observer key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')

    const requested = await store.requestOwnershipTransfer(owner, member.memberId)

    expect(requested).toMatchObject({
      status: 'pending',
      requestedByMemberId: owner.memberId,
      targetMemberId: member.memberId,
    })
    await expect(store.authenticateApiKey(boot.apiKey)).resolves.toMatchObject({ role: 'owner' })
    await expect(store.authenticateApiKey(joined.apiKey)).resolves.toMatchObject({ role: 'member' })

    const result = await store.acceptOwnershipTransfer(member, requested.id)

    expect(result).toEqual({
      transfer: expect.objectContaining({ id: requested.id, status: 'accepted' }),
      formerOwner: expect.objectContaining({ id: owner.memberId, role: 'member', status: 'active' }),
      owner: expect.objectContaining({ id: member.memberId, role: 'owner', status: 'active' }),
    })
    await expect(store.overview(owner)).rejects.toThrow(/role is stale/iu)
    await expect(store.overview(member)).rejects.toThrow(/role is stale/iu)
    const formerOwner = await store.authenticateApiKey(boot.apiKey)
    const currentOwner = await store.authenticateApiKey(joined.apiKey)
    if (formerOwner === undefined || currentOwner === undefined) throw new Error('existing keys should remain active')
    expect(formerOwner.role).toBe('member')
    expect(currentOwner.role).toBe('owner')
    await expect(store.acceptOwnershipTransfer(currentOwner, requested.id)).resolves.toEqual(result)
    await expect(store.acceptOwnershipTransfer(observer, requested.id)).rejects.toThrow(/only.*target|unavailable/iu)
    const transferAudits = (store as unknown as {
      ownershipTransferAuditEvents: Array<{ transferId: string; action: string }>
    }).ownershipTransferAuditEvents.filter(event => event.transferId === requested.id)
    expect(transferAudits).toHaveLength(2)
    expect(transferAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'requested' }),
      expect.objectContaining({ action: 'accepted' }),
    ]))
    const overview = await store.overview(currentOwner)
    expect(overview.members.filter(candidate => candidate.role === 'owner')).toEqual([
      expect.objectContaining({ id: member.memberId }),
    ])
    expect(overview.contributions).toContainEqual(expect.objectContaining({
      id: contribution.id,
      ownerMemberId: owner.memberId,
      status: 'authorizing',
    }))
    await expect(store.leaveTeam(formerOwner)).resolves.toMatchObject({
      member: { id: owner.memberId, role: 'member', status: 'removed' },
    })
  })

  it('lets the target reject and the current Owner revoke a pending ownership transfer', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const firstInvite = await store.createInvite(owner, 60_000, 'First')
    const firstJoin = await store.acceptInvite(firstInvite.inviteToken, 'First')
    const firstMember = await store.authenticateApiKey(firstJoin.apiKey)
    if (firstMember === undefined) throw new Error('first member key should authenticate')

    const rejectedRequest = await store.requestOwnershipTransfer(owner, firstMember.memberId)
    const rejected = await store.rejectOwnershipTransfer(firstMember, rejectedRequest.id)
    expect(rejected).toMatchObject({
      id: rejectedRequest.id,
      status: 'rejected',
    })
    await expect(store.rejectOwnershipTransfer(firstMember, rejectedRequest.id)).resolves.toEqual(rejected)
    await expect(store.acceptOwnershipTransfer(firstMember, rejectedRequest.id)).rejects.toThrow(/rejected|no longer pending/iu)

    const revokedRequest = await store.requestOwnershipTransfer(owner, firstMember.memberId)
    const revoked = await store.revokeOwnershipTransfer(owner, revokedRequest.id)
    expect(revoked).toMatchObject({
      id: revokedRequest.id,
      status: 'revoked',
    })
    await expect(store.revokeOwnershipTransfer(owner, revokedRequest.id)).resolves.toEqual(revoked)
    await expect(store.acceptOwnershipTransfer(firstMember, revokedRequest.id)).rejects.toThrow(/revoked|no longer pending/iu)
    await expect(store.authenticateApiKey(boot.apiKey)).resolves.toMatchObject({ role: 'owner' })
    await expect(store.authenticateApiKey(firstJoin.apiKey)).resolves.toMatchObject({ role: 'member' })
    const transferAudits = (store as unknown as {
      ownershipTransferAuditEvents: Array<{ transferId: string; action: string }>
    }).ownershipTransferAuditEvents
    expect(transferAudits.filter(event => event.transferId === rejectedRequest.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'requested' }),
      expect.objectContaining({ action: 'rejected' }),
    ]))
    expect(transferAudits.filter(event => event.transferId === revokedRequest.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'requested' }),
      expect.objectContaining({ action: 'revoked' }),
    ]))
  })

  it('expires ownership transfers by server time and exposes pending requests only to participants', async () => {
    let now = 1_000
    const store = new MemoryTeamStore({ now: () => now })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const targetInvite = await store.createInvite(owner, 60_000, 'Target')
    const targetJoin = await store.acceptInvite(targetInvite.inviteToken, 'Target')
    const target = await store.authenticateApiKey(targetJoin.apiKey)
    if (target === undefined) throw new Error('target key should authenticate')
    const observerInvite = await store.createInvite(owner, 60_000, 'Observer')
    const observerJoin = await store.acceptInvite(observerInvite.inviteToken, 'Observer')
    const observer = await store.authenticateApiKey(observerJoin.apiKey)
    if (observer === undefined) throw new Error('observer key should authenticate')

    const requested = await store.requestOwnershipTransfer(owner, target.memberId)
    expect(requested.expiresAt).toBe(requested.createdAt + 24 * 60 * 60 * 1_000)
    await expect(store.overview(owner)).resolves.toMatchObject({ ownershipTransfer: { id: requested.id, status: 'pending' } })
    await expect(store.overview(target)).resolves.toMatchObject({ ownershipTransfer: { id: requested.id, status: 'pending' } })
    expect((await store.overview(observer)).ownershipTransfer).toBeUndefined()

    now = requested.expiresAt
    await expect(store.acceptOwnershipTransfer(target, requested.id)).rejects.toThrow(/expired|no longer pending/iu)
    expect((await store.overview(owner)).ownershipTransfer).toBeUndefined()
    const transferAudits = (store as unknown as {
      ownershipTransferAuditEvents: Array<{ transferId: string; action: string }>
    }).ownershipTransferAuditEvents.filter(event => event.transferId === requested.id)
    expect(transferAudits).toHaveLength(2)
    expect(transferAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'requested' }),
      expect.objectContaining({ action: 'expired' }),
    ]))
  })

  it('allows only one pending request, enforces actor permissions, and accepts while paused', async () => {
    const store = new MemoryTeamStore({ now: () => 5_000 })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const targetInvite = await store.createInvite(owner, 60_000, 'Target')
    const targetJoin = await store.acceptInvite(targetInvite.inviteToken, 'Target')
    const target = await store.authenticateApiKey(targetJoin.apiKey)
    if (target === undefined) throw new Error('target key should authenticate')
    const observerInvite = await store.createInvite(owner, 60_000, 'Observer')
    const observerJoin = await store.acceptInvite(observerInvite.inviteToken, 'Observer')
    const observer = await store.authenticateApiKey(observerJoin.apiKey)
    if (observer === undefined) throw new Error('observer key should authenticate')

    const requested = await store.requestOwnershipTransfer(owner, target.memberId)
    await expect(store.requestOwnershipTransfer(owner, observer.memberId)).rejects.toThrow(/already.*pending/iu)
    await expect(store.acceptOwnershipTransfer(observer, requested.id)).rejects.toThrow(/unavailable/iu)
    await expect(store.rejectOwnershipTransfer(owner, requested.id)).rejects.toThrow(/unavailable/iu)
    await expect(store.revokeOwnershipTransfer(target, requested.id)).rejects.toThrow(/unavailable/iu)

    await lifecycleStore(store).setTeamStatus(owner, {
      operationId: '00000000-0000-4000-8000-000000000704',
      expectedLifecycleRevision: 1,
      status: 'paused',
    })
    await expect(store.acceptOwnershipTransfer(target, requested.id)).resolves.toMatchObject({
      transfer: { status: 'accepted', resolvedAt: 5_000 },
      formerOwner: { id: owner.memberId, role: 'member' },
      owner: { id: target.memberId, role: 'owner' },
    })
  })

  it('cancels pending ownership transfers when the target departs or the Team is dissolved', async () => {
    let now = 10_000
    const store = new MemoryTeamStore({ now: () => now })
    const lifecycle = lifecycleStore(store)
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const transferRecords = (store as unknown as {
      ownershipTransfers: Map<string, { status: string; resolvedAt?: number }>
    }).ownershipTransfers

    const leavingInvite = await store.createInvite(owner, 60_000, 'Leaving')
    const leavingJoin = await store.acceptInvite(leavingInvite.inviteToken, 'Leaving')
    const leaving = await store.authenticateApiKey(leavingJoin.apiKey)
    if (leaving === undefined) throw new Error('leaving member key should authenticate')
    const leavingTransfer = await store.requestOwnershipTransfer(owner, leaving.memberId)
    now = 11_000
    await store.leaveTeam(leaving)
    expect(transferRecords.get(leavingTransfer.id)).toMatchObject({ status: 'canceled', resolvedAt: now })

    const removedInvite = await store.createInvite(owner, 60_000, 'Removed')
    const removedJoin = await store.acceptInvite(removedInvite.inviteToken, 'Removed')
    const removed = await store.authenticateApiKey(removedJoin.apiKey)
    if (removed === undefined) throw new Error('removed member key should authenticate')
    const removedTransfer = await store.requestOwnershipTransfer(owner, removed.memberId)
    now = 12_000
    await store.removeMember(owner, removed.memberId)
    expect(transferRecords.get(removedTransfer.id)).toMatchObject({ status: 'canceled', resolvedAt: now })

    const dissolvedInvite = await store.createInvite(owner, 60_000, 'Dissolved')
    const dissolvedJoin = await store.acceptInvite(dissolvedInvite.inviteToken, 'Dissolved')
    const dissolved = await store.authenticateApiKey(dissolvedJoin.apiKey)
    if (dissolved === undefined) throw new Error('dissolved member key should authenticate')
    const dissolvedTransfer = await store.requestOwnershipTransfer(owner, dissolved.memberId)
    now = 13_000
    await lifecycle.dissolveTeam(owner, {
      operationId: '00000000-0000-4000-8000-000000000705',
      expectedLifecycleRevision: 1,
      confirmationName: 'Friends',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    })
    expect(transferRecords.get(dissolvedTransfer.id)).toMatchObject({ status: 'canceled', resolvedAt: now })
    const transferAudits = (store as unknown as {
      ownershipTransferAuditEvents: Array<{ transferId: string; action: string }>
    }).ownershipTransferAuditEvents
    for (const transfer of [leavingTransfer, removedTransfer, dissolvedTransfer]) {
      const events = transferAudits.filter(event => event.transferId === transfer.id)
      expect(events).toHaveLength(2)
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'requested' }),
        expect.objectContaining({ action: 'canceled' }),
      ]))
    }
  })

  it.each(['leave', 'remove', 'dissolve'] as const)(
    'expires an ownership transfer before automatic cancellation on %s at the exact deadline',
    async (departure) => {
      let now = 20_000
      const store = new MemoryTeamStore({ now: () => now })
      const lifecycle = lifecycleStore(store)
      const boot = await store.bootstrap('Friends', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner key should authenticate')
      const invite = await store.createInvite(owner, 60_000, 'Target')
      const joined = await store.acceptInvite(invite.inviteToken, 'Target')
      const target = await store.authenticateApiKey(joined.apiKey)
      if (target === undefined) throw new Error('target key should authenticate')
      const requested = await store.requestOwnershipTransfer(owner, target.memberId)
      const transferRecords = (store as unknown as {
        ownershipTransfers: Map<string, { status: string; resolvedAt?: number }>
      }).ownershipTransfers

      now = requested.expiresAt
      if (departure === 'leave') await store.leaveTeam(target)
      if (departure === 'remove') await store.removeMember(owner, target.memberId)
      if (departure === 'dissolve') {
        await lifecycle.dissolveTeam(owner, {
          operationId: '00000000-0000-4000-8000-000000000706',
          expectedLifecycleRevision: 1,
          confirmationName: 'Friends',
          recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
        })
      }

      expect(transferRecords.get(requested.id)).toMatchObject({ status: 'expired', resolvedAt: now })
    },
  )

  it('does not insert an invite created by a former owner while ownership is being transferred', async () => {
    const delegate = new Aes256GcmTeamInviteKeyEncryptionProvider(Buffer.alloc(32, 7))
    let releaseEncryption: (() => void) | undefined
    let markEncryptionStarted: (() => void) | undefined
    const encryptionStarted = new Promise<void>((resolve) => {
      markEncryptionStarted = resolve
    })
    let blockNextEncryption = false
    const cipher = new TeamInviteCipher({
      keyEncryptionProvider: {
        async wrapKey(context, plaintextKey) {
          if (blockNextEncryption) {
            blockNextEncryption = false
            markEncryptionStarted?.()
            await new Promise<void>((resolve) => {
              releaseEncryption = resolve
            })
          }
          return delegate.wrapKey(context, plaintextKey)
        },
        unwrapKey: (context, wrappedKey) => delegate.unwrapKey(context, wrappedKey),
      },
    })
    const store = new MemoryTeamStore({ inviteCipher: cipher })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const memberInvite = await store.createInvite(owner, 60_000, 'Member')
    const joined = await store.acceptInvite(memberInvite.inviteToken, 'Friend')
    const target = await store.authenticateApiKey(joined.apiKey)
    if (target === undefined) throw new Error('member key should authenticate')
    const requested = await store.requestOwnershipTransfer(owner, joined.member.id)

    blockNextEncryption = true
    const creating = store.createInvite(owner, 60_000, 'Must not survive transfer')
    await encryptionStarted
    await store.acceptOwnershipTransfer(target, requested.id)
    releaseEncryption?.()

    await expect(creating).rejects.toThrow(/only the owner|stale/iu)
    const currentOwner = await store.authenticateApiKey(joined.apiKey)
    if (currentOwner === undefined) throw new Error('new owner key should authenticate')
    await expect(store.overview(currentOwner)).resolves.toMatchObject({ invites: [] })
    await delegate.dispose()
  })

  it('rejects ineligible ownership transfers without changing either role', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')

    await expect(store.requestOwnershipTransfer(member, owner.memberId)).rejects.toThrow(/only the owner/iu)
    await expect(store.requestOwnershipTransfer(owner, owner.memberId)).rejects.toThrow(/different Team member/iu)
    const foreign = await store.bootstrap('Other', 'Outsider')
    await expect(store.requestOwnershipTransfer(owner, foreign.member.id)).rejects.toThrow(/not found/iu)

    const removedInvite = await store.createInvite(owner, 60_000)
    const removedJoin = await store.acceptInvite(removedInvite.inviteToken, 'Former Friend')
    const removedMember = await store.authenticateApiKey(removedJoin.apiKey)
    if (removedMember === undefined) throw new Error('departing key should authenticate')
    await store.leaveTeam(removedMember)
    await expect(store.requestOwnershipTransfer(owner, removedMember.memberId)).rejects.toThrow(/not active/iu)

    await store.revokeApiKey(owner, member.keyId)
    await expect(store.requestOwnershipTransfer(owner, member.memberId)).rejects.toThrow(/active Team API key/iu)
    await expect(store.overview(owner)).resolves.toMatchObject({
      currentMember: { role: 'owner' },
      members: expect.arrayContaining([expect.objectContaining({ id: member.memberId, role: 'member' })]),
    })
  })

  it('atomically removes a departing member, every key, and every owned contribution', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const secondKey = await store.issueApiKey(member, 'laptop')
    const firstContribution = await store.createContributionAccount(member, 'Friend Codex')
    const secondContribution = await store.createContributionAccount(member, 'Friend Codex backup')
    const ownerContribution = await store.createContributionAccount(owner, 'Owner Codex')

    const result = await store.leaveTeam(member)

    expect(result.member).toMatchObject({ id: member.memberId, status: 'removed' })
    expect(result.contributions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstContribution.id, status: 'revoked' }),
      expect.objectContaining({ id: secondContribution.id, status: 'revoked' }),
    ]))
    expect(await store.authenticateApiKey(joined.apiKey)).toBeUndefined()
    expect(await store.authenticateApiKey(secondKey.token)).toBeUndefined()
    const overview = await store.overview(owner)
    expect(overview.members).toContainEqual(expect.objectContaining({ id: member.memberId, status: 'removed' }))
    expect(overview.contributions).toContainEqual(expect.objectContaining({ id: ownerContribution.id, status: 'authorizing' }))
    expect(overview.contributions.filter(account => account.ownerMemberId === member.memberId))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: firstContribution.id, status: 'revoked' }),
        expect.objectContaining({ id: secondContribution.id, status: 'revoked' }),
      ]))
  })

  it('rejects owner departure without changing the Team', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')

    await expect(store.leaveTeam(owner)).rejects.toThrow(/owner.*cannot leave/iu)

    expect(await store.authenticateApiKey(boot.apiKey)).toEqual(owner)
    await expect(store.overview(owner)).resolves.toMatchObject({ currentMember: { status: 'active', role: 'owner' } })
  })

  it('keeps control-plane authentication available while paused but rejects new usage', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, contribution.id, 'active')

    await lifecycleStore(store).setTeamStatus(owner, {
      operationId: '00000000-0000-4000-8000-000000000704',
      expectedLifecycleRevision: 1,
      status: 'paused',
    })
    const pausedOwner = await store.authenticateApiKey(boot.apiKey)
    expect(pausedOwner).not.toBeUndefined()
    if (pausedOwner === undefined) throw new Error('paused Team key should still authenticate')
    await expect(store.beginUsageEvent(pausedOwner, 'paused-event', contribution.id, 'gpt-5-codex'))
      .rejects.toThrow(/team is paused/iu)
    await expect(lifecycleStore(store).setTeamStatus(pausedOwner, {
      operationId: '00000000-0000-4000-8000-000000000705',
      expectedLifecycleRevision: 2,
      status: 'active',
    })).resolves.toMatchObject({ status: 'active', lifecycleRevision: 3 })
  })

  it('keeps contribution controls owned by the contributor', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')

    const account = await store.createContributionAccount(member, 'Friend Codex')
    expect(account.ownerMemberId).toBe(member.memberId)
    expect(account.status).toBe('authorizing')
    expect(account.personalReservePercent).toBe(20)
    expect(account.dailySharedCreditLimit).toBeNull()
    await expect(store.updateContributionAccount(owner, account.id, { personalReservePercent: 50 }))
      .rejects.toThrow(/owner of the contribution account/u)

    await expect(store.updateContributionAccount(member, account.id, { status: 'active' }))
      .rejects.toThrow(/authorization status cannot be changed manually/iu)
    await store.setContributionAccountStatus(member.teamId, account.id, 'active')

    const updated = await store.updateContributionAccount(member, account.id, {
      status: 'paused',
      personalReservePercent: 50,
      maxSharedRequestsPerWindow: 12,
      dailySharedCreditLimit: 50_000,
    })
    expect(updated).toMatchObject({
      status: 'paused',
      personalReservePercent: 50,
      maxSharedRequestsPerWindow: 12,
      dailySharedCreditLimit: 50_000,
    })
    const browserStyleUpdate = await store.updateContributionAccount(member, account.id, {
      personalReservePercent: 55,
      allowedModels: ['gpt-5-codex'],
    })
    expect(browserStyleUpdate).toMatchObject({
      personalReservePercent: 55,
      dailySharedCreditLimit: 50_000,
      allowedModels: ['gpt-5-codex'],
    })
    expect((await store.overview(owner)).contributions).toEqual([browserStyleUpdate])
    const revoked = await store.revokeContributionAccount(member, account.id)
    expect(revoked.status).toBe('revoked')
  })

  it('keeps revoked contributions terminal when a late OAuth callback arrives', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')

    await store.revokeContributionAccount(owner, contribution.id)
    await expect(store.setContributionAccountStatus(owner.teamId, contribution.id, 'active'))
      .resolves.toMatchObject({ status: 'revoked' })
    await expect(store.listContributionAccountsByStatus('revoked'))
      .resolves.toMatchObject([{ id: contribution.id, status: 'revoked' }])
  })

  it('lists and revokes contribution accounts only for their contributor', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const ownerAccount = await store.createContributionAccount(owner, 'Owner Codex')
    const invite = await store.createInvite(owner, 60_000, 'Friend')
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const memberAccount = await store.createContributionAccount(member, 'Friend Codex')

    await expect(store.listContributionAccounts(owner)).resolves.toEqual([
      expect.objectContaining({ id: ownerAccount.id, ownerMemberId: owner.memberId }),
    ])
    await expect(store.listContributionAccounts(member)).resolves.toEqual([
      expect.objectContaining({ id: memberAccount.id, ownerMemberId: member.memberId }),
    ])
    await expect(store.overview(member)).resolves.toMatchObject({
      contributions: expect.arrayContaining([
        expect.objectContaining({ id: ownerAccount.id }),
        expect.objectContaining({ id: memberAccount.id }),
      ]),
    })
    await expect(store.listContributionAccountsByStatus('authorizing')).resolves.toHaveLength(2)

    await expect(store.revokeContributionAccount(owner, memberAccount.id))
      .rejects.toThrow(/owner of the contribution account/iu)
    await expect(store.revokeContributionAccount(member, memberAccount.id))
      .resolves.toMatchObject({ id: memberAccount.id, status: 'revoked' })
    await expect(store.listContributionAccounts(owner)).resolves.toMatchObject([{ id: ownerAccount.id, status: 'authorizing' }])
  })

  it('begins reauthorization only for the contributor and preserves sharing protections', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const contribution = await store.createContributionAccount(member, 'Friend Codex')
    await store.setContributionAccountStatus(member.teamId, contribution.id, 'active')
    await store.updateContributionAccount(member, contribution.id, {
      personalReservePercent: 45,
      maxSharedRequestsPerWindow: 17,
      maxSharedConcurrency: 2,
      allowedModels: ['gpt-5-codex'],
    })
    await store.setContributionAccountStatus(member.teamId, contribution.id, 'reauth_required', 'sign in again')

    await expect(store.beginContributionReauthorization(owner, contribution.id))
      .rejects.toThrow(/owner of the contribution account/iu)
    await expect(store.beginContributionReauthorization(member, contribution.id)).resolves.toMatchObject({
      id: contribution.id,
      status: 'authorizing',
      personalReservePercent: 45,
      maxSharedRequestsPerWindow: 17,
      maxSharedConcurrency: 2,
      allowedModels: ['gpt-5-codex'],
    })
    expect((await store.listContributionAccounts(member))[0]).not.toHaveProperty('lastError')
    await expect(store.beginContributionReauthorization(member, contribution.id))
      .rejects.toThrow(/reauthorization/iu)
  })

  it('redacts diagnostics before contribution state is returned or retained', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')

    const updated = await store.setContributionAccountStatus(
      owner.teamId,
      contribution.id,
      'reauth_required',
      'OAuth failed Authorization: Bearer opaque-provider-token client_secret=provider-client-secret',
    )

    expect(updated.lastError).toContain('[redacted]')
    expect(updated.lastError).not.toMatch(/opaque-provider-token|provider-client-secret/u)
    expect(JSON.stringify(await store.listContributionAccounts(owner)))
      .not.toMatch(/opaque-provider-token|provider-client-secret/u)
  })

  it('rejects a new usage event after a contribution is paused', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, contribution.id, 'active')
    await store.setContributionAccountStatus(owner.teamId, contribution.id, 'paused')

    await expect(store.beginUsageEvent(owner, 'late-event', contribution.id, 'gpt-5-codex'))
      .rejects.toThrow(/not active/u)
  })

  it('enforces the weekly estimated-cost limit for shared use and releases cancelled reservations', async () => {
    const store = new MemoryTeamStore({ now: () => Date.UTC(2026, 7, 24, 12) })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(joined.apiKey)
    if (friend === undefined) throw new Error('friend key should authenticate')
    const created = await store.createContributionAccount(owner, 'Owner Codex')
    await store.updateContributionAccount(owner, created.id, {
      weeklySharedEstimatedApiCostLimitMicros: 100_000,
    })
    const account = await store.setContributionAccountStatus(owner.teamId, created.id, 'active')

    await store.beginUsageEvent(friend, 'weekly-held', account.id, 'gpt-5-codex')
    await expect(store.beginUsageEvent(friend, 'weekly-blocked', account.id, 'gpt-5-codex'))
      .rejects.toThrow(/weekly shared estimated API cost limit/iu)
    await expect(store.beginUsageEvent(owner, 'owner-own', account.id, 'gpt-5-codex')).resolves.toBeDefined()

    await store.settleUsageEvent(owner.teamId, 'weekly-held', 'cancelled')
    await expect(store.beginUsageEvent(friend, 'weekly-after-cancel', account.id, 'gpt-5-codex')).resolves.toBeDefined()
  })

  it('aggregates shared account use for a rolling day and seven UTC calendar days', async () => {
    const current = Date.UTC(2026, 7, 20, 12)
    let now = current - 25 * 60 * 60 * 1_000
    const store = new MemoryTeamStore({ now: () => now })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(joined.apiKey)
    if (friend === undefined) throw new Error('friend key should authenticate')
    const account = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, account.id, 'active')

    await store.beginUsageEvent(friend, 'old-shared', account.id, 'gpt-5-codex')
    await store.settleUsageEvent(owner.teamId, 'old-shared', 'succeeded', {
      inputTokens: 50,
      cachedInputTokens: 0,
      outputTokens: 0,
    })
    now = current
    await store.beginUsageEvent(friend, 'recent-measured', account.id, 'gpt-5-codex')
    await store.settleUsageEvent(owner.teamId, 'recent-measured', 'succeeded', {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 0,
    })
    await store.beginUsageEvent(friend, 'recent-unmeasured', account.id, 'gpt-5-codex')
    await store.beginUsageEvent(owner, 'own-use-excluded', account.id, 'gpt-5-codex')
    await store.settleUsageEvent(owner.teamId, 'own-use-excluded', 'succeeded', {
      inputTokens: 10_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    })

    await expect(store.listUsageAggregates(friend)).resolves.toEqual({
      generatedAt: current,
      last24HoursStartedAt: current - 24 * 60 * 60 * 1_000,
      last7DaysStartedAt: Date.UTC(2026, 7, 14),
      accountTotals24Hours: [{
        upstreamAccountId: account.id,
        requestCount: 2,
        measuredRequestCount: 1,
        credits: 100,
      }],
      memberDaily7Days: [{
        upstreamAccountId: account.id,
        consumerMemberId: friend.memberId,
        dayStartedAt: Date.UTC(2026, 7, 19),
        requestCount: 1,
        measuredRequestCount: 1,
        credits: 50,
      }, {
        upstreamAccountId: account.id,
        consumerMemberId: friend.memberId,
        dayStartedAt: Date.UTC(2026, 7, 20),
        requestCount: 2,
        measuredRequestCount: 1,
        credits: 100,
      }],
    })
  })

  it('returns aggregate-only usage shaped by the authenticated owner or member', async () => {
    const now = Date.UTC(2026, 7, 23, 10)
    const store = new MemoryTeamStore({ now: () => now })
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const friend = await store.authenticateApiKey(joined.apiKey)
    if (friend === undefined) throw new Error('friend key should authenticate')

    const ownerAccount = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, ownerAccount.id, 'active')
    const friendAccount = await store.createContributionAccount(friend, 'Friend Codex')
    await store.setContributionAccountStatus(owner.teamId, friendAccount.id, 'active')

    await store.beginUsageEvent(friend, 'friend-priced', ownerAccount.id, 'untrusted-request-model')
    await store.settleUsageEvent(owner.teamId, 'friend-priced', 'succeeded', {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 20,
    }, {
      estimatedCostUsdMicros: 1_234n,
      pricingCatalogVersion: 'fixture-v1',
    })
    await store.beginUsageEvent(friend, 'friend-unmeasured', ownerAccount.id, 'untrusted-request-model')
    await store.beginUsageEvent(owner, 'owner-unpriced', friendAccount.id, 'untrusted-request-model')
    await store.settleUsageEvent(owner.teamId, 'owner-unpriced', 'succeeded', {
      inputTokens: 40,
      cachedInputTokens: 0,
      outputTokens: 10,
    })
    await store.beginUsageEvent(owner, 'owner-self-excluded', ownerAccount.id, 'untrusted-request-model')
    await store.settleUsageEvent(owner.teamId, 'owner-self-excluded', 'succeeded', {
      inputTokens: 10_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    })

    await expect(store.readUsageProjection(owner)).resolves.toEqual({
      role: 'owner',
      window: { startedAt: now - 86_400_000, endedAt: now },
      currency: 'USD',
      team: {
        requestCount: 3,
        tokenMeasuredRequestCount: 2,
        pricedRequestCount: 1,
        totalTokens: '170',
        estimatedCostUsdMicros: '1234',
      },
      mine: {
        requestCount: 1,
        tokenMeasuredRequestCount: 1,
        pricedRequestCount: 0,
        totalTokens: '50',
        estimatedCostUsdMicros: null,
      },
      ownedAccounts: expect.any(Array),
    })
    await expect(store.readUsageProjection(friend)).resolves.toEqual({
      role: 'member',
      window: { startedAt: now - 86_400_000, endedAt: now },
      currency: 'USD',
      mine: {
        requestCount: 2,
        tokenMeasuredRequestCount: 1,
        pricedRequestCount: 1,
        totalTokens: '120',
        estimatedCostUsdMicros: '1234',
      },
      ownedAccounts: expect.any(Array),
    })
    const ownerOwnedUsage = (await store.readUsageProjection(owner)).ownedAccounts
    expect(ownerOwnedUsage).toHaveLength(1)
    expect(ownerOwnedUsage[0]).toMatchObject({
      accountId: ownerAccount.id,
      currentUtcWeek: {
        window: { startedAt: Date.UTC(2026, 7, 17), endedAt: now },
        resetAt: Date.UTC(2026, 7, 24),
        aggregate: {
          requestCount: 2,
          tokenMeasuredRequestCount: 1,
          pricedRequestCount: 1,
          totalTokens: '120',
          estimatedCostUsdMicros: '1234',
        },
      },
      last24Hours: {
        window: { startedAt: now - 86_400_000, endedAt: now },
        aggregate: {
          requestCount: 2,
          tokenMeasuredRequestCount: 1,
          pricedRequestCount: 1,
          totalTokens: '120',
          estimatedCostUsdMicros: '1234',
        },
      },
      aggregate: {
        requestCount: 2,
        tokenMeasuredRequestCount: 1,
        pricedRequestCount: 1,
        totalTokens: '120',
        estimatedCostUsdMicros: '1234',
      },
      recentRequests: expect.arrayContaining([
        expect.objectContaining({ id: 'friend-priced', model: 'untrusted-request-model' }),
        expect.objectContaining({ id: 'friend-unmeasured', model: 'untrusted-request-model' }),
      ]),
    })
    expect(JSON.stringify(ownerOwnedUsage)).not.toContain(friend.memberId)

    await lifecycleStore(store).setTeamStatus(owner, {
      operationId: '00000000-0000-4000-8000-000000000706',
      expectedLifecycleRevision: 1,
      status: 'paused',
    })
    await expect(store.readUsageProjection(friend)).resolves.toMatchObject({ role: 'member' })
  })

  it('coalesces periodic invitation-envelope sweeps and awaits the active sweep during disposal', async () => {
    vi.useFakeTimers()
    try {
      const store = new MemoryTeamStore()
      let finishSweep: ((value: number) => void) | undefined
      const pendingSweep = new Promise<number>((resolve) => { finishSweep = resolve })
      const sweep = vi.spyOn(store, 'sweepExpiredInviteEnvelopes').mockReturnValue(pendingSweep)
      const service = new TeamService({ store, broker: new FakeCredentialBroker() })

      service.startInviteEnvelopeSweeping({ intervalMs: 100 })
      await Promise.resolve()
      expect(sweep).toHaveBeenCalledOnce()
      const first = service.sweepExpiredInviteEnvelopes()
      const second = service.sweepExpiredInviteEnvelopes()
      expect(first).toBe(second)

      await vi.advanceTimersByTimeAsync(100)
      expect(sweep).toHaveBeenCalledOnce()

      let disposed = false
      const disposing = service.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      finishSweep?.(1)
      await disposing
      expect(disposed).toBe(true)

      await vi.advanceTimersByTimeAsync(100)
      expect(sweep).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects invitation-envelope sweep intervals longer than the retention bound', async () => {
    const service = new TeamService()
    expect(() => service.startInviteEnvelopeSweeping({ intervalMs: 24 * 60 * 60 * 1_000 + 1 }))
      .toThrow(/sweep interval.*allowed range/iu)
    await service.dispose()
  })

  it('starts contribution OAuth through a Host-only broker', async () => {
    const broker = new FakeCredentialBroker()
    const service = new TeamService({ store: new MemoryTeamStore(), broker })
    const boot = await service.store.bootstrap('Friends', 'Owner')
    const owner = await service.store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')

    const started = await service.startContributionOAuth(owner, 'Owner Codex')
    expect(started).toMatchObject({
      method: 'device_code',
      verificationUrl: 'https://auth.example.test/codex/device',
      userCode: 'ABCD-EFGH',
      expiresAt: 1_800_000,
    })
    expect(started.account.ownerMemberId).toBe(owner.memberId)
    expect(broker.started).toEqual([{ teamId: owner.teamId, accountId: started.account.id }])

    const cancelled = await service.cancelContributionOAuth(owner, started.account.id)
    expect(cancelled).toMatchObject({ id: started.account.id, status: 'reauth_required' })
    await service.revokeContributionAccount(owner, started.account.id)
    expect(broker.revoked).toEqual([{ teamId: owner.teamId, accountId: started.account.id }])
  })

  it('activates a browser OAuth handoff without returning provider credentials', async () => {
    const broker = new FakeCredentialBroker()
    const service = new TeamService({ store: new MemoryTeamStore(), broker })
    const boot = await service.store.bootstrap('Friends', 'Owner')
    const owner = await service.store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')

    const started = await service.startContributionOAuth(owner, 'Pending account', 'browser')
    expect(started).toMatchObject({ method: 'browser_handoff', account: { status: 'authorizing' } })
    const envelope: TeamCredentialHandoffEnvelope = {
      version: 1,
      sessionId: '00000000-0000-4000-8000-000000000001',
      clientPublicKey: 'client-public-key',
      iv: 'test-iv',
      ciphertext: 'test-ciphertext',
      tag: 'test-tag',
    }

    await expect(service.completeContributionOAuthHandoff(owner, started.account.id, envelope))
      .resolves.toMatchObject({ id: started.account.id, label: 'Owner Codex', status: 'active' })
    await expect(service.completeContributionOAuthHandoff(owner, started.account.id, envelope))
      .resolves.toMatchObject({ id: started.account.id, label: 'Owner Codex', status: 'active' })
    expect(broker.methods).toEqual(['browser'])
    expect(broker.completed).toEqual([{
      ref: { teamId: owner.teamId, accountId: started.account.id },
      envelope,
    }, {
      ref: { teamId: owner.teamId, accountId: started.account.id },
      envelope,
    }])
    expect(JSON.stringify(started)).not.toMatch(/access|refresh|credential/iu)
  })

  it('discards a cancelled first browser authorization without leaving a ghost account', async () => {
    const broker = new FakeCredentialBroker()
    const service = new TeamService({ store: new MemoryTeamStore(), broker })
    const boot = await service.store.bootstrap('Friends', 'Owner')
    const owner = await service.store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const started = await service.startContributionOAuth(owner, 'Owner Codex', 'browser')

    await expect(service.cancelContributionOAuth(owner, started.account.id, { discardInitial: true }))
      .resolves.toMatchObject({ id: started.account.id, status: 'revoked' })
    expect(broker.cancelled).toEqual([{ teamId: owner.teamId, accountId: started.account.id }])
    expect(broker.revoked).toEqual([{ teamId: owner.teamId, accountId: started.account.id }])
  })

  it('projects a provider region failure as a stable authorization network error', async () => {
    class RegionBlockedBroker extends FakeCredentialBroker {
      override startOAuth(): ReturnType<TeamCredentialBroker['startOAuth']> {
        return Promise.reject(new Error(
          'OpenAI Codex device code request failed with status 403: {"error":{"message":"Country, region, or territory not supported","secret":"provider-detail"}}',
        ))
      }
    }
    const service = new TeamService({ store: new MemoryTeamStore(), broker: new RegionBlockedBroker() })
    const boot = await service.store.bootstrap('Friends', 'Owner')
    const owner = await service.store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')

    await expect(service.startContributionOAuth(owner, 'Owner Codex'))
      .rejects.toThrow('team_authorization_network_unavailable')
    const persisted = (await service.store.listContributionAccounts(owner))[0]
    expect(persisted).toMatchObject({ status: 'revoked', lastError: 'team_authorization_network_unavailable' })
    expect(JSON.stringify(persisted)).not.toMatch(/Country, region|provider-detail|device code request/iu)
  })

  it('revokes a newly issued OAuth credential when Team dissolution wins the start race', async () => {
    const store = new MemoryTeamStore()
    const lifecycle = lifecycleStore(store)
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    class DissolvingBroker extends FakeCredentialBroker {
      override async startOAuth(ref: TeamCredentialRef): ReturnType<TeamCredentialBroker['startOAuth']> {
        await lifecycle.dissolveTeam(owner, {
          operationId: '00000000-0000-4000-8000-000000001301',
          expectedLifecycleRevision: 1,
          confirmationName: 'Friends',
          recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
        })
        return super.startOAuth(ref)
      }
    }
    const broker = new DissolvingBroker()
    const service = new TeamService({ store, broker })

    await expect(service.startContributionOAuth(owner, 'Owner Codex')).rejects.toThrow(/revoked|invalid|dissolved/iu)
    expect(broker.revoked).toEqual([
      expect.objectContaining({ teamId: owner.teamId }),
    ])
  })

  it('drains every departing member contribution before deleting broker credentials', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const invite = await store.createInvite(owner, 60_000)
    const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
    const member = await store.authenticateApiKey(joined.apiKey)
    if (member === undefined) throw new Error('member key should authenticate')
    const first = await store.createContributionAccount(member, 'Friend Codex')
    const second = await store.createContributionAccount(member, 'Friend Codex backup')
    const events: string[] = []
    const router = new TeamRequestRouter()
    vi.spyOn(router, 'drainAccount').mockImplementation(async (accountId) => { events.push(`drain:${accountId}`) })
    class OrderedBroker extends FakeCredentialBroker {
      override revoke(ref: TeamCredentialRef): Promise<void> {
        events.push(`revoke:${ref.accountId}`)
        return super.revoke(ref)
      }
    }
    const broker = new OrderedBroker()
    const service = new TeamService({ store, broker, router })

    const result = await service.leaveTeam(member)

    expect(result.member.status).toBe('removed')
    expect(events.slice(0, 2)).toEqual(expect.arrayContaining([`drain:${first.id}`, `drain:${second.id}`]))
    expect(events.slice(2)).toEqual(expect.arrayContaining([`revoke:${first.id}`, `revoke:${second.id}`]))
    expect(await store.authenticateApiKey(joined.apiKey)).toBeUndefined()
  })

  it('returns a committed Team dissolution without waiting for credential cleanup', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, contribution.id, 'active')
    let releaseRevoke: (() => void) | undefined
    const revokeBlocked = new Promise<void>(resolve => { releaseRevoke = resolve })
    let signalRevokeStarted: (() => void) | undefined
    const revokeStarted = new Promise<void>(resolve => { signalRevokeStarted = resolve })
    const broker = new FakeCredentialBroker(
      async () => undefined,
      'active',
      async () => {
        signalRevokeStarted?.()
        await revokeBlocked
      },
    )
    const service = new TeamService({ store, broker })
    const lifecycleService = service as unknown as {
      dissolveTeam(
        auth: TestTeamAuthContext,
        input: TestTeamDissolutionInput,
      ): Promise<TestTeamDissolutionResult>
    }

    await expect(lifecycleService.dissolveTeam(owner, {
      operationId: '00000000-0000-4000-8000-000000001401',
      expectedLifecycleRevision: 1,
      confirmationName: 'Friends',
      recoverySecretHash: TEST_ONLY_RECOVERY_SECRET_HASH,
    })).resolves.toMatchObject({
      teamId: owner.teamId,
      status: 'dissolved',
      revokedContributionCount: 1,
    })
    await revokeStarted
    expect(broker.revoked).toEqual([{ teamId: owner.teamId, accountId: contribution.id }])

    releaseRevoke?.()
    await service.dispose()
  })

  it('retries drain and credential deletion for persisted revoked contributions', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')
    await store.revokeContributionAccount(owner, contribution.id)
    const router = new TeamRequestRouter()
    const drain = vi.spyOn(router, 'drainAccount')
    const broker = new FakeCredentialBroker()
    const service = new TeamService({ store, broker, router })

    await service.reconcileContributionAuthorizations()

    expect(drain).toHaveBeenCalledWith(contribution.id)
    expect(broker.revoked).toEqual([{ teamId: owner.teamId, accountId: contribution.id }])
  })

  it('returns a successful departure and retries persisted credential cleanup after a transient failure', async () => {
    vi.useFakeTimers()
    try {
      const store = new MemoryTeamStore()
      const boot = await store.bootstrap('Friends', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner key should authenticate')
      const invite = await store.createInvite(owner, 60_000)
      const joined = await store.acceptInvite(invite.inviteToken, 'Friend')
      const member = await store.authenticateApiKey(joined.apiKey)
      if (member === undefined) throw new Error('member key should authenticate')
      const contribution = await store.createContributionAccount(member, 'Friend Codex')
      let revokeAttempts = 0
      const broker = new FakeCredentialBroker(
        async () => undefined,
        'active',
        async () => {
          revokeAttempts += 1
          if (revokeAttempts === 1) throw new Error('credential broker is temporarily unavailable')
        },
      )
      const router = new TeamRequestRouter()
      const drain = vi.spyOn(router, 'drainAccount')
      const service = new TeamService({ store, broker, router, revokedCleanupRetryMs: 10 })

      await expect(service.leaveTeam(member)).resolves.toMatchObject({ member: { status: 'removed' } })
      expect(await store.authenticateApiKey(joined.apiKey)).toBeUndefined()
      expect(broker.revoked).toEqual([{ teamId: owner.teamId, accountId: contribution.id }])

      await vi.advanceTimersByTimeAsync(10)

      expect(drain).toHaveBeenCalledTimes(2)
      expect(broker.revoked).toEqual([
        { teamId: owner.teamId, accountId: contribution.id },
        { teamId: owner.teamId, accountId: contribution.id },
      ])
      await service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not overwrite an OAuth success that races with cancellation', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const broker = new FakeCredentialBroker(async ref => {
      await store.setContributionAccountStatus(ref.teamId, ref.accountId, 'active')
    })
    const service = new TeamService({ store, broker })
    const started = await service.startContributionOAuth(owner, 'Owner Codex')

    await expect(service.cancelContributionOAuth(owner, started.account.id))
      .resolves.toMatchObject({ id: started.account.id, status: 'active' })
    await expect(store.listContributionAccounts(owner))
      .resolves.toMatchObject([{ id: started.account.id, status: 'active' }])
  })

  it('reauthorizes an existing contribution in place', async () => {
    const broker = new FakeCredentialBroker()
    const service = new TeamService({ store: new MemoryTeamStore(), broker })
    const boot = await service.store.bootstrap('Friends', 'Owner')
    const owner = await service.store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await service.store.createContributionAccount(owner, 'Owner Codex')
    await service.store.setContributionAccountStatus(owner.teamId, contribution.id, 'reauth_required', 'expired')

    const result = await service.reauthorizeContributionOAuth(owner, contribution.id)

    expect(result).toMatchObject({ account: { id: contribution.id, status: 'authorizing' }, method: 'device_code' })
    expect(broker.restarted).toEqual([{ teamId: owner.teamId, accountId: contribution.id }])
    expect(await service.store.listContributionAccounts(owner)).toHaveLength(1)
  })

  it('restores reauth_required when restarting OAuth fails', async () => {
    class FailingRestartBroker extends FakeCredentialBroker {
      override restartOAuth(ref: TeamCredentialRef): ReturnType<TeamCredentialBroker['restartOAuth']> {
        this.restarted.push(ref)
        return Promise.reject(new Error('provider refused Authorization: Bearer opaque-provider-token'))
      }
    }
    const broker = new FailingRestartBroker()
    const service = new TeamService({ store: new MemoryTeamStore(), broker })
    const boot = await service.store.bootstrap('Friends', 'Owner')
    const owner = await service.store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await service.store.createContributionAccount(owner, 'Owner Codex')
    await service.store.setContributionAccountStatus(owner.teamId, contribution.id, 'reauth_required')

    await expect(service.reauthorizeContributionOAuth(owner, contribution.id))
      .rejects.toThrow(TEAM_AUTHORIZATION_FAILED_CODE)
    const persisted = (await service.store.listContributionAccounts(owner))[0]
    expect(persisted).toMatchObject({
      id: contribution.id,
      status: 'reauth_required',
      lastError: TEAM_AUTHORIZATION_FAILED_CODE,
    })
    expect(JSON.stringify(persisted)).not.toMatch(/provider refused|opaque-provider-token|authorization: bearer/iu)
  })

  it('cleans up a restarted credential when revocation wins the race', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    class RevokingRestartBroker extends FakeCredentialBroker {
      override async restartOAuth(ref: TeamCredentialRef): ReturnType<TeamCredentialBroker['restartOAuth']> {
        this.restarted.push(ref)
        await store.revokeContributionAccount(owner, ref.accountId)
        return super.startOAuth(ref)
      }
    }
    const broker = new RevokingRestartBroker()
    const service = new TeamService({ store, broker })
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')
    await store.setContributionAccountStatus(owner.teamId, contribution.id, 'reauth_required')

    await expect(service.reauthorizeContributionOAuth(owner, contribution.id)).rejects.toThrow(/revoked during authorization/iu)
    expect(broker.revoked).toEqual([{ teamId: owner.teamId, accountId: contribution.id }])
    await expect(store.listContributionAccounts(owner)).resolves.toMatchObject([{ id: contribution.id, status: 'revoked' }])
  })

  it('reconciles interrupted contribution authorization from Host credential state', async () => {
    const store = new MemoryTeamStore()
    const boot = await store.bootstrap('Friends', 'Owner')
    const owner = await store.authenticateApiKey(boot.apiKey)
    if (owner === undefined) throw new Error('owner key should authenticate')
    const contribution = await store.createContributionAccount(owner, 'Owner Codex')
    const broker = new FakeCredentialBroker()
    const service = new TeamService({ store, broker })

    await service.reconcileContributionAuthorizations()

    expect(broker.inspected).toEqual([{ teamId: owner.teamId, accountId: contribution.id }])
    await expect(store.listContributionAccounts(owner))
      .resolves.toMatchObject([{ id: contribution.id, status: 'active' }])
  })
})
