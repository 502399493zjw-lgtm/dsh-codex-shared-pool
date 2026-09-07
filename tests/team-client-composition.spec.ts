import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import WebRuntime from '@deepseek-ai/dsh-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as OpenAICodex from '../src/index.ts'

let context: Context
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-team-composition-'))
  vi.stubEnv('DSH_HOME', root)
  context = new Context()
  await context.plugin(LlmRuntime)
  await context.plugin(WebRuntime)
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network request') }))
})

afterEach(async () => {
  await context.fiber.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

async function provideCredentials() {
  return context.plugin({
    name: 'test-team-credentials',
    apply(ctx: Context) {
      ctx.provide('credentials', { resolve: async () => undefined } as never)
    },
  })
}

async function streamError(): Promise<string> {
  try {
    const chunks = []
    for await (const chunk of context.llm.stream({
      provider: 'openai-codex', model: 'gpt-5.6-sol', sessionId: 'composition-test' as never,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
      })],
    })) chunks.push(chunk)
    return JSON.stringify(chunks)
  } catch (error) {
    return String(error)
  }
}

describe('Team client credential service lifecycle', () => {
  it('keeps credentials optional for a Host that has only local accounts', async () => {
    await context.plugin(OpenAICodex)
    const listProfiles = vi.spyOn(context.openAICodex.credentials, 'listProfiles')
    expect(await streamError()).not.toContain('DSH credential service is required for Team client mode')
    expect(listProfiles).toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['before', 'after'] as const)('fails closed when credentials loaded %s the plugin disappear before the first model call', async (timing) => {
    const initial = timing === 'before' ? await provideCredentials() : undefined
    await context.plugin(OpenAICodex)
    const provider = initial ?? await provideCredentials()
    expect(context.get('credentials')).toBeDefined()
    await provider.dispose()
    expect(context.get('credentials')).toBeUndefined()
    const listProfiles = vi.spyOn(context.openAICodex.credentials, 'listProfiles')
    expect(await streamError()).toContain('DSH credential service is required for Team client mode')
    expect(listProfiles).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not use local accounts for explicit Team mode without credentials', async () => {
    await context.plugin(OpenAICodex, {
      teamClient: { enabled: true, baseUrl: 'https://pool.example.test/plugins/dsh-codex-shared-pool/team' },
    })
    const listProfiles = vi.spyOn(context.openAICodex.credentials, 'listProfiles')
    const error = await streamError()
    expect(error).toContain('DSH credential service is required for Team client mode')
    expect(listProfiles).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
