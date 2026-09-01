import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const prototypeUrl = new URL('./team-account-onboarding.html', import.meta.url)

test('documents the local-to-Team authorization contract', async () => {
  const html = await readFile(prototypeUrl, 'utf8')

  assert.match(html, /本机账号/u)
  assert.match(html, /需要再次授权/u)
  assert.match(html, /不会上传本机 auth\.json/u)
  assert.match(html, /用于 Team/u)
  assert.match(html, /添加其他 Team 账号/u)
  assert.match(html, /取消等待/u)
  assert.match(html, /终止共享/u)
})

test('exposes stable hooks for the three visible prototype states', async () => {
  const html = await readFile(prototypeUrl, 'utf8')

  for (const state of ['local', 'authorizing', 'team-active']) {
    assert.match(html, new RegExp(`data-account-state=["']${state}["']`, 'u'))
  }
  assert.doesNotMatch(html, /data-account-state=["']team-paused["']/u)
})

test('follows the existing Codex settings two-column visual model', async () => {
  const html = await readFile(prototypeUrl, 'utf8')

  assert.match(html, /class="dsh-codex-team-workspace"/u)
  assert.match(html, /class="dsh-codex-team-profile-list"/u)
  assert.match(html, /class="dsh-codex-team-profile-detail"/u)
  assert.doesNotMatch(html, /class="flow"/u)
  assert.doesNotMatch(html, /Team 调度规则/u)
})

test('does not describe a Team-only account as locally logged in', async () => {
  const html = await readFile(prototypeUrl, 'utf8')

  assert.match(html, /account\.source === 'teammate'/u)
  assert.match(html, /account\.ownerName \+ ' 贡献'/u)
  assert.match(html, /: '仅 Team'/u)
})

test('keeps quota separate from authorization status copy', async () => {
  const html = await readFile(prototypeUrl, 'utf8')

  assert.match(html, /quota: 74/u)
  assert.match(html, /return account\.quota/u)
})

test('merges local and Team management into one Codex subscription pool page', async () => {
  const html = await readFile(prototypeUrl, 'utf8')

  assert.match(html, /<span>Codex 订阅池<\/span>/u)
  assert.match(html, /<h1>Codex 订阅池<\/h1>/u)
  assert.match(html, /role="tablist"/u)
  assert.match(html, /data-pool-tab="local"/u)
  assert.match(html, /data-pool-tab="team"/u)
  assert.doesNotMatch(html, /<span>OpenAI Codex<\/span>/u)
  assert.doesNotMatch(html, /<span>Codex 团队<\/span>/u)
})

test('separates shared and unshared accounts with contributor labels and usage', async () => {
  const html = await readFile(prototypeUrl, 'utf8')

  assert.match(html, /label: '共享账号'/u)
  assert.match(html, /label: '未共享账号'/u)
  assert.doesNotMatch(html, /label: '我的贡献'/u)
  assert.doesNotMatch(html, /label: '团队其他账号'/u)
  assert.match(html, /'我贡献'/u)
  assert.match(html, /account\.ownerName \+ ' 贡献'/u)
  assert.match(html, /团队使用情况/u)
  assert.match(html, /最近 1 天/u)
  assert.match(html, /已用 Credits/u)
  assert.match(html, /每日共享上限/u)
  assert.match(html, /个人保留线/u)
  assert.match(html, /未缓存输入 × 1/u)
  assert.match(html, /缓存输入 × 0\.25/u)
  assert.match(html, /输出（含推理）× 4/u)
  assert.match(html, /不等于订阅剩余百分比或金额/u)
  assert.match(html, /请求完成后更新 · 最长每 1 分钟自动刷新/u)
  assert.match(html, /查看近 7 天/u)
  assert.match(html, /近 7 天/u)
  assert.doesNotMatch(html, /近 30 天/u)
  assert.match(html, /class="usage-chart"/u)
  assert.match(html, /请求次数/u)
  assert.match(html, /Credits/u)
  assert.match(html, /重试会分别计数/u)
  assert.match(html, /不含贡献者本人/u)
  assert.doesNotMatch(html, /额度净变化/u)
  assert.doesNotMatch(html, /账号整体估算/u)
  assert.match(html, /data-action="stop-sharing"/u)
  assert.doesNotMatch(html, /从 Team 移除/u)
  assert.match(html, /account\.state = 'local'/u)
  assert.match(html, /source: 'teammate'/u)
  assert.match(html, /ownerName: 'Mia'/u)
  assert.match(html, /由贡献者管理/u)
  assert.match(html, /account\.source === 'local'/u)
})
