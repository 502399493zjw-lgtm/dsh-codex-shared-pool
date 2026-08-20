/** Browser services guaranteed by the pinned published DSH runtime. */
export const CLIENT_INJECT = ['slots', 'locale', 'sessions'] as const

/** Services required by the quota Browser child plugin on pinned stock DSH. */
export const QUOTA_CLIENT_INJECT = ['slots', 'locale', 'settingsNavigation'] as const
