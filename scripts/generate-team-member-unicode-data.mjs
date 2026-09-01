import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const UNICODE_VERSION = '15.1.0'
const UCD_BASE_URL = `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd`
const SOURCES = Object.freeze({
  'UnicodeData.txt': '2fc713e6a31a87c4850a37fe2caffa4218180fadb5de86b43a143ddb4581fb86',
  'CompositionExclusions.txt': '59d2d9e3dfdf0a999cf9dae11d594f053631222679a2f5710315ea07f7fe82af',
  'DerivedNormalizationProps.txt': '8875dccee2bc1a7c1fe568a3b502a9e78c9e0495afd96b6568b4294d0ed1f7e1',
  'PropList.txt': '05672956317b6296bc2ec3d6cef1f6452b57ff4f2efc6dc55b0a19277d5fcfd1',
  'DerivedCoreProperties.txt': 'f55d0db69123431a7317868725b1fcbf1eab6b265d756d1bd7f0f6d9f9ee108b',
  'NormalizationTest.txt': '871238e37e3be0696ec2bd0891119a041b052da1a84485eda05a5438724b223e',
})

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const outputPath = resolve(scriptDirectory, '../src/team/member-display-name-unicode-15.1.0.generated.ts')
const conformanceOutputPath = resolve(scriptDirectory, '../tests/fixtures/team-member-unicode-15.1.0-conformance.generated.json')

function sourceDirectoryFromArguments(argv) {
  if (argv.length === 0) return undefined
  if (argv.length === 2 && argv[0] === '--source-dir') return resolve(argv[1])
  throw new Error('usage: node scripts/generate-team-member-unicode-data.mjs [--source-dir PATH]')
}

async function loadSource(fileName, sourceDirectory) {
  const bytes = sourceDirectory === undefined
    ? Buffer.from(await fetch(`${UCD_BASE_URL}/${fileName}`).then(response => {
        if (!response.ok) throw new Error(`failed to fetch ${fileName}: HTTP ${response.status}`)
        return response.arrayBuffer()
      }))
    : await readFile(resolve(sourceDirectory, fileName))
  const actualHash = createHash('sha256').update(bytes).digest('hex')
  const expectedHash = SOURCES[fileName]
  if (actualHash !== expectedHash) {
    throw new Error(`${fileName} SHA-256 mismatch: expected ${expectedHash}, received ${actualHash}`)
  }
  return bytes.toString('utf8')
}

function codePointRange(value) {
  const [startText, endText = startText] = value.trim().split('..')
  return [Number.parseInt(startText, 16), Number.parseInt(endText, 16)]
}

function mergeRanges(ranges) {
  const sorted = ranges.toSorted((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged = []
  for (const [start, end] of sorted) {
    const previous = merged.at(-1)
    if (previous !== undefined && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end)
    else merged.push([start, end])
  }
  return merged
}

function parsePropertyRanges(text, property) {
  const ranges = []
  for (const line of text.split('\n')) {
    const fields = line.replace(/#.*/, '').split(';').map(field => field.trim())
    if (fields.length < 2 || fields[1] !== property || fields[0] === '') continue
    ranges.push(codePointRange(fields[0]))
  }
  return mergeRanges(ranges)
}

function parseCompositionExclusions(text) {
  const exclusions = new Set()
  for (const line of text.split('\n')) {
    const value = line.replace(/#.*/, '').trim()
    if (value === '') continue
    const [start, end] = codePointRange(value)
    for (let codePoint = start; codePoint <= end; codePoint += 1) exclusions.add(codePoint)
  }
  return exclusions
}

function parseUnicodeData(text, compositionExclusions) {
  const records = []
  const controlRanges = []
  let pendingRange

  for (const line of text.trimEnd().split('\n')) {
    const fields = line.split(';')
    const codePoint = Number.parseInt(fields[0], 16)
    const name = fields[1]
    if (name.endsWith(', First>')) {
      pendingRange = { codePoint, fields }
      continue
    }
    if (name.endsWith(', Last>')) {
      if (pendingRange === undefined) throw new Error(`unexpected UnicodeData Last record at U+${fields[0]}`)
      if (pendingRange.fields[2] === 'Cc') controlRanges.push([pendingRange.codePoint, codePoint])
      pendingRange = undefined
      continue
    }
    if (fields[2] === 'Cc') controlRanges.push([codePoint, codePoint])
    records.push({
      codePoint,
      canonicalCombiningClass: Number.parseInt(fields[3], 10),
      decomposition: fields[5],
    })
  }
  if (pendingRange !== undefined) throw new Error('unterminated UnicodeData First record')

  const combiningClassRanges = []
  for (const record of records) {
    if (record.canonicalCombiningClass === 0) continue
    const previous = combiningClassRanges.at(-1)
    if (previous !== undefined
      && previous[2] === record.canonicalCombiningClass
      && previous[1] + 1 === record.codePoint) {
      previous[1] = record.codePoint
    } else {
      combiningClassRanges.push([record.codePoint, record.codePoint, record.canonicalCombiningClass])
    }
  }

  const combiningClassByCodePoint = new Map(records.map(record => [record.codePoint, record.canonicalCombiningClass]))
  const decompositions = []
  const compositions = []
  for (const record of records) {
    if (record.decomposition === '') continue
    const parts = record.decomposition.split(' ')
    const compatibility = parts[0].startsWith('<')
    const mapping = (compatibility ? parts.slice(1) : parts).map(value => Number.parseInt(value, 16))
    decompositions.push([record.codePoint, compatibility ? 1 : 0, ...mapping])
    if (!compatibility
      && mapping.length === 2
      && !compositionExclusions.has(record.codePoint)
      && (combiningClassByCodePoint.get(mapping[0]) ?? 0) === 0) {
      compositions.push([mapping[0], mapping[1], record.codePoint])
    }
  }

  return {
    combiningClassRanges,
    compositions,
    controlRanges: mergeRanges(controlRanges),
    decompositions,
  }
}

function parseNfkcCasefoldMappings(text) {
  const mappings = []
  for (const line of text.split('\n')) {
    const fields = line.replace(/#.*/, '').split(';').map(field => field.trim())
    if (fields.length < 3 || fields[1] !== 'NFKC_CF') continue
    const [start, end] = codePointRange(fields[0])
    const mapping = fields[2] === '' ? [] : fields[2].split(' ').map(value => Number.parseInt(value, 16))
    mappings.push([start, end, ...mapping])
  }
  return mappings
}

function parseNormalizationTestVectors(text) {
  const vectors = []
  for (const line of text.split('\n')) {
    const fields = line.replace(/#.*/, '').split(';').map(field => field.trim())
    if (fields.length < 5 || fields[0] === '' || fields[0].startsWith('@')) continue
    vectors.push(fields.slice(0, 5))
  }
  return vectors
}

function emitArray(name, type, rows) {
  return `export const ${name}: ${type} = [\n${rows.map(row => `  [${row.join(', ')}],`).join('\n')}\n]\n`
}

async function main() {
  const sourceDirectory = sourceDirectoryFromArguments(process.argv.slice(2))
  const entries = await Promise.all(Object.keys(SOURCES).map(async fileName => [fileName, await loadSource(fileName, sourceDirectory)]))
  const sources = Object.fromEntries(entries)
  const unicode = parseUnicodeData(sources['UnicodeData.txt'], parseCompositionExclusions(sources['CompositionExclusions.txt']))
  const sourceManifest = Object.entries(SOURCES).map(([fileName, sha256]) => ({
    fileName,
    sha256,
    url: `${UCD_BASE_URL}/${fileName}`,
  }))

  const output = [
    '/* eslint-disable */',
    '/**',
    ' * @generated by scripts/generate-team-member-unicode-data.mjs; do not edit.',
    ` * Unicode ${UNICODE_VERSION} data is used under the Unicode License v3: https://www.unicode.org/license.txt`,
    ' */',
    `export const GENERATED_TEAM_MEMBER_UNICODE_VERSION = '${UNICODE_VERSION}' as const`,
    `export const GENERATED_TEAM_MEMBER_UNICODE_SOURCES = ${JSON.stringify(sourceManifest, undefined, 2)} as const`,
    emitArray('TEAM_MEMBER_CANONICAL_COMBINING_CLASS_RANGES', 'readonly (readonly [number, number, number])[]', unicode.combiningClassRanges),
    emitArray('TEAM_MEMBER_DECOMPOSITIONS', 'readonly (readonly number[])[]', unicode.decompositions),
    emitArray('TEAM_MEMBER_COMPOSITIONS', 'readonly (readonly [number, number, number])[]', unicode.compositions),
    emitArray('TEAM_MEMBER_NFKC_CASEFOLD_MAPPINGS', 'readonly (readonly number[])[]', parseNfkcCasefoldMappings(sources['DerivedNormalizationProps.txt'])),
    emitArray('TEAM_MEMBER_WHITE_SPACE_RANGES', 'readonly (readonly [number, number])[]', parsePropertyRanges(sources['PropList.txt'], 'White_Space')),
    emitArray('TEAM_MEMBER_CONTROL_RANGES', 'readonly (readonly [number, number])[]', unicode.controlRanges),
    emitArray('TEAM_MEMBER_DEFAULT_IGNORABLE_RANGES', 'readonly (readonly [number, number])[]', parsePropertyRanges(sources['DerivedCoreProperties.txt'], 'Default_Ignorable_Code_Point')),
    emitArray('TEAM_MEMBER_BIDI_CONTROL_RANGES', 'readonly (readonly [number, number])[]', parsePropertyRanges(sources['PropList.txt'], 'Bidi_Control')),
  ].join('\n')

  await writeFile(outputPath, output)
  await writeFile(conformanceOutputPath, `${JSON.stringify({
    normalizationTestSha256: SOURCES['NormalizationTest.txt'],
    unicodeVersion: UNICODE_VERSION,
    vectors: parseNormalizationTestVectors(sources['NormalizationTest.txt']),
  })}\n`)
  process.stdout.write(`generated ${outputPath}\n`)
  process.stdout.write(`generated ${conformanceOutputPath}\n`)
}

await main()
