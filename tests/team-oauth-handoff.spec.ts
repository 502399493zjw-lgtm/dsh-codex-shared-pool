import { describe, expect, it } from 'vitest'
import {
  sealTeamCredentialHandoff,
  TeamCredentialHandoffRegistry,
} from '../src/team/oauth-handoff.ts'

const ref = { teamId: 'team-1', accountId: 'account-1' }
const credential = {
  type: 'oauth' as const,
  access: 'opaque-access-token',
  refresh: 'opaque-refresh-token',
  expires: 1_900_000_000_000,
  accountId: 'provider-account-1',
}

describe('Team credential OAuth handoff', () => {
  it('retains only an exact-envelope receipt while keeping direct consumption one-time', () => {
    const registry = new TeamCredentialHandoffRegistry({ now: () => 1_000, ttlMs: 60_000 })
    const offer = registry.create(ref)
    const envelope = sealTeamCredentialHandoff(offer, ref, { label: 'Personal Codex', credential })

    expect(registry.complete(ref, envelope)).toEqual({ label: 'Personal Codex', credential })
    expect(() => registry.complete(ref, envelope)).toThrow(/already used/iu)
    expect(registry.completeReplaySafe(ref, envelope)).toEqual({ replayed: true })
    expect(() => registry.complete(ref, { ...envelope, tag: `${envelope.tag.slice(0, -2)}AA` }))
      .toThrow(/expired|unknown|already used|replay/iu)
  })

  it('binds ciphertext to the team and account and rejects tampering', () => {
    const registry = new TeamCredentialHandoffRegistry({ now: () => 1_000, ttlMs: 60_000 })
    const offer = registry.create(ref)
    const envelope = sealTeamCredentialHandoff(offer, ref, { label: 'Personal Codex', credential })

    expect(() => registry.complete({ ...ref, accountId: 'account-2' }, envelope)).toThrow(/account|session/iu)
    expect(() => registry.complete(ref, { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` }))
      .toThrow(/decrypt|invalid|authenticate/iu)
  })

  it('expires and explicitly cancels unused offers without exposing credential material', () => {
    let now = 1_000
    const registry = new TeamCredentialHandoffRegistry({ now: () => now, ttlMs: 60_000 })
    const expiring = registry.create(ref)
    expect(JSON.stringify(expiring)).not.toContain('private')
    expect(JSON.stringify(expiring)).not.toContain('refresh')

    now = 61_001
    const expiredEnvelope = sealTeamCredentialHandoff(expiring, ref, { label: 'Personal Codex', credential })
    expect(() => registry.complete(ref, expiredEnvelope)).toThrow(/expired/iu)

    const cancellable = registry.create(ref)
    const cancelledEnvelope = sealTeamCredentialHandoff(cancellable, ref, { label: 'Personal Codex', credential })
    registry.cancel(ref)
    expect(() => registry.complete(ref, cancelledEnvelope)).toThrow(/expired|unknown|cancelled/iu)
  })
})
