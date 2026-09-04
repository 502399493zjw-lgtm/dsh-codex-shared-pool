/** Bound a whole operation, including stages that do not implement cancellation.
 * Such stages may finish later; callers must check the signal before further I/O.
 */
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  caller?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const cancel = (): void => { controller.abort(caller?.reason) }
  if (caller?.aborted) cancel()
  else caller?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Request timed out', 'TimeoutError'))
  }, timeoutMs)
  let onAbort: (() => void) | undefined
  try {
    controller.signal.throwIfAborted()
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => { reject(controller.signal.reason) }
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([operation(controller.signal), aborted])
  } finally {
    clearTimeout(timer)
    caller?.removeEventListener('abort', cancel)
    if (onAbort !== undefined) controller.signal.removeEventListener('abort', onAbort)
  }
}
