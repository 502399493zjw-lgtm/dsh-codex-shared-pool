import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const deploymentPackageFiles = [
  'deploy/broker/Dockerfile',
  'deploy/broker/Dockerfile.dockerignore',
  'deploy/edge/Dockerfile',
  'deploy/edge/server.mjs',
  'deploy/host/bootstrap.mjs',
  'deploy/host/Dockerfile',
  'deploy/host/Dockerfile.dockerignore',
  'deploy/host/smoke-live-sharing.mjs',
  'deploy/host/smoke-multi-team.mjs',
  'deploy/host/team-host.patch.yml',
  'deploy/postgres/init-runtime-logins.sh',
  'deploy/postgres/runtime-roles.sql',
  'deploy/self-hosted/compose.yml',
  'deploy/self-hosted/init-secrets.mjs',
]

assert.equal(packageJson.name, 'dsh-codex-shared-pool')
assert.equal(packageJson.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(packageJson.exports?.['./client']?.default, './lib/client.js')
assert.equal(packageJson.exports?.['./invariant']?.default, './lib/invariant.js')
assert.equal(packageJson.bin?.['dsh-openai-codex'], 'lib/bin.js')
assert.equal(packageJson.bin?.['dsh-codex-team-broker'], 'lib/team-broker-bin.js')
assert.equal(packageJson.bin?.['dsh-codex-team-migrate'], 'lib/team-migrate-bin.js')
assert.equal(packageJson.dsh?.client?.platform, 'web')
assert.equal(packageJson.dependencies?.['@deepseek-ai/dsh-sdk-protocol'], '0.1.0-rc.8')
assert.match(packageJson.dependencies?.pg ?? '', /^\^8\./u)
assert.deepEqual(
  packageJson.files?.filter(path => path.startsWith('deploy/')),
  deploymentPackageFiles,
  'deployment files must use an explicit allowlist so runtime secrets cannot enter the package',
)
assert.doesNotMatch(packageJson.files?.join('\n') ?? '', /\.secrets|\.env|deploy\/\*\*/u)

const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
assert.match(patch, /id:\s*codex-shared-pool/u)
assert.match(patch, /name:\s*dsh-codex-shared-pool/u)

const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.match(client, /^window\.__ModuleLoader__\.load\(\{/u)
assert.match(client, /id:\s*"dsh-codex-shared-pool"/u)
assert.match(client, /factory:\s*\(require\)\s*=>\s*\{/u)
assert.match(client, /plugins\/dsh-openai-codex\/quota/u)
assert.match(client, /TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH/u)
assert.match(client, /TEAM_MANAGEMENT_INVITES_REVOKE_PATH/u)
assert.match(client, /\/oauth\/reauthorize/u)
assert.match(client, /Sign in again/u)
assert.match(client, /重新授权/u)
assert.match(client, /TEAM_MANAGEMENT_LEAVE_PATH/u)
assert.match(client, /Leave Team/u)
assert.match(client, /退出 Team/u)
assert.match(client, /TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH/u)
assert.match(client, /canReceiveOwnership/u)
assert.match(client, /Transfer ownership/u)
assert.match(client, /转移所有权/u)
assert.match(client, /data-dsh-plugin-style/u)
assert.match(client, /--team-blue/u)

const host = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
const hostChunkNames = (await readdir(new URL('../lib/', import.meta.url)))
  .filter(name => name.endsWith('.js') && ![
    'bin.js',
    'client.js',
    'index.js',
    'invariant.js',
    'team-broker-bin.js',
    'team-migrate-bin.js',
  ].includes(name))
assert.ok(hostChunkNames.length > 0, 'host shared chunk must be emitted')
const hostChunks = await Promise.all(
  hostChunkNames.map(name => readFile(new URL(`../lib/${name}`, import.meta.url), 'utf8')),
)
const hostBundle = [host, ...hostChunks].join('\n')
assert.match(hostBundle, /plugins\/dsh-openai-codex\/(?:auth\/status|quota)/u)
assert.match(hostBundle, /\/plugins\/dsh-codex-shared-pool\/team/u)
assert.match(hostBundle, /TEAM_BOOTSTRAP_PATH/u)
assert.match(hostBundle, /TEAM_OVERVIEW_PATH/u)
assert.match(hostBundle, /TEAM_JOIN_PATH/u)
assert.match(hostBundle, /TEAM_MEMBERS_LEAVE_PATH/u)
assert.match(hostBundle, /TEAM_OWNERSHIP_TRANSFER_PATH/u)
assert.match(hostBundle, /TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH/u)
assert.match(hostBundle, /TEAM_MANAGEMENT_INVITES_REVOKE_PATH/u)
assert.match(hostBundle, /TEAM_CONTRIBUTIONS_PATH/u)
assert.match(hostBundle, /TEAM_CONTRIBUTION_OAUTH_START_PATH/u)
assert.match(hostBundle, /TEAM_CONTRIBUTION_OAUTH_REAUTHORIZE_PATH/u)
assert.match(hostBundle, /TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH/u)
assert.match(hostBundle, /\/oauth\/reauthorize/u)
assert.match(hostBundle, /TEAM_USAGE_PATH/u)
assert.match(hostBundle, /TEAM_STATUS_PATH/u)
assert.match(hostBundle, /TEAM_RESPONSES_PATH/u)
assert.match(hostBundle, /TEAM_CODEX_RESPONSES_PATH/u)
assert.match(hostBundle, /TeamCapacityProvider/u)
assert.match(hostBundle, /LocalTeamCredentialBroker/u)
assert.match(hostBundle, /RemoteTeamCredentialBroker/u)
assert.match(hostBundle, /\/v1\/dsh-team-credential-broker/u)
assert.match(hostBundle, /DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY/u)
assert.match(hostBundle, /TeamKeyEncryptionKeyring/u)
assert.match(hostBundle, /PostgresTeamStore/u)
assert.match(hostBundle, /PostgresTeamRequestRouter/u)
assert.match(hostBundle, /DSH_CODEX_SHARED_POOL_DATABASE_URL/u)
assert.match(hostBundle, /DSH_CODEX_SHARED_POOL_BOOTSTRAP_TOKEN/u)
assert.match(hostBundle, /DSH_CODEX_SHARED_POOL_TEAM_API_KEY/u)
assert.match(hostBundle, /team-client-v1/u)
assert.match(hostBundle, /redacted team credential/u)

const bin = await readFile(new URL('../lib/bin.js', import.meta.url), 'utf8')
assert.match(bin, /safeExternalErrorMessage/u)

const brokerBin = await readFile(new URL('../lib/team-broker-bin.js', import.meta.url), 'utf8')
const brokerBundle = [brokerBin, ...hostChunks].join('\n')
assert.match(brokerBundle, /dsh-codex-team-broker/u)
assert.match(brokerBundle, /DSH_CODEX_SHARED_POOL_DATABASE_URL_FILE/u)
assert.match(brokerBundle, /DSH_CODEX_SHARED_POOL_CREDENTIAL_MASTER_KEY_FILE/u)
assert.match(brokerBundle, /DSH_CODEX_SHARED_POOL_CREDENTIAL_BROKER_API_KEY_FILE/u)
assert.match(brokerBundle, /team_contribution_credentials/u)

const migrateBin = await readFile(new URL('../lib/team-migrate-bin.js', import.meta.url), 'utf8')
const migrateBundle = [migrateBin, ...hostChunks].join('\n')
assert.match(migrateBundle, /dsh-codex-team-migrate/u)
assert.match(migrateBundle, /dsh_team_host_login/u)
assert.match(migrateBundle, /dsh_team_broker_login/u)
assert.match(migrateBundle, /team_contribution_credentials/u)

for (const path of ['../lib/invariant.js', '../lib/bin.js', '../lib/team-broker-bin.js', '../lib/team-migrate-bin.js']) {
  const content = await readFile(new URL(path, import.meta.url), 'utf8')
  assert.ok(content.length > 0, `${path} must not be empty`)
}

const style = await readFile(new URL('../lib/style.css', import.meta.url), 'utf8')
assert.ok(style.length > 0, 'lib/style.css must not be empty')
assert.ok(client.includes(JSON.stringify(style)), 'client.js must embed the exact emitted CSS')

const hostTypes = await readFile(new URL('../lib/types/index.d.ts', import.meta.url), 'utf8')
assert.match(hostTypes, /TeamKeyEncryptionKeyring/u)
assert.match(hostTypes, /TeamCredentialKeyRewrapOptions/u)
assert.match(hostTypes, /TeamCredentialKeyRewrapResult/u)
assert.match(hostTypes, /RemoteTeamCredentialBroker/u)
assert.match(hostTypes, /TeamCredentialBrokerHttpHandlerOptions/u)
assert.match(hostTypes, /RunningTeamCredentialBrokerDaemon/u)
assert.match(hostTypes, /TeamCredentialBrokerEnvironment/u)
assert.match(hostTypes, /TEAM_MEMBERS_LEAVE_PATH/u)
assert.match(hostTypes, /TeamMemberDepartureResult/u)
assert.match(hostTypes, /TEAM_MANAGEMENT_LEAVE_PATH/u)
assert.match(hostTypes, /TeamManagementDepartureResult/u)
assert.match(hostTypes, /TEAM_OWNERSHIP_TRANSFER_PATH/u)
assert.match(hostTypes, /TeamOwnershipTransferResult/u)
assert.match(hostTypes, /TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH/u)
assert.match(hostTypes, /TEAM_MANAGEMENT_INVITES_REVOKE_PATH/u)
assert.match(hostTypes, /TeamManagementOwnershipTransferResult/u)
assert.match(hostTypes, /TeamManagementMemberSummary/u)
assert.match(hostTypes, /TeamContributionCapacitySummary/u)
assert.match(hostTypes, /TeamContributionCapacityBucketSummary/u)
assert.match(hostTypes, /TeamRouteAccountInspection/u)
const managementTypes = await readFile(
  new URL('../lib/types/shared/team-management.d.ts', import.meta.url),
  'utf8',
)
assert.match(managementTypes, /canReceiveOwnership/u)

const brokerDockerfile = await readFile(new URL('../deploy/broker/Dockerfile', import.meta.url), 'utf8')
assert.match(brokerDockerfile, /lib\/team-broker-bin\.js/u)
assert.match(brokerDockerfile, /\/healthz/u)
assert.match(brokerDockerfile, /pnpm install --frozen-lockfile --ignore-scripts/u)
const runtimeRoles = await readFile(new URL('../deploy/postgres/runtime-roles.sql', import.meta.url), 'utf8')
assert.match(runtimeRoles, /REVOKE ALL ON TABLE public\.team_contribution_credentials FROM dsh_team_host/u)
assert.match(runtimeRoles, /ON TABLE public\.team_contribution_credentials[\s\S]*TO dsh_team_broker/u)

for (const path of ['../lib/index.js', '../lib/types/index.d.ts', '../lib/types/client/index.d.ts']) {
  const content = await readFile(new URL(path, import.meta.url), 'utf8')
  assert.ok(content.length > 0, `${path} must not be empty`)
}

console.log('package verification passed')
