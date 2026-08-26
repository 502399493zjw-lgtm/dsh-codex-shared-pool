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

  it('keeps the prototype usage hierarchy instead of equal metric tiles', () => {
    expect(css).toMatch(/\.usageCards\s*\{[^}]*border-top:\s*1px solid var\(--team-line-strong\);[^}]*border-bottom:\s*1px solid var\(--team-line-strong\);/s)
    expect(css).toMatch(/\.usageMetric:first-child\s+dd\s*\{[^}]*font-size:\s*clamp\(24px,\s*4cqi,\s*32px\);/s)
    expect(css).toMatch(/\.usageMetric:not\(:first-child\)\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between;/s)
  })

  it('uses visible structural rules to separate the workspace and usage rows', () => {
    expect(css).toMatch(/--team-line:\s*color-mix\(in srgb, var\(--team-ink\) 18%, transparent\);/)
    expect(css).toMatch(/--team-line-strong:\s*color-mix\(in srgb, var\(--team-ink\) 30%, transparent\);/)
    expect(css).toMatch(/\.workspaceShell\s*\{[^}]*border:\s*1px solid var\(--team-line-strong\);[^}]*border-top:\s*0;[^}]*border-radius:\s*0 0 14px 14px;/s)
    expect(css).toMatch(/\.workspaceRail\s*\{[^}]*border-right:\s*1px solid var\(--team-line-strong\);/s)
    expect(css).toMatch(/\.workspaceHeader\s*\{[^}]*border-bottom:\s*1px solid var\(--team-line-strong\);/s)
    expect(css).toMatch(/\.usageCardHeader\s*\{[^}]*border-bottom:\s*1px solid var\(--team-line\);/s)
    expect(css).toMatch(/\.usageMetric:not\(:first-child\)\s*\{[^}]*border-top:\s*1px solid var\(--team-line\);/s)
    expect(css).toMatch(/\.usageCardTitle\s*\{[^}]*overflow-wrap:\s*anywhere;/s)
    expect(css).toMatch(/\.usageMetric dt\s*\{[^}]*white-space:\s*nowrap;/s)
    expect(css).toMatch(/\.usageMetric dd\s*\{[^}]*white-space:\s*nowrap;/s)
  })

  it('does not repeat the workspace header divider above member and invite sections', () => {
    expect(css).toMatch(/\.workspaceSection\s*\{[^}]*border-top:\s*0;[^}]*padding-top:\s*0;/s)
  })

  it('keeps the rail return action visually compact with a full touch target', () => {
    expect(css).toMatch(/\.workspaceBack\s*\{[^}]*width:\s*44px;[^}]*min-height:\s*44px;[^}]*justify-content:\s*center;/s)
  })

  it('stacks owner usage groups only when the settings slot is genuinely narrow', () => {
    expect(css).toMatch(
      /@container team-settings \(max-width: 620px\)\s*\{[\s\S]*?\.usageCards\[data-owner='true'\]\s*\{[^}]*grid-template-columns:\s*1fr;/,
    )
  })

  it('keeps the invitation entry action on one line', () => {
    expect(css).toMatch(
      /\.workspaceSectionHeader\s*>\s*button\s*\{[^}]*min-height:\s*36px;[^}]*padding:\s*7px 12px;[^}]*font-size:\s*13px;[^}]*white-space:\s*nowrap;/s,
    )
    expect(css).toMatch(
      /\.usageHeader\s*>\s*button\s*\{[^}]*white-space:\s*nowrap;/s,
    )
  })
})
