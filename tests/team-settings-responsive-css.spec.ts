import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  new URL('../src/client/team/TeamSettings.module.css', import.meta.url),
  'utf8',
)

describe('Team Settings responsive container contract', () => {
  it('uses the DSH settings slot width as its responsive boundary', () => {
    expect(css).toMatch(
      /\.page\s*\{[^}]*container-name:\s*team-settings;[^}]*container-type:\s*inline-size;/s,
    )
    expect(css).toMatch(
      /\.workspaceShell\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(132px,\s*152px\)\s+minmax\(0,\s*1fr\);/s,
    )
    expect(css).toMatch(
      /@container team-settings \(max-width: 460px\)\s*\{[\s\S]*?\.workspaceShell\s*\{[^}]*grid-template-columns:\s*1fr;/,
    )
  })

  it('keeps the desktop workspace at a stable, taller height while letting mobile grow naturally', () => {
    expect(css).toMatch(
      /\.workspaceShell\s*\{[^}]*height:\s*clamp\(500px,\s*58vh,\s*580px\);/s,
    )
    expect(css).toMatch(/\.workspaceMain\s*\{[^}]*overflow-y:\s*auto;/s)
    expect(css).toMatch(
      /@container team-settings \(max-width: 460px\)\s*\{[\s\S]*?\.workspaceShell\s*\{[^}]*height:\s*auto;/,
    )
  })

  it('uses a compact type scale inside the team settings workspace', () => {
    expect(css).toMatch(/\.workspaceTitle\s*\{[^}]*font-size:\s*18px;/s)
    expect(css).toMatch(/\.workspaceNavigation button\s*\{[^}]*font-size:\s*13px;/s)
    expect(css).toMatch(/\.workspaceTeamName\s*\{[^}]*font-size:\s*clamp\(21px,\s*3\.6cqi,\s*24px\);/s)
    expect(css).toMatch(/\.workspaceSectionTitle\s*\{[^}]*font-size:\s*19px;/s)
    expect(css).toMatch(/\.usageHeading\s*\{[^}]*font-size:\s*19px;/s)
    expect(css).toMatch(/\.usageCardTitle\s*\{[^}]*font-size:\s*14px;/s)
  })

  it('keeps the prototype usage hierarchy instead of equal metric tiles', () => {
    expect(css).toMatch(/\.usageCards\s*\{[^}]*border-top:\s*1px solid var\(--team-line-strong\);[^}]*border-bottom:\s*1px solid var\(--team-line-strong\);/s)
    expect(css).toMatch(/\.usageMetric:first-child\s+dd\s*\{[^}]*font-size:\s*clamp\(24px,\s*4cqi,\s*32px\);/s)
    expect(css).toMatch(/\.usageMetric:not\(:first-child\)\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between;/s)
  })

  it('uses structural rules without boxing every usage row', () => {
    expect(css).toMatch(/--team-line:\s*color-mix\(in srgb, var\(--team-ink\) 18%, transparent\);/)
    expect(css).toMatch(/--team-line-strong:\s*color-mix\(in srgb, var\(--team-ink\) 30%, transparent\);/)
    expect(css).toMatch(/\.workspaceShell\s*\{[^}]*border:\s*1px solid var\(--team-line-strong\);[^}]*border-radius:\s*14px;/s)
    expect(css).toMatch(/\.workspaceRail\s*\{[^}]*border-right:\s*1px solid var\(--team-line-strong\);/s)
    expect(css).toMatch(/\.workspaceHeader\s*\{[^}]*border-bottom:\s*1px solid var\(--team-line-strong\);/s)
    expect(css).toMatch(/\.usageCardHeader\s*\{[^}]*border-bottom:\s*0;/s)
    expect(css).toMatch(/\.usageMetric:not\(:first-child\)\s*\{[^}]*border-top:\s*0;/s)
    expect(css).toMatch(/\.usageCardTitle\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*nowrap;/s)
    expect(css).toMatch(/\.usageMetric dt\s*\{[^}]*white-space:\s*nowrap;/s)
    expect(css).toMatch(/\.usageMetric dd\s*\{[^}]*white-space:\s*nowrap;/s)
  })

  it('does not repeat the workspace header divider above member and invite sections', () => {
    expect(css).toMatch(/\.workspaceSection\s*\{[^}]*border-top:\s*0;[^}]*padding-top:\s*0;/s)
  })

  it('keeps the rail return action quiet and pinned to the lower-left', () => {
    expect(css).toMatch(/\.workspaceBack\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;[^}]*margin:\s*auto 0 0;[^}]*border:\s*0;[^}]*background:\s*transparent;/s)
  })

  it('stacks owner usage groups only when the settings slot is genuinely narrow', () => {
    expect(css).toMatch(
      /@container team-settings \(max-width: 460px\)\s*\{[\s\S]*?\.usageCards\[data-owner='true'\]\s*\{[^}]*grid-template-columns:\s*1fr;/,
    )
  })

  it('keeps compact header actions intentional', () => {
    expect(css).toMatch(
      /\.workspaceSectionHeader\s*>\s*button\s*\{[^}]*min-height:\s*36px;[^}]*padding:\s*7px 12px;[^}]*font-size:\s*13px;[^}]*white-space:\s*nowrap;/s,
    )
    expect(css).toMatch(
      /\.usageRefresh\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;[^}]*padding:\s*0;/s,
    )
  })

  it('keeps member and invitation actions at the upper-right until the workspace becomes mobile', () => {
    const mediumContainer = css.slice(
      css.indexOf('@container team-settings (max-width: 620px)'),
      css.indexOf('@container team-settings (max-width: 460px)'),
    )
    const narrowViewport = css.slice(
      css.indexOf('@media (max-width: 720px)'),
      css.indexOf('@media (max-width: 420px)'),
    )

    expect(mediumContainer).not.toContain('.workspaceSectionHeader,')
    expect(narrowViewport).not.toContain('.workspaceSectionHeader,')
    expect(css).toMatch(
      /@container team-settings \(max-width: 460px\)\s*\{[\s\S]*?\.workspaceSectionHeader\s*\{[^}]*align-items:\s*stretch;[^}]*flex-direction:\s*column;/,
    )
  })
})
