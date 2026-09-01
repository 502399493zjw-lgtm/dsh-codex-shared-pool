import { createHash } from 'node:crypto'
import {
  GENERATED_TEAM_MEMBER_UNICODE_VERSION,
  TEAM_MEMBER_BIDI_CONTROL_RANGES,
  TEAM_MEMBER_CANONICAL_COMBINING_CLASS_RANGES,
  TEAM_MEMBER_COMPOSITIONS,
  TEAM_MEMBER_CONTROL_RANGES,
  TEAM_MEMBER_DECOMPOSITIONS,
  TEAM_MEMBER_DEFAULT_IGNORABLE_RANGES,
  TEAM_MEMBER_NFKC_CASEFOLD_MAPPINGS,
  TEAM_MEMBER_WHITE_SPACE_RANGES,
} from './member-display-name-unicode-15.1.0.generated.js'

export const TEAM_MEMBER_DISPLAY_NAME_UNICODE_VERSION = GENERATED_TEAM_MEMBER_UNICODE_VERSION
export const MAX_TEAM_MEMBER_DISPLAY_NAME_SCALARS = 120

export interface NormalizedTeamMemberDisplayName {
  readonly displayName: string
  readonly displayNameKey: string
}

type CodePointRange = readonly [number, number]
type Decomposition = {
  readonly compatibility: boolean
  readonly mapping: readonly number[]
}

const MAX_CODE_POINT = 0x10FFFF
const HIGH_SURROGATE_START = 0xD800
const HIGH_SURROGATE_END = 0xDBFF
const LOW_SURROGATE_START = 0xDC00
const LOW_SURROGATE_END = 0xDFFF

const HANGUL_S_BASE = 0xAC00
const HANGUL_L_BASE = 0x1100
const HANGUL_V_BASE = 0x1161
const HANGUL_T_BASE = 0x11A7
const HANGUL_L_COUNT = 19
const HANGUL_V_COUNT = 21
const HANGUL_T_COUNT = 28
const HANGUL_N_COUNT = HANGUL_V_COUNT * HANGUL_T_COUNT
const HANGUL_S_COUNT = HANGUL_L_COUNT * HANGUL_N_COUNT

const COMPOSITION_KEY_RADIX = MAX_CODE_POINT + 1
const FALLBACK_HASH_DOMAIN = 'dsh-team-member-display-name-fallback\0'
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
// Unicode 15.1 NFD expands any one scalar to at most four scalars. Therefore,
// an untrimmed core longer than 4 * 120 cannot normalize to a valid value.
const MAX_NORMALIZABLE_DISPLAY_NAME_INPUT_SCALARS = 4 * MAX_TEAM_MEMBER_DISPLAY_NAME_SCALARS

const decompositions = new Map<number, Decomposition>()
for (const row of TEAM_MEMBER_DECOMPOSITIONS) {
  const [codePoint, compatibility, ...mapping] = row
  decompositions.set(codePoint!, { compatibility: compatibility === 1, mapping })
}

const compositions = new Map<number, number>()
for (const [first, second, composite] of TEAM_MEMBER_COMPOSITIONS) {
  compositions.set(first * COMPOSITION_KEY_RADIX + second, composite)
}

function isInRanges(ranges: readonly CodePointRange[], codePoint: number): boolean {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const [start, end] = ranges[middle]!
    if (codePoint < start) high = middle - 1
    else if (codePoint > end) low = middle + 1
    else return true
  }
  return false
}

function canonicalCombiningClass(codePoint: number): number {
  let low = 0
  let high = TEAM_MEMBER_CANONICAL_COMBINING_CLASS_RANGES.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const [start, end, combiningClass] = TEAM_MEMBER_CANONICAL_COMBINING_CLASS_RANGES[middle]!
    if (codePoint < start) high = middle - 1
    else if (codePoint > end) low = middle + 1
    else return combiningClass
  }
  return 0
}

function scalarValues(value: string, field: string, maximumScalars?: number): number[] {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)

  const codePoints: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index)
    if (first >= HIGH_SURROGATE_START && first <= HIGH_SURROGATE_END) {
      const second = value.charCodeAt(index + 1)
      if (!(second >= LOW_SURROGATE_START && second <= LOW_SURROGATE_END)) {
        throw new TypeError(`${field} contains an unpaired UTF-16 surrogate`)
      }
      codePoints.push(((first - HIGH_SURROGATE_START) << 10) + second - LOW_SURROGATE_START + 0x10000)
      index += 1
    } else {
      if (first >= LOW_SURROGATE_START && first <= LOW_SURROGATE_END) {
        throw new TypeError(`${field} contains an unpaired UTF-16 surrogate`)
      }
      codePoints.push(first)
    }
    if (maximumScalars !== undefined && codePoints.length > maximumScalars) {
      throw new TypeError(`${field} exceeds the ${maximumScalars}-scalar raw safety limit`)
    }
  }
  return codePoints
}

function stringFromScalarValues(codePoints: readonly number[]): string {
  return codePoints.map(codePoint => String.fromCodePoint(codePoint)).join('')
}

function assertNoForbiddenCodePoints(codePoints: readonly number[], field: string, stage: 'input' | 'after NFKC'): void {
  for (const codePoint of codePoints) {
    let property: string | undefined
    if (isInRanges(TEAM_MEMBER_BIDI_CONTROL_RANGES, codePoint)) property = 'Bidi_Control'
    else if (isInRanges(TEAM_MEMBER_CONTROL_RANGES, codePoint)) property = 'Control'
    else if (isInRanges(TEAM_MEMBER_DEFAULT_IGNORABLE_RANGES, codePoint)) property = 'Default_Ignorable_Code_Point'
    if (property !== undefined) {
      throw new TypeError(`${field} ${stage} contains Unicode 15.1 ${property} U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`)
    }
  }
}

function appendDecomposition(output: number[], codePoint: number, compatibility: boolean): void {
  const hangulIndex = codePoint - HANGUL_S_BASE
  if (hangulIndex >= 0 && hangulIndex < HANGUL_S_COUNT) {
    const leading = HANGUL_L_BASE + Math.floor(hangulIndex / HANGUL_N_COUNT)
    const vowel = HANGUL_V_BASE + Math.floor((hangulIndex % HANGUL_N_COUNT) / HANGUL_T_COUNT)
    const trailingIndex = hangulIndex % HANGUL_T_COUNT
    output.push(leading, vowel)
    if (trailingIndex !== 0) output.push(HANGUL_T_BASE + trailingIndex)
    return
  }

  const decomposition = decompositions.get(codePoint)
  if (decomposition === undefined || (!compatibility && decomposition.compatibility)) {
    output.push(codePoint)
    return
  }
  for (const mappedCodePoint of decomposition.mapping) {
    appendDecomposition(output, mappedCodePoint, compatibility)
  }
}

function canonicallyOrder(codePoints: readonly number[]): number[] {
  const output: number[] = []
  let combiningSequence: number[] = []
  const flushCombiningSequence = (): void => {
    if (combiningSequence.length === 0) return
    combiningSequence.sort((left, right) => canonicalCombiningClass(left) - canonicalCombiningClass(right))
    output.push(...combiningSequence)
    combiningSequence = []
  }

  for (const codePoint of codePoints) {
    const combiningClass = canonicalCombiningClass(codePoint)
    if (combiningClass === 0) {
      flushCombiningSequence()
      output.push(codePoint)
    } else {
      combiningSequence.push(codePoint)
    }
  }
  flushCombiningSequence()
  return output
}

function composePair(first: number, second: number): number | undefined {
  const leadingIndex = first - HANGUL_L_BASE
  if (leadingIndex >= 0 && leadingIndex < HANGUL_L_COUNT) {
    const vowelIndex = second - HANGUL_V_BASE
    if (vowelIndex >= 0 && vowelIndex < HANGUL_V_COUNT) {
      return HANGUL_S_BASE + (leadingIndex * HANGUL_V_COUNT + vowelIndex) * HANGUL_T_COUNT
    }
  }

  const syllableIndex = first - HANGUL_S_BASE
  if (syllableIndex >= 0 && syllableIndex < HANGUL_S_COUNT && syllableIndex % HANGUL_T_COUNT === 0) {
    const trailingIndex = second - HANGUL_T_BASE
    if (trailingIndex > 0 && trailingIndex < HANGUL_T_COUNT) return first + trailingIndex
  }

  return compositions.get(first * COMPOSITION_KEY_RADIX + second)
}

function canonicallyCompose(codePoints: readonly number[]): number[] {
  if (codePoints.length === 0) return []

  const firstCodePoint = codePoints[0]!
  const output: number[] = [firstCodePoint]
  let starterPosition = 0
  let starter = firstCodePoint
  let lastCombiningClass = 0

  for (let index = 1; index < codePoints.length; index += 1) {
    const codePoint = codePoints[index]!
    const combiningClass = canonicalCombiningClass(codePoint)
    const composite = composePair(starter, codePoint)
    if (composite !== undefined && (lastCombiningClass < combiningClass || lastCombiningClass === 0)) {
      output[starterPosition] = composite
      starter = composite
      continue
    }

    if (combiningClass === 0) {
      starterPosition = output.length
      starter = codePoint
    }
    output.push(codePoint)
    lastCombiningClass = combiningClass
  }
  return output
}

function normalizeScalarValues(codePoints: readonly number[], compatibility: boolean): number[] {
  const decomposed: number[] = []
  for (const codePoint of codePoints) appendDecomposition(decomposed, codePoint, compatibility)
  return canonicallyCompose(canonicallyOrder(decomposed))
}

function nfkcCasefoldMapping(codePoint: number): readonly number[] | undefined {
  let low = 0
  let high = TEAM_MEMBER_NFKC_CASEFOLD_MAPPINGS.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const row = TEAM_MEMBER_NFKC_CASEFOLD_MAPPINGS[middle]!
    if (codePoint < row[0]!) high = middle - 1
    else if (codePoint > row[1]!) low = middle + 1
    else return row.slice(2)
  }
  return undefined
}

function nfkcCasefold(codePoints: readonly number[]): number[] {
  const casefolded: number[] = []
  for (const codePoint of codePoints) {
    const mapping = nfkcCasefoldMapping(codePoint)
    if (mapping === undefined) casefolded.push(codePoint)
    else casefolded.push(...mapping)
  }
  return normalizeScalarValues(casefolded, false)
}

/** @internal Fixed-data hooks used only by the Unicode conformance suite. */
export const TEAM_MEMBER_UNICODE_151_CONFORMANCE = Object.freeze({
  normalizeNfc(value: string): string {
    return stringFromScalarValues(normalizeScalarValues(scalarValues(value, 'NFC conformance value'), false))
  },
  normalizeNfkc(value: string): string {
    return stringFromScalarValues(normalizeScalarValues(scalarValues(value, 'NFKC conformance value'), true))
  },
  normalizeNfkcCasefold(value: string): string {
    return stringFromScalarValues(nfkcCasefold(scalarValues(value, 'NFKC_Casefold conformance value')))
  },
})

function trimmedDisplayNameInput(value: string, field: string): number[] {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)

  const core: number[] = []
  let pendingWhitespace: number[] = []
  let pendingWhitespaceOverflow = false
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index)
    let codePoint: number
    if (first >= HIGH_SURROGATE_START && first <= HIGH_SURROGATE_END) {
      const second = value.charCodeAt(index + 1)
      if (!(second >= LOW_SURROGATE_START && second <= LOW_SURROGATE_END)) {
        throw new TypeError(`${field} contains an unpaired UTF-16 surrogate`)
      }
      codePoint = ((first - HIGH_SURROGATE_START) << 10) + second - LOW_SURROGATE_START + 0x10000
      index += 1
    } else {
      if (first >= LOW_SURROGATE_START && first <= LOW_SURROGATE_END) {
        throw new TypeError(`${field} contains an unpaired UTF-16 surrogate`)
      }
      codePoint = first
    }

    assertNoForbiddenCodePoints([codePoint], field, 'input')
    if (isInRanges(TEAM_MEMBER_WHITE_SPACE_RANGES, codePoint)) {
      if (core.length === 0) continue
      if (core.length + pendingWhitespace.length >= MAX_NORMALIZABLE_DISPLAY_NAME_INPUT_SCALARS) {
        pendingWhitespaceOverflow = true
      } else if (!pendingWhitespaceOverflow) {
        pendingWhitespace.push(codePoint)
      }
      continue
    }

    if (pendingWhitespaceOverflow) {
      throw new TypeError(`${field} exceeds the Unicode 15.1 safe normalization bound`)
    }
    core.push(...pendingWhitespace, codePoint)
    pendingWhitespace = []
    if (core.length > MAX_NORMALIZABLE_DISPLAY_NAME_INPUT_SCALARS) {
      throw new TypeError(`${field} exceeds the Unicode 15.1 safe normalization bound`)
    }
  }
  return core
}

export function normalizeTeamMemberDisplayName(value: string, field: string): NormalizedTeamMemberDisplayName {
  const trimmedInput = trimmedDisplayNameInput(value, field)
  const normalized = normalizeScalarValues(trimmedInput, true)
  assertNoForbiddenCodePoints(normalized, field, 'after NFKC')
  const displayCodePoints = normalized
  if (displayCodePoints.length < 1 || displayCodePoints.length > MAX_TEAM_MEMBER_DISPLAY_NAME_SCALARS) {
    throw new TypeError(`${field} must contain 1 to ${MAX_TEAM_MEMBER_DISPLAY_NAME_SCALARS} Unicode scalar values after boundary trimming and NFKC`)
  }

  const displayNameKey = nfkcCasefold(displayCodePoints)
  if (displayNameKey.length === 0) throw new TypeError(`${field} must have a non-empty NFKC_Casefold key`)

  return {
    displayName: stringFromScalarValues(displayCodePoints),
    displayNameKey: stringFromScalarValues(displayNameKey),
  }
}

function base32LowerNoPadding(bytes: Uint8Array): string {
  let output = ''
  let buffer = 0
  let bufferedBits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bufferedBits += 8
    while (bufferedBits >= 5) {
      bufferedBits -= 5
      output += BASE32_ALPHABET[(buffer >>> bufferedBits) & 0x1F]
    }
  }
  if (bufferedBits > 0) output += BASE32_ALPHABET[(buffer << (5 - bufferedBits)) & 0x1F]
  return output
}

export function fallbackTeamMemberDisplayName(memberId: string): NormalizedTeamMemberDisplayName {
  scalarValues(memberId, 'memberId')
  const digest = createHash('sha256').update(FALLBACK_HASH_DOMAIN, 'utf8').update(memberId, 'utf8').digest()
  const shortId = base32LowerNoPadding(digest).slice(0, 10)
  return normalizeTeamMemberDisplayName(`成员 · ${shortId}`, 'fallback displayName')
}

export function appendTeamMemberDisplayNameCollisionSuffix(
  baseDisplayName: string,
  ordinal: number,
): NormalizedTeamMemberDisplayName {
  if (!Number.isSafeInteger(ordinal) || ordinal < 2) {
    throw new RangeError('display-name collision ordinal must be a safe integer greater than or equal to 2')
  }

  const base = normalizeTeamMemberDisplayName(baseDisplayName, 'baseDisplayName')
  const suffix = scalarValues(` · ${ordinal}`, 'collision suffix')
  const availableBaseScalars = MAX_TEAM_MEMBER_DISPLAY_NAME_SCALARS - suffix.length
  const prefix = scalarValues(base.displayName, 'baseDisplayName').slice(0, availableBaseScalars)
  while (prefix.length > 0 && isInRanges(TEAM_MEMBER_WHITE_SPACE_RANGES, prefix[prefix.length - 1]!)) prefix.pop()
  return normalizeTeamMemberDisplayName(
    stringFromScalarValues([...prefix, ...suffix]),
    'collision displayName',
  )
}
