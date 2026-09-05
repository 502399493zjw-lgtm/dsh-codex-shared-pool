/** Short, abortable waits for an occupied shared slot; never replays provider calls. */
import { TeamRouteCapacityError } from './routing.ts'

const WAIT_MS = 5_000
const POLL_MS = 250

export async function waitForTeamAdmission<T>(admit: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const deadline = performance.now() + WAIT_MS
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted()
    try {
      return await admit()
    } catch (error) {
      const remaining = deadline - performance.now()
      if (!(error instanceof TeamRouteCapacityError)
        || !error.reasons.includes('shared_concurrency_reached')
        || remaining <= 0 || attempt >= WAIT_MS / POLL_MS) throw error
      await pause(Math.min(POLL_MS, remaining), signal)
    }
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
