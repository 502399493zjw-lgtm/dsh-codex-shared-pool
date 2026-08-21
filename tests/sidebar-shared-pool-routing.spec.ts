import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const directory = fileURLToPath(new URL('..', import.meta.url))

describe('sidebar Shared Pool quota source', () => {
  it('does not replace the Shared Pool projection when subprocess is available', () => {
    const hostSource = readFileSync(`${directory}/src/index.ts`, 'utf8')
    const routeSource = readFileSync(`${directory}/src/auth-routes.ts`, 'utf8')

    expect(hostSource).not.toContain('new CodexQuotaProvider')
    expect(hostSource).toContain(
      'registerOpenAICodexAuthRoutes(webCtx, credentials, imageTools, network, routingEvents)',
    )
    expect(routeSource).toContain('await auth.quotaSnapshot()')
    expect(routeSource).not.toContain('auth.quotaSnapshot(quota)')
  })
})
