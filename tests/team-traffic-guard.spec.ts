import { DataType, newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  POSTGRES_TEAM_MIGRATION_12_LOCK_SQL,
  POSTGRES_TEAM_MIGRATION_20_LOCK_SQL,
  PostgresTeamStore,
} from '../src/team/postgres-store.ts'
import {
  MemoryTeamTrafficGuard,
  PostgresTeamTrafficGuard,
  TeamTrafficGuardError,
} from '../src/team/traffic-guard.ts'

function options(overrides: Partial<ConstructorParameters<typeof MemoryTeamTrafficGuard>[0]> = {}) {
  let currentTime = 1_000
  let sequence = 0
  return {
    clock: {
      now: () => currentTime,
      set: (value: number) => { currentTime = value },
      advance: (value: number) => { currentTime += value },
    },
    value: {
      requestsPerMinute: 60,
      maxConcurrency: 4,
      failureThreshold: 8,
      circuitOpenMs: 60_000,
      leaseTtlMs: 3_000,
      now: () => currentTime,
      id: () => `traffic-${++sequence}`,
      ...overrides,
    },
  }
}

describe('memory Team API-key traffic guard', () => {
  it('enforces concurrency and makes lease completion idempotent', async () => {
    const setup = options({ maxConcurrency: 1 })
    const guard = new MemoryTeamTrafficGuard(setup.value)
    const first = await guard.acquire('key-1')

    await expect(guard.acquire('key-1')).rejects.toMatchObject({
      code: 'TEAM_TRAFFIC_GUARD',
      reason: 'concurrency',
      retryAfterSeconds: 1,
    })
    await first.finish('neutral')
    await first.finish('failure')
    const second = await guard.acquire('key-1')
    await second.finish('success')
  })

  it('counts completed acquisitions for the trailing RPM window', async () => {
    const setup = options({ requestsPerMinute: 1 })
    const guard = new MemoryTeamTrafficGuard(setup.value)
    const first = await guard.acquire('key-1')
    await first.finish('success')

    await expect(guard.acquire('key-1')).rejects.toMatchObject({
      reason: 'rate_limit',
      retryAfterSeconds: 60,
    })
    setup.clock.advance(60_001)
    await expect(guard.acquire('key-1')).resolves.toBeDefined()
  })

  it('shares completion-order circuit state and closes it after the open interval', async () => {
    const setup = options({ failureThreshold: 2, circuitOpenMs: 5_000 })
    const guard = new MemoryTeamTrafficGuard(setup.value)
    await (await guard.acquire('key-1')).finish('failure')
    await (await guard.acquire('key-1')).finish('failure')

    await expect(guard.acquire('key-1')).rejects.toMatchObject({
      reason: 'circuit_open',
      retryAfterSeconds: 5,
    })
    setup.clock.advance(5_001)
    const recovered = await guard.acquire('key-1')
    await recovered.finish('success')
    await expect(guard.acquire('key-1')).resolves.toBeDefined()
  })

  it('renews a live lease and never resurrects one after expiry', async () => {
    const setup = options({ maxConcurrency: 1, leaseTtlMs: 1_000 })
    const guard = new MemoryTeamTrafficGuard(setup.value)
    const first = await guard.acquire('key-1')
    setup.clock.advance(500)
    await first.renew()
    setup.clock.advance(600)
    await expect(guard.acquire('key-1')).rejects.toMatchObject({ reason: 'concurrency' })

    setup.clock.advance(401)
    await expect(first.renew()).rejects.toBeInstanceOf(TeamTrafficGuardError)
    const replacement = await guard.acquire('key-1')
    await replacement.finish('neutral')
  })
})

function testPool(): PgPool {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  memory.public.interceptQueries((query) => {
    const normalized = query.trim()
    return normalized === POSTGRES_TEAM_MIGRATION_12_LOCK_SQL
      || normalized === POSTGRES_TEAM_MIGRATION_20_LOCK_SQL
      ? []
      : null
  })
  memory.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer, DataType.integer],
    returns: DataType.integer,
    implementation: () => 1,
  })
  memory.public.registerFunction({
    name: 'char_length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value: string) => value.length,
  })
  const adapter = memory.adapters.createPg()
  return new adapter.Pool() as unknown as PgPool
}

async function postgresSetup(overrides: Partial<ConstructorParameters<typeof PostgresTeamTrafficGuard>[0]> = {}) {
  const pool = testPool()
  let currentTime = 1_000
  let sequence = 0
  const store = new PostgresTeamStore({ pool })
  const boot = await store.bootstrap('Friends', 'Owner')
  const owner = await store.authenticateApiKey(boot.apiKey)
  if (owner === undefined) throw new Error('owner key should authenticate')
  const value = {
    pool,
    requestsPerMinute: 60,
    maxConcurrency: 4,
    failureThreshold: 8,
    circuitOpenMs: 60_000,
    leaseTtlMs: 3_000,
    now: () => currentTime,
    id: () => `traffic-${++sequence}`,
    ...overrides,
  }
  return {
    pool,
    store,
    owner,
    value,
    clock: {
      advance: (value: number) => { currentTime += value },
    },
  }
}

describe('PostgreSQL Team API-key traffic guard', () => {
  it('shares concurrency and trailing RPM state across guard instances', async () => {
    const setup = await postgresSetup({ maxConcurrency: 1, requestsPerMinute: 2 })
    const firstGuard = new PostgresTeamTrafficGuard(setup.value)
    const secondGuard = new PostgresTeamTrafficGuard(setup.value)
    const first = await firstGuard.acquire(setup.owner.keyId)

    await expect(secondGuard.acquire(setup.owner.keyId)).rejects.toMatchObject({ reason: 'concurrency' })
    await first.finish('neutral')
    const second = await secondGuard.acquire(setup.owner.keyId)
    await second.finish('success')
    await expect(firstGuard.acquire(setup.owner.keyId)).rejects.toMatchObject({
      reason: 'rate_limit',
      retryAfterSeconds: 60,
    })
    setup.clock.advance(60_001)
    await expect(secondGuard.acquire(setup.owner.keyId)).resolves.toBeDefined()
    await setup.pool.end()
  })

  it('persists completion-order circuit state and completes leases idempotently', async () => {
    const setup = await postgresSetup({ failureThreshold: 2, circuitOpenMs: 5_000 })
    const firstGuard = new PostgresTeamTrafficGuard(setup.value)
    const secondGuard = new PostgresTeamTrafficGuard(setup.value)
    const first = await firstGuard.acquire(setup.owner.keyId)
    await first.finish('failure')
    await first.finish('success')
    await (await secondGuard.acquire(setup.owner.keyId)).finish('failure')

    await expect(firstGuard.acquire(setup.owner.keyId)).rejects.toMatchObject({
      reason: 'circuit_open',
      retryAfterSeconds: 5,
    })
    setup.clock.advance(5_001)
    await expect(secondGuard.acquire(setup.owner.keyId)).resolves.toBeDefined()
    await setup.pool.end()
  })

  it('renews live leases, expires abandoned ones, and rejects revoked keys', async () => {
    const setup = await postgresSetup({ maxConcurrency: 1, leaseTtlMs: 1_000 })
    const guard = new PostgresTeamTrafficGuard(setup.value)
    const first = await guard.acquire(setup.owner.keyId)
    setup.clock.advance(500)
    await first.renew()
    setup.clock.advance(600)
    await expect(guard.acquire(setup.owner.keyId)).rejects.toMatchObject({ reason: 'concurrency' })
    setup.clock.advance(401)
    await expect(first.renew()).rejects.toMatchObject({ reason: 'lease_expired' })
    const replacement = await guard.acquire(setup.owner.keyId)
    await replacement.finish('neutral')

    const alternate = await setup.store.issueApiKey(setup.owner, 'Owner backup')
    const alternateAuth = await setup.store.authenticateApiKey(alternate.token)
    if (alternateAuth === undefined) throw new Error('alternate Owner key should authenticate')
    await setup.store.revokeApiKey(alternateAuth, setup.owner.keyId)
    await expect(guard.acquire(setup.owner.keyId)).rejects.toMatchObject({
      reason: 'revoked',
      status: 401,
    })
    await setup.pool.end()
  })
})
