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

  it('stacks owner usage groups only when the settings slot is genuinely narrow', () => {
    expect(css).toMatch(
      /@container team-settings \(max-width: 520px\)\s*\{[\s\S]*?\.usageCards\[data-owner='true'\]\s*\{[^}]*grid-template-columns:\s*1fr;/,
    )
  })

  it('keeps the invitation entry action on one line', () => {
    expect(css).toMatch(
      /\.workspaceSectionHeader\s*>\s*button\s*\{[^}]*white-space:\s*nowrap;/s,
    )
    expect(css).toMatch(
      /\.usageHeader\s*>\s*button\s*\{[^}]*white-space:\s*nowrap;/s,
    )
  })
})
