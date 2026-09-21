// matchDeny 纯函数:命令黑白名单匹配(防火墙语义:allow 豁免 > deny 拒绝)。
// BDD 场景见 docs/progress/feat-shell-select-deny.md 场景 1-4/6。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchDeny, DenyError } from '../src/denylist.mjs'

test('deny 命中:抛 DenyError,消息含命中的 pattern', () => {
  const deny = ['format ']
  assert.throws(() => matchDeny('format c: /q', deny, []), (error) => {
    assert.ok(error instanceof DenyError)
    assert.equal(error.code, 'SHELL_COMMAND_BLOCKED')
    assert.ok(error.message.includes('format '))
    return true
  })
})

test('allow 豁免:命中 allow 的命令跳过 deny 检查', () => {
  const deny = ['rm -rf']
  const allow = ['rm -rf .*node_modules']
  assert.doesNotThrow(() => matchDeny('rm -rf ./node_modules', deny, allow))
  assert.throws(() => matchDeny('rm -rf C:\\Windows', deny, allow), DenyError)
})

test('大小写不敏感:DISKPART 拒绝 diskpart', () => {
  assert.throws(() => matchDeny('diskpart', ['DISKPART'], []), DenyError)
})

test('空配置不拦:deny 空数组/undefined 照常放行', () => {
  assert.doesNotThrow(() => matchDeny('git status', [], []))
  assert.doesNotThrow(() => matchDeny('git status', undefined, undefined))
})

test('坏正则容错:非法条目跳过,不瘫执行链', () => {
  assert.doesNotThrow(() => matchDeny('anything', ['[bad', '(bad', 'ok'], []))
})

test('多行命令整文本匹配:第一行干净也挡住后续行命中', () => {
  assert.throws(() => matchDeny('echo start\nformat c:', ['format '], []), DenyError)
})
