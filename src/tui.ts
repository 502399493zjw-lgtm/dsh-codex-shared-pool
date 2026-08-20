/** Optional dsh-tui front-door adapter for account and live preference commands. */

import { spawn } from 'node:child_process'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { safeExternalErrorMessage } from './safe-message.ts'
import type { OpenAICodexService } from './service.ts'
import type { OpenAICodexUsage } from './usage.ts'

interface TuiSubcommandNode {
  name: string
  aliases?: readonly string[]
  description: string
  descriptions?: Readonly<Partial<Record<'zh' | 'en', string>>>
  tag?: string
}

interface TuiCommandTreeRuntime {
  register(provider: {
    root: string
    descriptions?: Readonly<Partial<Record<'zh' | 'en', string>>>
    children(canonicalPath: readonly string[]): readonly TuiSubcommandNode[]
  }): () => void
}

interface TuiContext extends Context {
  tuiCommandTrees: TuiCommandTreeRuntime
}

const HELP = [
  'Usage: /codex <status|login|logout|profiles|add|cancel|activate|rename|remove|usage|config|set>',
  '  /codex status',
  '  /codex login',
  '  /codex logout',
  '  /codex profiles',
  '  /codex add',
  '  /codex cancel',
  '  /codex activate <profile-id>',
  '  /codex rename <profile-id> <label>',
  '  /codex remove <profile-id>',
  '  /codex usage',
  '  /codex config',
  '  /codex set <read-image|imagegen-other-models|fast|websocket-context|native-compaction> <on|off>',
].join('\n')

function translatedNode(name: string, en: string, zh: string): TuiSubcommandNode {
  return { name, description: en, descriptions: { en, zh } }
}

const CODEX_ACTIONS: readonly TuiSubcommandNode[] = [
  translatedNode('status', 'Show the ChatGPT sign-in state', '查看 ChatGPT 登录状态'),
  translatedNode('login', 'Sign in with ChatGPT in the system browser', '在系统浏览器中登录 ChatGPT'),
  translatedNode('logout', 'Remove the dsh Codex credential', '移除 dsh Codex 登录凭据'),
  translatedNode('profiles', 'List ordered Codex profiles', '列出按优先级排序的 Codex 账号'),
  translatedNode('add', 'Add another ChatGPT profile', '添加另一个 ChatGPT 账号'),
  translatedNode('cancel', 'Cancel the current sign-in', '取消当前登录'),
  translatedNode('activate', 'Give one profile global priority', '将一个账号设为全局优先'),
  translatedNode('rename', 'Rename one profile', '重命名一个账号'),
  translatedNode('remove', 'Remove one exact profile', '移除一个指定账号'),
  translatedNode('usage', 'Show current Codex usage limits', '查看当前 Codex 用量限制'),
  translatedNode('config', 'Show live Codex settings', '查看 Codex 实时配置'),
  translatedNode('set', 'Change one live Codex setting', '修改一项 Codex 实时配置'),
]

const CODEX_SETTINGS: readonly TuiSubcommandNode[] = [
  translatedNode('read-image', 'Enhance read_image with HTTP(S) input', '为 read_image 增加 HTTP(S) 图片输入'),
  translatedNode('imagegen-other-models', 'Allow other vision models to call imagegen', '允许其他视觉模型调用 imagegen'),
  translatedNode('fast', 'Use the Codex Fast service tier', '使用 Codex 快速服务层'),
  translatedNode('websocket-context', 'Reuse Codex WebSocket response context', '复用 Codex WebSocket 响应上下文'),
  translatedNode('native-compaction', 'Use Codex V2 Responses compaction', '使用 Codex V2 Responses 压缩'),
]

const BOOLEAN_VALUES: readonly TuiSubcommandNode[] = [
  translatedNode('on', 'Enable this setting', '启用此设置'),
  translatedNode('off', 'Disable this setting', '关闭此设置'),
]

function codexSubcommands(path: readonly string[]): readonly TuiSubcommandNode[] {
  if (path.length === 1 && path[0] === 'codex') return CODEX_ACTIONS
  if (path.length === 2 && path[0] === 'codex' && path[1] === 'set') return CODEX_SETTINGS
  if (path.length === 3 && path[0] === 'codex' && path[1] === 'set'
    && CODEX_SETTINGS.some(setting => setting.name === path[2])) return BOOLEAN_VALUES
  return []
}

function success(text: string): CommandResult {
  return { kind: 'success', text }
}

function failure(text: string): CommandResult {
  return { kind: 'error', text }
}

function waitForPromptAbort(prompt: AuthPrompt): Promise<string> {
  const signal = prompt.signal
  if (signal === undefined) return new Promise<string>(() => {})
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('OpenAI Codex sign-in aborted'))
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('OpenAI Codex sign-in aborted'))
    }, { once: true })
  })
}

/** Open one provider-issued HTTPS challenge without passing it through shell parsing. */
function openBrowser(rawUrl: string): boolean {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:') throw new Error(`refusing to open non-HTTPS authorization URL from ${url.host}`)
  if (process.platform === 'linux' && process.env.DISPLAY === undefined && process.env.WAYLAND_DISPLAY === undefined) {
    return false
  }
  const command = process.platform === 'win32'
    ? { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url.href] }
    : process.platform === 'darwin'
      ? { file: 'open', args: [url.href] }
      : { file: 'xdg-open', args: [url.href] }
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {})
  child.unref()
  return true
}

type LoginState =
  | { status: 'idle' }
  | { status: 'signing-in' }
  | { status: 'error'; message: string }

/** Own the browser challenge while the command returns control to the TUI immediately. */
class TuiLoginController {
  private state: LoginState = { status: 'idle' }
  private operation: Promise<void> | undefined
  private cancellation: AbortController | undefined
  private challenge: Promise<string> | undefined
  private resolveChallenge: ((message: string) => void) | undefined
  private rejectChallenge: ((error: unknown) => void) | undefined

  constructor(private readonly service: OpenAICodexService) {}

  async start(addProfile = false): Promise<string> {
    if (!addProfile) {
      const stored = await this.service.authStatus()
      if (stored.authenticated) return 'OpenAI Codex is already signed in.'
    }
    if (this.operation === undefined) this.begin(addProfile)
    const challenge = this.challenge
    if (challenge === undefined) throw new Error('OpenAI Codex sign-in did not create an authorization challenge')
    return await challenge
  }

  status(): LoginState {
    return this.state
  }

  async cancel(): Promise<boolean> {
    const cancellation = this.cancellation
    const operation = this.operation
    if (cancellation === undefined || operation === undefined) return false
    cancellation.abort(new Error('OpenAI Codex sign-in cancelled'))
    await operation.catch(() => undefined)
    this.state = { status: 'idle' }
    return true
  }

  async logout(): Promise<void> {
    await this.cancel()
    await this.service.logout()
    this.state = { status: 'idle' }
  }

  async dispose(): Promise<void> {
    this.cancellation?.abort(new Error('OpenAI Codex TUI adapter disposed'))
    await this.operation?.catch(() => undefined)
  }

  private begin(addProfile: boolean): void {
    const cancellation = new AbortController()
    this.cancellation = cancellation
    this.state = { status: 'signing-in' }
    this.challenge = new Promise<string>((resolve, reject) => {
      this.resolveChallenge = resolve
      this.rejectChallenge = reject
    })
    const interaction = {
      signal: cancellation.signal,
      prompt: prompt => prompt.type === 'select'
        ? Promise.resolve('browser')
        : waitForPromptAbort(prompt),
      notify: (event) => { this.onEvent(event) },
    } satisfies Parameters<OpenAICodexService['login']>[0]
    const login = addProfile
      ? this.service.loginProfile(interaction).then(() => undefined)
      : this.service.login(interaction)
    this.operation = login.then(
      () => { this.state = { status: 'idle' } },
      (error: unknown) => {
        const message = safeExternalErrorMessage(error)
        this.state = { status: 'error', message }
        this.rejectChallenge?.(error)
      },
    ).finally(() => {
      this.operation = undefined
      this.cancellation = undefined
      this.resolveChallenge = undefined
      this.rejectChallenge = undefined
    })
  }

  private onEvent(event: AuthEvent): void {
    if (event.type !== 'auth_url') return
    try {
      const opened = openBrowser(event.url)
      this.resolveChallenge?.(opened
        ? 'Opened the ChatGPT authorization page. Use /codex status after approval.'
        : `Open this ChatGPT authorization page: ${event.url}\nUse /codex status after approval.`)
    } catch (error: unknown) {
      this.cancellation?.abort(error)
      this.rejectChallenge?.(error)
    }
  }
}

function formatExpiry(expiresAt: Date | undefined): string {
  return expiresAt === undefined || Number.isNaN(expiresAt.valueOf())
    ? ''
    : ` Access token expires ${expiresAt.toISOString()}; refresh is automatic.`
}

function formatUsage(usage: OpenAICodexUsage): string {
  const lines: string[] = []
  for (const limit of usage.rateLimits) {
    const name = limit.name ?? limit.id
    for (const window of limit.windows) {
      lines.push(`${name} (${window.windowSeconds}s): ${window.remainingPercent.toFixed(1)}% remaining`)
    }
  }
  if (usage.individualLimit !== undefined) {
    lines.push(`Individual limit: ${usage.individualLimit.remainingPercent.toFixed(1)}% remaining (${usage.individualLimit.remaining}/${usage.individualLimit.limit})`)
  }
  if (usage.credits !== undefined) {
    lines.push(`Credits: ${usage.credits.unlimited ? 'unlimited' : usage.credits.balance ?? 'available'}`)
  }
  return lines.length === 0 ? 'OpenAI Codex usage is currently unavailable.' : lines.join('\n')
}

function formatConfig(service: OpenAICodexService): string {
  const image = service.imagePreferences()
  const responses = service.responsePreferences()
  return [
    `read-image: ${image.modifyReadImage ? 'on' : 'off'}`,
    `imagegen-other-models: ${image.shareImagegenWithOtherModels ? 'on' : 'off'}`,
    `fast: ${responses.useFastMode ? 'on' : 'off'}`,
    `websocket-context: ${responses.useWebSocketContextReuse ? 'on' : 'off'}`,
    `native-compaction: ${responses.useNativeCompaction ? 'on' : 'off'}`,
  ].join('\n')
}

async function updateSetting(service: OpenAICodexService, key: string, enabled: boolean): Promise<void> {
  switch (key) {
    case 'read-image':
      await service.updateImagePreferences({ modifyReadImage: enabled })
      return
    case 'imagegen-other-models':
      await service.updateImagePreferences({ shareImagegenWithOtherModels: enabled })
      return
    case 'fast':
      await service.updateResponsePreferences({ useFastMode: enabled })
      return
    case 'websocket-context':
      await service.updateResponsePreferences({ useWebSocketContextReuse: enabled })
      return
    case 'native-compaction':
      await service.updateResponsePreferences({ useNativeCompaction: enabled })
      return
    default:
      throw new Error(`unknown setting ${JSON.stringify(key)}`)
  }
}

/**
 * Register executable commands and optional TUI completions from the root Codex plugin.
 *
 * @param ctx - Root Codex plugin context that owns the registrations.
 */
export function installOpenAICodexTui(ctx: Context): void {
  ctx.inject(['commands'], registerCodexCommand)
  ctx.inject(['tuiCommandTrees'], registerTuiCommandTree)
}

function registerCodexCommand(ctx: Context): void {
  const commandCtx = ctx
  const service = commandCtx.openAICodex
  const login = new TuiLoginController(service)
  const disposeCommand = commandCtx.commands.register({
    name: 'codex',
    description: 'Manage the OpenAI Codex account and provider settings',
    input: { hint: 'subcommand' },
    async handler({ rawInput }) {
      const parts = rawInput.trim().split(/\s+/u).filter(Boolean)
      const action = parts[0] ?? 'status'
      try {
        switch (action) {
          case 'status': {
            const state = login.status()
            if (state.status === 'signing-in') return success('OpenAI Codex sign-in is waiting for browser approval.')
            if (state.status === 'error') return failure(`OpenAI Codex sign-in failed: ${state.message}`)
            const status = await service.authStatus()
            return status.authenticated
              ? success(`OpenAI Codex is signed in.${formatExpiry(status.expiresAt)}`)
              : failure('OpenAI Codex is signed out. Run /codex login.')
          }
          case 'login':
            if (parts.length !== 1) return failure(HELP)
            return success(await login.start())
          case 'add':
            if (parts.length !== 1) return failure(HELP)
            return success(await login.start(true))
          case 'cancel':
            if (parts.length !== 1) return failure(HELP)
            return success(await login.cancel()
              ? 'OpenAI Codex sign-in cancelled.'
              : 'No OpenAI Codex sign-in is active.')
          case 'logout':
            if (parts.length !== 1) return failure(HELP)
            await login.logout()
            {
              const remaining = await service.listProfiles()
              return success(remaining.length === 0
                ? 'OpenAI Codex is signed out.'
                : `Removed the active Codex profile; ${remaining.length} stored profile${remaining.length === 1 ? '' : 's'} remain.`)
            }
          case 'profiles': {
            if (parts.length !== 1) return failure(HELP)
            const profiles = await service.listProfiles()
            return success(profiles.length === 0
              ? 'No OpenAI Codex profiles are stored.'
              : profiles.map((profile, index) => `${index === 0 ? '*' : '-'} ${profile.id}: ${profile.label}`).join('\n'))
          }
          case 'activate':
            if (parts.length !== 2) return failure(HELP)
            await service.prioritizeProfile(parts[1] as string)
            return success(`Codex profile ${parts[1]} now has global priority.`)
          case 'rename': {
            if (parts.length < 3) return failure(HELP)
            const profileId = parts[1] as string
            const label = parts.slice(2).join(' ')
            await service.renameProfile(profileId, label)
            return success(`Renamed Codex profile ${profileId} to ${label}.`)
          }
          case 'remove':
            if (parts.length !== 2) return failure(HELP)
            await service.removeProfile(parts[1] as string)
            return success(`Removed Codex profile ${parts[1]}.`)
          case 'usage':
            if (parts.length !== 1) return failure(HELP)
            return success(formatUsage(await service.usage()))
          case 'config':
            if (parts.length !== 1) return failure(HELP)
            return success(formatConfig(service))
          case 'set': {
            if (parts.length !== 3 || (parts[2] !== 'on' && parts[2] !== 'off')) return failure(HELP)
            await updateSetting(service, parts[1] as string, parts[2] === 'on')
            return success(formatConfig(service))
          }
          default:
            return failure(HELP)
        }
      } catch (error: unknown) {
        return failure(safeExternalErrorMessage(error))
      }
    },
  })
  ctx.effect(() => async () => {
    disposeCommand()
    await login.dispose()
  }, 'OpenAI Codex command adapter')
}

function registerTuiCommandTree(ctx: Context): void {
  const tui = ctx as TuiContext
  const disposeTree = tui.tuiCommandTrees.register({
    root: 'codex',
    descriptions: {
      en: 'Manage the OpenAI Codex account and provider settings',
      zh: '管理 OpenAI Codex 账号与提供方设置',
    },
    children: codexSubcommands,
  })
  ctx.effect(() => disposeTree, 'OpenAI Codex TUI completion adapter')
}
