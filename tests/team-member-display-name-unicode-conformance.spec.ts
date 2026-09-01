import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { TEAM_MEMBER_NFKC_CASEFOLD_MAPPINGS } from '../src/team/member-display-name-unicode-15.1.0.generated.ts'
import {
  TEAM_MEMBER_DISPLAY_NAME_UNICODE_VERSION,
  TEAM_MEMBER_UNICODE_151_CONFORMANCE,
} from '../src/team/member-display-name.ts'

interface NormalizationConformanceFixture {
  readonly normalizationTestSha256: string
  readonly unicodeVersion: string
  readonly vectors: readonly (readonly [string, string, string, string, string])[]
}

function fromHexSequence(sequence: string): string {
  if (sequence === '') return ''
  return sequence.split(' ').map(value => String.fromCodePoint(Number.parseInt(value, 16))).join('')
}

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/team-member-unicode-15.1.0-conformance.generated.json', import.meta.url),
  'utf8',
)) as NormalizationConformanceFixture

describe('Team member Unicode 15.1 conformance', () => {
  it('passes every official NormalizationTest.txt NFC and NFKC relation', { timeout: 60_000 }, () => {
    expect(fixture.unicodeVersion).toBe(TEAM_MEMBER_DISPLAY_NAME_UNICODE_VERSION)
    expect(fixture.normalizationTestSha256).toBe('871238e37e3be0696ec2bd0891119a041b052da1a84485eda05a5438724b223e')

    for (const vector of fixture.vectors) {
      const [source, nfc, nfd, nfkc, nfkd] = vector.map(fromHexSequence)
      expect(TEAM_MEMBER_UNICODE_151_CONFORMANCE.normalizeNfc(source)).toBe(nfc)
      expect(TEAM_MEMBER_UNICODE_151_CONFORMANCE.normalizeNfc(nfc)).toBe(nfc)
      expect(TEAM_MEMBER_UNICODE_151_CONFORMANCE.normalizeNfc(nfd)).toBe(nfc)
      expect(TEAM_MEMBER_UNICODE_151_CONFORMANCE.normalizeNfc(nfkc)).toBe(nfkc)
      expect(TEAM_MEMBER_UNICODE_151_CONFORMANCE.normalizeNfc(nfkd)).toBe(nfkc)
      expect(TEAM_MEMBER_UNICODE_151_CONFORMANCE.normalizeNfkc(source)).toBe(nfkc)
      expect(TEAM_MEMBER_UNICODE_151_CONFORMANCE.normalizeNfkc(nfc)).toBe(nfkc)
      expect(TEAM_MEMBER_UNICODE_151_CONFORMANCE.normalizeNfkc(nfd)).toBe(nfkc)
      expect(TEAM_MEMBER_UNICODE_151_CONFORMANCE.normalizeNfkc(nfkc)).toBe(nfkc)
      expect(TEAM_MEMBER_UNICODE_151_CONFORMANCE.normalizeNfkc(nfkd)).toBe(nfkc)
    }
  })

  it('applies every explicit DerivedNormalizationProps NFKC_CF mapping', { timeout: 60_000 }, () => {
    for (const [start, end, ...mapping] of TEAM_MEMBER_NFKC_CASEFOLD_MAPPINGS) {
      const expected = mapping.map(codePoint => String.fromCodePoint(codePoint)).join('')
      for (let codePoint = start; codePoint <= end; codePoint += 1) {
        expect(TEAM_MEMBER_UNICODE_151_CONFORMANCE.normalizeNfkcCasefold(String.fromCodePoint(codePoint))).toBe(expected)
      }
    }
  })
})
