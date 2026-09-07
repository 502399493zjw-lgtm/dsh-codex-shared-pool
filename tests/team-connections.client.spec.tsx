// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TeamConnections } from '../src/client/team/TeamConnections.tsx'
import { TeamManagementApi } from '../src/client/team/api.ts'
import { zh, type TeamSettingsKey } from '../src/client/team/locales.ts'
import type { TeamManagementExpectedContext, TeamSavedConnection } from '../src/shared/team-management.ts'

const savedTeam: TeamSavedConnection = {
  id: 'saved-team', teamId: 'team-1', teamName: '已退出团队', currentMemberId: 'member-1', memberName: '成员',
}
const activeTeam: TeamSavedConnection = {
  id: 'active-team', teamId: 'team-2', teamName: '仍在参与的团队', currentMemberId: 'member-2', memberName: '成员',
}
const context: TeamManagementExpectedContext = {
  serverOrigin: 'https://team.example.test', teamId: 'team-1', currentMemberId: 'member-1',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

function fixture(api: TeamManagementApi, expectedContext: TeamManagementExpectedContext | null = null) {
  return <TeamConnections api={api} t={(key: TeamSettingsKey) => zh[key]} expectedContext={expectedContext}
    disabled={false} onCreate={() => {}} onChanged={async () => {}} />
}

function toggle() { fireEvent.click(screen.getByRole('button', { name: zh.savedTeams })) }

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('clears the previous saved list when reopening fails', async () => {
  const api = new TeamManagementApi(vi.fn())
  vi.spyOn(api, 'connections').mockResolvedValueOnce([savedTeam]).mockRejectedValueOnce(new Error('offline'))
  render(fixture(api))
  toggle()
  await screen.findByRole('menuitemradio', { name: '已退出团队 · 成员' })
  toggle()
  toggle()
  await screen.findByRole('alert')
  expect(screen.queryByRole('menuitemradio')).toBeNull()
})

it('does not restore a saved list from a response started before the team context changed', async () => {
  const api = new TeamManagementApi(vi.fn())
  const previous = deferred<readonly TeamSavedConnection[]>()
  vi.spyOn(api, 'connections').mockReturnValueOnce(previous.promise).mockRejectedValueOnce(new Error('offline'))
  const view = render(fixture(api, context))
  toggle()
  view.rerender(fixture(api))
  expect(screen.queryByRole('menu')).toBeNull()
  toggle()
  await screen.findByRole('alert')
  await act(async () => { previous.resolve([savedTeam]) })
  expect(screen.queryByRole('menuitemradio')).toBeNull()
})

it.each(['success', 'failure'] as const)('keeps the latest list when an earlier menu request finishes last with %s', async result => {
  const api = new TeamManagementApi(vi.fn())
  const previous = deferred<readonly TeamSavedConnection[]>()
  vi.spyOn(api, 'connections').mockReturnValueOnce(previous.promise).mockResolvedValueOnce([activeTeam])
  render(fixture(api))
  toggle()
  toggle()
  toggle()
  await screen.findByRole('menuitemradio', { name: '仍在参与的团队 · 成员' })
  await act(async () => {
    if (result === 'success') previous.resolve([savedTeam])
    else previous.reject(new Error('offline'))
  })
  expect(screen.queryByRole('menuitemradio', { name: '已退出团队 · 成员' })).toBeNull()
  expect(screen.getByRole('menuitemradio', { name: '仍在参与的团队 · 成员' })).toBeDefined()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('continues loading the latest list after an earlier request completes', async () => {
  const api = new TeamManagementApi(vi.fn())
  const previous = deferred<readonly TeamSavedConnection[]>()
  const latest = deferred<readonly TeamSavedConnection[]>()
  vi.spyOn(api, 'connections').mockReturnValueOnce(previous.promise).mockReturnValueOnce(latest.promise)
  render(fixture(api))
  toggle()
  toggle()
  toggle()
  await act(async () => { previous.resolve([savedTeam]) })
  expect(screen.getByRole('status').textContent).toBe(zh.loading)
  expect(screen.queryByRole('menuitemradio')).toBeNull()
  await act(async () => { latest.resolve([activeTeam]) })
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('menuitemradio', { name: '仍在参与的团队 · 成员' })).toBeDefined()
})

it('refreshes the saved list after a failed switch removes an invalid connection on the Host', async () => {
  const api = new TeamManagementApi(vi.fn())
  const connections = vi.spyOn(api, 'connections').mockResolvedValueOnce([savedTeam, activeTeam]).mockResolvedValueOnce([activeTeam])
  vi.spyOn(api, 'switchConnection').mockRejectedValueOnce(new Error('membership ended'))
  render(fixture(api))
  toggle()
  fireEvent.click(await screen.findByRole('menuitemradio', { name: '已退出团队 · 成员' }))
  await waitFor(() => expect(connections).toHaveBeenCalledTimes(2))
  await screen.findByRole('menuitemradio', { name: '仍在参与的团队 · 成员' })
  expect(screen.queryByRole('menuitemradio', { name: '已退出团队 · 成员' })).toBeNull()
  expect(screen.getByRole('alert').textContent).toBe(zh.requestFailed)
})

it('does not retain invalid saved connections when refreshing after a failed switch also fails', async () => {
  const api = new TeamManagementApi(vi.fn())
  vi.spyOn(api, 'connections').mockResolvedValueOnce([savedTeam]).mockRejectedValueOnce(new Error('offline'))
  vi.spyOn(api, 'switchConnection').mockRejectedValueOnce(new Error('membership ended'))
  render(fixture(api))
  toggle()
  fireEvent.click(await screen.findByRole('menuitemradio', { name: '已退出团队 · 成员' }))
  await screen.findByRole('alert')
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  expect(screen.queryByRole('menuitemradio')).toBeNull()
})
