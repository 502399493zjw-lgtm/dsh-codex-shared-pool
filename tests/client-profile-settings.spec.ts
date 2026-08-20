import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  OPENAI_CODEX_PROFILE_RENAME_PATH,
  parseProfileLabelDraft,
  renameOpenAICodexProfile,
} from '../src/client/profile-management.ts'

describe('OpenAI Codex profile settings contract', () => {
  it('keeps the rename field inside the stock DSH modal content width', async () => {
    const source = await readFile(new URL('../src/client/OpenAICodexSettings.tsx', import.meta.url), 'utf8')

    expect(source).toContain('.dsh-codex-dialog-field { display: flex; flex-direction: column; gap: 8px; width: 100%; min-width: 0; }')
    expect(source).not.toContain('min-width: min(420px, 72vw)')
  })

  it('keeps the add-account action inside a narrow settings sidebar', async () => {
    const source = await readFile(new URL('../src/client/OpenAICodexSettings.tsx', import.meta.url), 'utf8')

    expect(source).toContain("width: '100%', minWidth: 0, maxWidth: 1040")
    expect(source).toContain('.dsh-codex-list-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; min-width: 0; }')
    expect(source).toContain('.dsh-codex-add-account { max-width: 100%; min-width: 0; flex: 0 1 auto; }')
    expect(source).toContain('.dsh-codex-add-account-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }')
    expect(source).toContain('className="dsh-codex-add-account"')
    expect(source).toContain('className="dsh-codex-add-account-label"')
  })

  it('normalizes a profile label within the Host storage boundary', () => {
    expect(parseProfileLabelDraft('  Work Pro  ')).toEqual({
      ok: true,
      label: 'Work Pro',
    })
  })

  it.each(['', '   ', 'x'.repeat(81)])('rejects an invalid profile label %j before submission', label => {
    expect(parseProfileLabelDraft(label)).toEqual({ ok: false })
  })

  it('posts only the selected profile id and normalized label to the rename route', async () => {
    const request = vi.fn(async () => ({ ok: true as const }))

    await renameOpenAICodexProfile(request, 'profile-2', '  Work Pro  ')

    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(
      OPENAI_CODEX_PROFILE_RENAME_PATH,
      'POST',
      { profileId: 'profile-2', label: 'Work Pro' },
    )
  })

  it('does not send an invalid profile label', async () => {
    const request = vi.fn(async () => ({ ok: true as const }))

    await expect(renameOpenAICodexProfile(request, 'profile-2', '   '))
      .rejects.toThrow('Profile label must contain between 1 and 80 characters')
    expect(request).not.toHaveBeenCalled()
  })
})
