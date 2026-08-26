#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function envDocument(entries) {
  return `${entries.map(([name, value]) => `${name}=${value}`).join('\n')}\n`
}

async function exists(path) {
  try {
    await readFile(path, { encoding: 'utf8', flag: 'r' })
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function writePrivateFile(path, content) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(path, 0o600)
}

export async function initializeSelfHostedSecrets(rootDir) {
  const secretDir = join(rootDir, '.secrets')
  const postgresPath = join(secretDir, 'postgres.env')
  const migrationPath = join(secretDir, 'team-migrations.env')
  const hostPath = join(secretDir, 'team-host.env')
  const brokerPath = join(secretDir, 'credential-broker.env')
  const lockPath = join(secretDir, '.initialize.lock')
  const postgresTempPath = join(secretDir, `.postgres.env.${process.pid}.tmp`)
  const migrationTempPath = join(secretDir, `.team-migrations.env.${process.pid}.tmp`)
  const hostTempPath = join(secretDir, `.team-host.env.${process.pid}.tmp`)
  const brokerTempPath = join(secretDir, `.credential-broker.env.${process.pid}.tmp`)

  await mkdir(secretDir, { recursive: true, mode: 0o700 })
  await chmod(secretDir, 0o700)

  let lock
  try {
    lock = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`secret initialization is already running; remove ${lockPath} only if no initializer is active`)
    }
    throw error
  }

  try {
    if (await exists(postgresPath) || await exists(migrationPath) || await exists(hostPath) || await exists(brokerPath)) {
      throw new Error('deployment secret files already exist; refusing to overwrite them')
    }

    const postgresPassword = randomBytes(24).toString('hex')
    const teamHostDatabasePassword = randomBytes(24).toString('hex')
    const brokerDatabasePassword = randomBytes(24).toString('hex')
    const bootstrapToken = randomBytes(32).toString('base64url')
    const credentialMasterKey = randomBytes(32).toString('base64')
    const inviteMasterKey = randomBytes(32).toString('base64')
    const brokerApiKey = randomBytes(32).toString('base64url')
    const migrationDatabaseUrl = `postgres://dsh_team_migrator:${postgresPassword}@postgres:5432/dsh_codex_shared_pool`
    const teamHostDatabaseUrl = `postgres://dsh_team_host_login:${teamHostDatabasePassword}@postgres:5432/dsh_codex_shared_pool`
    const brokerDatabaseUrl = `postgres://dsh_team_broker_login:${brokerDatabasePassword}@postgres:5432/dsh_codex_shared_pool`

    await writePrivateFile(postgresTempPath, envDocument([
      ['POSTGRES_DB', 'dsh_codex_shared_pool'],
      ['POSTGRES_USER', 'dsh_team_migrator'],
      ['POSTGRES_PASSWORD', postgresPassword],
      ['POSTGRES_TEAM_HOST_PASSWORD', teamHostDatabasePassword],
      ['POSTGRES_TEAM_BROKER_PASSWORD', brokerDatabasePassword],
    ]))
    await writePrivateFile(migrationTempPath, envDocument([
      ['DSH_CODEX_SHARED_POOL_DATABASE_URL', migrationDatabaseUrl],
    ]))
    await writePrivateFile(hostTempPath, envDocument([
      ['DSH_CODEX_SHARED_POOL_DATABASE_URL', teamHostDatabaseUrl],
      ['DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN', bootstrapToken],
      ['DSH_CODEX_SHARED_POOL_INVITE_MASTER_KEY', inviteMasterKey],
      ['DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY', brokerApiKey],
    ]))
    await writePrivateFile(brokerTempPath, envDocument([
      ['DSH_CODEX_SHARED_POOL_DATABASE_URL', brokerDatabaseUrl],
      ['DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY', credentialMasterKey],
      ['DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY', brokerApiKey],
      ['DSH_CODEX_TEAM_BROKER_HOST', '127.0.0.1'],
    ]))

    const createdPaths = []
    try {
      await rename(postgresTempPath, postgresPath)
      createdPaths.push(postgresPath)
      await rename(migrationTempPath, migrationPath)
      createdPaths.push(migrationPath)
      await rename(hostTempPath, hostPath)
      createdPaths.push(hostPath)
      await rename(brokerTempPath, brokerPath)
      createdPaths.push(brokerPath)
    } catch (error) {
      await Promise.allSettled(createdPaths.map(path => unlink(path)))
      throw error
    }
    return { postgresPath, migrationPath, hostPath, brokerPath }
  } finally {
    await Promise.allSettled([
      unlink(postgresTempPath),
      unlink(migrationTempPath),
      unlink(hostTempPath),
      unlink(brokerTempPath),
      lock.close(),
    ])
    await unlink(lockPath).catch(error => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const rootDir = dirname(fileURLToPath(import.meta.url))
  const { postgresPath, migrationPath, hostPath, brokerPath } = await initializeSelfHostedSecrets(rootDir)
  console.log(`Created private deployment files:\n- ${postgresPath}\n- ${migrationPath}\n- ${hostPath}\n- ${brokerPath}`)
}
