#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const TEAM_BASE_URL = 'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team'
const TEAM_INTERNAL_BASE_URL = 'http://127.0.0.1:3081/plugins/dsh-codex-shared-pool/team'
const BROKER_AUTHORIZATION_URL = 'http://127.0.0.1:8788/v1/dsh-team-credential-broker/authorization'
const MAX_RESPONSE_BYTES = 1024 * 1024
const TEAM_FIXTURES = [
  { teamName: 'CI Alpha', ownerName: 'Alice', friendName: 'Carol' },
  { teamName: 'CI Beta', ownerName: 'Bob', friendName: 'Dave' },
]

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

async function readJson(response, label) {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`)
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

function validateBootstrap(value, expected) {
  const result = record(value, 'Team bootstrap response')
  const team = record(result.team, 'Team bootstrap response')
  const member = record(result.member, 'Team bootstrap response')
  const teamId = requiredString(team, 'id', 'Team bootstrap response')
  const memberId = requiredString(member, 'id', 'Team bootstrap response')
  if (team.name !== expected.teamName) throw new Error('invalid Team bootstrap response: Team name mismatch')
  if (member.teamId !== teamId) throw new Error('invalid Team bootstrap response: Owner Team mismatch')
  if (member.displayName !== expected.ownerName) throw new Error('invalid Team bootstrap response: Owner name mismatch')
  if (member.role !== 'owner' || member.status !== 'active') {
    throw new Error('invalid Team bootstrap response: active Owner missing')
  }
  if (typeof result.apiKey !== 'string' || !/^dsh_team_[A-Za-z0-9_-]{16,}$/u.test(result.apiKey)) {
    throw new Error('invalid Team bootstrap response: one-time Team API key missing')
  }
  return { teamId, memberId, apiKey: result.apiKey }
}

function validateInvite(value, owner) {
  const result = record(value, 'Team invite response')
  const invite = record(result.invite, 'Team invite response')
  const inviteId = requiredString(invite, 'id', 'Team invite response')
  if (invite.teamId !== owner.teamId || invite.invitedByMemberId !== owner.memberId || invite.status !== 'pending') {
    throw new Error('invalid Team invite response: pending Owner invite missing')
  }
  if (typeof result.inviteToken !== 'string' || !/^dsh_invite_[A-Za-z0-9_-]{16,}$/u.test(result.inviteToken)) {
    throw new Error('invalid Team invite response: one-time invite token missing')
  }
  return { inviteId, inviteToken: result.inviteToken }
}

function validateJoin(value, owner, friendName) {
  const result = record(value, 'Team join response')
  const team = record(result.team, 'Team join response')
  const member = record(result.member, 'Team join response')
  const memberId = requiredString(member, 'id', 'Team join response')
  if (team.id !== owner.teamId || team.name !== owner.teamName || team.status !== 'active') {
    throw new Error('invalid Team join response: Team mismatch')
  }
  if (
    member.teamId !== owner.teamId
    || member.displayName !== friendName
    || member.role !== 'member'
    || member.status !== 'active'
  ) {
    throw new Error('invalid Team join response: active friend member missing')
  }
  if (typeof result.apiKey !== 'string' || !/^dsh_team_[A-Za-z0-9_-]{16,}$/u.test(result.apiKey)) {
    throw new Error('invalid Team join response: one-time member API key missing')
  }
  if (memberId === owner.memberId || result.apiKey === owner.apiKey) {
    throw new Error('invalid Team join response: friend identity is not distinct')
  }
  return { memberId, displayName: friendName, role: 'member', apiKey: result.apiKey }
}

function requireTeamScopedList(value, key, teamId) {
  if (!Array.isArray(value[key])) throw new Error(`invalid Team overview: ${key} is missing`)
  for (const candidate of value[key]) {
    const item = record(candidate, 'Team overview')
    if (item.teamId !== teamId) throw new Error(`Team isolation failed: cross-Team ${key} entry`)
  }
}

function rejectSecretFields(value) {
  if (Array.isArray(value)) {
    for (const item of value) rejectSecretFields(item)
    return
  }
  if (value === null || typeof value !== 'object') return
  const forbidden = new Set([
    'apikey',
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
    if (forbidden.has(normalized)) throw new Error('Team overview exposed a forbidden secret field')
    rejectSecretFields(item)
  }
}

function rejectSecretValues(value, secrets, label) {
  const serialized = JSON.stringify(value)
  if (secrets.some(secret => serialized.includes(secret))) {
    throw new Error(`${label} exposed a deployment credential`)
  }
  return serialized
}

function validateOverview(value, expected, bootstraps, deploymentSecrets) {
  const overview = record(value, 'Team overview')
  const team = record(overview.team, 'Team overview')
  const member = record(overview.currentMember, 'Team overview')
  if (team.id !== expected.teamId || team.name !== expected.teamName || team.status !== 'active') {
    throw new Error('Team isolation failed: authenticated Team mismatch')
  }
  if (
    member.id !== expected.memberId
    || member.teamId !== expected.teamId
    || member.displayName !== expected.displayName
    || member.role !== expected.role
    || member.status !== 'active'
  ) {
    throw new Error('Team isolation failed: authenticated member mismatch')
  }
  for (const key of ['members', 'invites', 'apiKeys', 'contributions']) {
    requireTeamScopedList(overview, key, expected.teamId)
  }
  const memberIds = new Set(overview.members.map(candidate => requiredString(record(candidate, 'Team overview'), 'id', 'Team overview')))
  if (expected.expectedMemberIds.some(memberId => !memberIds.has(memberId))) {
    throw new Error('Team isolation failed: expected Team membership is incomplete')
  }
  rejectSecretFields(overview)
  const serialized = rejectSecretValues(
    overview,
    [...deploymentSecrets, ...bootstraps.map(item => item.apiKey)],
    'Team overview',
  )
  for (const other of bootstraps) {
    if (other.teamId === expected.teamId) continue
    if (
      serialized.includes(other.teamId)
      || serialized.includes(other.teamName)
      || serialized.includes(other.ownerName)
      || serialized.includes(other.friendName)
    ) {
      throw new Error('Team isolation failed: another Team appeared in the overview')
    }
  }
}

async function probeCredentialBroker(fetch, brokerApiKey, deploymentSecrets) {
  const response = await fetch(BROKER_AUTHORIZATION_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${brokerApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ teamId: 'team_smoke_probe', accountId: 'account_smoke_probe' }),
    redirect: 'error',
  })
  const result = record(await readJson(response, 'Credential Broker probe'), 'Credential Broker probe')
  if (result.status !== 'reauth_required') {
    throw new Error('Credential Broker probe returned an unexpected status')
  }
  rejectSecretFields(result)
  rejectSecretValues(result, deploymentSecrets, 'Credential Broker probe')
}

async function bootstrapTeam(fetch, bootstrapToken, fixture) {
  const response = await fetch(`${TEAM_INTERNAL_BASE_URL}/bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dsh-bootstrap-token': bootstrapToken,
    },
    body: JSON.stringify({ teamName: fixture.teamName, ownerName: fixture.ownerName }),
    redirect: 'error',
  })
  return {
    ...fixture,
    displayName: fixture.ownerName,
    role: 'owner',
    ...validateBootstrap(await readJson(response, 'Team bootstrap'), fixture),
  }
}

async function inviteFriend(fetch, owner) {
  const response = await fetch(`${TEAM_BASE_URL}/invites`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${owner.apiKey}`,
      'content-type': 'application/json',
    },
    body: '{}',
    redirect: 'error',
  })
  return validateInvite(await readJson(response, 'Team invite'), owner)
}

async function joinTeam(fetch, owner, invite) {
  const response = await fetch(`${TEAM_BASE_URL}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inviteToken: invite.inviteToken, displayName: owner.friendName }),
    redirect: 'error',
  })
  return {
    teamId: owner.teamId,
    teamName: owner.teamName,
    ownerName: owner.ownerName,
    friendName: owner.friendName,
    ...validateJoin(await readJson(response, 'Team join'), owner, owner.friendName),
  }
}

async function proveInviteIsOneTime(fetch, owner, invite) {
  const response = await fetch(`${TEAM_BASE_URL}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inviteToken: invite.inviteToken, displayName: `${owner.friendName} Again` }),
    redirect: 'error',
  })
  if (response.status !== 404) throw new Error('Team invite reuse was not rejected')
}

async function readOverview(fetch, bootstrap) {
  const response = await fetch(`${TEAM_BASE_URL}/overview`, {
    method: 'GET',
    headers: { authorization: `Bearer ${bootstrap.apiKey}` },
    redirect: 'error',
  })
  return readJson(response, 'Team overview')
}

export async function runMultiTeamDeploymentSmoke(options = {}) {
  const fetch = options.fetch ?? globalThis.fetch
  const bootstrapToken = (options.bootstrapToken ?? process.env.DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN)?.trim()
  const brokerApiKey = (
    options.brokerApiKey ?? process.env.DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY
  )?.trim()
  if (typeof fetch !== 'function') throw new Error('fetch is unavailable')
  if (!bootstrapToken || bootstrapToken.length < 16) {
    throw new Error('DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN is missing or too short')
  }
  if (!brokerApiKey || brokerApiKey.length < 16 || /\s/u.test(brokerApiKey)) {
    throw new Error('DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY is missing or invalid')
  }

  const deploymentSecrets = [bootstrapToken, brokerApiKey]
  await probeCredentialBroker(fetch, brokerApiKey, deploymentSecrets)

  const bootstraps = []
  for (const fixture of TEAM_FIXTURES) bootstraps.push(await bootstrapTeam(fetch, bootstrapToken, fixture))
  if (bootstraps[0].teamId === bootstraps[1].teamId || bootstraps[0].apiKey === bootstraps[1].apiKey) {
    throw new Error('Team isolation failed: bootstrap identities are not distinct')
  }

  const memberships = []
  for (const owner of bootstraps) {
    const invite = await inviteFriend(fetch, owner)
    const friend = await joinTeam(fetch, owner, invite)
    await proveInviteIsOneTime(fetch, owner, invite)
    memberships.push({ owner, friend, invite })
  }
  const memberKeys = memberships.flatMap(item => [item.owner.apiKey, item.friend.apiKey])
  if (new Set(memberKeys).size !== memberKeys.length) {
    throw new Error('Team isolation failed: member API keys are not distinct')
  }

  const smokeSecrets = [
    ...deploymentSecrets,
    ...memberKeys,
    ...memberships.map(item => item.invite.inviteToken),
  ]
  const teams = memberships.map(item => item.owner)
  for (const { owner, friend } of memberships) {
    const expectedMemberIds = [owner.memberId, friend.memberId]
    validateOverview(
      await readOverview(fetch, owner),
      { ...owner, expectedMemberIds },
      teams,
      smokeSecrets,
    )
    validateOverview(
      await readOverview(fetch, friend),
      { ...friend, expectedMemberIds },
      teams,
      smokeSecrets,
    )
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  if (process.argv[2] !== '--confirm-test-data') {
    throw new Error('usage: smoke-multi-team.mjs --confirm-test-data (creates disposable CI Teams and members)')
  }
  await runMultiTeamDeploymentSmoke()
  console.log('Multi-Team deployment smoke passed')
}
