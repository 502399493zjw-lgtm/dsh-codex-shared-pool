/**
 * Reduce an untrusted diagnostic before it reaches a browser, terminal, model
 * transcript, or durable status field.
 *
 * The source error remains available to Host control flow; only this bounded,
 * best-effort projection is safe to show outside credential-owning code.
 */
export function safeExternalErrorMessage(error: unknown, maxLength = 1000): string {
  const message = error instanceof Error ? error.message : String(error)
  const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 1000
  return message
    .replace(/\bdsh_(?:team|invite)_[A-Za-z0-9._~-]+\b/giu, '[redacted team credential]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\bauthorization\s*:\s*)[^\r\n]+/giu, '$1[redacted]')
    .replace(/(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]+/giu, '$1[redacted]')
    .replace(/(\b(?:authorization\s*:\s*)?(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[redacted]')
    .replace(/("(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|passwd|secret|cookie|set-cookie|code|token)"\s*:\s*")[^"]*(")/giu, '$1[redacted]$2')
    .replace(/('(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|passwd|secret|cookie|set-cookie|code|token)'\s*:\s*')[^']*(')/giu, '$1[redacted]$2')
    .replace(/(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|passwd|secret|cookie|set-cookie|code|token)\b\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/giu, '$1[redacted]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)[^@\s/]+@/giu, '$1[redacted]@')
    .slice(0, limit)
}
