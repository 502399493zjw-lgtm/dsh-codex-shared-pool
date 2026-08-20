import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import type { OpenAICodexService } from '../src/service.ts'
import { installOpenAICodexTui } from '../src/tui.ts'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}))

interface TuiHarness {
  readonly service: OpenAICodexService
  readonly run: (rawInput: string) => Promise<CommandResult>
  readonly rootCompletions: () => readonly string[]
}

function createHarness(): TuiHarness {
  let command: CommandDefinition | undefined
  let commandTree: { children(path: readonly string[]): readonly { name: string }[] } | undefined
  const service = {
    authStatus: vi.fn(async () => ({ authenticated: true, expiresAt: new Date('2030-01-01T00:00:00.000Z') })),
    login: vi.fn(async () => undefined),
    loginProfile: vi.fn(async () => ({ id: 'profile-3', label: 'Third', createdAt: 3, updatedAt: 3 })),
    logout: vi.fn(async () => undefined),
    usage: vi.fn(async () => ({ rateLimits: [] })),
    listProfiles: vi.fn(async () => [
      { id: 'profile-1', label: 'Personal', createdAt: 1, updatedAt: 1 },
      { id: 'profile-2', label: 'Work', createdAt: 2, updatedAt: 2 },
    ]),
    prioritizeProfile: vi.fn(async () => undefined),
    renameProfile: vi.fn(async () => undefined),
    removeProfile: vi.fn(async () => undefined),
    imagePreferences: vi.fn(() => ({ modifyReadImage: true, shareImagegenWithOtherModels: true })),
    responsePreferences: vi.fn(() => ({ useFastMode: false, useWebSocketContextReuse: false, useNativeCompaction: false })),
    updateImagePreferences: vi.fn(async () => ({ modifyReadImage: true, shareImagegenWithOtherModels: true })),
    updateResponsePreferences: vi.fn(async () => ({ useFastMode: false, useWebSocketContextReuse: false, useNativeCompaction: false })),
  } as unknown as OpenAICodexService
  const disposers: Array<() => Promise<void> | void> = []
  const context = {
    openAICodex: service,
    commands: {
      register(definition: CommandDefinition) {
        command = definition
        return () => undefined
      },
    },
    tuiCommandTrees: {
      register(tree: { children(path: readonly string[]): readonly { name: string }[] }) {
        commandTree = tree
        return () => undefined
      },
    },
    inject(_dependencies: readonly string[], callback: (ctx: Context) => unknown) {
      return callback(context as unknown as Context)
    },
    effect(register: () => (() => Promise<void> | void)) {
      const dispose = register()
      disposers.push(dispose)
      return dispose
    },
  }
  installOpenAICodexTui(context as unknown as Context)
  if (command === undefined) throw new Error('Codex command was not registered')
  return {
    service,
    run: rawInput => Promise.resolve(command!.handler({
      rawInput,
      signal: new AbortController().signal,
    } as Parameters<CommandDefinition['handler']>[0])),
    rootCompletions: () => commandTree?.children(['codex']).map(item => item.name) ?? [],
  }
}

describe('OpenAI Codex TUI profile management', () => {
  it('lists only secret-free ordered profile metadata', async () => {
    const { run, rootCompletions } = createHarness()

    await expect(run('profiles')).resolves.toEqual({
      kind: 'success',
      text: '* profile-1: Personal\n- profile-2: Work',
    })
    expect(rootCompletions()).toEqual(expect.arrayContaining([
      'profiles', 'add', 'cancel', 'activate', 'rename', 'remove',
    ]))
  })

  it('prioritizes, renames, and removes exact profiles', async () => {
    const { run, service } = createHarness()

    await expect(run('activate profile-2')).resolves.toEqual({
      kind: 'success',
      text: 'Codex profile profile-2 now has global priority.',
    })
    await expect(run('rename profile-2 Work Account')).resolves.toEqual({
      kind: 'success',
      text: 'Renamed Codex profile profile-2 to Work Account.',
    })
    await expect(run('remove profile-2')).resolves.toEqual({
      kind: 'success',
      text: 'Removed Codex profile profile-2.',
    })

    expect(service.prioritizeProfile).toHaveBeenCalledWith('profile-2')
    expect(service.renameProfile).toHaveBeenCalledWith('profile-2', 'Work Account')
    expect(service.removeProfile).toHaveBeenCalledWith('profile-2')
  })

  it('rejects incomplete profile commands without touching storage', async () => {
    const { run, service } = createHarness()

    expect((await run('activate')).kind).toBe('error')
    expect((await run('rename profile-2')).kind).toBe('error')
    expect((await run('remove profile-2 extra')).kind).toBe('error')
    expect(service.prioritizeProfile).not.toHaveBeenCalled()
    expect(service.renameProfile).not.toHaveBeenCalled()
    expect(service.removeProfile).not.toHaveBeenCalled()
  })

  it('starts one isolated profile login and cancels the shared in-flight operation', async () => {
    const { run, service } = createHarness()
    vi.mocked(service.loginProfile).mockImplementation(async (interaction: AuthInteraction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.test/codex' })
      await new Promise<void>((_resolve, reject) => {
        interaction.signal?.addEventListener('abort', () => reject(interaction.signal?.reason), { once: true })
      })
      throw new Error('unreachable')
    })

    const first = await run('add')
    const second = await run('add')

    expect(first).toEqual({
      kind: 'success',
      text: 'Opened the ChatGPT authorization page. Use /codex status after approval.',
    })
    expect(second).toEqual(first)
    expect(service.loginProfile).toHaveBeenCalledTimes(1)
    expect(service.login).not.toHaveBeenCalled()
    await expect(run('cancel')).resolves.toEqual({ kind: 'success', text: 'OpenAI Codex sign-in cancelled.' })
    await expect(run('cancel')).resolves.toEqual({ kind: 'success', text: 'No OpenAI Codex sign-in is active.' })
  })

  it('rejects extra add/cancel arguments and redacts profile-operation failures', async () => {
    const { run, service } = createHarness()
    vi.mocked(service.prioritizeProfile).mockRejectedValueOnce(
      new Error('provider refused Authorization: Bearer opaque-provider-token'),
    )

    expect((await run('add unexpected')).kind).toBe('error')
    expect((await run('cancel unexpected')).kind).toBe('error')
    expect(service.loginProfile).not.toHaveBeenCalled()

    const result = await run('activate profile-2')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('[redacted]')
    expect(result.text).not.toContain('opaque-provider-token')
  })

  it('does not claim logout signed out when another profile becomes active', async () => {
    const { run, service } = createHarness()

    await expect(run('logout')).resolves.toEqual({
      kind: 'success',
      text: 'Removed the active Codex profile; 2 stored profiles remain.',
    })
    expect(service.logout).toHaveBeenCalledOnce()

    vi.mocked(service.listProfiles).mockResolvedValueOnce([])
    await expect(run('logout')).resolves.toEqual({ kind: 'success', text: 'OpenAI Codex is signed out.' })
  })
})
