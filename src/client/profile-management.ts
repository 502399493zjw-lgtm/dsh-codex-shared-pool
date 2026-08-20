export const OPENAI_CODEX_PROFILE_RENAME_PATH = '/plugins/dsh-openai-codex/profiles/rename'

const MAX_PROFILE_LABEL_LENGTH = 80

export type ProfileLabelDraft =
  | { readonly ok: true; readonly label: string }
  | { readonly ok: false }

export type ProfileManagementRequest = (
  path: string,
  method: string,
  body: unknown,
) => Promise<unknown>

/** Mirror the Host profile-label boundary before submitting browser input. */
export function parseProfileLabelDraft(value: string): ProfileLabelDraft {
  const label = value.trim()
  if (label.length === 0 || label.length > MAX_PROFILE_LABEL_LENGTH) return { ok: false }
  return { ok: true, label }
}

/** Submit only the selected profile id and normalized display label. */
export async function renameOpenAICodexProfile(
  request: ProfileManagementRequest,
  profileId: string,
  labelDraft: string,
): Promise<void> {
  const parsed = parseProfileLabelDraft(labelDraft)
  if (!parsed.ok) throw new Error('Profile label must contain between 1 and 80 characters')
  await request(OPENAI_CODEX_PROFILE_RENAME_PATH, 'POST', {
    profileId,
    label: parsed.label,
  })
}
