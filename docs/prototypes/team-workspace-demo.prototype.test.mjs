import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const prototypeUrl = new URL('./team-workspace-demo.html', import.meta.url)

async function readPrototype() {
  return readFile(prototypeUrl, 'utf8')
}

test('keeps Team navigation focused on usage, members, and invitations', async () => {
  const html = await readPrototype()

  for (const view of ['usage', 'members', 'invites']) {
    assert.match(html, new RegExp(`data-workspace-view=["']${view}["']`, 'u'))
  }

  assert.match(html, /data-workspace-view=["']join["']/u)
  assert.match(html, />用量</u)
  assert.match(html, />成员</u)
  assert.match(html, />邀请码</u)
  assert.doesNotMatch(html, /data-view=["'](?:sharing|identity)["']/u)
  assert.doesNotMatch(html, /data-workspace-view=["'](?:sharing|identity)["']/u)
  assert.doesNotMatch(html, /aria-label=["']个人设置["']/u)
  assert.doesNotMatch(html, /<p class=["']rail-label["']>个人<\/p>/u)
  assert.doesNotMatch(html, /我的共享|允许 Team 使用我连接的 Codex 账号/u)
  assert.match(html, /<span>\$\{roleLabel\(\)\}<\/span>/u)
  assert.doesNotMatch(html, />容量</u)
})

test('uses a member-centric CTA before generating an invitation token', async () => {
  const html = await readPrototype()

  assert.match(html, /data-action=["']go-invites["'][^>]*>邀请成员<\/button>/u)
  assert.match(html, /data-action=["']create-invite["'][^>]*>生成邀请码<\/button>/u)
  assert.doesNotMatch(html, /data-action=["']go-invites["'][^>]*>生成邀请码<\/button>/u)
  assert.doesNotMatch(html, /生成邀请码邀请成员/u)
})

test('keeps the invitation CTA on one line when the section heading gets tight', async () => {
  const html = await readPrototype()

  assert.match(html, /<div class=["']section-heading["']><div><h2>邀请码<\/h2><p>[^<]*<\/p><\/div><button class=["']primary["'] data-action=["']create-invite["']/u)
  assert.match(html, /\.section-heading > \.primary\s*\{[^}]*flex:\s*0 0 auto/u)
  assert.match(html, /\.section-heading > \.primary\s*\{[^}]*white-space:\s*nowrap/u)
})

test('exposes Owner, member, active, and paused prototype scenarios', async () => {
  const html = await readPrototype()

  for (const role of ['owner', 'member']) {
    assert.match(html, new RegExp(`data-demo-role=["']${role}["']`, 'u'))
  }

  for (const status of ['active', 'paused']) {
    assert.match(html, new RegExp(`data-team-status=["']${status}["']`, 'u'))
  }

  assert.match(html, /原型场景/u)
  assert.match(html, /Team Owner/u)
})

test('keeps the member list avatar-free and limits row management to removal', async () => {
  const html = await readPrototype()

  assert.doesNotMatch(html, /class=["'][^"']*avatar/u)
  assert.match(html, /Team Owner · 我/u)
  assert.match(html, /data-action=["']member-menu["']/u)
  assert.match(html, /data-action=["']remove-member["']/u)
  assert.doesNotMatch(html, /升为管理员|降为成员|修改角色/u)
})

test('keeps Owner actions in a grouped Team menu', async () => {
  const html = await readPrototype()

  assert.match(html, /Team 运行/u)
  assert.match(html, /所有权/u)
  assert.match(html, /Team 生命周期/u)
  assert.match(html, /data-action=["']pause-team["']/u)
  assert.match(html, /data-action=["']resume-team["']/u)
  assert.match(html, /data-action=["']transfer-owner["']/u)
  assert.match(html, /data-action=["']dissolve-team["']/u)
  assert.match(html, /永久解散 Team/u)
})

test('lets the Owner reveal and copy an active invitation again after closing', async () => {
  const html = await readPrototype()

  assert.match(html, /data-action=["']create-invite["']/u)
  assert.match(html, /data-action=["']reveal-invite["']/u)
  assert.match(html, /data-action=["']revoke-invite["']/u)
  assert.match(html, /查看邀请码/u)
  assert.match(html, /关闭后仍可从邀请码列表再次查看/u)
  assert.match(html, /state\.overlay === 'reveal-invite'/u)
  assert.match(html, /data-action=["']copy-invite["']/u)
  assert.doesNotMatch(html, /关闭后无法再次查看|完整邀请码只在这里显示一次|完整邀请码不会在列表中再次出现/u)
  assert.doesNotMatch(html, /localStorage|sessionStorage/u)
  assert.match(html, /1 天/u)
  assert.match(html, /7 天/u)
  assert.match(html, /30 天/u)
  assert.match(html, /暂停期间不能生成或使用邀请码/u)
})

test('keeps migrated summary-only invitations visible but not revealable', async () => {
  const html = await readPrototype()

  assert.match(html, /revealable: false/u)
  assert.match(html, /revealable: true/u)
  assert.match(html, /invite\.revealable/u)
  assert.match(html, /旧邀请码无法查看，请撤销后重新生成/u)
  assert.match(html, /if \(!inviteCode \|\| !invite\?\.revealable/u)
})

test('keeps invitation secrets out of browser metadata and clears every transient reveal boundary', async () => {
  const html = await readPrototype()
  const initialMarkup = html.slice(0, html.indexOf('<script>'))
  const browserState = html.slice(html.indexOf('const state = {'), html.indexOf('let returnFocusSelector'))

  assert.doesNotMatch(initialMarkup, /TEAM-[A-Z0-9-]+/u)
  assert.doesNotMatch(browserState, /\bcode\s*:/u)
  assert.doesNotMatch(browserState, /TEAM-[A-Z0-9-]+/u)
  assert.match(html, /const mockServerInviteVault = new Map/u)
  assert.match(html, /revealedInviteCode: ''/u)
  assert.match(html, /mockServerInviteVault\.get\(inviteId\)/u)
  assert.match(html, /function clearRevealedInvite\(/u)
  assert.match(html, /60_000/u)
  assert.match(html, /document\.addEventListener\('visibilitychange'/u)
  assert.match(html, /document\.hidden/u)
  assert.match(html, /patch\.view|patch\.role|patch\.currentMemberId|patch\.disconnected/u)
})

test('deletes mock server invitation secrets and makes revoke → dissolve count only active invites', async () => {
  const html = await readPrototype()
  const activeInvitesSource = html.match(/function activeInvites\(\) \{[\s\S]*?\n    \}/u)?.[0]

  assert.ok(activeInvitesSource)
  const countActiveInvites = new Function('state', `${activeInvitesSource}; return activeInvites().length`)
  const dissolveFixture = { invites: [{ status: 'pending', expired: false, revoked: false }] }
  assert.equal(countActiveInvites(dissolveFixture), 1)
  dissolveFixture.invites[0].revoked = true
  assert.equal(countActiveInvites(dissolveFixture), 0)
  assert.match(html, /mockServerInviteVault\.delete\(inviteId\)/u)
  assert.match(html, /mockServerInviteVault\.clear\(\)/u)
  assert.match(html, /action === 'confirm-join'[\s\S]*?consumeInvite/u)
  assert.match(html, /action === 'confirm-revoke-invite'[\s\S]*?deleteInviteSecret[\s\S]*?revoked: true/u)
  assert.match(html, /action === 'accept-transfer'[\s\S]*?deleteAllInviteSecrets/u)
  assert.match(html, /action === 'confirm-dissolve'[\s\S]*?deleteAllInviteSecrets/u)
  assert.match(html, /\$\{activeInvites\(\)\.length\} 个有效邀请码失效/u)
})

test('keeps personal membership and standalone joining distinct from Team lifecycle controls', async () => {
  const html = await readPrototype()

  assert.match(html, /data-action=["']leave-team["']/u)
  assert.match(html, /Team Owner 不能直接退出/u)
  assert.match(html, /data-action=["']preview-invite["']/u)
  assert.match(html, /data-action=["']confirm-join["']/u)
  assert.match(html, /以成员身份加入/u)
  assert.match(html, /data-join-stage=["']uncertain["']/u)
  assert.match(html, /恢复加入/u)
  assert.match(html, /取消加入/u)
})

test('rejects invalid invitations before preview or join succeeds', async () => {
  const html = await readPrototype()

  assert.match(html, /if \(!matchedInvite\)\s*\{[\s\S]*?邀请码无效或已失效，请向 Team Owner 获取新的邀请码。[\s\S]*?return/u)
  assert.match(html, /action === 'confirm-join'[\s\S]*?!state\.joinInviteId[\s\S]*?邀请码无效或已失效/u)
  assert.doesNotMatch(html, /joinInviteId: matchedInvite\?\.id \|\| null/u)
})

test('models the server-owned display-name rules and duplicate-name response', async () => {
  const html = await readPrototype()

  assert.match(html, /maxlength=["']120["']/u)
  assert.match(html, /function validateDisplayNameForDemo\(/u)
  assert.match(html, /normalize\('NFKC'\)/u)
  assert.match(html, /\[\.\.\.normalized\]\.length/u)
  assert.match(html, /Default_Ignorable_Code_Point/u)
  assert.match(html, /这个成员名称已被使用，请换一个名称/u)
  assert.match(html, /名称须为 1–120 个字符/u)
})

test('does not reintroduce mixed routing, server, credential, or activity content', async () => {
  const html = await readPrototype()

  assert.doesNotMatch(html, /一次请求如何路由/u)
  assert.doesNotMatch(html, /最近请求|使用记录/u)
  assert.doesNotMatch(html, /http:\/\/127\.0\.0\.1:3099/u)
  assert.doesNotMatch(html, /Team Key|auth\.json|OAuth/u)
  assert.doesNotMatch(html, /共享账号|保护策略/u)
})

test('keeps every Team action in one place and closes the join and exit state gaps', async () => {
  const html = await readPrototype()

  assert.doesNotMatch(html, /function renderTabs\(/u)
  assert.doesNotMatch(html, /data-action=["']open-transfer["']/u)
  assert.match(html, /Team 已暂停，暂时不能加入/u)
  assert.match(html, /data-terminal-state=["']left["']/u)
  assert.match(html, /使用新邀请码加入/u)
  assert.match(html, /joinCode: ''/u)
})

test('shows estimated spend and Token usage without exposing internal Credits explanations', async () => {
  const html = await readPrototype()

  assert.match(html, /预估费用/u)
  assert.match(html, /US\$ 18\.42/u)
  assert.match(html, /Token 用量/u)
  assert.match(html, /12\.6M/u)
  assert.match(html, /请求次数/u)
  assert.match(html, /最近 24 小时/u)
  assert.match(html, /Team 总用量/u)
  assert.match(html, /我的用量/u)
  assert.match(html, /完整数据/u)
  assert.match(html, /部分数据/u)
  assert.match(html, /价格未知/u)
  assert.match(html, /暂时无法获取用量/u)
  assert.match(html, /暂停前已准入的请求完成结算后，用量仍可能更新/u)
  assert.match(html, /state\.usageMode === 'complete'\s*\? ''/u)
  assert.match(html, /\$\{status \? `<span class="usage-status \$\{state\.usageMode\}">\$\{status\}<\/span>` : ''\}/u)
  assert.doesNotMatch(html, /这些数字是什么|Credits|已计量加权用量|计量覆盖|请求尝试|根据已测量 Token 加权计算|不是金额或订阅余额|usage-definition/u)
  assert.doesNotMatch(html, /Team 可用容量|由我提供|本周期已使用 42%|已使用 42%|成员账单/u)
})

test('does not duplicate personal sharing management inside Team settings', async () => {
  const html = await readPrototype()

  assert.match(html, /personalByMemberId/u)
  assert.match(html, /function currentPersonal\(/u)
  assert.match(html, /state\.personalByMemberId\[state\.currentMemberId\]/u)
  assert.doesNotMatch(html, /renderSharingPanel|usage-sharing|sharingEnabled/u)
  assert.doesNotMatch(html, /data-action=["'](?:manage|save)-sharing["']/u)
  assert.doesNotMatch(html, /我的共享|允许 Team 使用我连接的 Codex 账号|管理我的共享/u)
})

test('keeps confirmation dialogs keyboard-modal and restores focus', async () => {
  const html = await readPrototype()

  assert.match(html, /aria-modal=["']true["']/u)
  assert.match(html, /document\.querySelector\('#app'\)\.inert/u)
  assert.match(html, /event\.key === 'Escape'/u)
  assert.match(html, /event\.key !== 'Tab'/u)
  assert.match(html, /returnFocusSelector/u)
  assert.match(html, /function finishDialog/u)
  assert.match(html, /aria-label=["']Team 工作区["']/u)
  assert.doesNotMatch(html, /aria-label=["']个人设置["']/u)
  assert.match(html, /aria-haspopup=["']menu["']/u)
  assert.match(html, /aria-controls=["']team-menu["']/u)
  assert.match(html, /focusOpenMenu/u)
  assert.match(html, /function moveMenuFocus\(/u)
  assert.match(html, /ArrowDown/u)
  assert.match(html, /ArrowUp/u)
  assert.match(html, /event\.key === 'Home'/u)
  assert.match(html, /event\.key === 'End'/u)
  assert.match(html, /finishDialog\(\{ status: 'paused' \}\)/u)
})

test('requires confirmation before resuming a paused Team', async () => {
  const html = await readPrototype()

  assert.match(html, /action === 'resume-team'[\s\S]*?overlay: 'resume'/u)
  assert.match(html, /state\.overlay === 'resume'/u)
  assert.match(html, /data-action=["']confirm-resume["']/u)
  assert.match(html, /action === 'confirm-resume'[\s\S]*?finishDialog\(\{ status: 'active' \}\)/u)
})

test('distinguishes complete, partial, unpriced, unmeasured, zero, and unavailable usage states', async () => {
  const html = await readPrototype()

  assert.match(html, /usageMode: 'complete'/u)
  assert.match(html, /data-usage-mode=["']complete["']>完整数据/u)
  assert.match(html, /complete: \{ estimatedCost: 'US\$ 5\.88', tokens: '3\.9M', requests: '39', tokenObserved: '39 \/ 39', pricedObserved: '39 \/ 39' \}/u)
  assert.match(html, /partial/u)
  assert.match(html, /data-usage-mode=["']unpriced["']>价格未知/u)
  assert.match(html, /unpriced: \{ estimatedCost: '—', tokens: '0\.7M', requests: '7', tokenObserved: '7 \/ 7', pricedObserved: '0 \/ 7' \}/u)
  assert.match(html, /Token 已计量 \$\{values\.tokenObserved\} · 费用已计量 \$\{values\.pricedObserved\}/u)
  assert.match(html, /unmeasured/u)
  assert.match(html, /zero/u)
  assert.match(html, /unavailable/u)
  assert.match(html, /部分数据 · Token \$\{values\.tokenObserved\} · 费用 \$\{values\.pricedObserved\}/u)
  assert.match(html, /暂无计量数据/u)
  assert.match(html, /暂无请求/u)
  assert.match(html, /estimatedCost: '—'/u)
  assert.match(html, /estimatedCost: 'US\$ 0\.00'/u)
  assert.doesNotMatch(html, /credits:|attempts:|metered:|\bobserved:/u)
})

test('keeps the prototype scenario controls from covering mobile content', async () => {
  const html = await readPrototype()

  assert.match(html, /\.scenario-inner\s*\{[^}]*flex-wrap:\s*wrap[^}]*overflow-x:\s*visible/u)
  assert.match(html, /@media \(max-width: 900px\)[\s\S]*?\.rail-kicker, \.rail-label, \.rail-foot\s*\{[^}]*display:\s*none/u)
  assert.match(html, /@media \(max-width: 900px\)[\s\S]*?\.scenario\s*\{[^}]*position:\s*static/u)
  assert.match(html, /@media \(max-width: 900px\)[\s\S]*?\.rail-title\s*\{[^}]*flex:\s*0 0 100%/u)
  assert.match(html, /@media \(max-width: 620px\)[\s\S]*?\.menu\s*\{[^}]*position:\s*static/u)
  assert.match(html, /@media \(max-width: 620px\)[\s\S]*?\.prototype-bar span\s*\{[^}]*display:\s*none/u)
  assert.match(html, /@media \(max-width: 620px\)[\s\S]*?\.scenario\s*\{[^}]*position:\s*static/u)
  assert.match(html, /@media \(max-width: 620px\)[\s\S]*?\.scenario button\s*\{[^}]*min-height:\s*44px/u)
  assert.match(html, /aria-pressed=/u)
  assert.match(html, /if \(!target\)\s*\{[\s\S]*?state\.overlay === 'team-menu'/u)
})

test('wraps maximum-length member names and invitation labels on narrow screens', async () => {
  const html = await readPrototype()

  assert.match(html, /\.row-title\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/u)
  assert.match(html, /\.role\s*\{[^}]*white-space:\s*nowrap/u)
  assert.match(html, /maxlength=["']120["']/u)
  assert.match(html, /maxlength=["']120["']/u)
})

test('escapes user-authored invite labels and display names before rendering HTML', async () => {
  const html = await readPrototype()

  assert.match(html, /function escapeHtml\(value\)/u)
  assert.match(html, /escapeHtml\(member\.name\)/u)
  assert.match(html, /escapeHtml\(invite\.label\)/u)
  assert.match(html, /escapeHtml\(state\.joinCode\)/u)
  assert.match(html, /escapeHtml\(state\.joinName\)/u)
  assert.match(html, /escapeHtml\(state\.toast\)/u)
  assert.doesNotMatch(html, /\$\{invite\.label\}|\$\{member\.name\}|\$\{state\.revealedInviteCode\}/u)
})

test('prevents ownership transfer overwrite and states the full dissolution impact', async () => {
  const html = await readPrototype()

  assert.match(html, /pendingTransferRecord\(\)[\s\S]*已有转让请求待确认/u)
  assert.match(html, /action === 'transfer-owner' && !pendingTransferRecord\(\)/u)
  assert.match(html, /全部 Team 设备凭据会立即撤销/u)
})

test('limits ownership transfer to eligible members and models its 24-hour expiry', async () => {
  const html = await readPrototype()

  assert.match(html, /eligibleForOwnership: true/u)
  assert.match(html, /member\.role === 'member' && member\.eligibleForOwnership/u)
  assert.match(html, /const TRANSFER_TTL_MS = 86_400_000/u)
  assert.match(html, /pendingTransferExpiresAt/u)
  assert.match(html, /Date\.now\(\) >= state\.pendingTransferExpiresAt/u)
  assert.match(html, /24 小时后自动到期/u)
})

test('locks background scrolling whenever a modal dialog is open', async () => {
  const html = await readPrototype()

  assert.match(html, /document\.documentElement\.classList\.toggle\('dialog-open', Boolean\(dialog\)\)/u)
  assert.match(html, /html\.dialog-open,\s*html\.dialog-open body\s*\{[^}]*overflow:\s*hidden/u)
})
