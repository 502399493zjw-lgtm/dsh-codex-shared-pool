/** Host-only marker for failures that require the user to authorize Codex again. */
export class OpenAICodexAuthenticationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenAICodexAuthenticationError'
  }
}

/** Distinguish authentication failure from ordinary quota telemetry failure. */
export function isOpenAICodexAuthenticationError(error: unknown): error is OpenAICodexAuthenticationError {
  return error instanceof OpenAICodexAuthenticationError
}
