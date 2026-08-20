/**
 * OpenAI Codex OAuth orchestration shared by the plugin and standalone launcher.
 * @module @deepseek-ai/dsh-codex_shared_pool/auth
 */

import { createModels } from '@earendil-works/pi-ai'
import type { AuthInteraction, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER, openAICodexAccountName } from './store.ts'
import type { CodexProfileSummary, OpenAICodexProfileStore } from './store.ts'

/** Non-secret login state shown by the launcher. */
export interface OpenAICodexAuthStatus {
  /** Whether a stored OAuth credential exists. */
  authenticated: boolean
  /** Access-token expiry time; refresh is automatic on the next request. */
  expiresAt?: Date
}

/**
 * Complete provider-native OAuth and persist the resulting credential.
 * @param interaction - terminal or UI callbacks for the provider flow.
 * @param store - credential store, defaulting under `$DSH_HOME`.
 */
export async function loginOpenAICodex(
  interaction: AuthInteraction,
  store: OpenAICodexCredentialStore = new OpenAICodexCredentialStore(),
): Promise<void> {
  const models = createModels({ credentials: store })
  models.setProvider(openaiCodexProvider())
  await models.login(OPENAI_CODEX_PROVIDER, 'oauth', interaction)
}

/** Minimal temporary store used so a new OAuth login cannot overwrite any stored profile. */
class CapturedCredentialStore implements CredentialStore {
  private credential: Credential | undefined

  read(providerId: string): Promise<Credential | undefined> {
    return Promise.resolve(providerId === OPENAI_CODEX_PROVIDER && this.credential !== undefined
      ? structuredClone(this.credential)
      : undefined)
  }

  list(): Promise<readonly CredentialInfo[]> {
    return Promise.resolve(this.credential === undefined
      ? []
      : [{ providerId: OPENAI_CODEX_PROVIDER, type: this.credential.type }])
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId !== OPENAI_CODEX_PROVIDER) throw new Error(`openai-codex: unsupported provider ${providerId}`)
    const candidate = await fn(this.credential === undefined ? undefined : structuredClone(this.credential))
    if (candidate !== undefined) this.credential = structuredClone(candidate)
    return this.credential === undefined ? undefined : structuredClone(this.credential)
  }

  delete(providerId: string): Promise<void> {
    if (providerId === OPENAI_CODEX_PROVIDER) this.credential = undefined
    return Promise.resolve()
  }
}

/**
 * Complete OAuth into an isolated store, then add it under the OpenAI account name.
 *
 * @param interaction - Provider authentication prompts and notifications.
 * @param store - Profile store that receives the new credential.
 * @returns Secret-free summary of the added profile.
 */
export async function loginOpenAICodexProfile(
  interaction: AuthInteraction,
  store: OpenAICodexProfileStore = new OpenAICodexCredentialStore(),
): Promise<CodexProfileSummary> {
  const captured = new CapturedCredentialStore()
  const models = createModels({ credentials: captured })
  models.setProvider(openaiCodexProvider())
  await models.login(OPENAI_CODEX_PROVIDER, 'oauth', interaction)
  const credential = await captured.read(OPENAI_CODEX_PROVIDER)
  if (credential?.type !== 'oauth') throw new Error('openai-codex: OAuth completed without a credential')
  const oauthCredential = credential
  return store.addProfile(openAICodexAccountName(oauthCredential) ?? 'Codex account', oauthCredential)
}

/**
 * Remove the request-resolved OpenAI Codex profile.
 * @param store - credential store, defaulting under `$DSH_HOME`.
 */
export async function logoutOpenAICodex(
  store: OpenAICodexCredentialStore = new OpenAICodexCredentialStore(),
): Promise<void> {
  await store.delete(OPENAI_CODEX_PROVIDER)
}

/**
 * Read non-secret OpenAI Codex login state without refreshing the token.
 * @param store - credential store, defaulting under `$DSH_HOME`.
 * @returns stored login state and expiry.
 */
export async function openAICodexAuthStatus(
  store: OpenAICodexCredentialStore = new OpenAICodexCredentialStore(),
): Promise<OpenAICodexAuthStatus> {
  const credential = await store.read(OPENAI_CODEX_PROVIDER)
  return credential?.type === 'oauth'
    ? { authenticated: true, expiresAt: new Date(credential.expires) }
    : { authenticated: false }
}
