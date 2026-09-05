/** Host-only anonymous provisioning validation. Never log raw credential inputs. */
import { createHash } from 'node:crypto'
import { normalizeTeamMemberDisplayName } from './member-display-name.ts'
import type { TeamAnonymousCreationInput } from './types.ts'

export type TeamAnonymousAction = 'create' | 'recover-owner'
export const TEAM_ANONYMOUS_LIMITS = {
  create: { max: 30, windowMs: 60 * 60 * 1000 },
  'recover-owner': { max: 60, windowMs: 10 * 60 * 1000 },
} as const
export class TeamAnonymousRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Team anonymous request rate limit exceeded')
    this.name = 'TeamAnonymousRateLimitError'
  }
}
export class TeamAnonymousCreationConflictError extends Error {
  readonly status = 409
  constructor() { super('Team creation request conflicts with an existing operation') }
}
export class TeamOwnerRecoveryUnavailableError extends Error {
  readonly status = 404
  constructor() { super('Team owner recovery is unavailable') }
}
export function anonymousSecret(value: string, prefix: 'dsh_create' | 'dsh_team' | 'dsh_recovery'): string {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`, 'u').test(value)) {
    throw new Error('Team creation or recovery credential is invalid')
  }
  return createHash('sha256').update(value).digest('hex')
}
export function normalizeAnonymousCreation(input: TeamAnonymousCreationInput) {
  const creationHash = anonymousSecret(input.creationToken, 'dsh_create')
  const keyHash = anonymousSecret(input.apiKey, 'dsh_team')
  const recoveryHash = anonymousSecret(input.recoveryCode, 'dsh_recovery')
  const teamName = input.teamName.trim()
  if (teamName.length === 0 || teamName.length > 120) throw new Error('teamName must contain 1 to 120 characters')
  const owner = normalizeTeamMemberDisplayName(input.ownerName, 'ownerName')
  const bindingHash = createHash('sha256').update(JSON.stringify([teamName, owner.displayName, keyHash, recoveryHash])).digest('hex')
  return { creationHash, keyHash, recoveryHash, bindingHash, teamName, owner }
}
