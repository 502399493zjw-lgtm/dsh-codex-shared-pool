/** Host-only Team service construction from secret-reference configuration. */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { TeamConfig } from './config.ts'
import { PostgresTeamRequestRouter } from './postgres-routing.ts'
import { PostgresTeamStore } from './postgres-store.ts'
import { TeamService } from './service.ts'
import type { TeamStore } from './store.ts'
import type { TeamCredentialBroker } from './credentials.ts'
import { LocalTeamCredentialBroker } from './credentials.ts'
import {
  Aes256GcmTeamKeyEncryptionProvider,
  decodeTeamCredentialMasterKey,
  PostgresTeamEnvelopeCredentialBackend,
  TeamKeyEncryptionKeyring,
} from './envelope-credentials.ts'
import type { TeamKeyEncryptionProvider } from './envelope-credentials.ts'
import { RemoteTeamCredentialBroker } from './remote-credentials.ts'

export const DEFAULT_TEAM_DATABASE_URL_REF = credentialRef('DSH_CODEX_SHARED_POOL_DATABASE_URL')
export const DEFAULT_TEAM_BOOTSTRAP_TOKEN_REF = credentialRef('DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN')
export const DEFAULT_TEAM_CREDENTIAL_MASTER_KEY_REF = credentialRef('DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY')
export const DEFAULT_TEAM_CREDENTIAL_BROKER_API_KEY_REF = credentialRef('DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY')

interface InitializableTeamStore extends TeamStore {
  initialize(): Promise<void>
}

export interface TeamRuntimeDependencies {
  readonly credentials?: Pick<CredentialProvider, 'resolve'>
  readonly createPostgresStore?: (connectionString: string) => InitializableTeamStore
  /** Host-only test/adapter seam; never sourced from plugin JSON configuration. */
  readonly broker?: TeamCredentialBroker
  /** Host-only managed-KMS seam; when omitted a KEK is resolved from DSH credentials. */
  readonly keyEncryptionProvider?: TeamKeyEncryptionProvider
  /** Host-only HTTP seam used by a remote credential broker client. */
  readonly fetch?: typeof fetch
}

/**
 * Build one Team service without ever placing a database connection string in
 * JSON-safe plugin configuration. PostgreSQL connection credentials are
 * resolved once for the lifetime of the underlying connection pool.
 */
export async function createTeamServiceFromConfig(
  config: Pick<TeamConfig,
    | 'storage'
    | 'databaseUrlRef'
    | 'credentialMasterKeyRef'
    | 'credentialPreviousMasterKeyRef'
    | 'credentialBroker'
    | 'credentialBrokerBaseUrl'
    | 'credentialBrokerApiKeyRef'
  >,
  dependencies: TeamRuntimeDependencies = {},
): Promise<TeamService> {
  if ((config.storage ?? 'memory') === 'memory') {
    if (config.credentialBroker === 'remote' && dependencies.broker === undefined) {
      throw new Error('remote Team credential broker mode requires PostgreSQL Team storage')
    }
    return initializeTeamService(new TeamService({
      ...(dependencies.broker === undefined ? {} : { broker: dependencies.broker }),
    }))
  }

  const credentials = dependencies.credentials
  if (credentials === undefined) throw new Error('DSH credential service is required for PostgreSQL Team storage')
  const ref = config.databaseUrlRef === undefined
    ? DEFAULT_TEAM_DATABASE_URL_REF
    : credentialRef(config.databaseUrlRef)
  const resolved = await credentials.resolve(ref)
  if (resolved === undefined || resolved.value.trim().length === 0) {
    throw new Error(`Team database credential ${String(ref)} is not configured`)
  }

  const store = (dependencies.createPostgresStore ?? (connectionString => new PostgresTeamStore({ connectionString })))(resolved.value)
  let service: TeamService | undefined
  try {
    await store.initialize()
    let broker = dependencies.broker
    if (broker === undefined) {
      if (!(store instanceof PostgresTeamStore)) {
        throw new Error('PostgreSQL Team credential storage requires PostgresTeamStore or an injected credential broker')
      }
      const onStatusChange = async (
        teamId: string,
        accountId: string,
        status: 'active' | 'reauth_required',
        lastError?: string,
        expectedStatus?: Parameters<TeamStore['setContributionAccountStatus']>[4],
      ) => {
        await store.setContributionAccountStatus(teamId, accountId, status, lastError, expectedStatus)
      }
      if (config.credentialBroker === 'remote') {
        broker = new RemoteTeamCredentialBroker({
          baseUrl: config.credentialBrokerBaseUrl ?? '',
          resolveApiKey: async () => resolveRemoteBrokerApiKey(config, credentials),
          onStatusChange,
          ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
        })
      } else {
        const keyEncryptionProvider = dependencies.keyEncryptionProvider
          ?? await resolveLocalKeyEncryptionProvider(config, credentials)
        broker = new LocalTeamCredentialBroker({
          storage: new PostgresTeamEnvelopeCredentialBackend({ pool: store.pool, keyEncryptionProvider }),
          onStatusChange,
        })
      }
    }
    const router = store instanceof PostgresTeamStore
      ? new PostgresTeamRequestRouter({ pool: store.pool })
      : undefined
    service = new TeamService({
      store,
      ...(router === undefined ? {} : { router }),
      broker,
    })
    await service.reconcileContributionAuthorizations()
    return service
  } catch (error: unknown) {
    if (service === undefined) await store.dispose().catch(() => undefined)
    else await service.dispose().catch(() => undefined)
    throw error
  }
}

async function resolveRemoteBrokerApiKey(
  config: Pick<TeamConfig, 'credentialBrokerApiKeyRef'>,
  credentials: Pick<CredentialProvider, 'resolve'>,
): Promise<string | undefined> {
  const ref = config.credentialBrokerApiKeyRef === undefined
    ? DEFAULT_TEAM_CREDENTIAL_BROKER_API_KEY_REF
    : credentialRef(config.credentialBrokerApiKeyRef)
  return (await credentials.resolve(ref))?.value
}

async function initializeTeamService(service: TeamService): Promise<TeamService> {
  try {
    await service.reconcileContributionAuthorizations()
    return service
  } catch (error: unknown) {
    await service.dispose().catch(() => undefined)
    throw error
  }
}

/** Resolve the bootstrap secret per operation so rotations affect the next request. */
export async function resolveTeamBootstrapToken(
  config: Pick<TeamConfig, 'bootstrapTokenRef'>,
  credentials: Pick<CredentialProvider, 'resolve'>,
): Promise<string | undefined> {
  const ref: CredentialRef = config.bootstrapTokenRef === undefined
    ? DEFAULT_TEAM_BOOTSTRAP_TOKEN_REF
    : credentialRef(config.bootstrapTokenRef)
  return (await credentials.resolve(ref))?.value
}

async function resolveLocalKeyEncryptionProvider(
  config: Pick<TeamConfig, 'credentialMasterKeyRef' | 'credentialPreviousMasterKeyRef'>,
  credentials: Pick<CredentialProvider, 'resolve'>,
): Promise<TeamKeyEncryptionProvider> {
  const ref = config.credentialMasterKeyRef === undefined
    ? DEFAULT_TEAM_CREDENTIAL_MASTER_KEY_REF
    : credentialRef(config.credentialMasterKeyRef)
  const primary = await resolveAesKeyEncryptionProvider(ref, credentials)
  const previousName = config.credentialPreviousMasterKeyRef?.trim()
  if (previousName === undefined || previousName.length === 0) return primary
  const previousRef = credentialRef(previousName)
  if (previousRef === ref) throw new Error('Team current and previous credential encryption key references must differ')
  const previous = await resolveAesKeyEncryptionProvider(previousRef, credentials)
  return new TeamKeyEncryptionKeyring(primary, [previous])
}

async function resolveAesKeyEncryptionProvider(
  ref: CredentialRef,
  credentials: Pick<CredentialProvider, 'resolve'>,
): Promise<Aes256GcmTeamKeyEncryptionProvider> {
  const resolved = await credentials.resolve(ref)
  if (resolved === undefined || resolved.value.trim().length === 0) {
    throw new Error(`Team credential encryption key ${String(ref)} is not configured`)
  }
  const key = decodeTeamCredentialMasterKey(resolved.value.trim())
  try {
    return new Aes256GcmTeamKeyEncryptionProvider(key)
  } finally {
    key.fill(0)
  }
}
