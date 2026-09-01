import { describe, expect, it } from 'vitest'
import type {
  TeamManagementContributionSummary,
  TeamManagementMemberSummary,
} from '../src/shared/team-management.ts'
import type { TeamMemberSummary } from '../src/team/types.ts'
import {
  canRevokeTeamInvite,
  canMemberLeaveTeam,
  canRemoveTeamMember,
  canTransferTeamOwnership,
  groupTeamContributions,
  localProfilesAvailableForTeam,
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
    expect(en.ownerLeaveUnavailable).toMatch(/transfer ownership/iu)
    expect(zh.leaveTeam).toBe('退出 Team')
    expect(zh.leaveTeamHint).toContain('所有 Team key')
    expect(zh.ownerLeaveUnavailable).toContain('转让所有权')
  })
})

describe('Team Settings invite-revocation contract', () => {
  it('offers revocation only to the Owner for pending invites', () => {
    expect(canRevokeTeamInvite('owner', 'pending')).toBe(true)
    expect(canRevokeTeamInvite('admin', 'pending')).toBe(false)
    expect(canRevokeTeamInvite('member', 'pending')).toBe(false)
    expect(canRevokeTeamInvite('owner', 'accepted')).toBe(false)
    expect(canRevokeTeamInvite('owner', 'expired')).toBe(false)
    expect(canRevokeTeamInvite('owner', 'revoked')).toBe(false)
  })

  it('explains that revocation immediately invalidates the token in both locales', () => {
    expect(en.revokeInvite).toBe('Revoke invite token')
    expect(en.pendingInviteExpires).toContain('{time}')
    expect(zh.revokeInvite).toBe('撤销邀请码')
    expect(zh.pendingInviteExpires).toContain('{time}')
  })
})

describe('Team Settings ownership-transfer contract', () => {
  const owner = member({ id: 'owner-1', displayName: 'Owner', role: 'owner' })

  it('offers transfer only when the Host marks an active same-Team non-owner as eligible', () => {
    expect(canTransferTeamOwnership(owner, managementMember())).toBe(true)
    expect(canTransferTeamOwnership(owner, managementMember({ role: 'admin' }))).toBe(false)
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
    expect(en.transferOwnershipHint).toContain('Member')
    expect(en.transferOwnershipWarning).toContain('Team keys')
    expect(en.transferOwnershipWarning).toContain('contribution ownership')
    expect(en.ownerLeaveUnavailable).not.toContain('not available')

    expect(zh.transferOwnership).toBe('转移所有权')
    expect(zh.transferOwnershipHint).toContain('成员')
    expect(zh.transferOwnershipWarning).toContain('Team key')
    expect(zh.transferOwnershipWarning).toContain('贡献账号归属')
    expect(zh.ownerLeaveUnavailable).not.toContain('尚未提供')
  })
})

describe('Team Settings member-management contract', () => {
  const owner = member({ id: 'owner-1', role: 'owner' })
  const admin = member({ id: 'admin-1', role: 'admin' })
  const teammate = managementMember({ id: 'member-2', role: 'member' })

  it('lets only Owners remove non-Owners, never themselves', () => {
    expect(canRemoveTeamMember(owner, teammate)).toBe(true)
    expect(canRemoveTeamMember(owner, managementMember({ id: 'admin-1', role: 'admin' }))).toBe(true)
    expect(canRemoveTeamMember(admin, teammate)).toBe(false)
    expect(canRemoveTeamMember(admin, managementMember({ id: 'admin-2', role: 'admin' }))).toBe(false)
    expect(canRemoveTeamMember(owner, managementMember({ id: owner.id }))).toBe(false)
    expect(canRemoveTeamMember(owner, managementMember({ role: 'owner' }))).toBe(false)
  })
})

describe('Team Settings contribution-protection contract', () => {
  it('parses the complete upper-bound protection settings accepted by the Host', () => {
    expect(parseContributionProtectionDraft({
      reserve: '99',
      requestCap: '1000000',
      weeklyLimitUsd: '10000',
      models: 'gpt-5-codex, gpt-5-mini',
    })).toEqual({
      ok: true,
      patch: {
        personalReservePercent: 99,
        maxSharedRequestsPerWindow: 1_000_000,
        weeklySharedEstimatedApiCostLimitMicros: 10_000_000_000,
        allowedModels: ['gpt-5-codex', 'gpt-5-mini'],
      },
    })
  })

  it.each(['', '1.5', '100', 'Infinity'])('rejects reserve value %j before submission', reserve => {
    expect(parseContributionProtectionDraft({ reserve, requestCap: '', weeklyLimitUsd: '', models: '' }))
      .toEqual({ ok: false, field: 'reserve' })
  })

  it.each(['0', '1.5', '1000001', 'Infinity'])('rejects request-cap value %j before submission', requestCap => {
    expect(parseContributionProtectionDraft({ reserve: '20', requestCap, weeklyLimitUsd: '', models: '' }))
      .toEqual({ ok: false, field: 'requestCap' })
  })

  it.each(['0', '0.001', '10000.01', 'Infinity'])('rejects weekly USD limit %j before submission', weeklyLimitUsd => {
    expect(parseContributionProtectionDraft({ reserve: '20', requestCap: '', weeklyLimitUsd, models: '' }))
      .toEqual({ ok: false, field: 'weeklyLimitUsd' })
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

describe('Team Settings contribution grouping', () => {
  const contribution = (id: string, ownerMemberId: string, status: TeamManagementContributionSummary['status']): TeamManagementContributionSummary => ({
    id,
    teamId: 'team-1',
    ownerMemberId,
    label: id,
    status,
    personalReservePercent: 20,
    maxSharedRequestsPerWindow: null,
    maxSharedConcurrency: 1,
    allowedModels: [],
    createdAt: 1,
    updatedAt: 1,
  })

  it('groups only the current member contributions and hides every teammate credential', () => {
    const groups = groupTeamContributions([
      contribution('mine-active', 'member-1', 'active'),
      contribution('mine-paused', 'member-1', 'paused'),
      contribution('mine-reauth', 'member-1', 'reauth_required'),
      contribution('mine-authorizing', 'member-1', 'authorizing'),
      contribution('friend-active', 'member-2', 'active'),
      contribution('friend-paused', 'member-2', 'paused'),
      contribution('revoked', 'member-1', 'revoked'),
    ], 'member-1')

    expect(groups.shared.map(account => account.id)).toEqual(['mine-active'])
    expect(groups.unshared.map(account => account.id)).toEqual(['mine-paused', 'mine-reauth'])
  })

  it('removes a local profile once its own durable Team contribution represents it', () => {
    const profiles = [
      { id: 'local-1', label: 'Personal', createdAt: 1, updatedAt: 1 },
      { id: 'local-2', label: 'Backup', createdAt: 2, updatedAt: 2 },
    ]
    const active = { ...contribution('shared', 'member-1', 'active'), sourceLocalProfileId: 'local-1' }

    expect(localProfilesAvailableForTeam(profiles, [active], 'member-1').map(profile => profile.id))
      .toEqual(['local-2'])
    expect(localProfilesAvailableForTeam(profiles, [{ ...active, status: 'revoked' }], 'member-1'))
      .toEqual(profiles)
    expect(localProfilesAvailableForTeam(profiles, [{ ...active, ownerMemberId: 'member-2' }], 'member-1'))
      .toEqual(profiles)
  })
})
