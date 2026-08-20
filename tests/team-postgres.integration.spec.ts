import { randomInt, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresTeamStore } from '../src/team/postgres-store.ts'
import { PostgresTeamTrafficGuard, TeamTrafficGuardError } from '../src/team/traffic-guard.ts'
import {
  Aes256GcmTeamKeyEncryptionProvider,
  PostgresTeamEnvelopeCredentialBackend,
} from '../src/team/envelope-credentials.ts'
import type { TeamKeyEncryptionProvider } from '../src/team/envelope-credentials.ts'
import { OPENAI_CODEX_PROVIDER } from '../src/store.ts'

const databaseUrl = cleanDatabaseUrl(process.env.DSH_TEAM_POSTGRES_TEST_URL)
const describePostgres = databaseUrl === undefined ? describe.skip : describe

describePostgres('real PostgreSQL Team concurrency', () => {
  it('serializes concurrent ownership transfers and leaves exactly one Owner', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: 5,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const store = new PostgresTeamStore({ pool })
    let control: PoolClient | undefined
    let controlInTransaction = false
    let firstTransfer: ReturnType<PostgresTeamStore['transferOwnership']> | undefined
    let secondTransfer: ReturnType<PostgresTeamStore['transferOwnership']> | undefined

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await store.initialize()
      const boot = await store.bootstrap('Ownership Concurrency Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const firstInvite = await store.createInvite(owner, 60_000)
      const firstJoin = await store.acceptInvite(firstInvite.inviteToken, 'First Friend')
      const firstMember = await store.authenticateApiKey(firstJoin.apiKey)
      const secondInvite = await store.createInvite(owner, 60_000)
      const secondJoin = await store.acceptInvite(secondInvite.inviteToken, 'Second Friend')
      const secondMember = await store.authenticateApiKey(secondJoin.apiKey)
      if (firstMember === undefined || secondMember === undefined) throw new Error('invited members should authenticate')

      control = await pool.connect()
      await control.query('BEGIN')
      controlInTransaction = true
      const backend = await control.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const controlPid = backend.rows[0]?.pid
      if (controlPid === undefined) throw new Error('control backend PID was not returned')
      await control.query(
        'SELECT * FROM team_members WHERE id = $1 AND team_id = $2 FOR UPDATE',
        [owner.memberId, owner.teamId],
      )

      firstTransfer = store.transferOwnership(owner, firstMember.memberId)
      secondTransfer = store.transferOwnership(owner, secondMember.memberId)
      await waitForOwnershipTransferLockWait(admin, applicationName, controlPid, 2)

      await control.query('COMMIT')
      controlInTransaction = false
      const results = await Promise.allSettled([firstTransfer, secondTransfer])
      const succeeded = results.filter((result): result is PromiseFulfilledResult<Awaited<typeof firstTransfer>> => result.status === 'fulfilled')
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      expect(succeeded).toHaveLength(1)
      expect(failed).toHaveLength(1)
      expect(failed[0]?.reason).toBeInstanceOf(Error)
      expect(String(failed[0]?.reason)).toMatch(/role is stale/iu)

      const roles = await pool.query<{ id: string; role: string }>(
        'SELECT id, role FROM team_members WHERE team_id = $1 ORDER BY id',
        [owner.teamId],
      )
      expect(roles.rows.filter(row => row.role === 'owner')).toEqual([
        { id: succeeded[0]?.value?.owner.id, role: 'owner' },
      ])
      expect(roles.rows.find(row => row.id === owner.memberId)?.role).toBe('admin')
    } finally {
      if (controlInTransaction) await control?.query('ROLLBACK').catch(() => undefined)
      await Promise.allSettled([firstTransfer, secondTransfer].filter(isPromise))
      control?.release()
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('does not let emergency pause return between usage admission and its durable insert', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const lockNamespace = randomInt(1, 2_147_483_647)
    const lockKey = randomInt(1, 2_147_483_647)
    const admin = new Pool({ connectionString, max: 3, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: 5,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const store = new PostgresTeamStore({ pool })
    let control: PoolClient | undefined
    let advisoryLockHeld = false
    let usagePromise: Promise<unknown> | undefined
    let pausePromise: Promise<unknown> | undefined

    try {
      control = await admin.connect()
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await store.initialize()
      const boot = await store.bootstrap('Concurrency Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const created = await store.createContributionAccount(owner, 'Owner Codex')
      const contribution = await store.setContributionAccountStatus(owner.teamId, created.id, 'active')

      await pool.query(`
        CREATE FUNCTION block_usage_insert_for_test() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${lockNamespace}, ${lockKey});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER block_usage_insert_for_test
          BEFORE INSERT ON team_usage_events
          FOR EACH ROW EXECUTE FUNCTION block_usage_insert_for_test();
      `)
      await control.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [lockNamespace, lockKey])
      advisoryLockHeld = true

      usagePromise = store.beginUsageEvent(owner, 'usage-before-pause', contribution.id, 'gpt-5-codex')
      await waitForAdvisoryLockWait(admin, applicationName)

      let pauseSettled = false
      pausePromise = store.setTeamStatus(owner, 'paused').then((value) => {
        pauseSettled = true
        return value
      })
      await waitForTeamUpdateLockWait(admin, applicationName)
      expect(pauseSettled).toBe(false)

      await control.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [lockNamespace, lockKey])
      advisoryLockHeld = false
      await expect(usagePromise).resolves.toMatchObject({ id: 'usage-before-pause', status: 'in_progress' })
      await expect(pausePromise).resolves.toMatchObject({ id: owner.teamId, status: 'paused' })

      await expect(store.beginUsageEvent(owner, 'usage-after-pause', contribution.id, 'gpt-5-codex'))
        .rejects.toThrow('team is paused')
      const usageCount = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM team_usage_events')
      expect(Number(usageCount.rows[0]?.count)).toBe(1)
    } finally {
      if (advisoryLockHeld) {
        await control?.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [lockNamespace, lockKey]).catch(() => undefined)
      }
      await Promise.allSettled([usagePromise, pausePromise].filter(isPromise))
      control?.release()
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('serializes refresh-token mutation across Host replicas on the credential row', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: 4,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const store = new PostgresTeamStore({ pool })
    const provider = new Aes256GcmTeamKeyEncryptionProvider(Buffer.alloc(32, 0x41))
    const backend = new PostgresTeamEnvelopeCredentialBackend({ pool, keyEncryptionProvider: provider })
    const firstEntered = deferred<void>()
    const releaseFirst = deferred<void>()
    let firstPromise: Promise<unknown> | undefined
    let secondPromise: Promise<unknown> | undefined
    let secondSawRefresh: string | undefined

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await store.initialize()
      const boot = await store.bootstrap('Credential Concurrency Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const account = await store.createContributionAccount(owner, 'Owner Codex')
      const credentialStore = backend.open({ teamId: account.teamId, accountId: account.id })
      await credentialStore.addProfile('Owner Codex', {
        type: 'oauth', access: 'access-before', refresh: 'refresh-before', expires: Date.now() + 60_000, accountId: 'provider-account',
      })

      firstPromise = credentialStore.modify(OPENAI_CODEX_PROVIDER, async current => {
        if (current?.type !== 'oauth') throw new Error('OAuth credential expected')
        firstEntered.resolve()
        await releaseFirst.promise
        return { ...current, access: 'access-first', refresh: 'refresh-first' }
      })
      await firstEntered.promise

      secondPromise = backend.open({ teamId: account.teamId, accountId: account.id })
        .modify(OPENAI_CODEX_PROVIDER, async current => {
          if (current?.type !== 'oauth') throw new Error('OAuth credential expected')
          secondSawRefresh = current.refresh
          return { ...current, access: 'access-second', refresh: 'refresh-second' }
        })
      await waitForCredentialUpdateLockWait(admin, applicationName)
      expect(secondSawRefresh).toBeUndefined()

      releaseFirst.resolve()
      await expect(firstPromise).resolves.toMatchObject({ refresh: 'refresh-first' })
      await expect(secondPromise).resolves.toMatchObject({ refresh: 'refresh-second' })
      expect(secondSawRefresh).toBe('refresh-first')
      await expect(credentialStore.read(OPENAI_CODEX_PROVIDER)).resolves.toMatchObject({
        access: 'access-second',
        refresh: 'refresh-second',
      })
    } finally {
      releaseFirst.resolve()
      await Promise.allSettled([firstPromise, secondPromise].filter(isPromise))
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('serializes online key rewrap with live credential mutation on the same row', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: 4,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const store = new PostgresTeamStore({ pool })
    const provider = new Aes256GcmTeamKeyEncryptionProvider(Buffer.alloc(32, 0x42))
    const backend = new PostgresTeamEnvelopeCredentialBackend({ pool, keyEncryptionProvider: provider })
    const rewrapEntered = deferred<void>()
    const releaseRewrap = deferred<void>()
    let rewrapPromise: Promise<unknown> | undefined
    let mutationPromise: Promise<unknown> | undefined
    let mutationEntered = false

    const blockingTarget: TeamKeyEncryptionProvider = {
      wrapKey: async (ref, plaintextKey) => {
        rewrapEntered.resolve()
        await releaseRewrap.promise
        return provider.wrapKey(ref, plaintextKey)
      },
      unwrapKey: (ref, wrappedKey) => provider.unwrapKey(ref, wrappedKey),
    }

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await store.initialize()
      const boot = await store.bootstrap('Rewrap Concurrency Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const account = await store.createContributionAccount(owner, 'Owner Codex')
      const credentialStore = backend.open({ teamId: account.teamId, accountId: account.id })
      await credentialStore.addProfile('Owner Codex', {
        type: 'oauth', access: 'access-before', refresh: 'refresh-before', expires: Date.now() + 60_000, accountId: 'provider-account',
      })

      rewrapPromise = backend.rewrapCredentialKeys({ targetKeyEncryptionProvider: blockingTarget, force: true })
      await rewrapEntered.promise
      mutationPromise = backend.open({ teamId: account.teamId, accountId: account.id })
        .modify(OPENAI_CODEX_PROVIDER, async current => {
          mutationEntered = true
          if (current?.type !== 'oauth') throw new Error('OAuth credential expected')
          return { ...current, access: 'access-after', refresh: 'refresh-after' }
        })
      await waitForCredentialUpdateLockWait(admin, applicationName)
      expect(mutationEntered).toBe(false)

      releaseRewrap.resolve()
      await expect(rewrapPromise).resolves.toMatchObject({ scanned: 1, rewrapped: 1 })
      await expect(mutationPromise).resolves.toMatchObject({ refresh: 'refresh-after' })
      expect(mutationEntered).toBe(true)
      await expect(credentialStore.read(OPENAI_CODEX_PROVIDER)).resolves.toMatchObject({
        access: 'access-after',
        refresh: 'refresh-after',
      })
    } finally {
      releaseRewrap.resolve()
      await Promise.allSettled([rewrapPromise, mutationPromise].filter(isPromise))
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)

  it('atomically admits only one request at the cross-Host API-key concurrency boundary', async () => {
    const connectionString = requiredDatabaseUrl()
    const suffix = randomUUID().replaceAll('-', '')
    const schema = `dsh_team_it_${suffix}`
    const applicationName = `dsh-team-it-${suffix}`
    const admin = new Pool({ connectionString, max: 2, application_name: `${applicationName}-admin` })
    const pool = new Pool({
      connectionString,
      max: 5,
      application_name: applicationName,
      options: `-c search_path=${schema},public`,
    })
    const store = new PostgresTeamStore({ pool })
    const guardOptions = {
      pool,
      requestsPerMinute: 60,
      maxConcurrency: 1,
      failureThreshold: 8,
      circuitOpenMs: 60_000,
      leaseTtlMs: 60_000,
    }
    const firstGuard = new PostgresTeamTrafficGuard(guardOptions)
    const secondGuard = new PostgresTeamTrafficGuard(guardOptions)
    let control: PoolClient | undefined
    let controlInTransaction = false
    let firstPromise: ReturnType<PostgresTeamTrafficGuard['acquire']> | undefined
    let secondPromise: ReturnType<PostgresTeamTrafficGuard['acquire']> | undefined

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      await store.initialize()
      const boot = await store.bootstrap('Traffic Concurrency Team', 'Owner')
      const owner = await store.authenticateApiKey(boot.apiKey)
      if (owner === undefined) throw new Error('owner should authenticate')
      const seed = await firstGuard.acquire(owner.keyId)
      await seed.finish('neutral')

      control = await pool.connect()
      await control.query('BEGIN')
      controlInTransaction = true
      const backend = await control.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const controlPid = backend.rows[0]?.pid
      if (controlPid === undefined) throw new Error('control backend PID was not returned')
      await control.query(
        'SELECT * FROM team_api_key_traffic_state WHERE key_id = $1 FOR UPDATE',
        [owner.keyId],
      )

      firstPromise = firstGuard.acquire(owner.keyId)
      secondPromise = secondGuard.acquire(owner.keyId)
      await waitForTrafficStateLockWait(admin, applicationName, controlPid, 2)

      await control.query('COMMIT')
      controlInTransaction = false
      const results = await Promise.allSettled([firstPromise, secondPromise])
      const admitted = results.filter((result): result is PromiseFulfilledResult<Awaited<typeof firstPromise>> => result.status === 'fulfilled')
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      expect(admitted).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.reason).toBeInstanceOf(TeamTrafficGuardError)
      expect(rejected[0]?.reason).toMatchObject({ reason: 'concurrency' })
      await admitted[0]?.value?.finish('neutral')
    } finally {
      if (controlInTransaction) await control?.query('ROLLBACK').catch(() => undefined)
      await Promise.allSettled([firstPromise, secondPromise].filter(isPromise))
      control?.release()
      await pool.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  }, 20_000)
})

async function waitForAdvisoryLockWait(pool: Pool, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE application_name = $1
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
          AND query LIKE '%INSERT INTO team_usage_events%'
      ) AS waiting
    `, [applicationName])
    if (result.rows[0]?.waiting === true) return
    await delay(20)
  }
  throw new Error('usage insert did not reach the PostgreSQL advisory-lock barrier')
}

async function waitForTeamUpdateLockWait(pool: Pool, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE application_name = $1
          AND wait_event_type = 'Lock'
          AND query LIKE 'UPDATE teams SET status%'
      ) AS waiting
    `, [applicationName])
    if (result.rows[0]?.waiting === true) return
    await delay(20)
  }
  throw new Error('Team pause did not reach the PostgreSQL row-lock barrier')
}

async function waitForCredentialUpdateLockWait(pool: Pool, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE application_name = $1
          AND wait_event_type = 'Lock'
          AND query LIKE '%SELECT * FROM team_contribution_credentials%FOR UPDATE%'
      ) AS waiting
    `, [applicationName])
    if (result.rows[0]?.waiting === true) return
    await delay(20)
  }
  throw new Error('credential mutation did not reach the PostgreSQL row-lock barrier')
}

async function waitForTrafficStateLockWait(
  pool: Pool,
  applicationName: string,
  controlPid: number,
  expectedWaiters: number,
): Promise<void> {
  const deadline = Date.now() + 5_000
  let observed: readonly LockWaitObservation[] = []
  while (Date.now() < deadline) {
    const result = await pool.query<LockWaitObservation>(`
      SELECT pid, wait_event_type, wait_event, query, pg_blocking_pids(pid) AS blocking_pids
      FROM pg_stat_activity
      WHERE application_name = $1
        AND pid <> pg_backend_pid()
    `, [applicationName])
    observed = result.rows
    const waiters = observed.filter(row => row.wait_event_type === 'Lock'
      && row.query.includes('team_api_key_traffic_state'))
    if (waiters.length >= expectedWaiters
      && waiters.every(row => hasBlockingPath(row.pid, controlPid, observed))) return
    await delay(20)
  }
  throw new Error(`traffic admissions did not reach the PostgreSQL state-row lock barrier: ${JSON.stringify(observed)}`)
}

async function waitForOwnershipTransferLockWait(
  pool: Pool,
  applicationName: string,
  controlPid: number,
  expectedWaiters: number,
): Promise<void> {
  const deadline = Date.now() + 5_000
  let observed: readonly LockWaitObservation[] = []
  while (Date.now() < deadline) {
    const result = await pool.query<LockWaitObservation>(`
      SELECT pid, wait_event_type, wait_event, query, pg_blocking_pids(pid) AS blocking_pids
      FROM pg_stat_activity
      WHERE application_name = $1
        AND pid <> pg_backend_pid()
    `, [applicationName])
    observed = result.rows
    const waiters = observed.filter(row => row.wait_event_type === 'Lock'
      && row.query.includes('SELECT * FROM team_members WHERE id')
      && row.query.includes('FOR UPDATE'))
    if (waiters.length >= expectedWaiters
      && waiters.every(row => hasBlockingPath(row.pid, controlPid, observed))) return
    await delay(20)
  }
  throw new Error(`ownership transfers did not reach the PostgreSQL owner-row lock barrier: ${JSON.stringify(observed)}`)
}

interface LockWaitObservation {
  readonly pid: number
  readonly wait_event_type: string | null
  readonly wait_event: string | null
  readonly query: string
  readonly blocking_pids: number[]
}

function hasBlockingPath(
  waiterPid: number,
  controlPid: number,
  observations: readonly LockWaitObservation[],
  visited: ReadonlySet<number> = new Set(),
): boolean {
  if (waiterPid === controlPid) return true
  if (visited.has(waiterPid)) return false
  const current = observations.find(row => row.pid === waiterPid)
  if (current === undefined) return false
  const nextVisited = new Set(visited).add(waiterPid)
  return current.blocking_pids.some(blockerPid => blockerPid === controlPid
    || hasBlockingPath(blockerPid, controlPid, observations, nextVisited))
}

function cleanDatabaseUrl(value: string | undefined): string | undefined {
  const result = value?.trim()
  return result === undefined || result.length === 0 ? undefined : result
}

function requiredDatabaseUrl(): string {
  if (databaseUrl === undefined) throw new Error('DSH_TEAM_POSTGRES_TEST_URL is required')
  return databaseUrl
}

function quoteIdentifier(value: string): string {
  if (!/^dsh_team_it_[a-f0-9]{32}$/u.test(value)) throw new Error('unsafe PostgreSQL integration schema name')
  return `"${value}"`
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function isPromise(value: Promise<unknown> | undefined): value is Promise<unknown> {
  return value !== undefined
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise: (value: T) => void = () => undefined
  const promise = new Promise<T>(resolve => { resolvePromise = resolve })
  return {
    promise,
    resolve: value => resolvePromise(value as T),
  }
}
