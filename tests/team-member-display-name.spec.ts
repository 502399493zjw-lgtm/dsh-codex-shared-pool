import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendTeamMemberDisplayNameCollisionSuffix,
  fallbackTeamMemberDisplayName,
  MAX_TEAM_MEMBER_DISPLAY_NAME_SCALARS,
  normalizeTeamMemberDisplayName,
  TEAM_MEMBER_DISPLAY_NAME_UNICODE_VERSION,
} from '../src/team/member-display-name.ts'

const normalize = (value: string) => normalizeTeamMemberDisplayName(value, 'displayName')

describe('Team member display-name Unicode profile', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pins the profile to Unicode 15.1.0 without using the runtime normalizer', () => {
    expect(TEAM_MEMBER_DISPLAY_NAME_UNICODE_VERSION).toBe('15.1.0')
    vi.spyOn(String.prototype, 'normalize').mockImplementation(() => {
      throw new Error('runtime Unicode normalization must not be used')
    })

    expect(normalize('Ｆｒｉｅｎｄ')).toEqual({
      displayName: 'Friend',
      displayNameKey: 'friend',
    })
  })

  it('returns an NFKC display value and an NFKC_Casefold comparison key', () => {
    expect(normalize('e\u0301')).toEqual({
      displayName: 'é',
      displayNameKey: 'é',
    })
    expect(normalize('① Straße Σς İ')).toEqual({
      displayName: '1 Straße Σς İ',
      displayNameKey: '1 strasse σσ i\u0307',
    })
  })

  it('uses the fixed White_Space property to trim boundaries while permitting interior spaces', () => {
    expect(normalize('\u3000Live\u00A0Member\u3000')).toEqual({
      displayName: 'Live Member',
      displayNameKey: 'live member',
    })
    expect(normalize('\u00A8')).toEqual({
      displayName: ' \u0308',
      displayNameKey: ' \u0308',
    })
  })

  it.each([
    ['Control', 'A\u0000B'],
    ['Control', '\tName'],
    ['Control', 'Name\n'],
    ['Default_Ignorable_Code_Point', 'A\u200BB'],
    ['Default_Ignorable_Code_Point', `A${String.fromCodePoint(0xE0100)}B`],
    ['Bidi_Control', 'A\u202EB'],
  ])('rejects fixed Unicode 15.1 %s code points', (property, value) => {
    expect(() => normalize(value)).toThrow(new RegExp(property, 'iu'))
  })

  it('rejects lone UTF-16 surrogates but treats assigned and unassigned 15.1 scalars as identity', () => {
    expect(() => normalize('A\uD800B')).toThrow(/surrogate/iu)
    expect(() => normalize('A\uDC00B')).toThrow(/surrogate/iu)

    const unicode151Ideograph = String.fromCodePoint(0x2EBF0)
    expect(normalize(unicode151Ideograph)).toEqual({
      displayName: unicode151Ideograph,
      displayNameKey: unicode151Ideograph,
    })
    expect(normalize('\u0378')).toEqual({
      displayName: '\u0378',
      displayNameKey: '\u0378',
    })
    // U+1C89 was unassigned in Unicode 15.1 but receives a lowercase mapping
    // in newer Unicode releases. The pinned profile must keep it unchanged.
    expect(normalize('\u1C89')).toEqual({
      displayName: '\u1C89',
      displayNameKey: '\u1C89',
    })
  })

  it('requires 1 to 120 Unicode scalar values after NFKC', () => {
    expect(MAX_TEAM_MEMBER_DISPLAY_NAME_SCALARS).toBe(120)
    expect(normalize('a'.repeat(120)).displayName).toHaveLength(120)
    expect(normalize('A').displayNameKey).not.toBe('')
    expect(() => normalize('')).toThrow(/1 to 120 Unicode scalar/iu)
    expect(() => normalize('a'.repeat(121))).toThrow(/1 to 120 Unicode scalar/iu)
    expect(() => normalize('㍿'.repeat(31))).toThrow(/1 to 120 Unicode scalar/iu)
    expect(Array.from(normalize(String.fromCodePoint(0x1F600).repeat(120)).displayName)).toHaveLength(120)
    expect(normalize('\u1100\u1161\u11A8'.repeat(41)).displayName).toBe('각'.repeat(41))
  })

  it('trims arbitrarily long boundary whitespace while bounding the normalizable core', () => {
    expect(normalize(`${'\u3000'.repeat(4_096)}Name${'\u00A0'.repeat(4_096)}`)).toEqual({
      displayName: 'Name',
      displayNameKey: 'name',
    })
    expect(() => normalize(`a${'\u0300'.repeat(480)}`)).toThrow(/safe normalization bound/iu)
    expect(() => normalize(`a${'\u3000'.repeat(480)}b`)).toThrow(/safe normalization bound/iu)
  })

  it('implements algorithmic Hangul composition, canonical ordering, and canonical blocking', () => {
    expect(normalize('\u1100\u1161\u11A8')).toEqual({ displayName: '각', displayNameKey: '각' })
    expect(normalize('a\u0315\u0300')).toEqual({ displayName: 'à\u0315', displayNameKey: 'à\u0315' })
    expect(normalize('A\u0305\u0301')).toEqual({ displayName: 'A\u0305\u0301', displayNameKey: 'a\u0305\u0301' })
  })

  it('provides normalized deterministic migration fallbacks and collision suffixes', () => {
    expect(fallbackTeamMemberDisplayName('member-1')).toEqual(fallbackTeamMemberDisplayName('member-1'))
    expect(fallbackTeamMemberDisplayName('member-1')).not.toEqual(fallbackTeamMemberDisplayName('member-2'))
    expect(fallbackTeamMemberDisplayName('member-1').displayName).toMatch(/^成员 · [a-z2-7]{10}$/u)
    expect(fallbackTeamMemberDisplayName('').displayName).toMatch(/^成员 · [a-z2-7]{10}$/u)
    expect(appendTeamMemberDisplayNameCollisionSuffix('Ｆｒｉｅｎｄ', 2)).toEqual({
      displayName: 'Friend · 2',
      displayNameKey: 'friend · 2',
    })
    expect(appendTeamMemberDisplayNameCollisionSuffix('a'.repeat(120), 12).displayName).toBe(`${'a'.repeat(115)} · 12`)
    expect(() => appendTeamMemberDisplayNameCollisionSuffix('Friend', 1)).toThrow(/ordinal/iu)
  })
})
