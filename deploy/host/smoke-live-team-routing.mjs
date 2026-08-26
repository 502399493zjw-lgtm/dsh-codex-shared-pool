#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { validateLiveFriendResponse } from './smoke-live-sharing.mjs'

const TEAM_BASE_URL = 'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team'
const TEAM_INTERNAL_BASE_URL = 'http://127.0.0.1:3081/plugins/dsh-codex-shared-pool/team'
const DEFAULT_MODEL = 'gpt-5.4'
const MAX_JSON_BYTES = 1024 * 1024
const MAX_OAUTH_WAIT_MS = 15 * 60_000
const OAUTH_POLL_MS = 2_000
const EXPECTED_OUTPUT = 'DSH team live smoke ok'
const LIVE_PROMPT = `Reply with exactly: ${EXPECTED_OUTPUT}`
const CONFIRMATION_FLAG = '--confirm-two-contributor-live-openai-test-data'

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

function teamKey(value, label) {
  if (typeof value !== 'string' || !/^dsh_team_[A-Za-z0-9_-]{16,}$/u.test(value)) {
    throw new Error(`invalid ${label}: one-time Team API key missing`)
  }
  return value
}

function modelName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(value)) {
    throw new Error('live Team routing model is invalid')
  }
  return value
}

function runIdentifier(value) {
  const result = String(value).trim()
  if (!/^[A-Za-z0-9_-]{4,48}$/u.test(result)) throw new Error('live Team routing run id is invalid')
  return result
}

async function boundedText(response, label) {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
    throw new Error(`${label} response exceeded the smoke-test limit`)
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_JSON_BYTES) throw new Error(`${label} response exceeded the smoke-test limit`)
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

async function readJson(response, label) {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`)
  const text = await boundedText(response, label)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

function jsonHeaders(apiKey) {
  return {
    ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
    'content-type': 'application/json',
  }
}

async function jsonRequest(fetch, path, label, { apiKey, body, method = 'POST', bootstrapToken } = {}) {
  const baseUrl = bootstrapToken === undefined ? TEAM_BASE_URL : TEAM_INTERNAL_BASE_URL
  return readJson(await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...jsonHeaders(apiKey),
      ...(bootstrapToken === undefined ? {} : { 'x-dsh-bootstrap-token': bootstrapToken }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
  }), label)
}

function validateBootstrap(value, expectedTeamName) {
  const result = record(value, 'Team bootstrap response')
  const team = record(result.team, 'Team bootstrap response')
  const member = record(result.member, 'Team bootstrap response')
  const teamId = requiredString(team, 'id', 'Team bootstrap response')
  const memberId = requiredString(member, 'id', 'Team bootstrap response')
  if (team.name !== expectedTeamName || team.status !== 'active') {
    throw new Error('invalid Team bootstrap response: active Team mismatch')
  }
  if (
    member.teamId !== teamId
    || member.displayName !== 'Live Member A'
    || member.role !== 'owner'
    || member.status !== 'active'
  ) {
    throw new Error('invalid Team bootstrap response: active Member A missing')
  }
  return { teamId, memberId, apiKey: teamKey(result.apiKey, 'Team bootstrap response') }
}

function validateInvite(value, owner) {
  const result = record(value, 'Team invite response')
  const invite = record(result.invite, 'Team invite response')
  const inviteId = requiredString(invite, 'id', 'Team invite response')
  if (
    invite.teamId !== owner.teamId
    || invite.invitedByMemberId !== owner.memberId
    || invite.status !== 'pending'
  ) {
    throw new Error('invalid Team invite response: pending Member A invite missing')
  }
  if (typeof result.inviteToken !== 'string' || !/^dsh_invite_[A-Za-z0-9_-]{16,}$/u.test(result.inviteToken)) {
    throw new Error('invalid Team invite response: one-time invite token missing')
  }
  return { inviteId, inviteToken: result.inviteToken }
}

function validateJoin(value, owner, teamName) {
  const result = record(value, 'Team join response')
  const team = record(result.team, 'Team join response')
  const member = record(result.member, 'Team join response')
  const memberId = requiredString(member, 'id', 'Team join response')
  if (team.id !== owner.teamId || team.name !== teamName || team.status !== 'active') {
    throw new Error('invalid Team join response: Team mismatch')
  }
  if (
    member.teamId !== owner.teamId
    || member.displayName !== 'Live Member B'
    || member.role !== 'member'
    || member.status !== 'active'
  ) {
    throw new Error('invalid Team join response: active Member B missing')
  }
  const apiKey = teamKey(result.apiKey, 'Team join response')
  if (memberId === owner.memberId || apiKey === owner.apiKey) {
    throw new Error('invalid Team join response: Member B identity is not distinct')
  }
  return { teamId: owner.teamId, memberId, apiKey }
}

function validateOAuth(value, expected) {
  const result = record(value, 'contribution OAuth response')
  const account = record(result.account, 'contribution OAuth response')
  const accountId = requiredString(account, 'id', 'contribution OAuth response')
  if (
    account.teamId !== expected.teamId
    || account.ownerMemberId !== expected.memberId
    || account.label !== expected.label
    || account.status !== 'authorizing'
  ) {
    throw new Error('invalid contribution OAuth response: authorizing account mismatch')
  }
  if (result.method !== 'device_code') throw new Error('invalid contribution OAuth response: device flow missing')
  const verificationUrl = requiredString(result, 'verificationUrl', 'contribution OAuth response')
  let parsed
  try { parsed = new URL(verificationUrl) } catch { throw new Error('invalid contribution OAuth response: unsafe verification URL') }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    throw new Error('invalid contribution OAuth response: unsafe verification URL')
  }
  const userCode = requiredString(result, 'userCode', 'contribution OAuth response')
  if (!/^[A-Za-z0-9-]{4,32}$/u.test(userCode)) {
    throw new Error('invalid contribution OAuth response: user code is invalid')
  }
  if (!Number.isSafeInteger(result.expiresAt) || result.expiresAt <= 0) {
    throw new Error('invalid contribution OAuth response: expiry is invalid')
  }
  return { accountId, verificationUrl: parsed.toString(), userCode, expiresAt: result.expiresAt }
}

function contributionStatus(value, expected) {
  const overview = record(value, 'Team overview')
  const team = record(overview.team, 'Team overview')
  if (team.id !== expected.teamId) throw new Error('invalid Team overview: Team mismatch')
  if (!Array.isArray(overview.contributions)) throw new Error('invalid Team overview: contributions missing')
  const account = overview.contributions.find(candidate => (
    candidate !== null
    && typeof candidate === 'object'
    && !Array.isArray(candidate)
    && candidate.id === expected.accountId
  ))
  if (account === undefined) throw new Error('authorized contribution disappeared from Team overview')
  if (account.teamId !== expected.teamId || account.ownerMemberId !== expected.memberId) {
    throw new Error('invalid Team overview: contribution ownership mismatch')
  }
  return requiredString(account, 'status', 'Team overview')
}

async function waitForContribution(fetch, contributor, challenge, options) {
  const deadline = options.now() + Math.min(
    MAX_OAUTH_WAIT_MS,
    Math.max(1_000, challenge.expiresAt - options.now()),
  )
  while (true) {
    const overview = await jsonRequest(fetch, '/overview', 'Team overview', {
      apiKey: contributor.apiKey,
      method: 'GET',
    })
    const status = contributionStatus(overview, { ...contributor, accountId: challenge.accountId })
    if (status === 'active') return
    if (status === 'reauth_required' || status === 'revoked') {
      throw new Error(`OpenAI contribution ${contributor.name} authorization did not complete`)
    }
    if (status !== 'authorizing') throw new Error('OpenAI contribution entered an unexpected state')
    if (options.now() >= deadline) throw new Error(`OpenAI contribution ${contributor.name} authorization timed out`)
    await options.wait(OAUTH_POLL_MS)
  }
}

async function startContribution(fetch, contributor, label, options) {
  const challenge = validateOAuth(await jsonRequest(fetch, '/contributions/oauth/start', 'contribution OAuth', {
    apiKey: contributor.apiKey,
    body: { label },
  }), { ...contributor, label })
  await options.onChallenge({
    contributor: contributor.name,
    verificationUrl: challenge.verificationUrl,
    userCode: challenge.userCode,
    expiresAt: challenge.expiresAt,
  })
  await waitForContribution(fetch, contributor, challenge, options)
  return challenge.accountId
}

async function runRequest(fetch, memberKey, model, sessionId) {
  await validateLiveFriendResponse(await fetch(`${TEAM_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${memberKey}`,
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'session-id': sessionId,
    },
    body: JSON.stringify({ model, input: LIVE_PROMPT, stream: true, store: false }),
    redirect: 'error',
  }))
}

function rejectContentFields(value) {
  if (Array.isArray(value)) {
    for (const item of value) rejectContentFields(item)
    return
  }
  if (value === null || typeof value !== 'object') return
  const forbidden = new Set([
    'authorization',
    'credential',
    'file',
    'idtoken',
    'input',
    'output',
    'prompt',
    'response',
    'token',
  ])
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll('_', '').replaceAll('-', '')
    if (forbidden.has(normalized)) throw new Error('Team usage response exposed a forbidden content or credential field')
    rejectContentFields(item)
  }
}

async function readUsage(fetch, memberKey, secrets) {
  const result = record(await jsonRequest(fetch, '/usage', 'Team usage', {
    apiKey: memberKey,
    method: 'GET',
  }), 'Team usage response')
  if (!Array.isArray(result.events)) throw new Error('invalid Team usage response: events missing')
  rejectContentFields(result)
  const serialized = JSON.stringify(result)
  if (serialized.includes(LIVE_PROMPT) || secrets.some(secret => serialized.includes(secret))) {
    throw new Error('Team usage response exposed request content or a credential')
  }
  return result.events
}

function validateNewUsage(events, knownIds, expected, previousFinishedAt) {
  const unseen = events.filter(candidate => (
    candidate !== null
    && typeof candidate === 'object'
    && !Array.isArray(candidate)
    && typeof candidate.id === 'string'
    && !knownIds.has(candidate.id)
  ))
  if (unseen.length !== 1) throw new Error('Team usage response did not contain exactly one new request attempt')
  const event = record(unseen[0], 'Team usage event')
  if (
    event.teamId !== expected.teamId
    || event.consumerMemberId !== expected.consumerMemberId
    || event.upstreamOwnerMemberId !== expected.upstreamOwnerMemberId
    || event.upstreamAccountId !== expected.upstreamAccountId
    || event.model !== expected.model
    || event.unit !== 'request'
    || event.status !== 'succeeded'
  ) {
    throw new Error(`Team usage response did not prove the expected ${expected.source} route`)
  }
  if (
    !Number.isSafeInteger(event.startedAt)
    || !Number.isSafeInteger(event.finishedAt)
    || event.finishedAt < event.startedAt
    || (previousFinishedAt !== undefined && event.startedAt < previousFinishedAt)
  ) {
    throw new Error('Team usage event timestamps are invalid or out of order')
  }
  knownIds.add(event.id)
  return { id: event.id, finishedAt: event.finishedAt }
}

async function runAndProve(fetch, context, expected, knownIds, previousFinishedAt) {
  await runRequest(fetch, context.memberKey, context.model, context.sessionId)
  const events = await readUsage(fetch, context.memberKey, context.secrets)
  return validateNewUsage(events, knownIds, expected, previousFinishedAt)
}

export async function validatePausedTeamRejection(response, secrets) {
  const text = await boundedText(response, 'paused Team rejection')
  if (response.status !== 429) throw new Error(`paused Team request was not rejected before forwarding (HTTP ${response.status})`)
  if (secrets.some(secret => text.includes(secret)) || text.includes(LIVE_PROMPT)) {
    throw new Error('paused Team rejection exposed request content or a credential')
  }
  let payload
  try {
    payload = record(JSON.parse(text), 'paused Team rejection')
  } catch {
    throw new Error('paused Team rejection did not return a valid capacity reason')
  }
  if (
    payload.code !== 'TEAM_CAPACITY_UNAVAILABLE'
    || !Array.isArray(payload.reasons)
    || !payload.reasons.includes('team_paused')
  ) {
    throw new Error('paused Team rejection did not prove the team_paused capacity reason')
  }
}

async function provePausedRejection(fetch, memberKey, model, sessionId, secrets) {
  await validatePausedTeamRejection(await fetch(`${TEAM_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${memberKey}`,
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'session-id': sessionId,
    },
    body: JSON.stringify({ model, input: LIVE_PROMPT, stream: true, store: false }),
    redirect: 'error',
  }), secrets)
}

async function cleanupRequest(fetch, path, apiKey, body, label, failures) {
  try {
    const response = await fetch(`${TEAM_BASE_URL}${path}`, {
      method: 'POST',
      headers: jsonHeaders(apiKey),
      body: JSON.stringify(body),
      redirect: 'error',
    })
    if (!response.ok) failures.push(`${label} failed with HTTP ${response.status}`)
    await response.body?.cancel().catch(() => undefined)
  } catch {
    failures.push(`${label} failed`)
  }
}

function safePrimaryError(error) {
  const message = error instanceof Error ? error.message : 'unknown live Team routing error'
  return message
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:dsh_team|dsh_invite)_[A-Za-z0-9_-]+\b/gu, '[REDACTED]')
    .replace(/\b(?:access_token|refresh_token|id_token|api[_-]?key|client_secret)\s*[:=]\s*[^\s,;]+/giu, '[REDACTED]')
    .slice(0, 512)
}

/**
 * Run only against an explicitly disposable Team deployment. Exactly two
 * separately authorized contributions and three successful provider requests
 * are expected. Secrets remain in process memory and cleanup always runs.
 */
export async function runLiveTeamRoutingSmoke(options = {}) {
  if (options.confirmed !== true) {
    throw new Error('live Team routing smoke requires explicit two-contributor disposable-test confirmation')
  }
  const fetch = options.fetch ?? globalThis.fetch
  if (typeof fetch !== 'function') throw new Error('fetch is unavailable')
  if (typeof options.onChallenge !== 'function') throw new Error('live Team routing smoke requires a device challenge handler')
  const bootstrapToken = (options.bootstrapToken ?? process.env.DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN)?.trim()
  if (!bootstrapToken || bootstrapToken.length < 16) {
    throw new Error('DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN is missing or too short')
  }
  const model = modelName(options.model ?? process.env.DSH_CODEX_SHARED_POOL_LIVE_SMOKE_MODEL ?? DEFAULT_MODEL)
  const runId = runIdentifier(options.runId ?? randomUUID())
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const now = options.now ?? Date.now
  const teamName = `Live Team routing smoke ${runId}`
  const labels = { A: 'Live contribution A', B: 'Live contribution B' }

  let owner
  let invite
  let friend
  let accountA
  let accountB
  let accountAActive = false
  let accountBActive = false
  let result
  let primaryError
  const cleanupFailures = []
  try {
    owner = validateBootstrap(await jsonRequest(fetch, '/bootstrap', 'Team bootstrap', {
      bootstrapToken,
      body: { teamName, ownerName: 'Live Member A' },
    }), teamName)
    owner.name = 'A'
    invite = validateInvite(await jsonRequest(fetch, '/invites', 'Team invite', {
      apiKey: owner.apiKey,
      body: {},
    }), owner)
    friend = validateJoin(await jsonRequest(fetch, '/join', 'Team join', {
      body: { inviteToken: invite.inviteToken, displayName: 'Live Member B' },
    }), owner, teamName)
    friend.name = 'B'

    accountA = await startContribution(fetch, owner, labels.A, { onChallenge: options.onChallenge, wait, now })
    accountAActive = true
    accountB = await startContribution(fetch, friend, labels.B, { onChallenge: options.onChallenge, wait, now })
    accountBActive = true

    const secrets = [bootstrapToken, owner.apiKey, friend.apiKey, invite.inviteToken]
    const initialEvents = await readUsage(fetch, friend.apiKey, secrets)
    if (initialEvents.length !== 0) throw new Error('disposable Team already contained usage events')
    const knownIds = new Set()
    const usageEventIds = []
    let previousFinishedAt

    const own = await runAndProve(fetch, {
      memberKey: friend.apiKey,
      model,
      sessionId: `${runId}-own`,
      secrets,
    }, {
      teamId: owner.teamId,
      consumerMemberId: friend.memberId,
      upstreamOwnerMemberId: friend.memberId,
      upstreamAccountId: accountB,
      model,
      source: 'own',
    }, knownIds, previousFinishedAt)
    usageEventIds.push(own.id)
    previousFinishedAt = own.finishedAt

    await jsonRequest(fetch, '/contributions/update', 'Member B contribution pause', {
      apiKey: friend.apiKey,
      body: { accountId: accountB, status: 'paused' },
    })

    for (let request = 0; request < 2; request += 1) {
      const shared = await runAndProve(fetch, {
        memberKey: friend.apiKey,
        model,
        sessionId: `${runId}-shared`,
        secrets,
      }, {
        teamId: owner.teamId,
        consumerMemberId: friend.memberId,
        upstreamOwnerMemberId: owner.memberId,
        upstreamAccountId: accountA,
        model,
        source: 'shared',
      }, knownIds, previousFinishedAt)
      usageEventIds.push(shared.id)
      previousFinishedAt = shared.finishedAt
    }

    await jsonRequest(fetch, '/status', 'Team pause', {
      apiKey: owner.apiKey,
      body: { status: 'paused' },
    })
    await provePausedRejection(fetch, friend.apiKey, model, `${runId}-rejected`, secrets)
    const finalEvents = await readUsage(fetch, friend.apiKey, secrets)
    const finalIds = new Set(finalEvents.map(event => record(event, 'Team usage event').id))
    if (finalIds.size !== knownIds.size || [...knownIds].some(id => !finalIds.has(id))) {
      throw new Error('paused Team rejection unexpectedly changed the usage event set')
    }

    result = {
      teamId: owner.teamId,
      consumerMemberId: friend.memberId,
      ownAccountId: accountB,
      sharedAccountId: accountA,
      usageEventIds,
      model,
      providerRequestCount: 3,
      rejectedRequestCount: 1,
      flow: ['own', 'shared', 'shared'],
    }
  } catch (error) {
    primaryError = new Error(safePrimaryError(error))
  } finally {
    if (owner !== undefined) {
      await cleanupRequest(fetch, '/status', owner.apiKey, { status: 'paused' }, 'Team pause cleanup', cleanupFailures)
      if (accountB !== undefined && friend !== undefined) {
        if (!accountBActive) {
          await cleanupRequest(fetch, '/contributions/oauth/cancel', friend.apiKey, { accountId: accountB }, 'Member B OAuth cancel cleanup', cleanupFailures)
        }
        await cleanupRequest(fetch, '/contributions/revoke', friend.apiKey, { accountId: accountB }, 'Member B contribution revoke cleanup', cleanupFailures)
      }
      if (accountA !== undefined) {
        if (!accountAActive) {
          await cleanupRequest(fetch, '/contributions/oauth/cancel', owner.apiKey, { accountId: accountA }, 'Member A OAuth cancel cleanup', cleanupFailures)
        }
        await cleanupRequest(fetch, '/contributions/revoke', owner.apiKey, { accountId: accountA }, 'Member A contribution revoke cleanup', cleanupFailures)
      }
      if (friend !== undefined) {
        await cleanupRequest(fetch, '/members/leave', friend.apiKey, {}, 'Member B departure cleanup', cleanupFailures)
      } else if (invite !== undefined) {
        await cleanupRequest(fetch, '/invites/revoke', owner.apiKey, { inviteId: invite.inviteId }, 'invite revoke cleanup', cleanupFailures)
      }
      await cleanupRequest(fetch, '/keys/current/revoke', owner.apiKey, {}, 'Member A key revoke cleanup', cleanupFailures)
    }
  }
  if (primaryError !== undefined) throw primaryError
  if (cleanupFailures.length > 0) {
    throw new Error(`live Team routing smoke cleanup failed: ${cleanupFailures.join('; ')}`)
  }
  return result
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  if (process.argv[2] !== CONFIRMATION_FLAG) {
    throw new Error(
      `usage: smoke-live-team-routing.mjs ${CONFIRMATION_FLAG} `
      + '(creates a disposable Team, starts two OAuth authorizations, and performs three live OpenAI requests)',
    )
  }
  const result = await runLiveTeamRoutingSmoke({
    confirmed: true,
    onChallenge: ({ contributor, verificationUrl, userCode, expiresAt }) => {
      console.log(`Contributor ${contributor}: open ${verificationUrl}`)
      console.log(`Contributor ${contributor}: enter device code ${userCode}`)
      console.log(`Contributor ${contributor}: device challenge expires at ${new Date(expiresAt).toISOString()}`)
    },
  })
  console.log(JSON.stringify(result, null, 2))
  console.log('Two-contributor live Team routing smoke passed; disposable credentials were revoked and the Team was paused')
}
