#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const TEAM_PATH = '/plugins/dsh-codex-shared-pool/team'
const MANAGEMENT_PATH = '/plugins/dsh-codex-shared-pool/team-client'
const MANAGEMENT_SESSION_PATH = `${MANAGEMENT_PATH}/session`
const MANAGEMENT_CAPABILITY_HEADER = 'x-dsh-team-management-capability'
const MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_TEAM_NAME = 'Team Web Smoke'
const DEFAULT_OWNER_NAME = 'Smoke Owner'
const SMOKE_INVITE_LABEL = 'Team Web Smoke invitation'
const REVOKED_INVITE_PROBE_NAME = 'Revoked Invite Probe'
const INVITE_EXPIRES_IN_MS = 24 * 60 * 60 * 1000

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid ${label}: expected an object`)
  }
  return value
}

function requiredString(value, key, label) {
  if (typeof value[key] !== 'string' || value[key].length === 0) {
    throw new Error(`invalid ${label}: ${key} is missing`)
  }
  return value[key]
}

function requiredSafeInteger(value, key, label, minimum = 1) {
  if (!Number.isSafeInteger(value[key]) || value[key] < minimum) {
    throw new Error(`invalid ${label}: ${key} is missing`)
  }
  return value[key]
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

function rejectSecretFields(value, label) {
  if (Array.isArray(value)) {
    for (const item of value) rejectSecretFields(item, label)
    return
  }
  if (value === null || typeof value !== 'object') return
  const forbidden = new Set([
    'apikey',
    'apikeys',
    'authorization',
    'clientsecret',
    'credential',
    'idtoken',
    'invitetoken',
    'refreshtoken',
    'token',
    'tokenhash',
  ])
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll('_', '').replaceAll('-', '')
    if (forbidden.has(normalized)) throw new Error(`${label} exposed a forbidden secret field`)
    rejectSecretFields(item, label)
  }
}

function rejectSecretValues(value, secrets, label) {
  const serialized = JSON.stringify(value)
  if (secrets.some(secret => secret.length > 0 && serialized.includes(secret))) {
    throw new Error(`${label} exposed a one-time credential`)
  }
}

async function readJson(response, label, allowedStatuses = [200]) {
  if (!allowedStatuses.includes(response.status)) {
    throw new Error(`${label} failed with HTTP ${response.status}`)
  }
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeded the smoke-test limit`)
  }
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeded the smoke-test limit`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

async function request(fetch, baseUrl, path, label, options = {}) {
  let response
  try {
    response = await fetch(new URL(path, baseUrl), {
      method: options.method ?? 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        ...options.headers,
        ...options.body === undefined ? {} : { 'content-type': 'application/json' },
      },
      ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
    })
  } catch {
    throw new Error(`${label} request failed`)
  }
  return readJson(response, label, options.allowedStatuses)
}

function validateStatus(value, expectedConfigured, baseUrl) {
  const status = record(value, 'Team management status')
  if (status.enabled !== true || status.keyWritable !== true || status.keyConfigured !== expectedConfigured) {
    throw new Error('invalid Team management status')
  }
  if (typeof status.serverOrigin !== 'string' || new URL(status.serverOrigin).origin !== baseUrl.origin) {
    throw new Error('invalid Team management status: server origin mismatch')
  }
}

function validateManagementSession(value) {
  const session = record(value, 'Team management session')
  const capability = requiredString(session, 'capability', 'Team management session')
  if (!/^dsh_tm_[A-Za-z0-9_-]{43}$/u.test(capability)) {
    throw new Error('invalid Team management session: capability mismatch')
  }
  if (!Number.isInteger(session.expiresAt) || session.expiresAt <= Date.now()) {
    throw new Error('invalid Team management session: expiry mismatch')
  }
  return capability
}

function createManagementClient(fetch, baseUrl) {
  const provenanceHeaders = {
    origin: baseUrl.origin,
    'sec-fetch-site': 'same-origin',
  }
  let capability
  const get = (path, label, options = {}) => request(fetch, baseUrl, path, label, {
    ...options,
    headers: { ...provenanceHeaders, ...options.headers },
  })
  const post = async (path, label, body, options = {}) => {
    if (capability === undefined) {
      capability = validateManagementSession(await request(
        fetch,
        baseUrl,
        MANAGEMENT_SESSION_PATH,
        'Team management session',
        { method: 'POST', headers: provenanceHeaders, body: {} },
      ))
    }
    return request(fetch, baseUrl, path, label, {
      ...options,
      method: 'POST',
      headers: {
        ...provenanceHeaders,
        ...options.headers,
        [MANAGEMENT_CAPABILITY_HEADER]: capability,
      },
      body,
    })
  }
  return { get, post }
}

function validateInitialOverview(value, teamName, ownerName, secrets) {
  const overview = record(value, 'Team management overview')
  const team = record(overview.team, 'Team management overview')
  const currentMember = record(overview.currentMember, 'Team management overview')
  const teamId = requiredString(team, 'id', 'Team management overview')
  requiredSafeInteger(team, 'lifecycleRevision', 'Team management overview')
  const ownerMemberId = requiredString(currentMember, 'id', 'Team management overview')
  if (team.name !== teamName || team.status !== 'active') {
    throw new Error('invalid Team management overview: Team mismatch')
  }
  if (
    currentMember.teamId !== teamId
    || currentMember.displayName !== ownerName
    || currentMember.role !== 'owner'
    || currentMember.status !== 'active'
  ) {
    throw new Error('invalid Team management overview: active Owner missing')
  }
  validateOverview(overview, { teamId, ownerMemberId }, secrets)
  return { teamId, ownerMemberId }
}

function validateOverview(value, expected, secrets, expectedPendingInviteId) {
  const overview = record(value, 'Team management overview')
  const team = record(overview.team, 'Team management overview')
  const currentMember = record(overview.currentMember, 'Team management overview')
  requiredSafeInteger(team, 'lifecycleRevision', 'Team management overview')
  if (team.id !== expected.teamId || team.status !== 'active') {
    throw new Error('invalid Team management overview: Team mismatch')
  }
  if (currentMember.id !== expected.ownerMemberId || currentMember.teamId !== expected.teamId) {
    throw new Error('invalid Team management overview: Owner mismatch')
  }
  for (const key of ['members', 'invites', 'contributions']) {
    if (!Array.isArray(overview[key])) throw new Error(`invalid Team management overview: ${key} is missing`)
    for (const candidate of overview[key]) {
      const item = record(candidate, 'Team management overview')
      if (item.teamId !== expected.teamId) throw new Error(`invalid Team management overview: cross-Team ${key} entry`)
    }
  }
  const pending = overview.invites.filter(candidate => record(candidate, 'Team management overview').status === 'pending')
  if (expectedPendingInviteId === undefined) {
    if (pending.length !== 0) throw new Error('invalid Team management overview: unexpected pending invite')
  } else if (pending.length !== 1 || pending[0].id !== expectedPendingInviteId) {
    throw new Error('invalid Team management overview: pending invite mismatch')
  }
  rejectSecretFields(overview, 'Team management overview')
  rejectSecretValues(overview, secrets, 'Team management overview')
}

function validateCreatedInvite(value, teamId, ownerMemberId, secrets) {
  const result = record(value, 'Team invite response')
  const invite = record(result.invite, 'Team invite response')
  if (
    invite.teamId !== teamId
    || invite.invitedByMemberId !== ownerMemberId
    || invite.status !== 'pending'
  ) {
    throw new Error('invalid Team invite response: pending invite mismatch')
  }
  const inviteId = requiredString(invite, 'id', 'Team invite response')
  if (typeof result.inviteToken !== 'string' || !/^dsh_invite_[A-Za-z0-9_-]{16,}$/u.test(result.inviteToken)) {
    throw new Error('invalid Team invite response: one-time invite token missing')
  }
  rejectSecretValues(result.invite, secrets, 'Team invite response')
  return { inviteId, inviteToken: result.inviteToken }
}

function validateRevokedInvite(value, expected) {
  const result = record(value, 'Team invite revocation response')
  const invite = record(result.invite, 'Team invite revocation response')
  if (invite.id !== expected.inviteId || invite.teamId !== expected.teamId || invite.status !== 'revoked') {
    throw new Error('invalid Team invite revocation response')
  }
  rejectSecretFields(result, 'Team invite revocation response')
  rejectSecretValues(result, expected.secrets, 'Team invite revocation response')
}

function validateRejectedJoin(value, inviteToken) {
  const result = record(value, 'revoked invite probe')
  if (typeof result.error !== 'string' || !/invalid|expired|revoked/iu.test(result.error)) {
    throw new Error('revoked invite probe returned an unexpected rejection')
  }
  rejectSecretValues(result, [inviteToken], 'revoked invite probe')
}

async function disconnect(management) {
  const value = record(await management.post(
    `${MANAGEMENT_PATH}/disconnect`,
    'Team disconnect',
    { revokeRemote: true },
  ), 'Team disconnect response')
  if (value.disconnected !== true || value.remoteRevoked !== true) {
    throw new Error('invalid Team disconnect response')
  }
  rejectSecretFields(value, 'Team disconnect response')
}

export async function runTeamWebSmoke(options = {}) {
  const fetch = options.fetch ?? globalThis.fetch
  const baseUrl = new URL(options.baseUrl ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3099/')
  const teamName = options.teamName ?? DEFAULT_TEAM_NAME
  const ownerName = options.ownerName ?? DEFAULT_OWNER_NAME
  if (typeof fetch !== 'function') throw new Error('fetch is unavailable')
  if (!isLoopback(baseUrl.hostname)) throw new Error('Team Web smoke requires a loopback DSH_WEB_URL')
  const management = createManagementClient(fetch, baseUrl)

  let keyConfigured = false
  let cleanedUp = false
  let result
  let failure
  try {
    validateStatus(await management.get(`${MANAGEMENT_PATH}/status`, 'initial Team management status'), true, baseUrl)
    keyConfigured = true
    const secrets = []
    const ownerTeam = validateInitialOverview(
      await management.get(`${MANAGEMENT_PATH}/overview`, 'initial Team management overview'),
      teamName,
      ownerName,
      secrets,
    )

    const createdInvite = validateCreatedInvite(await management.post(
      `${MANAGEMENT_PATH}/invites`,
      'Team invite creation',
      { label: SMOKE_INVITE_LABEL, expiresInMs: INVITE_EXPIRES_IN_MS },
      {
        allowedStatuses: [201],
      },
    ), ownerTeam.teamId, ownerTeam.ownerMemberId, secrets)
    secrets.push(createdInvite.inviteToken)
    validateOverview(
      await management.get(`${MANAGEMENT_PATH}/overview`, 'Team management overview after invite creation'),
      ownerTeam,
      secrets,
      createdInvite.inviteId,
    )

    validateRevokedInvite(await management.post(
      `${MANAGEMENT_PATH}/invites/revoke`,
      'Team invite revocation',
      { inviteId: createdInvite.inviteId },
    ), { ...ownerTeam, ...createdInvite, secrets })

    validateRejectedJoin(await request(fetch, baseUrl, `${TEAM_PATH}/join`, 'revoked invite probe', {
      method: 'POST',
      body: { inviteToken: createdInvite.inviteToken, displayName: REVOKED_INVITE_PROBE_NAME },
      allowedStatuses: [404],
    }), createdInvite.inviteToken)
    validateOverview(
      await management.get(`${MANAGEMENT_PATH}/overview`, 'Team management overview after invite revocation'),
      ownerTeam,
      secrets,
    )
    result = {
      teamId: ownerTeam.teamId,
      ownerMemberId: ownerTeam.ownerMemberId,
      inviteId: createdInvite.inviteId,
    }
  } catch (error) {
    failure = error
  } finally {
    if (keyConfigured) {
      try {
        await disconnect(management)
        validateStatus(await management.get(`${MANAGEMENT_PATH}/status`, 'disconnected Team management status'), false, baseUrl)
        cleanedUp = true
      } catch (error) {
        if (failure === undefined) failure = error
      }
    }
  }

  if (failure !== undefined) throw failure
  if (result === undefined) throw new Error('Team Web smoke did not complete')
  return { ...result, cleanedUp }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  if (process.argv[2] !== '--confirm-test-data') {
    throw new Error('usage: smoke-team-web.mjs --confirm-test-data (requires a disposable Team-enabled stock DSH)')
  }
  await runTeamWebSmoke()
  console.log('Team-enabled stock DSH Web smoke passed and removed its preconfigured Owner Team key')
}
