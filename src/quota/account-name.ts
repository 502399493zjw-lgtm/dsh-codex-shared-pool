/** Credential-safe extraction of the OpenAI account label used by Settings. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const OPENAI_PROFILE_CLAIM = 'https://api.openai.com/profile'
const MAX_CODEX_AUTH_BYTES = 64 * 1024

/**
 * Read the human-facing account name embedded by OpenAI in an OAuth access token.
 * @param accessToken - Unknown access-token field from the local Codex auth document.
 * @returns The normalized name, then email, or undefined when neither is usable.
 */
export function openAICodexAccountName(accessToken: unknown): string | undefined {
  if (typeof accessToken !== 'string') return undefined
  const parts = accessToken.split('.')
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

/**
 * Read only the display name claim from one Codex home's local auth document.
 * @param accountHome - Absolute Codex home owned by the Host.
 * @returns The Settings-compatible account name, or undefined for a safe app-server fallback.
 */
export async function readOpenAICodexAccountName(accountHome: string): Promise<string | undefined> {
  let text: string
  try {
    text = await readFile(join(accountHome, 'auth.json'), 'utf8')
  } catch {
    return undefined
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_CODEX_AUTH_BYTES) return undefined
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined
  const tokens = (document as Record<string, unknown>).tokens
  if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) return undefined
  return openAICodexAccountName((tokens as Record<string, unknown>).access_token)
}
