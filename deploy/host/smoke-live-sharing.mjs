#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const TEAM_BASE_URL = 'http://127.0.0.1:3080/plugins/dsh-codex-shared-pool/team'
const TEAM_INTERNAL_BASE_URL = 'http://127.0.0.1:3081/plugins/dsh-codex-shared-pool/team'
const DEFAULT_MODEL = 'gpt-5.4'
const MAX_JSON_BYTES = 1024 * 1024
const MAX_STREAM_BYTES = 4 * 1024 * 1024
const MAX_OAUTH_WAIT_MS = 15 * 60_000
const OAUTH_POLL_MS = 2_000
const LIVE_EXPECTED_OUTPUT = 'DSH team live smoke ok'
const LIVE_PROMPT = `Reply with exactly: ${LIVE_EXPECTED_OUTPUT}`

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
    throw new Error('live smoke model is invalid')
  }
  return value
}

async function boundedText(response, label, maximumBytes) {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
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
      if (bytes > maximumBytes) throw new Error(`${label} response exceeded the smoke-test limit`)
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

async function readJson(response, label) {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`)
  const text = await boundedText(response, label, MAX_JSON_BYTES)
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
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...jsonHeaders(apiKey),
      ...(bootstrapToken === undefined ? {} : { 'x-dsh-bootstrap-token': bootstrapToken }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
  })
  return readJson(response, label)
}

function validateBootstrap(value, expectedName) {
  const result = record(value, 'Team bootstrap response')
  const team = record(result.team, 'Team bootstrap response')
  const member = record(result.member, 'Team bootstrap response')
  const teamId = requiredString(team, 'id', 'Team bootstrap response')
  const ownerMemberId = requiredString(member, 'id', 'Team bootstrap response')
  if (team.name !== expectedName || team.status !== 'active') {
    throw new Error('invalid Team bootstrap response: active Team mismatch')
  }
  if (
    member.teamId !== teamId
    || member.displayName !== 'Live Owner'
    || member.role !== 'owner'
    || member.status !== 'active'
  ) {
    throw new Error('invalid Team bootstrap response: active Owner missing')
  }
  return { teamId, ownerMemberId, ownerKey: teamKey(result.apiKey, 'Team bootstrap response') }
}

function validateInvite(value, owner) {
  const result = record(value, 'Team invite response')
  const invite = record(result.invite, 'Team invite response')
  const inviteId = requiredString(invite, 'id', 'Team invite response')
  if (
    invite.teamId !== owner.teamId
    || invite.invitedByMemberId !== owner.ownerMemberId
    || invite.status !== 'pending'
  ) {
    throw new Error('invalid Team invite response: pending Owner invite missing')
  }
  if (typeof result.inviteToken !== 'string' || !/^dsh_invite_[A-Za-z0-9_-]{16,}$/u.test(result.inviteToken)) {
    throw new Error('invalid Team invite response: one-time invite token missing')
  }
  return { inviteId, inviteToken: result.inviteToken }
}

function validateJoin(value, owner, expectedName) {
  const result = record(value, 'Team join response')
  const team = record(result.team, 'Team join response')
  const member = record(result.member, 'Team join response')
  const friendMemberId = requiredString(member, 'id', 'Team join response')
  if (team.id !== owner.teamId || team.name !== expectedName || team.status !== 'active') {
    throw new Error('invalid Team join response: Team mismatch')
  }
  if (
    member.teamId !== owner.teamId
    || member.displayName !== 'Live Friend'
    || member.role !== 'member'
    || member.status !== 'active'
  ) {
    throw new Error('invalid Team join response: active friend missing')
  }
  const friendKey = teamKey(result.apiKey, 'Team join response')
  if (friendMemberId === owner.ownerMemberId || friendKey === owner.ownerKey) {
    throw new Error('invalid Team join response: friend identity is not distinct')
  }
  return { friendMemberId, friendKey }
}

function validateOAuth(value, owner) {
  const result = record(value, 'contribution OAuth response')
  const account = record(result.account, 'contribution OAuth response')
  const accountId = requiredString(account, 'id', 'contribution OAuth response')
  if (
    account.teamId !== owner.teamId
    || account.ownerMemberId !== owner.ownerMemberId
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

function contributionStatus(value, owner, accountId) {
  const overview = record(value, 'Team overview')
  const team = record(overview.team, 'Team overview')
  if (team.id !== owner.teamId) throw new Error('invalid Team overview: Team mismatch')
  if (!Array.isArray(overview.contributions)) throw new Error('invalid Team overview: contributions missing')
  const account = overview.contributions.find(candidate => (
    candidate !== null
    && typeof candidate === 'object'
    && !Array.isArray(candidate)
    && candidate.id === accountId
  ))
  if (account === undefined) throw new Error('authorized contribution disappeared from Team overview')
  if (account.teamId !== owner.teamId || account.ownerMemberId !== owner.ownerMemberId) {
    throw new Error('invalid Team overview: contribution ownership mismatch')
  }
  return requiredString(account, 'status', 'Team overview')
}

async function waitForContribution(fetch, owner, accountId, challenge, options) {
  const deadline = options.now() + Math.min(
    MAX_OAUTH_WAIT_MS,
    Math.max(1_000, challenge.expiresAt - options.now()),
  )
  while (true) {
    const overview = await jsonRequest(fetch, '/overview', 'Team overview', {
      apiKey: owner.ownerKey,
      method: 'GET',
    })
    const status = contributionStatus(overview, owner, accountId)
    if (status === 'active') return
    if (status === 'reauth_required' || status === 'revoked') {
      throw new Error('OpenAI contribution authorization did not complete')
    }
    if (status !== 'authorizing') throw new Error('OpenAI contribution entered an unexpected state')
    if (options.now() >= deadline) throw new Error('OpenAI contribution authorization timed out')
    await options.wait(OAUTH_POLL_MS)
  }
}

function outputText(value) {
  if (!Array.isArray(value)) return ''
  return value.flatMap(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return []
    const content = item.content
    if (!Array.isArray(content)) return []
    return content.flatMap(part => (
      part !== null
      && typeof part === 'object'
      && !Array.isArray(part)
      && part.type === 'output_text'
      && typeof part.text === 'string'
        ? [part.text]
        : []
    ))
  }).join('')
}

export async function validateLiveFriendResponse(response) {
  if (!response.ok) throw new Error(`friend Responses request failed with HTTP ${response.status}`)
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'text/event-stream') throw new Error('friend Responses request returned an invalid content type')
  const stream = await boundedText(response, 'friend Responses request', MAX_STREAM_BYTES)
  const deltas = []
  const completedItems = []
  let terminalOutput = ''
  let completed = false
  for (const block of stream.split(/\r?\n\r?\n/u)) {
    const data = block.split(/\r?\n/u)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (data.length === 0 || data === '[DONE]') continue
    let event
    try {
      event = JSON.parse(data)
    } catch {
      throw new Error('friend Responses stream contained invalid event data')
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error('friend Responses stream contained an invalid event')
    }
    if (event.type === 'response.failed' || event.type === 'error') {
      throw new Error('friend Responses stream reported a provider failure')
    }
    if (event.type === 'response.output_text.delta') {
      if (typeof event.delta !== 'string') {
        throw new Error('friend Responses stream contained an invalid text delta')
      }
      deltas.push(event.delta)
      continue
    }
    if (event.type === 'response.output_item.done') {
      const text = outputText([event.item])
      if (text.length > 0) completedItems.push(text)
      continue
    }
    if (event.type === 'response.completed' || event.type === 'response.done') {
      completed = true
      if (event.response !== null && typeof event.response === 'object' && !Array.isArray(event.response)) {
        terminalOutput = outputText(event.response.output)
      }
    }
  }
  if (!completed) throw new Error('friend Responses stream did not complete')
  const received = (deltas.length > 0 ? deltas.join('') : completedItems.join('') || terminalOutput).trim()
  if (received !== LIVE_EXPECTED_OUTPUT) {
    throw new Error(`friend Responses stream did not contain the expected ${LIVE_EXPECTED_OUTPUT} output`)
  }
}

async function runFriendRequest(fetch, friendKey, model) {
  await validateLiveFriendResponse(await fetch(`${TEAM_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${friendKey}`,
      accept: 'text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, input: LIVE_PROMPT, stream: true, store: false }),
    redirect: 'error',
  }))
}

function validateUsage(value, expected, secrets) {
  const result = record(value, 'Team usage response')
  if (!Array.isArray(result.events)) throw new Error('invalid Team usage response: events missing')
  const event = result.events.find(candidate => (
    candidate !== null
    && typeof candidate === 'object'
    && !Array.isArray(candidate)
    && candidate.teamId === expected.teamId
    && candidate.consumerMemberId === expected.friendMemberId
    && candidate.upstreamOwnerMemberId === expected.ownerMemberId
    && candidate.upstreamAccountId === expected.accountId
    && candidate.model === expected.model
    && candidate.unit === 'request'
    && candidate.status === 'succeeded'
  ))
  if (event === undefined) throw new Error('Team usage response did not prove the friend shared request')
  const serialized = JSON.stringify(result)
  if (serialized.includes(LIVE_PROMPT) || secrets.some(secret => serialized.includes(secret))) {
    throw new Error('Team usage response exposed request content or a credential')
  }
  return requiredString(event, 'id', 'Team usage response')
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

async function recoverContributionId(fetch, owner, label) {
  try {
    const overview = record(await jsonRequest(fetch, '/overview', 'Team overview', {
      apiKey: owner.ownerKey,
      method: 'GET',
    }), 'Team overview')
    if (!Array.isArray(overview.contributions)) return undefined
    const matches = overview.contributions.filter(candidate => (
      candidate !== null
      && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && candidate.teamId === owner.teamId
      && candidate.ownerMemberId === owner.ownerMemberId
      && candidate.label === label
      && candidate.status !== 'revoked'
    ))
    return matches.length === 1 && typeof matches[0].id === 'string' ? matches[0].id : undefined
  } catch {
    return undefined
  }
}

/**
 * Run only against an explicitly disposable Team deployment. The function
 * retains API keys only in process memory, prints only the device challenge,
 * and always attempts to pause the Team, revoke the Pool credential, remove
 * the friend, and revoke the Owner key before returning.
 */
export async function runLiveSharingSmoke(options = {}) {
  if (options.confirmed !== true) {
    throw new Error('live sharing smoke requires explicit disposable-test confirmation')
  }
  const fetch = options.fetch ?? globalThis.fetch
  if (typeof fetch !== 'function') throw new Error('fetch is unavailable')
  if (typeof options.onChallenge !== 'function') throw new Error('live sharing smoke requires a device challenge handler')
  const bootstrapToken = (options.bootstrapToken ?? process.env.DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN)?.trim()
  if (!bootstrapToken || bootstrapToken.length < 16) {
    throw new Error('DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN is missing or too short')
  }
  const model = modelName(options.model ?? process.env.DSH_CODEX_SHARED_POOL_LIVE_SMOKE_MODEL ?? DEFAULT_MODEL)
  const runId = String(options.runId ?? randomUUID()).trim()
  if (!/^[A-Za-z0-9_-]{4,64}$/u.test(runId)) throw new Error('live smoke run id is invalid')
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const now = options.now ?? Date.now
  const teamName = `Live sharing smoke ${runId}`
  const contributionLabel = 'Live Codex contribution'

  let owner
  let invite
  let friend
  let accountId
  let result
  let primaryError
  const cleanupFailures = []
  try {
    owner = validateBootstrap(await jsonRequest(fetch, '/bootstrap', 'Team bootstrap', {
      bootstrapToken,
      body: { teamName, ownerName: 'Live Owner' },
    }), teamName)
    invite = validateInvite(await jsonRequest(fetch, '/invites', 'Team invite', {
      apiKey: owner.ownerKey,
      body: {},
    }), owner)
    friend = validateJoin(await jsonRequest(fetch, '/join', 'Team join', {
      body: { inviteToken: invite.inviteToken, displayName: 'Live Friend' },
    }), owner, teamName)
    const challenge = validateOAuth(await jsonRequest(fetch, '/contributions/oauth/start', 'contribution OAuth', {
      apiKey: owner.ownerKey,
      body: { label: contributionLabel },
    }), owner)
    accountId = challenge.accountId
    await options.onChallenge({
      verificationUrl: challenge.verificationUrl,
      userCode: challenge.userCode,
      expiresAt: challenge.expiresAt,
    })
    await waitForContribution(fetch, owner, accountId, challenge, { wait, now })
    await runFriendRequest(fetch, friend.friendKey, model)
    const usageEventId = validateUsage(await jsonRequest(fetch, '/usage', 'Team usage', {
      apiKey: friend.friendKey,
      method: 'GET',
    }), {
      teamId: owner.teamId,
      ownerMemberId: owner.ownerMemberId,
      friendMemberId: friend.friendMemberId,
      accountId,
      model,
    }, [bootstrapToken, owner.ownerKey, friend.friendKey, invite.inviteToken])
    result = {
      teamId: owner.teamId,
      ownerMemberId: owner.ownerMemberId,
      friendMemberId: friend.friendMemberId,
      accountId,
      usageEventId,
      model,
    }
  } catch (error) {
    primaryError = error
  } finally {
    if (owner !== undefined) {
      await cleanupRequest(fetch, '/status', owner.ownerKey, { status: 'paused' }, 'Team pause cleanup', cleanupFailures)
      if (accountId === undefined) accountId = await recoverContributionId(fetch, owner, contributionLabel)
      if (accountId !== undefined) {
        await cleanupRequest(
          fetch,
          '/contributions/revoke',
          owner.ownerKey,
          { accountId },
          'contribution revoke cleanup',
          cleanupFailures,
        )
      }
      if (friend !== undefined) {
        await cleanupRequest(fetch, '/members/leave', friend.friendKey, {}, 'friend departure cleanup', cleanupFailures)
      } else if (invite !== undefined) {
        await cleanupRequest(
          fetch,
          '/invites/revoke',
          owner.ownerKey,
          { inviteId: invite.inviteId },
          'invite revoke cleanup',
          cleanupFailures,
        )
      }
      await cleanupRequest(fetch, '/keys/current/revoke', owner.ownerKey, {}, 'Owner key revoke cleanup', cleanupFailures)
    }
  }
  if (primaryError !== undefined) throw primaryError
  if (cleanupFailures.length > 0) throw new Error(`live sharing smoke cleanup failed: ${cleanupFailures.join('; ')}`)
  return result
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  if (process.argv[2] !== '--confirm-disposable-live-openai-test-data') {
    throw new Error(
      'usage: smoke-live-sharing.mjs --confirm-disposable-live-openai-test-data '
      + '(creates and disables a disposable Team, performs one live OpenAI request)',
    )
  }
  const result = await runLiveSharingSmoke({
    confirmed: true,
    onChallenge: ({ verificationUrl, userCode, expiresAt }) => {
      console.log(`Open ${verificationUrl}`)
      console.log(`Enter device code ${userCode}`)
      console.log(`The device challenge expires at ${new Date(expiresAt).toISOString()}`)
    },
  })
  console.log(JSON.stringify(result, null, 2))
  console.log('Live Team sharing smoke passed; disposable credentials were revoked and the Team was paused')
}
