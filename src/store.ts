/**
 * Owner-only ordered OAuth profile storage and Session binding for OpenAI Codex.
 * @module @deepseek-ai/dsh-codex_shared_pool/store
 */

import { mkdir, readFile, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type { Credential, CredentialInfo, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Provider route and pi-ai provider id owned by this bundle. */
export const OPENAI_CODEX_PROVIDER = 'openai-codex'

/** Basename of the profile document inside the Harness home. */
export const OPENAI_CODEX_AUTH_FILENAME = '.openai-codex-profiles.json'

/** Previous single-account document, read only for a non-destructive migration. */
export const LEGACY_OPENAI_CODEX_AUTH_FILENAME = '.openai-codex-auth.json'

/** Current ordered-profile on-disk format. */
const AUTH_FORMAT_VERSION = 2

/** Prior ordered-profile document format used by the original DSH bundle. */
const LEGACY_PROFILE_FORMAT_VERSION = 1

/** Prior single-account document format. */
const LEGACY_AUTH_FORMAT_VERSION = 1

interface StoredProfile {
  id: string
  label: string
  credential: StoredOAuthCredential
  createdAt: number
  updatedAt: number
}

interface StoredOAuthCredential extends OAuthCredential {
  accountId: string
}

interface AuthDocument {
  version: typeof AUTH_FORMAT_VERSION
  profiles: StoredProfile[]
}

/** Secret-free profile data safe to return from the web API. */
export interface CodexProfileSummary {
  id: string
  label: string
  createdAt: number
  updatedAt: number
}

/**
 * Host-only profile operations required by isolated OAuth authorization flows.
 * Implementations use Host-owned storage;
 * callers receive credentials only through the pi-ai `CredentialStore` API.
 */
export interface OpenAICodexProfileStore extends CredentialStore {
  listProfiles(): Promise<readonly CodexProfileSummary[]>
  addProfile(labelInput: string, credentialInput: OAuthCredential): Promise<CodexProfileSummary>
  removeProfile(profileId: string): Promise<void>
}

const OPENAI_PROFILE_CLAIM = 'https://api.openai.com/profile'

/**
 * Read the human-facing account name embedded by OpenAI in the OAuth access token.
 *
 * @param credential - OAuth credential containing the provider access token.
 * @returns Profile name, email fallback, or undefined when unavailable.
 */
export function openAICodexAccountName(credential: OAuthCredential): string | undefined {
  const parts = credential.access.split('.')
  if (parts.length !== 3 || parts[1] === undefined) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
    const profile = (payload as Record<string, unknown>)[OPENAI_PROFILE_CLAIM]
    if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return undefined
    for (const key of ['name', 'email']) {
      const value = (profile as Record<string, unknown>)[key]
      if (typeof value !== 'string') continue
      const normalized = value.trim().replace(/\s+/gu, ' ')
      if (normalized.length > 0) return normalized.slice(0, 80)
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Reject a credential document readable by another POSIX user. */
async function assertOwnerOnly(filename: string): Promise<void> {
  let mode: number
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    if (isENOENT(error)) return
    throw error
  }
  /* v8 ignore next -- native Windows coverage takes the mode-less branch */
  if (process.platform === 'win32') return
  /* v8 ignore start -- POSIX tests cover this branch; Windows cannot express it */
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `openai-codex: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
      + ` run "chmod 600 ${filename}" before starting again`,
    )
  }
  /* v8 ignore stop */
}

function parseCredential(raw: unknown, filename: string): StoredOAuthCredential {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`openai-codex: ${filename} credential must be an object`)
  }
  const credential = raw as Record<string, unknown>
  if (Object.keys(credential).some(key => !['type', 'access', 'refresh', 'expires', 'accountId'].includes(key))) {
    throw new Error(`openai-codex: ${filename} credential contains an unknown field`)
  }
  if (credential['type'] !== 'oauth') throw new Error(`openai-codex: ${filename} credential type must be oauth`)
  for (const key of ['access', 'refresh', 'accountId'] as const) {
    if (typeof credential[key] !== 'string' || credential[key].length === 0) {
      throw new Error(`openai-codex: ${filename} credential ${key} must be a non-empty string`)
    }
  }
  if (typeof credential['expires'] !== 'number' || !Number.isFinite(credential['expires']) || credential['expires'] <= 0) {
    throw new Error(`openai-codex: ${filename} credential expires must be a positive finite number`)
  }
  return structuredClone(credential) as StoredOAuthCredential
}

function parseProfiles(rawProfiles: unknown[], filename: string): StoredProfile[] {
  const ids = new Set<string>()
  const accountIds = new Set<string>()
  return rawProfiles.map((raw, index): StoredProfile => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`openai-codex: ${filename} profile ${index} must be an object`)
    }
    const profile = raw as Record<string, unknown>
    if (Object.keys(profile).some(key => !['id', 'label', 'credential', 'createdAt', 'updatedAt'].includes(key))) {
      throw new Error(`openai-codex: ${filename} profile ${index} contains an unknown field`)
    }
    const id = profile['id']
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`openai-codex: ${filename} profile ${index} id must be a non-empty string`)
    }
    const label = normalizeLabel(profile['label'])
    const createdAt = profile['createdAt']
    const updatedAt = profile['updatedAt']
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) {
      throw new Error(`openai-codex: ${filename} profile ${index} createdAt must be a positive finite number`)
    }
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) {
      throw new Error(`openai-codex: ${filename} profile ${index} updatedAt must be a positive finite number`)
    }
    const credential = parseCredential(profile['credential'], filename)
    if (ids.has(id)) throw new Error(`openai-codex: ${filename} contains a duplicate profile id`)
    if (accountIds.has(credential.accountId)) throw new Error(`openai-codex: ${filename} contains a duplicate account`)
    ids.add(id)
    accountIds.add(credential.accountId)
    return {
      id,
      label,
      credential,
      createdAt,
      updatedAt,
    }
  })
}

/** Validate the strict JSON document without quoting token-bearing input. */
function parseDocument(text: string, filename: string): AuthDocument {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`openai-codex: ${filename} is not valid JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`openai-codex: ${filename} must contain an object`)
  }
  const rawDocument = value as Record<string, unknown>
  if (rawDocument['version'] === LEGACY_PROFILE_FORMAT_VERSION) {
    if (Object.keys(rawDocument).some(key => !['version', 'activeProfileId', 'profiles'].includes(key))) {
      throw new Error(`openai-codex: ${filename} contains an unknown top-level field`)
    }
    if (!Array.isArray(rawDocument['profiles'])) {
      throw new Error(`openai-codex: ${filename} profiles must be an array`)
    }
    const activeProfileId = rawDocument['activeProfileId']
    if (activeProfileId !== undefined && typeof activeProfileId !== 'string') {
      throw new Error(`openai-codex: ${filename} activeProfileId must be a string`)
    }
    const profiles = parseProfiles(rawDocument['profiles'], filename)
    if (activeProfileId !== undefined && !profiles.some(profile => profile.id === activeProfileId)) {
      throw new Error(`openai-codex: ${filename} active profile does not exist`)
    }
    if (profiles.length > 0 && activeProfileId === undefined) {
      throw new Error(`openai-codex: ${filename} must select an active profile`)
    }
    if (activeProfileId !== undefined) {
      const activeIndex = profiles.findIndex(profile => profile.id === activeProfileId)
      const [activeProfile] = profiles.splice(activeIndex, 1)
      if (activeProfile !== undefined) profiles.unshift(activeProfile)
    }
    return { version: AUTH_FORMAT_VERSION, profiles }
  }
  if (rawDocument['version'] !== AUTH_FORMAT_VERSION) {
    throw new Error(`openai-codex: ${filename} has unsupported auth format version ${String(rawDocument['version'])}`)
  }
  if (Object.keys(rawDocument).some(key => !['version', 'profiles'].includes(key))) {
    throw new Error(`openai-codex: ${filename} contains an unknown top-level field`)
  }
  if (!Array.isArray(rawDocument['profiles'])) {
    throw new Error(`openai-codex: ${filename} profiles must be an array`)
  }
  return {
    version: AUTH_FORMAT_VERSION,
    profiles: parseProfiles(rawDocument['profiles'], filename),
  }
}

function parseLegacyDocument(text: string, filename: string): StoredOAuthCredential {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`openai-codex: ${filename} is not valid JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`openai-codex: ${filename} must contain an object`)
  }
  const document = value as Record<string, unknown>
  if (document['version'] !== LEGACY_AUTH_FORMAT_VERSION || Object.keys(document).some(key => !['version', 'credential'].includes(key))) {
    throw new Error(`openai-codex: ${filename} is not a supported legacy auth document`)
  }
  return parseCredential(document['credential'], filename)
}

function normalizeLabel(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('openai-codex: profile label must be a string')
  const label = raw.trim()
  if (label.length === 0) throw new Error('openai-codex: profile label must not be empty')
  if (label.length > 80) throw new Error('openai-codex: profile label must be at most 80 characters')
  return label
}

function cloneCredential(credential: OAuthCredential): OAuthCredential {
  return structuredClone(credential)
}

function emptyDocument(): AuthDocument {
  return { version: AUTH_FORMAT_VERSION, profiles: [] }
}

interface SessionProfileReplacement {
  readonly profileId: string
  readonly replaced: boolean
}

/**
 * Resolve the default OAuth profile document path.
 * @param dshHome - Optional DSH home override.
 * @returns Absolute profile document path.
 */
export function openAICodexAuthPath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), OPENAI_CODEX_AUTH_FILENAME))
}

/** File-backed pi-ai store with ordered profiles and quota-checked Session bindings. */
export class OpenAICodexCredentialStore implements OpenAICodexProfileStore {
  /** Absolute path of the owned profile document. */
  readonly filename: string
  private readonly sessionBindings = new Map<string, string>()

  constructor(
    filename: string = openAICodexAuthPath(),
    private readonly resolveSessionId?: () => string | undefined,
  ) {
    this.filename = resolve(filename)
  }

  private async readDocument(): Promise<AuthDocument> {
    await assertOwnerOnly(this.filename)
    let text: string
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (isENOENT(error)) return this.readLegacyDocument()
      throw error
    }
    return parseDocument(text, this.filename)
  }

  private async readLegacyDocument(): Promise<AuthDocument> {
    const legacyFilename = join(dirname(this.filename), LEGACY_OPENAI_CODEX_AUTH_FILENAME)
    await assertOwnerOnly(legacyFilename)
    let text: string
    let modifiedAt: number
    try {
      text = await readFile(legacyFilename, 'utf8')
      modifiedAt = Math.max(1, Math.floor((await stat(legacyFilename)).mtimeMs))
    } catch (error) {
      if (isENOENT(error)) return emptyDocument()
      throw error
    }
    const credential = parseLegacyDocument(text, legacyFilename)
    const profile: StoredProfile = {
      id: `legacy-${createHash('sha256').update(credential.accountId).digest('hex').slice(0, 24)}`,
      label: 'Imported account',
      credential,
      createdAt: modifiedAt,
      updatedAt: modifiedAt,
    }
    return { version: AUTH_FORMAT_VERSION, profiles: [profile] }
  }

  private async transaction<T>(fn: (document: AuthDocument) => Promise<T> | T): Promise<T> {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    return withFileLock(this.filename, async () => {
      const document = await this.readDocument()
      const result = await fn(document)
      const validated = parseDocument(JSON.stringify(document), this.filename)
      await writeFileAtomic(this.filename, `${JSON.stringify(validated, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
      return result
    })
  }

  private resolveProfileId(document: AuthDocument): string | undefined {
    const sessionId = this.resolveSessionId?.()
    if (sessionId !== undefined) {
      const bound = this.sessionBindings.get(sessionId)
      if (bound !== undefined && document.profiles.some(profile => profile.id === bound)) return bound
      const firstProfileId = document.profiles[0]?.id
      if (firstProfileId !== undefined) this.sessionBindings.set(sessionId, firstProfileId)
      return firstProfileId
    }
    return document.profiles[0]?.id
  }

  private summary(profile: StoredProfile): CodexProfileSummary {
    return {
      id: profile.id,
      label: openAICodexAccountName(profile.credential) ?? profile.label,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    }
  }

  /**
   * List every stored profile without credentials.
   * @returns Secret-free summaries for every stored profile.
   */
  async listProfiles(): Promise<readonly CodexProfileSummary[]> {
    const document = await this.readDocument()
    return document.profiles.map(profile => this.summary(profile))
  }

  /**
   * Read a valid in-memory profile binding for one Session.
   * @param sessionId - Session whose binding is requested.
   * @returns Bound profile id, or undefined before allocation or after removal.
   */
  async sessionProfileId(sessionId: string): Promise<string | undefined> {
    const profileId = this.sessionBindings.get(sessionId)
    if (profileId === undefined) return undefined
    if ((await this.readDocument()).profiles.some(profile => profile.id === profileId)) return profileId
    this.sessionBindings.delete(sessionId)
    return undefined
  }

  /**
   * Commit the first valid profile binding for one Session.
   * @param sessionId - Session receiving a profile binding.
   * @param profileId - Ordered profile selected by the allocator.
   * @returns The binding retained for the Session.
   */
  async bindSessionProfile(sessionId: string, profileId: string): Promise<string> {
    const document = await this.readDocument()
    const existing = this.sessionBindings.get(sessionId)
    if (existing !== undefined && document.profiles.some(profile => profile.id === existing)) return existing
    if (!document.profiles.some(profile => profile.id === profileId)) {
      throw new Error(`openai-codex: profile does not exist: ${profileId}`)
    }
    this.sessionBindings.set(sessionId, profileId)
    return profileId
  }

  /**
   * Replace one Session binding only while the inspected profile remains current.
   * @param sessionId - Session whose binding may be replaced.
   * @param expectedProfileId - Profile observed before quota inspection.
   * @param profileId - Replacement selected by the allocator.
   * @returns The committed binding and whether this call replaced it, or undefined after invalidation.
   */
  async replaceSessionProfile(
    sessionId: string,
    expectedProfileId: string,
    profileId: string,
  ): Promise<SessionProfileReplacement | undefined> {
    const document = await this.readDocument()
    const existing = this.sessionBindings.get(sessionId)
    if (existing !== expectedProfileId) {
      if (existing !== undefined && document.profiles.some(profile => profile.id === existing)) {
        return { profileId: existing, replaced: false }
      }
      this.sessionBindings.delete(sessionId)
      return undefined
    }
    if (!document.profiles.some(profile => profile.id === profileId)) {
      throw new Error(`openai-codex: profile does not exist: ${profileId}`)
    }
    this.sessionBindings.set(sessionId, profileId)
    return { profileId, replaced: profileId !== expectedProfileId }
  }

  /**
   * Add one unique OAuth account profile.
   * @param labelInput - Human-facing profile label.
   * @param credentialInput - OAuth credential retained only by the Host.
   * @returns Secret-free summary of the added profile.
   */
  async addProfile(labelInput: string, credentialInput: OAuthCredential): Promise<CodexProfileSummary> {
    const label = normalizeLabel(labelInput)
    const credential = parseCredential(credentialInput, this.filename)
    return this.transaction((document) => {
      if (document.profiles.some(profile => profile.credential.accountId === credential.accountId)) {
        throw new Error('openai-codex: account already exists in another profile')
      }
      const now = Date.now()
      const profile: StoredProfile = {
        id: randomUUID(),
        label,
        credential,
        createdAt: now,
        updatedAt: now,
      }
      document.profiles.push(profile)
      return this.summary(profile)
    })
  }

  /**
   * Add one local OAuth account, or refresh the credential for its existing profile.
   * Existing profile identity, label, order, creation time, and Session bindings stay intact.
   * @param labelInput - Human-facing label used only when a new profile is created.
   * @param credentialInput - OAuth credential retained only by the Host.
   * @returns Secret-free summary of the added or refreshed profile.
   */
  async addOrRefreshProfile(labelInput: string, credentialInput: OAuthCredential): Promise<CodexProfileSummary> {
    const label = normalizeLabel(labelInput)
    const credential = parseCredential(credentialInput, this.filename)
    return this.transaction((document) => {
      const existing = document.profiles.find(profile => profile.credential.accountId === credential.accountId)
      if (existing !== undefined) {
        existing.credential = credential
        existing.updatedAt = Date.now()
        return this.summary(existing)
      }
      const now = Date.now()
      const profile: StoredProfile = {
        id: randomUUID(),
        label,
        credential,
        createdAt: now,
        updatedAt: now,
      }
      document.profiles.push(profile)
      return this.summary(profile)
    })
  }

  /**
   * Make one profile the first candidate for every allocation decision.
   * @param profileId - Profile to move to the front of the stored order.
   */
  async prioritizeProfile(profileId: string): Promise<void> {
    await this.transaction((document) => {
      const index = document.profiles.findIndex(profile => profile.id === profileId)
      if (index === -1) throw new Error(`openai-codex: profile does not exist: ${profileId}`)
      if (index === 0) return
      const [profile] = document.profiles.splice(index, 1)
      if (profile === undefined) throw new Error(`openai-codex: profile does not exist: ${profileId}`)
      document.profiles.unshift(profile)
    })
  }

  /**
   * Rename one profile.
   * @param profileId - Profile to rename.
   * @param labelInput - New human-facing label.
   */
  async renameProfile(profileId: string, labelInput: string): Promise<void> {
    const label = normalizeLabel(labelInput)
    await this.transaction((document) => {
      const profile = document.profiles.find(candidate => candidate.id === profileId)
      if (profile === undefined) throw new Error(`openai-codex: profile does not exist: ${profileId}`)
      profile.label = label
      profile.updatedAt = Date.now()
    })
  }

  /**
   * Remove one stored profile and its credential.
   * @param profileId - Profile and credential to remove.
   */
  async removeProfile(profileId: string): Promise<void> {
    await this.transaction((document) => {
      const index = document.profiles.findIndex(profile => profile.id === profileId)
      if (index === -1) throw new Error(`openai-codex: profile does not exist: ${profileId}`)
      document.profiles.splice(index, 1)
      for (const [sessionId, boundProfileId] of this.sessionBindings) {
        if (boundProfileId === profileId) this.sessionBindings.delete(sessionId)
      }
    })
  }

  /**
   * Scope credential operations to one profile.
   * @param profileId - Profile bound to the returned store.
   * @returns pi-ai credential store facade.
   */
  forProfile(profileId: string): CredentialStore {
    return new ScopedCredentialStore(this, profileId)
  }

  /**
   * Read one profile credential for Host-only provider work.
   * @param profileId - Profile to read.
   * @returns Detached OAuth credential, or undefined when absent.
   */
  async readProfileCredential(profileId: string): Promise<OAuthCredential | undefined> {
    const profile = (await this.readDocument()).profiles.find(candidate => candidate.id === profileId)
    return profile === undefined ? undefined : cloneCredential(profile.credential)
  }

  /**
   * Read only the provider account identifier needed for Host-side identity coordination.
   * Tokens remain inside the credential store.
   */
  async readProfileProviderAccountId(profileId: string): Promise<string | undefined> {
    return (await this.readDocument()).profiles.find(candidate => candidate.id === profileId)?.credential.accountId
  }

  /**
   * Atomically update one profile credential.
   * @param profileId - Profile to update.
   * @param fn - Credential transformation applied inside the transaction.
   * @returns Detached resulting credential.
   */
  async modifyProfileCredential(
    profileId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.transaction(async (document) => {
      const profile = document.profiles.find(candidate => candidate.id === profileId)
      if (profile === undefined) throw new Error(`openai-codex: profile does not exist: ${profileId}`)
      const candidate = await fn(cloneCredential(profile.credential))
      if (candidate === undefined) return cloneCredential(profile.credential)
      profile.credential = parseCredential(candidate, this.filename)
      profile.updatedAt = Date.now()
      return cloneCredential(profile.credential)
    })
  }

  /** @inheritdoc */
  async read(providerId: string): Promise<Credential | undefined> {
    if (providerId !== OPENAI_CODEX_PROVIDER) return undefined
    const document = await this.readDocument()
    const profileId = this.resolveProfileId(document)
    const profile = document.profiles.find(candidate => candidate.id === profileId)
    return profile === undefined ? undefined : cloneCredential(profile.credential)
  }

  /** @inheritdoc */
  async list(): Promise<readonly CredentialInfo[]> {
    const credential = await this.read(OPENAI_CODEX_PROVIDER)
    return credential === undefined
      ? []
      : [{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }]
  }

  /** @inheritdoc */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId !== OPENAI_CODEX_PROVIDER) {
      throw new Error(`openai-codex: credential store does not own provider "${providerId}"`)
    }
    return this.transaction(async (document) => {
      let profileId = this.resolveProfileId(document)
      let profile = document.profiles.find(candidate => candidate.id === profileId)
      const candidate = await fn(profile === undefined ? undefined : cloneCredential(profile.credential))
      if (candidate === undefined) return profile === undefined ? undefined : cloneCredential(profile.credential)
      const credential = parseCredential(candidate, this.filename)
      const now = Date.now()
      if (profile === undefined) {
        profile = {
          id: randomUUID(),
          label: 'Default',
          credential,
          createdAt: now,
          updatedAt: now,
        }
        document.profiles.push(profile)
        profileId = profile.id
        const sessionId = this.resolveSessionId?.()
        if (sessionId !== undefined) this.sessionBindings.set(sessionId, profileId)
      } else {
        profile.credential = credential
        profile.updatedAt = now
      }
      return cloneCredential(profile.credential)
    })
  }

  /** Delete the profile resolved for the current Session or global priority. */
  async delete(providerId: string): Promise<void> {
    if (providerId !== OPENAI_CODEX_PROVIDER) return
    const document = await this.readDocument()
    const profileId = this.resolveProfileId(document)
    if (profileId !== undefined) await this.removeProfile(profileId)
  }
}

/** Provider store scoped to one profile for quota reads and token refresh. */
class ScopedCredentialStore implements CredentialStore {
  constructor(
    private readonly parent: OpenAICodexCredentialStore,
    private readonly profileId: string,
  ) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === OPENAI_CODEX_PROVIDER
      ? this.parent.readProfileCredential(this.profileId)
      : undefined
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return await this.read(OPENAI_CODEX_PROVIDER) === undefined
      ? []
      : [{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }]
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId !== OPENAI_CODEX_PROVIDER) {
      throw new Error(`openai-codex: credential store does not own provider "${providerId}"`)
    }
    return this.parent.modifyProfileCredential(this.profileId, fn)
  }

  async delete(providerId: string): Promise<void> {
    if (providerId === OPENAI_CODEX_PROVIDER) await this.parent.removeProfile(this.profileId)
  }
}
