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
      /@container team-settings \(max-width: 800px\)\s*\{[\s\S]*?\.workspaceShell\s*\{[^}]*grid-template-columns:\s*1fr;/,
    )
  })

  it('stacks owner usage cards when the settings slot is narrow', () => {
    expect(css).toMatch(
      /@container team-settings \(max-width: 620px\)\s*\{[\s\S]*?\.usageCards\[data-owner='true'\]\s*\{[^}]*grid-template-columns:\s*1fr;/,
    )
  })

  it('keeps the invitation entry action on one line', () => {
    expect(css).toMatch(
      /\.workspaceSectionHeader\s*>\s*button\s*\{[^}]*white-space:\s*nowrap;/s,
    )
  })
})
