import assert from 'node:assert/strict'

const baseUrl = new URL(process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3099/')

async function get(path) {
  const url = new URL(path, baseUrl)
  const response = await fetch(url, {
    headers: { accept: 'application/json, text/html' },
  })
  const body = await response.text()
  assert.equal(response.status, 200, `${url} returned HTTP ${response.status}: ${body.slice(0, 200)}`)
  return { url, response, body }
}

const root = await get('/')
assert.match(root.body, /DeepSeek Harness|dsh/u, 'stock DSH web shell did not load')

for (const path of [
  '/plugins/dsh-openai-codex/auth/status',
  '/plugins/dsh-openai-codex/profiles',
  '/plugins/dsh-openai-codex/quota',
]) {
  const result = await get(path)
  assert.doesNotMatch(result.body, /refresh_token|access_token|client_secret|authorization/u,
    `${path} leaked credential material`)
  assert.doesNotThrow(() => JSON.parse(result.body), `${path} did not return JSON`)
}

console.log(`web smoke passed: ${baseUrl.origin}`)
