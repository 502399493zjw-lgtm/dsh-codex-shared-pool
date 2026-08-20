import { describe, expect, it } from 'vitest'
import type { TeamManagementMemberSummary } from '../src/shared/team-management.ts'
import type { TeamMemberSummary } from '../src/team/types.ts'
import {
  canRevokeTeamInvite,
  canMemberLeaveTeam,
  canTransferTeamOwnership,
  parseContributionProtectionDraft,
} from '../src/client/team/team-settings-contract.ts'
import { en, zh } from '../src/client/team/locales.ts'

function member(overrides: Partial<TeamMemberSummary> = {}): TeamMemberSummary {
  return {
    id: 'member-1',
    teamId: 'team-1',
    displayName: 'Member One',
    role: 'member',
    status: 'active',
    joinedAt: 1,
    ...overrides,
  }
}

function managementMember(
  overrides: Partial<TeamManagementMemberSummary> = {},
): TeamManagementMemberSummary {
  return {
    ...member(),
    canReceiveOwnership: true,
    ...overrides,
  }
}

describe('Team Settings departure contract', () => {
  it('offers real Team departure only to non-owner members', () => {
    expect(canMemberLeaveTeam('owner')).toBe(false)
    expect(canMemberLeaveTeam('admin')).toBe(true)
    expect(canMemberLeaveTeam('member')).toBe(true)
  })

  it('distinguishes Team departure from disconnecting one Host in both locales', () => {
    expect(en.leaveTeam).toBe('Leave Team')
    expect(en.leaveTeamHint).toContain('all of your Team keys')
    expect(en.ownerLeaveUnavailable).toContain('transfer ownership')
    expect(zh.leaveTeam).toBe('退出 Team')
    expect(zh.leaveTeamHint).toContain('所有 Team key')
    expect(zh.ownerLeaveUnavailable).toContain('转移所有权')
  })
})

describe('Team Settings invite-revocation contract', () => {
  it('offers revocation only to operators for pending invites', () => {
    expect(canRevokeTeamInvite('owner', 'pending')).toBe(true)
    expect(canRevokeTeamInvite('admin', 'pending')).toBe(true)
    expect(canRevokeTeamInvite('member', 'pending')).toBe(false)
    expect(canRevokeTeamInvite('owner', 'accepted')).toBe(false)
    expect(canRevokeTeamInvite('owner', 'expired')).toBe(false)
    expect(canRevokeTeamInvite('owner', 'revoked')).toBe(false)
  })

  it('explains that revocation immediately invalidates the token in both locales', () => {
    expect(en.revokeInvite).toBe('Revoke invite')
    expect(en.pendingInviteExpires).toContain('{time}')
    expect(zh.revokeInvite).toBe('撤销邀请')
    expect(zh.pendingInviteExpires).toContain('{time}')
  })
})

describe('Team Settings ownership-transfer contract', () => {
  const owner = member({ id: 'owner-1', displayName: 'Owner', role: 'owner' })

  it('offers transfer only when the Host marks an active same-Team non-owner as eligible', () => {
    expect(canTransferTeamOwnership(owner, managementMember())).toBe(true)
    expect(canTransferTeamOwnership(owner, managementMember({ role: 'admin' }))).toBe(true)
    expect(canTransferTeamOwnership(owner, managementMember({ canReceiveOwnership: false }))).toBe(false)
    expect(canTransferTeamOwnership(owner, managementMember({ id: owner.id }))).toBe(false)
    expect(canTransferTeamOwnership(owner, managementMember({ status: 'suspended' }))).toBe(false)
    expect(canTransferTeamOwnership(owner, managementMember({ status: 'removed' }))).toBe(false)
    expect(canTransferTeamOwnership(owner, managementMember({ teamId: 'team-2' }))).toBe(false)
    expect(canTransferTeamOwnership(owner, managementMember({ role: 'owner' }))).toBe(false)
    expect(canTransferTeamOwnership(member({ role: 'admin' }), managementMember())).toBe(false)
    expect(canTransferTeamOwnership(member(), managementMember({ id: 'member-2' }))).toBe(false)
  })

  it('explains the role swap and preserved keys/contribution ownership in both locales', () => {
    expect(en.transferOwnership).toBe('Transfer ownership')
    expect(en.transferOwnershipHint).toContain('Admin')
    expect(en.transferOwnershipWarning).toContain('Team keys')
    expect(en.transferOwnershipWarning).toContain('contribution ownership')
    expect(en.ownerLeaveUnavailable).not.toContain('not available')

    expect(zh.transferOwnership).toBe('转移所有权')
    expect(zh.transferOwnershipHint).toContain('Admin')
    expect(zh.transferOwnershipWarning).toContain('Team key')
    expect(zh.transferOwnershipWarning).toContain('贡献账号归属')
    expect(zh.ownerLeaveUnavailable).not.toContain('尚未提供')
  })
})

describe('Team Settings contribution-protection contract', () => {
  it('parses the complete upper-bound protection settings accepted by the Host', () => {
    expect(parseContributionProtectionDraft({
      reserve: '99',
      requestCap: '1000000',
      models: 'gpt-5-codex, gpt-5-mini',
    })).toEqual({
      ok: true,
      patch: {
        personalReservePercent: 99,
        maxSharedRequestsPerWindow: 1_000_000,
        allowedModels: ['gpt-5-codex', 'gpt-5-mini'],
      },
    })
  })

  it.each(['', '1.5', '100', 'Infinity'])('rejects reserve value %j before submission', reserve => {
    expect(parseContributionProtectionDraft({ reserve, requestCap: '', models: '' }))
      .toEqual({ ok: false, field: 'reserve' })
  })

  it.each(['0', '1.5', '1000001', 'Infinity'])('rejects request-cap value %j before submission', requestCap => {
    expect(parseContributionProtectionDraft({ reserve: '20', requestCap, models: '' }))
      .toEqual({ ok: false, field: 'requestCap' })
  })

  it('rejects model lists the Host cannot store', () => {
    expect(parseContributionProtectionDraft({
      reserve: '20',
      requestCap: '',
      models: Array.from({ length: 33 }, (_, index) => `model-${index}`).join(','),
    })).toEqual({ ok: false, field: 'allowedModels' })

    expect(parseContributionProtectionDraft({
      reserve: '20',
      requestCap: '',
      models: 'm'.repeat(121),
    })).toEqual({ ok: false, field: 'allowedModels' })
  })
})
