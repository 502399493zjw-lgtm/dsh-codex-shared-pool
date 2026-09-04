import { afterEach, expect, it, vi } from 'vitest'
import { withDeadline } from '../src/with-deadline.ts'

afterEach(() => { vi.useRealTimers() })

it('rejects a non-cooperative operation at the deadline and clears its timer', async () => {
  vi.useFakeTimers()
  let signal!: AbortSignal
  const pending = withDeadline(value => { signal = value; return new Promise(() => {}) }, 15_000)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
  await vi.advanceTimersByTimeAsync(15_000)
  await rejected
  expect(signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not start work for an already aborted caller', async () => {
  const operation = vi.fn()
  await expect(withDeadline(operation, 100, AbortSignal.abort(new Error('stop')))).rejects.toThrow('stop')
  expect(operation).not.toHaveBeenCalled()
})

it('removes listeners and timers on success and consumes late rejection after cancellation', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  await expect(withDeadline(async () => 42, 100, controller.signal)).resolves.toBe(42)
  expect(remove).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  let rejectLate!: (error: Error) => void
  const pending = withDeadline(() => new Promise((_, reject) => { rejectLate = reject }), 100, controller.signal)
  const rejected = expect(pending).rejects.toThrow('stop')
  controller.abort(new Error('stop'))
  await rejected
  rejectLate(new Error('late failure'))
  await Promise.resolve()
  expect(vi.getTimerCount()).toBe(0)
})
