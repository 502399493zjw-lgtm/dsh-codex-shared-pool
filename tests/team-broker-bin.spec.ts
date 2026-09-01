import { describe, expect, it, vi } from 'vitest'
import { OutboundNetwork } from '../src/network.ts'
import { runTeamCredentialBroker } from '../src/team-broker-bin.ts'

describe('Team credential broker command', () => {
  it('prints boot-free help with file-based secret configuration', async () => {
    const stdout = vi.fn(() => true)
    const stderr = vi.fn(() => true)
    const install = vi.spyOn(OutboundNetwork.prototype, 'install')

    await expect(runTeamCredentialBroker(['--help'], { stdout: { write: stdout }, stderr: { write: stderr } }))
      .resolves.toBe(0)
    const help = stdout.mock.calls.map(call => call[0]).join('')
    expect(help).toContain('dsh-codex-team-broker')
    expect(help).toContain('DSH_CODEX_SHARED_POOL_DATABASE_URL_FILE')
    expect(help).toContain('DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY_FILE')
    expect(help).toContain('DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY_FILE')
    expect(help).toContain('/v1/dsh-team-credential-broker')
    expect(stderr).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    install.mockRestore()
  })

  it('rejects command arguments before resolving any environment secrets', async () => {
    const stdout = vi.fn(() => true)
    const stderr = vi.fn(() => true)
    const install = vi.spyOn(OutboundNetwork.prototype, 'install')

    await expect(runTeamCredentialBroker(['--listen', '0.0.0.0'], {
      stdout: { write: stdout },
      stderr: { write: stderr },
      environment: {},
    })).resolves.toBe(1)
    expect(stdout).not.toHaveBeenCalled()
    expect(stderr.mock.calls.map(call => call[0]).join('')).toMatch(/does not accept command arguments/iu)
    expect(install).not.toHaveBeenCalled()
    install.mockRestore()
  })

  it('installs and restores outbound proxy handling around a normal startup attempt', async () => {
    const stdout = vi.fn(() => true)
    const stderr = vi.fn(() => true)
    const dispose = vi.fn(async () => undefined)
    const install = vi.spyOn(OutboundNetwork.prototype, 'install').mockReturnValue(dispose)
    const proxyCredential = 'proxy-user:proxy-password'

    await expect(runTeamCredentialBroker([], {
      stdout: { write: stdout },
      stderr: { write: stderr },
      environment: {
        HTTPS_PROXY: `http://${proxyCredential}@proxy.test:8080`,
        NO_PROXY: '127.0.0.1,localhost',
      },
    })).resolves.toBe(1)

    expect(install).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(stderr.mock.calls.map(call => call[0]).join('')).not.toContain(proxyCredential)
    install.mockRestore()
  })
})
