/** Browser services guaranteed by the pinned published DSH runtime. */
export const CLIENT_INJECT = [
  'slots', 'locale', 'sessions', 'modelDirectories',
  // Cordis traces directoryFor() through the caller's context. Creating a
  // directory needs the separately provided rc.1 Remote session namespace.
  'remote', 'remote.session',
] as const

/** Quota registration has no hard dependency on optional Settings deep links. */
export const QUOTA_CLIENT_INJECT = ['slots', 'locale'] as const
