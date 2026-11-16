// matchDeny 纯函数:命令黑名单匹配(deny 绝对:命中即拒,无豁免语义)。
// BDD 场景见 docs/progress/feat-shell-select-deny.md 场景 1-4/6。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchDeny, DenyError } from '../src/denylist.mjs'

test('deny 命中:抛 DenyError,消息含命中的 pattern', () => {
  const deny = ['format ']
  assert.throws(() => matchDeny('format c: /q', deny), (error) => {
    assert.ok(error instanceof DenyError)
    assert.equal(error.code, 'SHELL_COMMAND_BLOCKED')
    assert.ok(error.message.includes('format '))
    return true
  })
})

test('精细放行在 deny 模式内用前瞻表达:禁 rm -rf,放行清 node_modules', () => {
  const deny = ['rm -rf\\s+(?!\\S*node_modules)']
  assert.throws(() => matchDeny('rm -rf C:\\Windows', deny), DenyError)
  assert.doesNotThrow(() => matchDeny('rm -rf ./node_modules', deny))
})

test('大小写不敏感:DISKPART 拒绝 diskpart', () => {
  assert.throws(() => matchDeny('diskpart', ['DISKPART']), DenyError)
})

test('空配置不拦:deny 空数组/undefined 照常放行', () => {
  assert.doesNotThrow(() => matchDeny('git status', []))
  assert.doesNotThrow(() => matchDeny('git status', undefined))
})

test('坏正则容错:非法条目跳过,不瘫执行链', () => {
  assert.doesNotThrow(() => matchDeny('anything', ['[bad', '(bad', 'ok']))
})

test('多行命令整文本匹配:第一行干净也挡住后续行命中', () => {
  assert.throws(() => matchDeny('echo start\nformat c:', ['format ']), DenyError)
})

test('P3 编译缓存:同一 deny 配置数组只编译一轮,逐命令不重编译正则', () => {
  // Given 配置快照里的 deny 数组(数组引用在两次 refresh 之间稳定)
  let compilePasses = 0
  const patterns = new Proxy(['format ', 'diskpart'], {
    get(target, prop, receiver) {
      if (prop === 'map') {
        return (fn) => {
          compilePasses += 1
          return target.map(fn)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  // When 连续匹配多条命令
  assert.doesNotThrow(() => matchDeny('git status', patterns))
  assert.throws(() => matchDeny('diskpart', patterns), DenyError)
  assert.throws(() => matchDeny('format c:', patterns), DenyError)
  // Then 只编译一轮(旧实现每条命令重编译整表)
  assert.equal(compilePasses, 1)
})
