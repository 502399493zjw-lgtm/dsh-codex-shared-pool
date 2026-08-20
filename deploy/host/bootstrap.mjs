#!/usr/bin/env node

const BOOTSTRAP_URL = 'http://127.0.0.1:3081/plugins/dsh-codex-shared-pool/team/bootstrap'
const [teamName, ownerName] = process.argv.slice(2)
const bootstrapToken = process.env.DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN?.trim()

if (!teamName?.trim() || !ownerName?.trim()) {
  throw new Error('usage: bootstrap.mjs <team-name> <owner-display-name>')
}
if (teamName.length > 128 || ownerName.length > 128) {
  throw new Error('team and owner names must be at most 128 characters')
}
if (!bootstrapToken || bootstrapToken.length < 16) {
  throw new Error('DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN is missing or too short')
}

const response = await fetch(BOOTSTRAP_URL, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-dsh-bootstrap-token': bootstrapToken,
  },
  body: JSON.stringify({ teamName: teamName.trim(), ownerName: ownerName.trim() }),
})

if (!response.ok) {
  throw new Error(`Team bootstrap failed with HTTP ${response.status}`)
}

const result = await response.json()
console.log(JSON.stringify(result, null, 2))
