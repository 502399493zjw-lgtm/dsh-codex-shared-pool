import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

assert.equal(packageJson.name, 'dsh-codex-shared-pool')
assert.equal(packageJson.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(packageJson.exports?.['./client']?.default, './lib/client.js')
assert.equal(packageJson.exports?.['./invariant']?.default, './lib/invariant.js')
assert.deepEqual(packageJson.bin, { 'dsh-openai-codex': 'lib/bin.js' })
assert.equal(packageJson.dsh?.client?.platform, 'web')
assert.equal(packageJson.dependencies?.['@deepseek-ai/dsh-sdk-protocol'], '0.1.0-rc.8')
assert.equal(packageJson.dependencies?.pg, undefined)
assert.deepEqual(
  packageJson.files?.filter(path => path.startsWith('deploy/')),
  [],
  'phase one must not publish deferred server deployment assets',
)
assert.doesNotMatch(packageJson.files?.join('\n') ?? '', /\.secrets|\.env|deploy\/\*\*/u)

const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
assert.match(patch, /id:\s*codex-shared-pool/u)
assert.match(patch, /name:\s*dsh-codex-shared-pool/u)

const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.match(client, /^window\.__ModuleLoader__\.load\(\{/u)
assert.match(client, /id:\s*"dsh-codex-shared-pool"/u)
assert.match(client, /factory:\s*\(require\)\s*=>\s*\{/u)
assert.match(client, /plugins\/dsh-openai-codex\/quota/u)
assert.match(client, /data-dsh-plugin-style/u)
assert.doesNotMatch(client, /codex-team|TEAM_MANAGEMENT|TeamSettings|--team-/u)

const host = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
const hostChunkNames = (await readdir(new URL('../lib/', import.meta.url)))
  .filter(name => name.endsWith('.js') && !['bin.js', 'client.js', 'index.js', 'invariant.js'].includes(name))
assert.ok(hostChunkNames.length > 0, 'host shared chunk must be emitted')
const hostChunks = await Promise.all(
  hostChunkNames.map(name => readFile(new URL(`../lib/${name}`, import.meta.url), 'utf8')),
)
const hostBundle = [host, ...hostChunks].join('\n')
assert.match(hostBundle, /plugins\/dsh-openai-codex\/(?:auth\/status|quota)/u)
assert.doesNotMatch(
  hostBundle,
  /dsh-codex-team|TEAM_(?:BOOTSTRAP|OVERVIEW|JOIN|RESPONSES)|Team(?:Service|Client|Gateway|CredentialBroker)|team-client-v1/u,
)

const bin = await readFile(new URL('../lib/bin.js', import.meta.url), 'utf8')
assert.match(bin, /safeExternalErrorMessage/u)

for (const path of ['../lib/invariant.js', '../lib/bin.js']) {
  const content = await readFile(new URL(path, import.meta.url), 'utf8')
  assert.ok(content.length > 0, `${path} must not be empty`)
}

const style = await readFile(new URL('../lib/style.css', import.meta.url), 'utf8')
assert.ok(style.length > 0, 'lib/style.css must not be empty')
assert.ok(client.includes(JSON.stringify(style)), 'client.js must embed the exact emitted CSS')

const hostTypes = await readFile(new URL('../lib/types/index.d.ts', import.meta.url), 'utf8')
assert.doesNotMatch(hostTypes, /\bTeam(?:Service|Client|Gateway|Credential|Management|Route|Contribution)/u)

for (const path of ['../lib/index.js', '../lib/types/index.d.ts', '../lib/types/client/index.d.ts']) {
  const content = await readFile(new URL(path, import.meta.url), 'utf8')
  assert.ok(content.length > 0, `${path} must not be empty`)
}

console.log('package verification passed')
