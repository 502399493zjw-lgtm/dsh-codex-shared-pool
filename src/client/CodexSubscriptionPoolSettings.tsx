/** One stock-DSH settings page for local and Team Codex subscription capacity. */

import { useState } from 'react'
import { OpenAICodexSettings } from './OpenAICodexSettings.tsx'
import type { OpenAICodexSettingsInjected } from './OpenAICodexSettings.tsx'
import { TeamSettings } from './team/TeamSettings.tsx'
import type { TeamSettingsInjected } from './team/TeamSettings.tsx'
import styles from './CodexSubscriptionPoolSettings.module.css'

type PoolTab = 'local' | 'team'

export interface CodexSubscriptionPoolSettingsInjected {
  readonly localT: OpenAICodexSettingsInjected['t']
  readonly teamT: TeamSettingsInjected['t']
}

export function CodexSubscriptionPoolSettings({
  localT,
  teamT,
}: CodexSubscriptionPoolSettingsInjected) {
  const [tab, setTab] = useState<PoolTab>('local')

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>{localT('poolTitle')}</h1>
        <p className={styles.intro}>{localT('poolIntro')}</p>
      </header>
      <div className={styles.tabs} role="tablist" aria-label={localT('poolTitle')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'local'}
          className={styles.tab}
          data-active={tab === 'local'}
          onClick={() => { setTab('local') }}
        >
          {localT('localTab')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'team'}
          className={styles.tab}
          data-active={tab === 'team'}
          onClick={() => { setTab('team') }}
        >
          {localT('teamTab')}
        </button>
      </div>
      <section className={styles.content} role="tabpanel">
        {tab === 'local'
          ? <OpenAICodexSettings t={localT} embedded />
          : <TeamSettings t={teamT} embedded />}
      </section>
    </main>
  )
}
