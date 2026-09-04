import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  new URL('../src/client/team/TeamSettings.module.css', import.meta.url),
  'utf8',
)
const subscriptionPoolCss = readFileSync(
  new URL('../src/client/CodexSubscriptionPoolSettings.module.css', import.meta.url),
  'utf8',
)
const subscriptionPoolSource = readFileSync(
  new URL('../src/client/CodexSubscriptionPoolSettings.tsx', import.meta.url),
  'utf8',
)
const localSettingsSource = readFileSync(
  new URL('../src/client/OpenAICodexSettings.tsx', import.meta.url),
  'utf8',
)

describe('Team Settings responsive container contract', () => {
  it('caps the plugin page to the visible settings content width', () => {
    expect(css).toMatch(/\.page\s*\{[^}]*width:\s*min\(100%,\s*calc\(100vw - 320px\),\s*960px\);/s)
  })

  it('bounds the subscription-pool settings shell with stable viewport gutters', () => {
    expect(subscriptionPoolSource).toMatch(/data-dsh-codex-subscription-pool/)
    expect(subscriptionPoolCss).toMatch(
      /@media \(min-width: 641px\)\s*\{[\s\S]*?\[role='dialog'\]\[aria-modal='true'\]:has\(\[data-dsh-codex-subscription-pool\]\)[^\{]*\{[^}]*width:\s*clamp\(760px,\s*calc\(100vw - 48px\),\s*1280px\);[^}]*max-width:\s*calc\(100vw - 24px\);[^}]*min-width:\s*0;/,
    )
    expect(subscriptionPoolCss).toMatch(
      /\[role='dialog'\]\[aria-modal='true'\]:has\(\[data-dsh-codex-subscription-pool\]\)[^\{]*> nav\s*\{[^}]*width:\s*clamp\(200px,\s*18vw,\s*224px\);[^}]*flex:\s*0 0 clamp\(200px,\s*18vw,\s*224px\);/s,
    )
    expect(subscriptionPoolCss).toMatch(
      /\[role='dialog'\]\[aria-modal='true'\]:has\(\[data-dsh-codex-subscription-pool\]\)[^\{]*> :not\(nav\)\s*\{[^}]*min-width:\s*0;/s,
    )
    expect(subscriptionPoolCss).toMatch(
      /\[role='dialog'\]\[aria-modal='true'\]:has\(\[data-dsh-codex-subscription-pool\]\)[^\{]*> :not\(nav\) > :last-child\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*padding-right:\s*clamp\(24px,\s*4vw,\s*48px\);[^}]*padding-left:\s*clamp\(24px,\s*4vw,\s*48px\);/s,
    )
    expect(subscriptionPoolCss).toMatch(
      /body\[data-ds-dark-theme\][\s\S]*?\[role='dialog'\]\[aria-modal='true'\]:has\(\[data-dsh-codex-subscription-pool\]\)[^\{]*\{[^}]*border:\s*1px solid #35383d;[^}]*background:\s*#242629;/s,
    )
    expect(subscriptionPoolCss).toMatch(
      /body\[data-ds-dark-theme\][\s\S]*?\[role='dialog'\]\[aria-modal='true'\]:has\(\[data-dsh-codex-subscription-pool\]\)[^\{]*> nav\s*\{[^}]*border-right:\s*1px solid #383c42;/s,
    )
  })

  it('caps both local and Team panels and lets their master-detail layouts collapse safely', () => {
    expect(subscriptionPoolCss).toMatch(/\.page\s*\{[^}]*width:\s*min\(100%,\s*960px\);[^}]*max-width:\s*960px;/s)
    expect(css).toMatch(/\.page\s*\{[^}]*width:\s*min\(100%,\s*calc\(100vw - 320px\),\s*960px\);[^}]*max-width:\s*960px;[^}]*min-width:\s*0;/s)
    expect(localSettingsSource).toMatch(/maxWidth:\s*960,\s*containerType:\s*'inline-size'/)
    expect(localSettingsSource).toMatch(
      /@container \(max-width:\s*520px\)\s*\{[\s\S]*?\.dsh-codex-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/,
    )
    expect(css).toMatch(
      /@container team-settings \(max-width: 520px\)\s*\{[\s\S]*?\.accountWorkspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/,
    )
  })

  it('stacks the stock settings shell instead of squeezing Team content on phones', () => {
    expect(subscriptionPoolCss).toMatch(
      /@media \(max-width: 640px\)\s*\{[\s\S]*?\[role='dialog'\]\[aria-modal='true'\]:has\(\[data-dsh-codex-subscription-pool\]\)[^\{]*\{[^}]*width:\s*calc\(100vw - 16px\);[^}]*flex-direction:\s*column;/s,
    )
    expect(subscriptionPoolCss).toMatch(
      /\[role='dialog'\]\[aria-modal='true'\]:has\(\[data-dsh-codex-subscription-pool\]\)[^\{]*> nav\s*\{[^}]*width:\s*100%;[^}]*border-bottom:\s*1px solid var\(--dsw-alias-border-l2,/s,
    )
    expect(subscriptionPoolCss).toMatch(
      /\[role='dialog'\]\[aria-modal='true'\]:has\(\[data-dsh-codex-subscription-pool\]\)[^\{]*> nav > :last-child\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/s,
    )
    expect(subscriptionPoolCss).toMatch(
      /\[role='dialog'\]\[aria-modal='true'\]:has\(\[data-dsh-codex-subscription-pool\]\)[^\{]*> nav > :last-child > button\s*\{[^}]*min-height:\s*44px;/s,
    )
    expect(subscriptionPoolCss).toMatch(
      /\[role='dialog'\]\[aria-modal='true'\]:has\(\[data-dsh-codex-subscription-pool\]\)[^\{]*> nav > :last-child > button > span\s*\{[^}]*white-space:\s*normal;[^}]*word-break:\s*keep-all;[^}]*text-overflow:\s*clip;/s,
    )
    expect(subscriptionPoolCss).toMatch(
      /\[role='dialog'\]\[aria-modal='true'\]:has\(\[data-dsh-codex-subscription-pool\]\)[^\{]*> :not\(nav\)\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s,
    )
  })

  it('keeps account selection as a desktop master-detail workspace', () => {
    expect(css).toMatch(
      /\.page\s*\{[^}]*container-name:\s*team-settings;[^}]*container-type:\s*inline-size;/s,
    )
    expect(css).toMatch(
      /\.workspaceShell\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(132px,\s*152px\)\s+minmax\(0,\s*1fr\);/s,
    )
    expect(css).toMatch(/\.workspaceShell\s*\{[^}]*height:\s*clamp\(500px,\s*58vh,\s*580px\);/s)
    expect(css).toMatch(/\.workspaceMain\s*\{[^}]*overflow-y:\s*auto;/s)
    expect(css).toMatch(/\.workspaceBack\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;[^}]*margin:\s*auto 0 0;[^}]*border:\s*0;/s)
    expect(css).toMatch(/\.workspaceTitle\s*\{[^}]*font-size:\s*18px;[^}]*line-height:\s*24px;/s)
    expect(css).toMatch(/\.workspaceNavigation button\s*\{[^}]*font-size:\s*13px;[^}]*line-height:\s*19px;/s)
    expect(css).toMatch(
      /@container team-settings \(max-width: 460px\)\s*\{[\s\S]*?\.workspaceShell\s*\{[^}]*height:\s*auto;[^}]*grid-template-columns:\s*1fr;[^}]*overflow:\s*visible;/,
    )
    expect(css).toMatch(
      /\.accountWorkspace\s*\{[^}]*min-height:\s*640px;[^}]*grid-template-columns:\s*minmax\(260px,\s*\.82fr\)\s+minmax\(0,\s*1\.45fr\);/s,
    )
    expect(css).not.toMatch(
      /@container team-settings \(max-width: 720px\)\s*\{[\s\S]*?\.accountWorkspace\s*\{[^}]*grid-template-columns:\s*1fr;/,
    )
    expect(css).toMatch(
      /@container team-settings \(max-width: 640px\)\s*\{[\s\S]*?\.accountWorkspace\s*\{[^}]*grid-template-columns:\s*minmax\(220px,\s*\.82fr\)\s+minmax\(0,\s*1\.45fr\);/,
    )
    expect(css).toMatch(
      /@container team-settings \(max-width: 460px\)\s*\{[\s\S]*?\.accountWorkspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/,
    )
    expect(css).not.toMatch(/@media \(max-width: (?:720|980)px\)\s*\{[\s\S]*?\.accountWorkspace/)
  })

  it('keeps the approved flat account rail and rectangular Team actions', () => {
    expect(css).toMatch(/\.accountDirectory\s*\{[^}]*background:\s*var\(--team-workspace-layer\);/s)
    expect(css).toMatch(/\.page \.primaryAccountAction\s*\{[^}]*min-height:\s*36px;[^}]*border-radius:\s*9px;/s)
    expect(css).toMatch(/\.detailTitle\s*\{[^}]*font-size:\s*20px;[^}]*font-weight:\s*600;/s)
    expect(css).toMatch(/\.accountNavItem\[data-selected='true'\]\s*\{[^}]*border-color:\s*var\(--team-blue-strong\);[^}]*background:\s*var\(--team-selected-layer\);/s)
    expect(css).toMatch(/\.prototypeSection h3\s*\{[^}]*margin:\s*0 0 20px;[^}]*font-size:\s*15px;[^}]*line-height:\s*22px;/s)
    expect(css).toMatch(/\.capacityLine\s*\{[^}]*font-size:\s*13px;[^}]*line-height:\s*20px;/s)
    expect(css).toMatch(/\.page \.detailFooterButton\s*\{[^}]*min-height:\s*60px;/s)
  })

  it('centers the sole zero-account empty state in the detail pane', () => {
    expect(css).toMatch(
      /\.accountDetailEmpty\s*\{[^}]*min-height:\s*100%;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*text-align:\s*center;/s,
    )
  })

  it('disables every account-loading animation when reduced motion is requested', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.skeletonBlock,\s*\.quotaTrack\[data-loading='true'\]\s*\{\s*animation:\s*none;/s,
    )
  })

  it('uses the host theme elevation and border tokens for visible panel boundaries', () => {
    expect(css).toMatch(/--team-line:\s*var\(--dsw-alias-border-l1,/)
    expect(css).toMatch(/--team-line-strong:\s*var\(--dsw-alias-border-l2,/)
    expect(css).toMatch(/--team-layer:\s*var\(--dsw-alias-bg-layer-3,/)
    expect(css).toMatch(/--team-layer-soft:\s*var\(--dsw-alias-bg-layer-2,/)
    expect(css).not.toMatch(/--dsw-alias-border-(?:subtle|default)/)
    expect(css).toMatch(/--team-context-layer:\s*color-mix\([^;]+var\(--team-ink\)[^;]*\);/)
    expect(css).toMatch(/--team-workspace-layer:\s*color-mix\([^;]+var\(--team-ink\)[^;]*\);/)
    expect(css).toMatch(/--team-panel-line:\s*color-mix\([^;]+var\(--team-ink\)[^;]*\);/)
    expect(css).toMatch(/\.teamBar,\s*\.routingSummary\s*\{[^}]*border:\s*1px solid var\(--team-panel-line\);[^}]*background:\s*var\(--team-context-layer\);/s)
    expect(css).toMatch(/\.accountWorkspace\s*\{[^}]*border:\s*1px solid var\(--team-panel-line-strong\);[^}]*background:\s*var\(--team-workspace-layer\);/s)
    expect(css).toMatch(/\.accountDirectory\s*\{[^}]*border-right:\s*1px solid var\(--team-panel-line-strong\);[^}]*background:\s*var\(--team-workspace-layer\);/s)
    expect(css).toMatch(/\.quotaTrack\s*\{[^}]*background:\s*var\(--team-panel-line-strong\);/s)
    expect(css).toMatch(/\.quotaTrack\[data-unavailable='true'\]\s*\{[^}]*opacity:\s*1;/s)
    expect(subscriptionPoolCss).toMatch(/--subscription-pool-line:\s*var\(--dsw-alias-border-l2,/)
    expect(subscriptionPoolCss).not.toMatch(/--dsw-alias-border-subtle/)
  })

  it('pins the approved Team prototype palette inside the DSH dark-theme scope', () => {
    expect(css).toMatch(
      /:global\(body\[data-ds-dark-theme\]\) \.page\s*\{[^}]*--team-context-layer:\s*#272a2e;[^}]*--team-workspace-layer:\s*#2b2e32;/s,
    )
    expect(css).toMatch(/:global\(body\[data-ds-dark-theme\]\) \.page\s*\{[^}]*--team-line:\s*#383c42;[^}]*--team-line-strong:\s*#44484f;/s)
    expect(css).toMatch(/:global\(body\[data-ds-dark-theme\]\) \.page\s*\{[^}]*--team-skeleton-strong:\s*#474c53;/s)
    expect(css).toMatch(/:global\(body\[data-ds-dark-theme\]\) \.page\s*\{[^}]*--team-ink:\s*#f3f5f7;[^}]*--team-muted:\s*#afb5bd;[^}]*--team-faint:\s*#7f8791;/s)
    expect(css).toMatch(/:global\(body\[data-ds-dark-theme\]\) \.page\s*\{[^}]*--team-blue:\s*#8bb8ff;[^}]*--team-blue-strong:\s*#5d91ed;[^}]*--team-green:\s*#50d890;[^}]*--team-red:\s*#ff747b;/s)
    expect(css).toMatch(/:global\(body\[data-ds-dark-theme\]\) \.page\s*\{[^}]*--team-selected-layer:\s*#333c4c;/s)
    expect(css).toMatch(/\.accountNavItem\[data-selected='true'\]\s*\{[^}]*border-color:\s*var\(--team-blue-strong\);[^}]*background:\s*var\(--team-selected-layer\);/s)
    expect(css).toMatch(/\.page \.stopSharingButton\s*\{[^}]*background:\s*rgba\(255,\s*116,\s*123,\s*\.08\);/s)
    expect(subscriptionPoolCss).toMatch(
      /:global\(body\[data-ds-dark-theme\]\) \.page\s*\{[^}]*--subscription-pool-text:\s*#f3f5f7;[^}]*--subscription-pool-muted:\s*#afb5bd;[^}]*--subscription-pool-line:\s*#383c42;[^}]*--subscription-pool-blue:\s*#8bb8ff;/s,
    )
    expect(subscriptionPoolCss).toMatch(
      /\.tabs\s*\{[^}]*border-bottom:\s*1px solid var\(--subscription-pool-line,/s,
    )
    expect(subscriptionPoolCss).toMatch(
      /\.tab\s*\{[^}]*color:\s*var\(--subscription-pool-muted,/s,
    )
    expect(subscriptionPoolCss).toMatch(
      /\.tab\[data-active='true'\]\s*\{[^}]*color:\s*var\(--subscription-pool-text,/s,
    )
    expect(subscriptionPoolCss).toMatch(
      /\.tab\[data-active='true'\]::after\s*\{[^}]*background:\s*var\(--subscription-pool-blue,/s,
    )
  })

  it('keeps only major detail separators and the summary row rhythm', () => {
    expect(css).toMatch(/\.prototypeSection\s*\{[^}]*border-top:\s*1px solid var\(--team-line-strong\);/s)
    expect(css).toMatch(/\.compactSummaryList > div\s*\{[^}]*border-top:\s*1px solid var\(--team-line\);[^}]*padding:\s*10px 0;/s)
    expect(css).toMatch(/\.compactSummaryList > div:first-child\s*\{[^}]*border-top:\s*0;[^}]*padding-top:\s*0;/s)
    expect(css).toMatch(/\.teamActionPanel\.accountActionBar\s*\{[^}]*border:\s*0;/s)
    expect(css).toMatch(/\.detailFooter\s*\{[^}]*border-top:\s*1px solid var\(--team-line-strong\);/s)
  })

  it('matches the approved dark controls, status pill, and compact detail type', () => {
    expect(css).toMatch(/\.teamBar,\s*\.routingSummary\s*\{[^}]*border-radius:\s*11px;/s)
    expect(css).toMatch(/:global\(body\[data-ds-dark-theme\]\) \.accountNavItem:hover\s*\{[^}]*background:\s*#34383d;/s)
    expect(css).toMatch(/\.accountNavStatus\.pill\s*\{[^}]*border:\s*1px solid rgba\(139,\s*184,\s*255,\s*\.3\);[^}]*border-radius:\s*999px;/s)
    expect(css).toMatch(/\.compactSummaryTitle\s*\{[^}]*margin:\s*0 0 20px;[^}]*font-size:\s*15px;[^}]*font-weight:\s*600;[^}]*line-height:\s*22px;/s)
    expect(css).toMatch(/\.page \.accountActionButton\s*\{[^}]*min-height:\s*36px;/s)
    expect(css).toMatch(/\.page \.stopSharingButton\s*\{[^}]*border-color:\s*rgba\(255,\s*116,\s*123,\s*\.38\);[^}]*background:\s*rgba\(255,\s*116,\s*123,\s*\.08\);[^}]*color:\s*#ff9ca1;/s)
  })

  it('keeps the prototype account-list typography hierarchy', () => {
    expect(css).toMatch(/\.directoryTitle\s*\{[^}]*color:\s*var\(--team-faint\);[^}]*font-weight:\s*500;/s)
    expect(css).toMatch(/\.directoryHint\s*\{[^}]*font-size:\s*12px;[^}]*line-height:\s*18px;/s)
    expect(css).toMatch(/\.directoryGroupHeader\s*\{[^}]*font-size:\s*11px;[^}]*line-height:\s*16px;/s)
    expect(css).toMatch(/\.directoryGroupTitle\s*\{[^}]*font-size:\s*11px;[^}]*font-weight:\s*650;[^}]*line-height:\s*16px;/s)
    expect(css).toMatch(/\.accountNavLabel\s*\{[^}]*font-size:\s*13px;[^}]*font-weight:\s*600;[^}]*line-height:\s*18px;/s)
    expect(css).toMatch(/\.accountNavOwner\s*\{[^}]*font-size:\s*13px;[^}]*line-height:\s*18px;/s)
    expect(css).toMatch(/\.accountNavStatus\s*\{[^}]*font-size:\s*11px;[^}]*line-height:\s*16px;/s)
  })

  it('keeps the approved subscription-pool heading and tab rhythm', () => {
    expect(subscriptionPoolCss).toMatch(/\.header\s*\{[^}]*padding-bottom:\s*26px;/s)
    expect(subscriptionPoolCss).toMatch(/\.title\s*\{[^}]*font-size:\s*30px;[^}]*font-weight:\s*680;[^}]*line-height:\s*36px;/s)
    expect(subscriptionPoolCss).toMatch(/\.intro\s*\{[^}]*margin:\s*10px 0 0;/s)
    expect(subscriptionPoolCss).toMatch(/\.tabs\s*\{[^}]*gap:\s*24px;/s)
    expect(subscriptionPoolCss).toMatch(/\.tab\s*\{[^}]*padding:\s*0 2px 12px;/s)
    expect(subscriptionPoolCss).toMatch(/\.content\s*\{[^}]*padding-top:\s*18px;/s)
  })

  it('keeps the prototype usage hierarchy instead of equal metric tiles', () => {
    expect(css).toMatch(/\.usageRefresh\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;[^}]*padding:\s*0;/s)
    expect(css).toMatch(/\.usageHeading\s*\{[^}]*font-size:\s*19px;[^}]*line-height:\s*26px;/s)
    expect(css).toMatch(/\.usageCards\s*\{[^}]*border:\s*1px solid var\(--team-line-strong\);[^}]*border-radius:\s*10px;[^}]*overflow:\s*hidden;/s)
    expect(css).toMatch(/\.usageCard\s*\{[^}]*padding:\s*16px;[^}]*background:\s*color-mix\(/s)
    expect(css).toMatch(/\.usageMetric:first-child\s+dd\s*\{[^}]*font-size:\s*clamp\(24px,\s*4cqi,\s*32px\);/s)
    expect(css).toMatch(/\.usageMetric:not\(:first-child\)\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between;[^}]*padding:\s*7px 0;/s)
    expect(css).not.toMatch(/\.usageMetric:not\(:first-child\)\s*\{[^}]*border-top:/s)
    expect(css).toMatch(/\.usageMetric dd\s*\{[^}]*min-width:\s*0;[^}]*white-space:\s*normal;/s)
    expect(css).toMatch(/\.usageMetric:first-child dd\s*\{[^}]*white-space:\s*nowrap;/s)
  })

  it('keeps the prototype compact Team bar and detail rhythm', () => {
    expect(css).toMatch(/\.teamIdentity \.hint\s*\{[^}]*font-size:\s*12px;[^}]*line-height:\s*18px;/s)
    expect(css).toMatch(/\.teamSettingsTrigger\s*\{[^}]*font-size:\s*13px;/s)
    expect(css).toMatch(/\.directoryHeader\s*\{[^}]*padding:\s*20px 20px 21px;/s)
    expect(css).toMatch(/\.page \.addAccountButton\s*\{[^}]*min-height:\s*32px;[^}]*padding:\s*6px 11px;/s)
    expect(css).toMatch(/\.compactSummaryList > div\s*\{[^}]*gap:\s*20px;/s)
    expect(css).toMatch(/\.compactRecentUsage\s*\{[^}]*padding-bottom:\s*22px;/s)
    expect(css).toMatch(/\.compactRecentLine\s*\{[^}]*font-size:\s*13px;[^}]*line-height:\s*20px;/s)
  })

  it('stacks owner usage groups only when the settings slot is genuinely narrow', () => {
    expect(css).toMatch(
      /@container team-settings \(max-width: 620px\)\s*\{[\s\S]*?\.usageCards\[data-owner='true'\]\s*\{[^}]*grid-template-columns:\s*1fr;/,
    )
    expect(css).toMatch(/\.usageCard \+ \.usageCard\s*\{[^}]*border-top:\s*1px solid var\(--team-line\);[^}]*border-left:\s*0;[^}]*padding:\s*16px;/s)
  })

  it('keeps the invitation entry action on one line', () => {
    expect(css).toMatch(
      /\.workspaceSectionHeader\s*>\s*button\s*\{[^}]*white-space:\s*nowrap;/s,
    )
    expect(css).toMatch(
      /\.usageHeader\s*>\s*button\s*\{[^}]*white-space:\s*nowrap;/s,
    )
  })

  it('gives the invite expiry control a visible frame', () => {
    expect(css).toMatch(
      /\.select\s*\{[^}]*border:\s*1px solid var\(--team-line-strong\);/s,
    )
  })
})
