import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseSemver,
  gtSemver,
  judgeVersion,
  buildUpgradeCommand,
  assertSameOrigin,
  VERDICT_OUTDATED,
  VERDICT_UP_TO_DATE,
  VERDICT_UNKNOWN,
} from '../src/core.mjs'

const CURRENT = '0.1.1-rc.2'

test('semver 解析:标准版本含 prerelease 与 build', () => {
  const parsed = parseSemver('1.2.3-rc.2+build.7')
  assert.deepEqual(
    { major: parsed.major, minor: parsed.minor, patch: parsed.patch, prerelease: parsed.prerelease },
    { major: 1, minor: 2, patch: 3, prerelease: ['rc', 2] },
  )
})

test('semver 解析:非 semver 字符串返回 null', () => {
  assert.equal(parseSemver('latest'), null)
  assert.equal(parseSemver(''), null)
  assert.equal(parseSemver(null), null)
  assert.equal(parseSemver('1.2'), null)
  assert.equal(parseSemver('01.2.3'), null)
})

test('semver 比较:prerelease 数值序 rc.2 低于 rc.10', () => {
  assert.equal(gtSemver('0.1.1-rc.10', '0.1.1-rc.2'), true)
  assert.equal(gtSemver('0.1.1-rc.2', '0.1.1-rc.10'), false)
})

test('semver 比较:无 prerelease 高于有 prerelease', () => {
  assert.equal(gtSemver('0.1.1', '0.1.1-rc.2'), true)
  assert.equal(gtSemver('0.1.1-rc.2', '0.1.1'), false)
})

test('semver 比较:spec 官方示例链严格升序', () => {
  const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
  for (let i = 1; i < chain.length; i++) {
    assert.equal(gtSemver(chain[i], chain[i - 1]), true, chain[i] + ' 应高于 ' + chain[i - 1])
    assert.equal(gtSemver(chain[i - 1], chain[i]), false, chain[i - 1] + ' 不应高于 ' + chain[i])
  }
})

test('semver 比较:build 元数据不参与比较', () => {
  assert.equal(gtSemver('1.0.0+build.1', '1.0.0+build.2'), false)
  assert.equal(gtSemver('1.0.0', '1.0.0+build.2'), false)
})

test('semver 比较:含非法版本返回 false', () => {
  assert.equal(gtSemver('not-a-version', '1.0.0'), false)
  assert.equal(gtSemver('1.0.0', null), false)
})

test('场景:通道落后判定', () => {
  const result = judgeVersion({ currentVersion: CURRENT, tags: { latest: '0.1.2-alpha.3', next: CURRENT }, channel: 'latest' })
  assert.equal(result.verdict, VERDICT_OUTDATED)
  assert.equal(result.channelLatest, '0.1.2-alpha.3')
  assert.equal(result.reason, null)
})

test('场景:通道切换后判定跟随', () => {
  const tags = { latest: '0.1.2-alpha.3', next: CURRENT, alpha: '0.1.2-alpha.3' }
  assert.equal(judgeVersion({ currentVersion: CURRENT, tags, channel: 'alpha' }).verdict, VERDICT_OUTDATED)
  assert.equal(judgeVersion({ currentVersion: CURRENT, tags, channel: 'next' }).verdict, VERDICT_UP_TO_DATE)
})

test('场景:已是最新判定', () => {
  const result = judgeVersion({ currentVersion: CURRENT, tags: { latest: CURRENT }, channel: 'latest' })
  assert.equal(result.verdict, VERDICT_UP_TO_DATE)
})

test('场景:通道不在 dist-tags 判未知', () => {
  const result = judgeVersion({ currentVersion: CURRENT, tags: { latest: CURRENT }, channel: 'beta' })
  assert.equal(result.verdict, VERDICT_UNKNOWN)
  assert.equal(result.channelLatest, null)
  assert.match(result.reason, /beta/)
})

test('场景:当前版本或 tags 缺失判未知', () => {
  assert.equal(judgeVersion({ currentVersion: null, tags: { latest: '1.0.0' }, channel: 'latest' }).verdict, VERDICT_UNKNOWN)
  assert.equal(judgeVersion({ currentVersion: CURRENT, tags: null, channel: 'latest' }).verdict, VERDICT_UNKNOWN)
})

test('场景:版本字符串非法判未知', () => {
  const result = judgeVersion({ currentVersion: 'dev-main', tags: { latest: '1.0.0' }, channel: 'latest' })
  assert.equal(result.verdict, VERDICT_UNKNOWN)
  assert.match(result.reason, /dev-main/)
})

test('场景:升级命令占位符替换', () => {
  const command = buildUpgradeCommand({ template: 'npm install -g @deepseek-ai/dsh@{tag}', tag: 'next' })
  assert.equal(command, 'npm install -g @deepseek-ai/dsh@next')
})

test('场景:升级命令模板可整体自改为无占位符命令', () => {
  const command = buildUpgradeCommand({ template: 'pnpm add -g @deepseek-ai/dsh', tag: 'alpha' })
  assert.equal(command, 'pnpm add -g @deepseek-ai/dsh')
})

test('场景:升级命令占位符多次出现全部替换', () => {
  const command = buildUpgradeCommand({ template: 'echo {tag} {tag}', tag: 'latest' })
  assert.equal(command, 'echo latest latest')
})

test('场景:升级命令模板为空拒绝执行', () => {
  assert.throws(() => buildUpgradeCommand({ template: '   ', tag: 'latest' }), /模板/)
  assert.throws(() => buildUpgradeCommand({ template: null, tag: 'latest' }), /模板/)
})

test('场景:同源请求触发重启允许', () => {
  assert.equal(assertSameOrigin({ origin: 'http://192.168.1.10:3080', referer: null, host: '192.168.1.10:3080' }), true)
  assert.equal(assertSameOrigin({ origin: null, referer: 'http://192.168.1.10:3080/settings', host: '192.168.1.10:3080' }), true)
})

test('场景:跨站请求被拒绝', () => {
  assert.throws(
    () => assertSameOrigin({ origin: 'http://evil.example:8080', referer: null, host: '192.168.1.10:3080' }),
    /不一致/,
  )
  assert.throws(
    () => assertSameOrigin({ origin: null, referer: 'http://evil.example/settings', host: '192.168.1.10:3080' }),
    /不一致/,
  )
})

test('场景:缺少来源头被拒绝', () => {
  assert.throws(() => assertSameOrigin({ origin: null, referer: null, host: '127.0.0.1:3080' }), /缺少/)
})

test('场景:请求 Host 缺失拒绝', () => {
  assert.throws(() => assertSameOrigin({ origin: 'http://127.0.0.1:3080', referer: null, host: '' }), /Host/)
})

test('场景:大小写不敏感比对', () => {
  assert.equal(assertSameOrigin({ origin: 'http://MY-PC.local:3080', referer: null, host: 'my-pc.local:3080' }), true)
})
