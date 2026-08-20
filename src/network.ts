/** Environment-driven outbound HTTP(S) transport for the DSH process. */

import {
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from 'undici'

type Environment = Readonly<Record<string, string | undefined>>

/** Resolved values stay private to the server process and never cross HTTP. */
export interface OutboundProxyEnvironment {
  httpProxy: string | undefined
  httpsProxy: string | undefined
  noProxy: string | undefined
}

/** Safe projection for diagnostics and the browser settings page. */
export interface OutboundNetworkStatus {
  enabled: boolean
  httpProxy: boolean
  httpsProxy: boolean
  noProxy: boolean
}

function readVariable(environment: Environment, lower: string, upper: string): string | undefined {
  // A defined lowercase value, including an empty one, suppresses uppercase.
  const selected = environment[lower] ?? environment[upper]
  const normalized = selected?.trim()
  return normalized === '' ? undefined : normalized
}

/**
 * Resolve standard proxy variables with the same precedence as Undici.
 *
 * @param environment - Process environment projection to inspect.
 * @returns Normalized proxy configuration retained by the Host.
 */
export function resolveOutboundProxyEnvironment(
  environment: Environment = process.env,
): OutboundProxyEnvironment {
  return {
    httpProxy: readVariable(environment, 'http_proxy', 'HTTP_PROXY'),
    httpsProxy: readVariable(environment, 'https_proxy', 'HTTPS_PROXY'),
    noProxy: readVariable(environment, 'no_proxy', 'NO_PROXY'),
  }
}

/** Own the process-global dispatcher for exactly one plugin lifecycle. */
export class OutboundNetwork {
  private readonly environment: OutboundProxyEnvironment
  private cleanup: (() => Promise<void>) | undefined

  constructor(environment: Environment = process.env) {
    this.environment = resolveOutboundProxyEnvironment(environment)
  }

  /**
   * Return presence flags only; proxy addresses and credentials remain secret.
   * @returns Secret-free effective network state.
   */
  status(): OutboundNetworkStatus {
    const httpProxy = this.environment.httpProxy !== undefined
    const httpsProxy = this.environment.httpsProxy !== undefined
    return {
      enabled: httpProxy || httpsProxy,
      httpProxy,
      httpsProxy,
      noProxy: this.environment.noProxy !== undefined,
    }
  }

  /**
   * Install an Undici dispatcher, returning an idempotent lifecycle cleanup.
   * @returns Asynchronous dispatcher cleanup.
   */
  install(): () => Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    if (!this.status().enabled) return async () => {}

    const previous = getGlobalDispatcher()
    const dispatcher = new EnvHttpProxyAgent({
      // Empty values prevent this captured configuration from rereading process.env.
      httpProxy: this.environment.httpProxy ?? '',
      httpsProxy: this.environment.httpsProxy ?? '',
      noProxy: this.environment.noProxy ?? '',
    })
    setGlobalDispatcher(dispatcher)

    let disposed = false
    this.cleanup = async () => {
      if (disposed) return
      disposed = true
      if (getGlobalDispatcher() === dispatcher) setGlobalDispatcher(previous)
      await dispatcher.close()
      this.cleanup = undefined
    }
    return this.cleanup
  }
}
