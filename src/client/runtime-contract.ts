/** Browser services guaranteed by the pinned published DSH runtime. */
export const CLIENT_INJECT = ['slots', 'locale', 'sessions'] as const

/** Quota registration has no hard dependency on optional Settings deep links. */
export const QUOTA_CLIENT_INJECT = ['slots', 'locale'] as const
