import { pathToFileURL } from 'node:url'

const DEFAULT_HEALTH_URL = 'http://127.0.0.1:8788/healthz'
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_POLL_INTERVAL_MS = 250
const REQUEST_TIMEOUT_MS = 2_000

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export async function waitForCredentialBroker(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const healthUrl = options.healthUrl ?? DEFAULT_HEALTH_URL
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)
  const deadline = Date.now() + timeoutMs

  while (true) {
    try {
      const response = await fetchImpl(healthUrl, {
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, timeoutMs)),
      })
      if (response.ok) return
    } catch {
      // Startup failures may contain connection details or response bodies.
      // The Host only needs a boolean readiness signal, so never echo them.
    }

    if (Date.now() >= deadline) {
      throw new Error('credential broker did not become ready before the startup timeout')
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  waitForCredentialBroker().catch(() => {
    console.error('Credential Broker did not become ready; Team Host startup stopped safely.')
    process.exitCode = 1
  })
}
