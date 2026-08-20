import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadResponsePreferences,
  resetResponsePreferencesForTests,
  responsePreferencesSnapshot,
  subscribeResponsePreferences,
  updateResponsePreferences,
} from '../src/client/response-preferences.ts'

afterEach(() => {
  resetResponsePreferencesForTests()
  vi.unstubAllGlobals()
})

describe('shared Responses API preferences', () => {
  it('de-duplicates loads and publishes Fast-mode updates to the model trigger', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ useFastMode: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ useFastMode: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const listener = vi.fn()
    const unsubscribe = subscribeResponsePreferences(listener)

    const [first, second] = await Promise.all([
      loadResponsePreferences(),
      loadResponsePreferences(),
    ])
    expect(first.useFastMode).toBe(false)
    expect(second.useFastMode).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)

    await updateResponsePreferences({ useFastMode: true })
    expect(responsePreferencesSnapshot()?.useFastMode).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenLastCalledWith(
      '/plugins/dsh-openai-codex/response-api',
      expect.objectContaining({ method: 'POST', body: '{"useFastMode":true}' }),
    )
    unsubscribe()
  })
})
