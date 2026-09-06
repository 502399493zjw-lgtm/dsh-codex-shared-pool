#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const PLUGIN = 'dsh-codex-shared-pool'
const DSH_VERSION = '0.1.2-rc.1'
const RELEASE_BEFORE = '2026-09-04T00:00:00.000Z'
// Independently downloaded from the official npm release tarball on 2026-09-06.
// Tarball sha256: ca370668053ad6d0ac325e919ef5f65de53de00b7bad78008e6fb422dfce3530
const DSH_ENTRY_SHA256 = 'dc23f6c5dd7df8834e3e38bdb9609d77b459834681ae9b7133b417b0c35f3166'
const RELEASE_SOURCE = 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.2-rc.1.tgz'
const OWNER = 'dsh-codex-shared-pool-stock-smoke'
const MARKER = '.stock-smoke-owner.json'
const ROUTES = ['auth/status', 'profiles', 'quota'].map(path => `/plugins/dsh-openai-codex/${path}`)

/** Use the stock launch-token exchange; keep both token and session cookie in memory. */
export async function authenticateStockWeb(baseUrl, launchUrl, fetcher = fetch) {
  const base = new URL(baseUrl)
  const launch = new URL(launchUrl)
  assert.equal(launch.origin, base.origin, 'launch URL must stay same-origin')
  assert.equal(launch.pathname, '/', 'launch URL must target the root')
  assert.ok(launch.searchParams.get('token'), 'stock Web launch token is missing')
  const anonymous = await fetcher(base, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  assert.equal(anonymous.status, 401, 'stock unauthenticated root must require authentication')
  await anonymous.text()
  const exchange = await fetcher(launch, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  assert.equal(exchange.status, 303, 'stock launch-token exchange did not redirect')
  assert.equal(exchange.headers.get('location'), '/', 'stock launch-token exchange did not remove its token')
  const setCookie = exchange.headers.get('set-cookie') ?? ''
  assert.ok(setCookie.startsWith('dsh-auth-') && /;\s*HttpOnly/iu.test(setCookie), 'stock browser session cookie is missing')
  const cookie = setCookie.split(';', 1)[0]
  await exchange.text()
  return async (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), base)
    assert.equal(url.origin, base.origin, 'authenticated smoke probes must stay same-origin')
    const headers = new Headers(options.headers)
    headers.set('cookie', cookie)
    return fetcher(url, { ...options, redirect: 'error', headers })
  }
}

async function readResponse(baseUrl, path, fetcher) {
  const url = new URL(path, baseUrl)
  assert.equal(url.origin, new URL(baseUrl).origin, 'smoke probes must stay same-origin')
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200, `${url.pathname} returned HTTP ${response.status}`)
  return response.text()
}

/** HTTP and boot-graph checks only; this does not execute browser factories or call a provider. */
export async function probeStockPlugin(baseUrl, fetcher = fetch) {
  const html = await readResponse(baseUrl, '/', fetcher)
  assert.match(html, /DeepSeek Harness|dsh/u, 'stock DSH web shell did not load')
  const wire = /globalThis\["__DSH_BOOT__"\]\s*=\s*([^<]+)<\/script>/u.exec(html)?.[1]
  assert.ok(wire, 'stock DSH boot manifest is missing')
  const graph = JSON.parse(wire)
  assert.ok(Array.isArray(graph.entries), 'stock DSH boot entries are malformed')
  const entry = graph.entries.find(candidate => candidate.id === PLUGIN)
  assert.ok(entry, 'plugin is absent from the boot manifest (check Host import/startup errors)')
  const shellUrl = /<script\b[^>]*type="module"[^>]*src="([^"]+)"/u.exec(html)?.[1]
  assert.ok(shellUrl, 'stock shell module URL is missing')
  const shell = await readResponse(baseUrl, shellUrl, fetcher)
  // The pinned Web shell passes its static-module factory to ModuleLoader.create.
  // Inspect the served table, rather than assuming every package is a dynamic entry.
  const factory = /\bstaticModules:([\w$]+)\(\)/u.exec(shell)?.[1]
  assert.ok(factory, 'stock shell static-module factory is missing')
  const tableStart = shell.indexOf(`function ${factory}(){return{`)
  assert.ok(tableStart >= 0, 'stock shell static-module table is missing')
  const tableBodyStart = tableStart + `function ${factory}(){return{`.length
  const tableEnd = shell.indexOf('}}', tableBodyStart)
  assert.ok(tableEnd >= tableBodyStart, 'stock shell static-module table is malformed')
  const staticModules = new Set([...shell.slice(tableBodyStart, tableEnd).matchAll(/(?:^|,)(?:"([^"]+)"|([\w$]+)):/gu)].map(match => match[1] ?? match[2]))
  for (const dependency of new Set([...(entry.inject ?? []), ...(entry.external ?? [])])) {
    const packageId = dependency.endsWith('/client') ? dependency.slice(0, -'/client'.length) : dependency
    assert.ok(staticModules.has(dependency) || graph.entries.some(candidate => candidate.id === packageId), `boot dependency ${dependency} is missing`)
  }
  assert.equal(typeof entry.url, 'string', 'plugin client bundle URL is missing')
  const bundle = await readResponse(baseUrl, entry.url, fetcher)
  assert.ok(/__ModuleLoader__\.load\(\s*\{\s*id:\s*["']dsh-codex-shared-pool["']/u.test(bundle) && !/^\s*</u.test(bundle),
    'plugin client bundle was not served as a module registration')
  for (const route of ROUTES) {
    const body = await readResponse(baseUrl, route, fetcher)
    assert.doesNotMatch(body, /refresh_token|access_token|client_secret|"authorization"/iu, `${route} exposed credential fields`)
    assert.doesNotThrow(() => JSON.parse(body), `${route} did not return JSON`)
  }
  return { plugin: PLUGIN, routes: ROUTES.length, bundle: entry.url }
}

function checksum(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function safeText(text, isolatedDirectory) {
  return String(text)
    .replaceAll(isolatedDirectory, '<isolated>')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer <redacted>')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{15,}/gu, '<redacted>')
    .replace(/((?:token|secret|password|api[_-]?key|_authToken)\s*[:=]\s*)[^\s,;]+/giu, '$1<redacted>')
    .replace(/\/Users\/[^/\s"']+\//gu, '<home>/')
    .replace(/\/home\/[^/\s"']+\//gu, '<home>/')
    .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+[\\/]/gu, '<home>/')
}

function isolatedEnvironment(directory) {
  const env = {}
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'])
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toUpperCase()) && value !== undefined) env[key] = value
  }
  return {
    ...env,
    NO_COLOR: '1',
    DSH_HOME: join(directory, 'dsh-home'),
    DSH_AGENTS_HOME: join(directory, 'agents'),
    // Quota discovery must never inspect the developer's real Codex account.
    DSH_CODEX_ACCOUNT_HOMES: join(directory, 'empty-codex-account'),
    npm_config_cache: join(directory, 'npm-cache'),
    npm_config_userconfig: join(directory, 'empty.npmrc'),
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_before: RELEASE_BEFORE,
  }
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    // Kill the DSH-owned tree, including any package manager or quota subprocess.
    await new Promise(resolveDone => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      killer.once('error', resolveDone)
      killer.once('close', resolveDone)
    })
    return
  }
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  await Promise.race([
    new Promise(resolveDone => child.once('close', resolveDone)),
    new Promise(resolveDone => setTimeout(resolveDone, 3_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}

async function unusedPort() {
  const listener = createServer()
  await new Promise((resolveListen, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolveListen))
  const port = listener.address().port
  await new Promise(resolveClose => listener.close(resolveClose))
  return port
}

async function main() {
  const { values } = parseArgs({ options: {
    tarball: { type: 'string' },
    'dsh-entry': { type: 'string' },
    artifacts: { type: 'string', default: `artifacts/stock-compat/${process.platform}-${Date.now()}` },
    help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('Usage: node scripts/smoke-stock-compat.mjs --tarball <plugin.tgz> --dsh-entry <installed @deepseek-ai/dsh/lib/bin.js> [--artifacts <directory>]')
    return
  }
  assert.ok(values.tarball && values['dsh-entry'], '--tarball and --dsh-entry are required')
  const tarball = resolve(values.tarball)
  const dshEntry = resolve(values['dsh-entry'])
  assert.equal(checksum(dshEntry), DSH_ENTRY_SHA256, 'DSH entry differs from the official pinned release')
  const cliPackage = JSON.parse(readFileSync(join(dirname(dshEntry), '../package.json'), 'utf8'))
  assert.equal(cliPackage.name, '@deepseek-ai/dsh')
  assert.equal(cliPackage.version, DSH_VERSION)
  const cordisPackage = JSON.parse(readFileSync(createRequire(dshEntry).resolve('@deepseek-ai/cordis/package.json'), 'utf8'))
  assert.equal(cordisPackage.version, '4.0.2', 'stock DSH Cordis version differs from the compatibility target')
  const runId = randomUUID()
  const directory = mkdtempSync(join(tmpdir(), `dsh-stock-${runId}-`))
  writeFileSync(join(directory, MARKER), JSON.stringify({ owner: OWNER, runId }))
  const artifacts = resolve(values.artifacts)
  mkdirSync(artifacts, { recursive: true })
  const logFile = join(artifacts, 'dsh.log')
  writeFileSync(logFile, '', { mode: 0o600 })
  const resources = { owner: OWNER, runId, directory, marker: MARKER, processIds: [], cleanup: 'pending' }
  const recordResources = () => writeFileSync(join(artifacts, 'resources.json'), `${JSON.stringify(resources, null, 2)}\n`, { mode: 0o600 })
  recordResources()
  writeFileSync(join(directory, 'empty.npmrc'), '')
  mkdirSync(join(directory, 'empty-codex-account'))
  const env = isolatedEnvironment(directory)
  const active = new Set()
  const checks = []
  let logs = ''
  let interrupted = false
  const log = chunk => {
    const text = safeText(chunk, directory)
    if (logs.length < 2 * 1024 * 1024) {
      const bounded = text.slice(0, 2 * 1024 * 1024 - logs.length)
      logs += bounded
      appendFileSync(logFile, bounded)
    }
  }
  const start = (args, onLine) => {
    const child = spawn(process.execPath, [dshEntry, ...args], {
      cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    })
    for (const stream of [child.stdout, child.stderr]) {
      let pending = ''
      stream.setEncoding('utf8')
      stream.on('data', chunk => {
        const lines = (pending + chunk).split('\n')
        pending = lines.pop().slice(0, 2 * 1024 * 1024)
        for (const line of lines) {
          onLine?.(line)
          log(`${line}\n`)
        }
      })
      stream.on('end', () => { if (pending) log(pending) })
    }
    child.once('error', error => log(error.message))
    active.add(child)
    if (child.pid !== undefined) resources.processIds.push(child.pid)
    recordResources()
    child.once('close', () => active.delete(child))
    return child
  }
  const run = async (label, args, timeoutMs) => {
    assert.ok(!interrupted, 'smoke interrupted')
    console.log(`stock smoke: ${label}`)
    const child = start(args)
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString().slice(0, Math.max(0, 2 * 1024 * 1024 - output.length)) })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; void stopProcess(child) }, timeoutMs)
    try {
      const code = await new Promise((resolveExit, reject) => {
        child.once('error', reject)
        child.once('close', resolveExit)
      })
      assert.ok(!timedOut, `${label} timed out`)
      assert.equal(code, 0, `${label} failed; see dsh.log`)
      checks.push(label)
      return output
    } finally { clearTimeout(timer) }
  }
  const interrupt = () => {
    interrupted = true
    for (const child of active) void stopProcess(child)
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const result = {
    execution: 'real', status: 'fail', runId, platform: process.platform, node: process.version,
    dsh: DSH_VERSION, cordis: cordisPackage.version, dshSource: RELEASE_SOURCE, dshEntrySha256: DSH_ENTRY_SHA256,
    dependencySnapshotBefore: RELEASE_BEFORE, pluginTarball: basename(tarball), pluginSha256: checksum(tarball),
    checks, notProven: ['browser factory execution and interaction', 'real provider OAuth', 'real model requests'],
  }
  const gitCommit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
  const gitStatus = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
  result.source = { commit: gitCommit.status === 0 ? gitCommit.stdout.trim() : null, dirty: gitStatus.status === 0 ? gitStatus.stdout.length > 0 : null }
  try {
    const version = await run('official CLI version', ['--version'], 30_000)
    assert.equal(version.trim().replace(/^v/u, ''), DSH_VERSION, 'CLI did not report the pinned version')
    await run('isolated tarball installation', ['plugin', '--profile', 'web', 'add', tarball], 300_000)
    const profileManifest = JSON.parse(readFileSync(join(env.DSH_HOME, 'profiles/web/package.json'), 'utf8'))
    assert.ok(profileManifest.dependencies?.[PLUGIN], 'plugin was not installed into the isolated profile')
    const composition = await run('stock config composition', ['--profile', 'web', '--dump-config'], 60_000)
    assert.ok(composition.includes(PLUGIN), 'composed config did not include the plugin')
    const port = await unusedPort()
    const url = `http://127.0.0.1:${port}/`
    let launchUrl
    const server = start(['web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], line => {
      const match = /^dsh web: (http:\/\/[^\s]+\?token=[^\s]+)/u.exec(line)
      if (match) launchUrl = match[1]
    })
    console.log('stock smoke: starting isolated web profile')
    const deadline = Date.now() + 90_000
    while (true) {
      assert.ok(!interrupted, 'smoke interrupted')
      assert.equal(server.exitCode, null, 'stock DSH Web exited before readiness; see dsh.log')
      assert.equal(server.signalCode, null, 'stock DSH Web was terminated; see dsh.log')
      if (launchUrl) break
      assert.ok(Date.now() < deadline, 'stock DSH Web did not become ready; see dsh.log')
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
    const authenticatedFetch = await authenticateStockWeb(url, launchUrl)
    launchUrl = undefined
    const probe = await probeStockPlugin(url, authenticatedFetch)
    checks.push('stock Web startup', 'stock launch-token and cookie authentication', 'plugin boot manifest and dynamic/static dependencies', 'client combo bundle', `${probe.routes} plugin JSON routes`)
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000))
    assert.equal(server.exitCode, null, 'stock DSH Web exited after readiness')
    assert.equal(server.signalCode, null, 'stock DSH Web was terminated after readiness')
    assert.doesNotMatch(logs, /failed to import loader entry|does not provide an export named|ERR_MODULE_NOT_FOUND/u,
      'stock DSH reported a module import failure; see dsh.log')
    checks.push('no module import failures')
    result.status = 'pass'
  } catch (error) {
    result.error = safeText(error.message, directory)
    process.exitCode = 1
  } finally {
    await Promise.all([...active].map(stopProcess))
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    try {
      const marker = JSON.parse(readFileSync(join(directory, MARKER), 'utf8'))
      assert.deepEqual(marker, { owner: OWNER, runId }, 'refusing to clean a directory without this run owner')
      rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 200 })
      result.cleanup = 'isolated processes and directory removed'
    } catch (error) {
      result.status = 'fail'
      result.cleanup = `failed: ${safeText(error.message, directory)}`
      process.exitCode = 1
    }
    resources.cleanup = result.cleanup
    recordResources()
    writeFileSync(join(artifacts, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  }
  console.log(`stock smoke: ${result.status}; evidence: ${artifacts}`)
  if (result.error) console.error(result.error)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
