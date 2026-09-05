import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForTeamAdmission } from '../src/team/admission-wait.ts'
import { TeamRouteCapacityError } from '../src/team/routing.ts'

afterEach(() => vi.useRealTimers())

describe('bounded Team admission wait', () => {
  it('waits for a busy shared slot without bypassing admission', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const busy = new TeamRouteCapacityError('busy', ['shared_concurrency_reached'])
    const admit = vi.fn().mockRejectedValueOnce(busy).mockResolvedValueOnce('lease')
    const result = waitForTeamAdmission(admit, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(250)
    await expect(result).resolves.toBe('lease')
    expect(admit).toHaveBeenCalledTimes(2)
  })

  it('stops waiting after five seconds with the specific capacity reason', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const busy = new TeamRouteCapacityError('busy', ['shared_concurrency_reached'])
    const admit = vi.fn().mockRejectedValue(busy)
    const result = waitForTeamAdmission(admit, new AbortController().signal)
    const rejection = expect(result).rejects.toBe(busy)
    await vi.advanceTimersByTimeAsync(5_000)
    await rejection
    expect(admit).toHaveBeenCalledTimes(21)
  })

  it('cancels promptly without another admission attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const admit = vi.fn().mockRejectedValue(new TeamRouteCapacityError('busy', ['shared_concurrency_reached']))
    const controller = new AbortController()
    const result = waitForTeamAdmission(admit, controller.signal)
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await rejection
    await vi.advanceTimersByTimeAsync(5_000)
    expect(admit).toHaveBeenCalledOnce()
  })

  it.each(['quota_unavailable', 'reserve_reached', 'request_cap_reached', 'quota_exhausted', 'weekly_shared_cost_reached'])
    ('does not retry %s', async reason => {
      const error = new TeamRouteCapacityError('blocked', [reason])
      const admit = vi.fn().mockRejectedValue(error)
      await expect(waitForTeamAdmission(admit, new AbortController().signal)).rejects.toBe(error)
      expect(admit).toHaveBeenCalledOnce()
    })
})
