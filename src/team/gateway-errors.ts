/** Bounded Team diagnostics shared by the Host gateway and provider adapter. */
export const TEAM_LIMIT_REASONS_HEADER = 'x-dsh-team-limit-reasons'

const messages: Readonly<Record<string, string>> = {
  concurrency: '当前成员的并发请求已达上限，请等待正在运行的请求结束',
  rate_limit: '当前成员的请求频率已达上限，请稍后重试',
  circuit_open: '连续请求失败，Team 暂时暂停了该成员的请求，请稍后重试',
  daily_shared_credits_reached: '贡献账号的每日共享 Credits 限额已达上限',
  weekly_shared_cost_reached: '贡献账号的每周共享预算已达上限',
  shared_concurrency_reached: '贡献账号的共享并发已达上限',
  reserve_reached: '贡献账号已达到个人保留额度边界',
  request_cap_reached: '贡献账号的共享请求次数已达上限',
  quota_unavailable: '暂时无法确认贡献账号的可用额度，请稍后重试',
  account_unavailable: '贡献账号当前不可用',
  model_unavailable: '贡献账号未开放此模型',
  quota_exhausted: '贡献账号报告可用额度已耗尽',
  team_paused: '团队已暂停接收新请求',
  upstream_hard_limit: '上游拒绝了共享账号请求，可能涉及账号权限或用量限制',
  no_candidates: '没有可用于此模型的共享账号',
  shared_unavailable: '当前没有可用的共享容量，请检查并发、保留额度和共享限制',
}

export function teamLimitReasonsHeader(reasons: readonly string[]): string {
  return [...new Set(reasons.filter(reason => Object.hasOwn(messages, reason)))].slice(0, 8).join(',')
}

export function teamLimitMessage(header: string | undefined): string {
  const details = (header ?? '').slice(0, 512).split(',')
    .filter(reason => Object.hasOwn(messages, reason)).map(reason => messages[reason])
  return `Team 请求受限：${[...new Set(details)].join('；') || '请检查团队共享并发、预算及账号容量后重试'}。`
}
