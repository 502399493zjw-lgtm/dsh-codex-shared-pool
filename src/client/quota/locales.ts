/** Copy dictionaries for the Codex quota sidebar contribution. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  aria: 'Codex 额度',
  account: 'Codex 账号：',
  remaining: '剩余',
  resetAt: '{time} 重置',
  resetUnknown: '重置时间未知',
  pool: '账号池',
  accounts: '个账号',
  totalRemaining: '总剩余',
  loading: '正在读取 Codex 额度…',
  unavailable: 'Codex 额度暂不可用',
  open: '打开',
} satisfies Record<string, string>

/** Codex quota locale key union. */
export type CodexQuotaLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  aria: 'Codex quota',
  account: 'Codex account: ',
  remaining: 'remaining',
  resetAt: 'resets {time}',
  resetUnknown: 'reset time unavailable',
  pool: 'Account pool',
  accounts: 'accounts',
  totalRemaining: 'total remaining',
  loading: 'Reading Codex quota…',
  unavailable: 'Codex quota unavailable',
  open: 'Open',
} satisfies Record<CodexQuotaLocaleKey, string>
