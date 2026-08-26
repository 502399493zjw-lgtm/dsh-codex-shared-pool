/** Validated Host-only Team control-plane configuration. */

import z from '@deepseek-ai/schemastery'

export interface TeamConfig {
  readonly enabled?: boolean
  /** Local development is ephemeral; hosted deployments should use PostgreSQL. */
  readonly storage?: 'memory' | 'postgres'
  /** DSH credential reference containing the PostgreSQL connection string. */
  readonly databaseUrlRef?: string
  /** DSH credential reference containing a base64/base64url 32-byte envelope KEK. */
  readonly credentialMasterKeyRef?: string
  /** Optional legacy KEK reference kept readable only during an online rotation. */
  readonly credentialPreviousMasterKeyRef?: string
  /** Host-only KEK reference for durable, revealable invitation tokens. */
  readonly inviteTokenMasterKeyRef?: string
  /** Optional historical invitation KEK kept readable during rotation. */
  readonly inviteTokenPreviousMasterKeyRef?: string
  /** Keep OAuth material in this Host or delegate fixed capabilities to an isolated broker. */
  readonly credentialBroker?: 'local' | 'remote'
  /** Complete remote URL ending in `/v1/dsh-team-credential-broker`. */
  readonly credentialBrokerBaseUrl?: string
  /** DSH credential reference containing the Host-to-broker internal API key. */
  readonly credentialBrokerApiKeyRef?: string
  /** DSH credential reference containing the one-time local bootstrap secret. */
  readonly bootstrapTokenRef?: string
  /** Maximum invite lifetime in milliseconds. */
  readonly maxInviteTtlMs?: number
  /** Host cadence for clearing expired invitation ciphertext; never over 24 hours. */
  readonly inviteEnvelopeSweepIntervalMs?: number
}

export const TeamConfigSchema: z<TeamConfig> = z.object({
  enabled: z.boolean().default(false),
  storage: z.union(['memory', 'postgres'] as const).default('memory'),
  databaseUrlRef: z.string().default('DSH_CODEX_SHARED_POOL_DATABASE_URL'),
  credentialMasterKeyRef: z.string().default('DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY'),
  credentialPreviousMasterKeyRef: z.string().default(''),
  inviteTokenMasterKeyRef: z.string().default('DSH_CODEX_SHARED_POOL_INVITE_MASTER_KEY'),
  inviteTokenPreviousMasterKeyRef: z.string().default(''),
  credentialBroker: z.union(['local', 'remote'] as const).default('local'),
  credentialBrokerBaseUrl: z.string().default(''),
  credentialBrokerApiKeyRef: z.string().default('DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY'),
  bootstrapTokenRef: z.string().default('DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN'),
  maxInviteTtlMs: z.number().step(1).min(60_000).max(30 * 24 * 60 * 60 * 1000).default(7 * 24 * 60 * 60 * 1000),
  inviteEnvelopeSweepIntervalMs: z.number().step(1).min(100).max(24 * 60 * 60 * 1_000).default(6 * 60 * 60 * 1_000),
})
