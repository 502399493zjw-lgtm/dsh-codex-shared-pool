import { spawn } from 'node:child_process'

const databaseUrl = process.env.DSH_TEAM_POSTGRES_TEST_URL?.trim()
if (databaseUrl === undefined || databaseUrl.length === 0) {
  console.error('DSH_TEAM_POSTGRES_TEST_URL is required for the real PostgreSQL integration suite')
  process.exitCode = 1
} else {
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const child = spawn(executable, [
    'exec',
    'vitest',
    'run',
    'tests/team-postgres.integration.spec.ts',
  ], {
    env: process.env,
    stdio: 'inherit',
  })

  child.once('error', (error) => {
    console.error(`failed to start the PostgreSQL integration suite: ${error.message}`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    if (signal !== null) {
      console.error(`PostgreSQL integration suite exited after signal ${signal}`)
      process.exitCode = 1
      return
    }
    process.exitCode = code ?? 1
  })
}
