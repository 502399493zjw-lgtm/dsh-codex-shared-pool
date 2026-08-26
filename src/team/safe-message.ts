import { safeExternalErrorMessage } from '../safe-message.ts'

/** Browser-safe, 240-character Team status projection. */
export function safeTeamErrorMessage(error: unknown, maxLength = 240): string {
  return safeExternalErrorMessage(error, maxLength)
}
