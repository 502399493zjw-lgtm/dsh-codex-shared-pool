/** Host-only Team client configuration and Codex bearer compatibility. */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { TEAM_PATH_PREFIX } from './types.ts'

const TEAM_CODEX_BEARER_HEADER = Buffer.from(JSON.stringify({
  alg: 'none',
  typ: 'JWT',
  dsh: 'team-client-v1',
})).toString('base64url')

const TEAM_CODEX_BEARER_PAYLOAD = Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'dsh-team-client' },
})).toString('base64url')

const MAX_TEAM_API_KEY_LENGTH = 4_096

export interface TeamClientConfig {
  readonly enabled?: boolean
  /** Complete Team base URL ending in the plugin's `/team` path. */
  readonly baseUrl?: string
  /** DSH credential reference containing this member's one-time Team API key. */
  readonly apiKeyRef?: string
}

export const TeamClientConfigSchema: z<TeamClientConfig> = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().default(''),
  apiKeyRef: z.string().default('DSH_CODEX_SHARED_POOL_TEAM_API_KEY'),
})

export const DEFAULT_TEAM_CLIENT_API_KEY_REF = credentialRef('DSH_CODEX_SHARED_POOL_TEAM_API_KEY')

/** Validate a Host-adminured Team endpoint before any secret can be sent to it. */
export function resolveTeamClientBaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error('Team client base URL is required when Team client mode is enabled')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Team client base URL must be an absolute URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('Team client base URL must not contain credentials')
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error('Team client base URL must not contain a query or fragment')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error('Team client base URL must use HTTPS except for loopback development')
  }
  const pathname = url.pathname.replace(/\/+$/u, '')
  if (pathname !== TEAM_PATH_PREFIX) {
    throw new Error(`Team base URL must end in ${TEAM_PATH_PREFIX}`)
  }
  return `${url.origin}${TEAM_PATH_PREFIX}`
}

/** Codex-native route derived from the validated Team base URL. */
export function teamClientResponsesUrl(baseUrl: string): string {
  return `${resolveTeamClientBaseUrl(baseUrl)}/codex/responses`
}

/** Resolve the current Team key for every operation, then adapt it to pi-ai's JWT-shaped Codex seam. */
export async function resolveTeamClientApiKey(
  config: Pick<TeamClientConfig, 'apiKeyRef'>,
  credentials: Pick<CredentialProvider, 'resolve'>,
): Promise<string> {
  const ref: CredentialRef = config.apiKeyRef === undefined
    ? DEFAULT_TEAM_CLIENT_API_KEY_REF
    : credentialRef(config.apiKeyRef)
  const value = (await credentials.resolve(ref))?.value
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Team API key credential ${String(ref)} is not configured`)
  }
  return createTeamCodexBearer(value)
}

/**
 * Preserve a Team key as the bearer authority while satisfying the Codex
 * provider's local, unverified account-id JWT projection. The wrapper is not
 * an authentication JWT: the server unwraps it and verifies the original
 * opaque key hash exactly as it does for direct clients.
 */
export function createTeamCodexBearer(teamApiKey: string): string {
  validateTeamApiKey(teamApiKey)
  return `${TEAM_CODEX_BEARER_HEADER}.${TEAM_CODEX_BEARER_PAYLOAD}.${Buffer.from(teamApiKey).toString('base64url')}`
}

/** Recover only wrappers emitted by {@link createTeamCodexBearer}. */
export function unwrapTeamCodexBearer(value: string): string | undefined {
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== TEAM_CODEX_BEARER_HEADER || parts[1] !== TEAM_CODEX_BEARER_PAYLOAD) {
    return undefined
  }
  const encoded = parts[2]
  if (encoded === undefined || encoded.length === 0) return undefined
  let decoded: string
  try {
    const bytes = Buffer.from(encoded, 'base64url')
    if (bytes.toString('base64url') !== encoded) return undefined
    decoded = bytes.toString('utf8')
  } catch {
    return undefined
  }
  try {
    validateTeamApiKey(decoded)
    return decoded
  } catch {
    return undefined
  }
}

function validateTeamApiKey(value: string): void {
  if (value.length < 16 || value.length > MAX_TEAM_API_KEY_LENGTH || /\s/u.test(value)) {
    throw new Error('Team API key is invalid')
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
}
