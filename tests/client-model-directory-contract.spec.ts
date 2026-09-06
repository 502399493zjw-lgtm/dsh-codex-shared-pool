import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as cordis from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { describe, expect, it, vi } from 'vitest'

// Rendering is outside this service-contract test. Keep the real plugin's
// apply/slot injection, Cordis tracing, and published model resolver intact.
vi.mock('../src/client/CodexSubscriptionPoolSettings.tsx', () => ({ CodexSubscriptionPoolSettings: () => null }))
vi.mock('../src/client/ImagegenToolView.tsx', () => ({ ImagegenToolView: () => null }))
vi.mock('../src/client/CodexModelSelect.tsx', () => ({ CodexModelSelect: () => null }))
vi.mock('../src/client/quota/index.ts', () => ({ apply: () => undefined }))

import * as client from '../src/client/index.tsx'

function snapshotStore<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const set = (next: T) => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    set,
    update: (update: (draft: T) => void) => {
      const draft = structuredClone(snapshot)
      update(draft)
      set(draft)
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

function publishedModelResolver() {
  const require = createRequire(import.meta.url)
  const source = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-model-selection/client'), 'utf8')
  let exported: typeof import('@deepseek-ai/dsh-client-ui-model-selection/client') | undefined
  const modules: Record<string, unknown> = {
    '@deepseek-ai/cordis': cordis,
    '@deepseek-ai/dsh-client-store': { createSnapshotStore: snapshotStore },
    'react': React,
    'react/jsx-runtime': jsxRuntime,
    '@deepseek-ai/dsh-client-ui-primitives': {},
  }
  // Published browser entries are ModuleLoader factories, not native ESM.
  // Execute the installed release's resolver rather than copying its behavior.
  new Function('window', source)({
    __ModuleLoader__: {
      load: ({ factory }: { factory: (require: (id: string) => unknown) => typeof exported }) => {
        exported = factory(id => {
          if (!(id in modules)) throw new Error(`unexpected browser dependency: ${id}`)
          return modules[id]
        })
      },
    },
  })
  if (exported === undefined) throw new Error('published model-selection factory did not load')
  return exported.ModelDirectoryResolver
}

describe('published model directory service boundary', () => {
  it('creates and selects a fresh session directory from our actual model slot', async () => {
    const ctx = new cordis.Context()
    const sessionId = 'model-contract-session' as SessionId
    const selection = { provider: 'openai-codex', model: 'gpt-5.4' }
    const selectModel = vi.fn(async () => ({ ok: true, value: undefined }))
    const projected = snapshotStore({ next: selection })
    const catalog = {
      default: selection,
      routableProviders: ['openai-codex'],
      groups: [{ id: 'openai-codex', name: 'OpenAI Codex', models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }] }],
      failures: [],
    }
    class Remote extends cordis.Service {
      constructor(context: cordis.Context) { super(context, 'remote') }
      $on() { return () => undefined }
    }
    class RemoteSessions extends cordis.Service {
      constructor(context: cordis.Context) { super(context, 'remote.session') }
      modelCatalog() { return Promise.resolve({ ok: true, value: catalog }) }
      selectModel = selectModel
    }
    type ModelSlotFace = {
      available: boolean
      directory: ReturnType<typeof snapshotStore>
      load: () => void
      select: (selection: typeof catalog.default) => Promise<boolean>
    }
    let injectModel: ((id: SessionId) => ModelSlotFace) | undefined
    ctx.provide('slots', {
      inject: (_name: string, register: () => unknown) => register(),
      register: (options: { name: string; inject: typeof injectModel }) => {
        if (options.name === 'conversation.input.model') injectModel = options.inject
        return () => undefined
      },
    })
    ctx.provide('locale', { register: () => () => undefined, bind: () => (key: string) => key })
    ctx.provide('sessions', {
      scope: () => ctx,
      binding: () => ({ session: { projections: { faceOf: () => projected } } }),
      subagentAddress: () => undefined,
    })
    try {
      await ctx.plugin(Remote)
      await ctx.plugin(RemoteSessions)
      await ctx.plugin(publishedModelResolver(), { blockReason: () => 'unavailable' })
      await ctx.plugin(client)

      expect(injectModel).toBeTypeOf('function')
      // The old declaration throws here: cannot get property "remote.session"
      // without inject. An already-populated stock directory masks the defect.
      const face = injectModel!(sessionId)
      expect(face.available).toBe(true)
      face.load()
      await expect(face.select(selection)).resolves.toBe(true)
      expect(selectModel).toHaveBeenCalledWith({ sessionId, ...selection })
      expect(face.directory.getSnapshot()).toMatchObject({ current: selection, status: 'ready' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
