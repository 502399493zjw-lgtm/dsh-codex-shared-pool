#!/usr/bin/env node

import { createServer, request as createUpstreamRequest } from 'node:http'
import { pathToFileURL } from 'node:url'

const TEAM_PATH_PREFIX = '/plugins/dsh-codex-shared-pool/team'
const TEAM_BOOTSTRAP_PATH = `${TEAM_PATH_PREFIX}/bootstrap`
const EDGE_HEALTH_PATH = '/healthz'
const UPSTREAM_HOST = '127.0.0.1'
const UPSTREAM_PORT = 3081
const DEFAULT_EDGE_HOST = '0.0.0.0'
const DEFAULT_EDGE_PORT = 3080
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function pathFromTarget(target) {
  if (typeof target !== 'string' || target.length === 0 || target.length > 16 * 1024) return undefined
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\') || target.includes('#')) return undefined
  const queryIndex = target.indexOf('?')
  const rawPath = queryIndex < 0 ? target : target.slice(0, queryIndex)
  // Reject all path escapes instead of trying to reason about encoded separators
  // or dot segments before the stock DSH router sees them.
  if (rawPath.includes('%')) return undefined
  let parsed
  try {
    parsed = new URL(target, 'http://edge.invalid')
  } catch {
    return undefined
  }
  if (parsed.origin !== 'http://edge.invalid' || parsed.pathname !== rawPath) return undefined
  return parsed.pathname
}

/** Classify the only request targets the public sidecar is allowed to serve. */
export function classifyEdgeTarget(target) {
  const path = pathFromTarget(target)
  if (path === EDGE_HEALTH_PATH) return 'health'
  if (path === undefined || path === TEAM_BOOTSTRAP_PATH) return 'blocked'
  if (path === TEAM_PATH_PREFIX || path.startsWith(`${TEAM_PATH_PREFIX}/`)) return 'team'
  return 'blocked'
}

function upstreamHeaders(source) {
  const headers = { ...source }
  for (const name of HOP_BY_HOP_HEADERS) delete headers[name]
  delete headers.cookie
  delete headers.forwarded
  delete headers['x-forwarded-for']
  delete headers['x-forwarded-host']
  delete headers['x-forwarded-proto']
  delete headers['x-dsh-bootstrap-token']
  headers.host = '127.0.0.1:3081'
  return headers
}

function downstreamHeaders(source) {
  const headers = { ...source }
  for (const name of HOP_BY_HOP_HEADERS) delete headers[name]
  delete headers['set-cookie']
  delete headers.server
  return headers
}

function plain(res, status, message, headers = {}) {
  res.writeHead(status, {
    ...headers,
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(message)
}

/**
 * Use only the TCP peer observed by this edge. Forwarding headers are untrusted;
 * deployments behind a proxy share its allowance rather than trusting claims.
 * The durable Host budget still applies across edge restarts and replicas.
 */
export function createAnonymousTeamEdgeLimiter(now = Date.now) {
  const buckets = new Map()
  const limits = new Map([
    [`${TEAM_PATH_PREFIX}/create`, { max: 5, windowMs: 3600000 }],
    [`${TEAM_PATH_PREFIX}/recover-owner`, { max: 10, windowMs: 600000 }],
  ])
  return req => {
    if (req.method !== 'POST') return undefined
    const path = pathFromTarget(req.url)
    const limit = limits.get(path)
    if (limit === undefined) return undefined
    const observedAt = now()
    for (const [key, bucket] of buckets) {
      if (bucket.expiresAt <= observedAt) buckets.delete(key)
    }
    const peer = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/u, '')
    const key = `${path}:${peer}`
    let bucket = buckets.get(key)
    // Bound memory under high-cardinality peer traffic without clearing live limits.
    if (bucket === undefined && buckets.size >= 10000) return 60
    if (bucket === undefined) {
      bucket = { count: 0, expiresAt: observedAt + limit.windowMs }
      buckets.set(key, bucket)
    }
    bucket.count = Math.min(bucket.count + 1, limit.max + 1)
    return bucket.count > limit.max ? Math.max(1, Math.ceil((bucket.expiresAt - observedAt) / 1000)) : undefined
  }
}

/** Create the fixed-capability public sidecar without exposing stock DSH Web. */
export function createTeamEdgeServer() {
  const admitAnonymous = createAnonymousTeamEdgeLimiter()
  const server = createServer((req, res) => {
    const classification = classifyEdgeTarget(req.url)
    if (classification === 'health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') { plain(res, 405, 'method not allowed\n'); return }
      plain(res, 200, req.method === 'HEAD' ? '' : 'ok\n')
      return
    }
    if (classification !== 'team' || req.headers.upgrade !== undefined) {
      plain(res, 404, 'not found\n')
      return
    }

    const retryAfterSeconds = admitAnonymous(req)
    if (retryAfterSeconds !== undefined) {
      plain(res, 429, 'Team anonymous request rate limit exceeded\n', { 'retry-after': String(retryAfterSeconds) })
      return
    }

    const upstream = createUpstreamRequest({
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req.headers),
    }, (upstreamResponse) => {
      res.writeHead(
        upstreamResponse.statusCode ?? 502,
        downstreamHeaders(upstreamResponse.headers),
      )
      upstreamResponse.pipe(res)
    })
    upstream.on('error', () => {
      if (res.headersSent) res.destroy()
      else plain(res, 502, 'Team service unavailable\n')
    })
    req.once('aborted', () => upstream.destroy())
    res.once('close', () => {
      if (!res.writableEnded) upstream.destroy()
    })
    req.pipe(upstream)
  })
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })
  return server
}

function parsePort(value) {
  const port = Number(value ?? DEFAULT_EDGE_PORT)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('invalid DSH_CODEX_TEAM_EDGE_PORT')
  return port
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const host = process.env.DSH_CODEX_TEAM_EDGE_HOST?.trim() || DEFAULT_EDGE_HOST
  const port = parsePort(process.env.DSH_CODEX_TEAM_EDGE_PORT)
  const server = createTeamEdgeServer()
  server.listen(port, host, () => {
    console.log(`Team edge listening on ${host}:${port}`)
  })
}
