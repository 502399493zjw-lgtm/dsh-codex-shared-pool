/** Shared browser store for the plugin's Responses API preferences. */

import type { ResponseApiPreferences } from '../shared/types.ts'

const RESPONSE_API_PATH = '/plugins/dsh-openai-codex/response-api'

let snapshot: ResponseApiPreferences | undefined
let pending: Promise<ResponseApiPreferences> | undefined
const listeners = new Set<() => void>()

function commit(value: ResponseApiPreferences): ResponseApiPreferences {
  snapshot = value
  for (const listener of listeners) listener()
  return value
}

async function request(method = 'GET', body?: unknown): Promise<ResponseApiPreferences> {
  const response = await fetch(RESPONSE_API_PATH, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...body === undefined ? {} : { 'content-type': 'application/json' },
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null
      && 'error' in value && typeof value.error === 'string'
      ? value.error
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return value as ResponseApiPreferences
}

/**
 * React external-store snapshot used by every Fast-mode surface.
 * @returns Last authoritative preferences, or undefined before loading.
 */
export function responsePreferencesSnapshot(): ResponseApiPreferences | undefined {
  return snapshot
}

/**
 * Subscribe to preference updates made from the menu or Settings.
 * @param listener - Callback invoked after authoritative state changes.
 * @returns Subscription disposer.
 */
export function subscribeResponsePreferences(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Load once per browser runtime, de-duplicating concurrent model-trigger requests.
 * @returns Authoritative server preferences.
 */
export function loadResponsePreferences(): Promise<ResponseApiPreferences> {
  if (snapshot !== undefined) return Promise.resolve(snapshot)
  if (pending !== undefined) return pending
  pending = request().then(commit).finally(() => { pending = undefined })
  return pending
}

/**
 * Persist a patch and publish the authoritative server response.
 * @param patch - Preference fields to update.
 * @returns Authoritative server preferences after the update.
 */
export async function updateResponsePreferences(
  patch: Partial<ResponseApiPreferences>,
): Promise<ResponseApiPreferences> {
  return commit(await request('POST', patch))
}

/** Test-only reset; kept explicit so state cannot leak across Vitest cases. */
export function resetResponsePreferencesForTests(): void {
  snapshot = undefined
  pending = undefined
  listeners.clear()
}
