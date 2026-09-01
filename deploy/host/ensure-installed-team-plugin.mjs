import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_HOME_PATH = '/opt/dsh-home'
const DEFAULT_PACKAGE_PATH = '/opt/dsh/plugin-package/dsh-codex-shared-pool.tgz'
const MARKER_NAME = '.dsh-codex-shared-pool-package.sha256'

async function installedPluginIsUsable(homePath) {
  const installedRoot = join(
    homePath,
    'profiles',
    'web',
    'node_modules',
    'dsh-codex-shared-pool',
  )
  try {
    const packagePath = join(installedRoot, 'package.json')
    const mainPath = join(installedRoot, 'lib', 'index.js')
    const migrationPath = join(installedRoot, 'lib', 'team-migrate-bin.js')
    const [packageContents, packageStats, mainStats, migrationStats] = await Promise.all([
      readFile(packagePath, 'utf8'),
      lstat(packagePath),
      lstat(mainPath),
      lstat(migrationPath),
    ])
    let manifest
    try {
      manifest = JSON.parse(packageContents)
    } catch {
      return false
    }
    return packageStats.isFile()
      && mainStats.isFile()
      && migrationStats.isFile()
      && (migrationStats.mode & 0o111) !== 0
      && manifest?.name === 'dsh-codex-shared-pool'
      && manifest?.main === 'lib/index.js'
      && manifest?.bin?.['dsh-codex-team-migrate'] === 'lib/team-migrate-bin.js'
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function readMarker(path) {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function runDshPluginInstall(packagePath) {
  await new Promise((resolve, reject) => {
    const child = spawn('dsh', ['plugin', '--profile', 'web', 'add', packagePath], {
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`dsh plugin installation failed (${signal ?? code ?? 'unknown'})`))
    })
  })
}

async function writeMarkerAtomic(markerPath, digest) {
  await mkdir(dirname(markerPath), { recursive: true })
  const temporaryPath = `${markerPath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    await writeFile(temporaryPath, `${digest}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporaryPath, markerPath)
    await chmod(markerPath, 0o600)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export async function ensureInstalledTeamPlugin({
  homePath = DEFAULT_HOME_PATH,
  packagePath = DEFAULT_PACKAGE_PATH,
  runInstall = runDshPluginInstall,
} = {}) {
  const digest = await sha256File(packagePath)
  const markerPath = join(homePath, MARKER_NAME)

  if (await readMarker(markerPath) === digest && await installedPluginIsUsable(homePath)) {
    return false
  }

  await runInstall(packagePath)
  if (!await installedPluginIsUsable(homePath)) {
    throw new Error('dsh plugin installation did not create a usable Team plugin')
  }
  await writeMarkerAtomic(markerPath, digest)
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await ensureInstalledTeamPlugin()
}
