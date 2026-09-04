// parity 测试:client.js 的 LOGIC 标记段与 core.mjs 同源函数对拍,
// 数据镜像常量(默认值/VERDICT)与 host 侧组合值对照。
// client 半区无法 import ESM,按 LOGIC 标记提取源码文本后工厂化执行。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  shouldReloadAfterRestart as coreShouldReload,
  isValidRegistryBase as coreIsValidRegistryBase,
  VERDICT_OUTDATED,
  VERDICT_UP_TO_DATE,
  VERDICT_UNKNOWN,
  TARGET_PACKAGE,
  TAG_PLACEHOLDER,
} from '../src/core.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SOURCE = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

// 提取 LOGIC-BEGIN <name> ... LOGIC-END <name> 之间的函数体并工厂化
function extractLogic(name) {
  const pattern = new RegExp('// LOGIC-BEGIN ' + name + '\\n([\\s\\S]*?)\\n\\s*// LOGIC-END ' + name)
  const match = CLIENT_SOURCE.match(pattern)
  assert.ok(match, 'client.js 缺少 LOGIC 段: ' + name)
  return new Function('return ' + match[1].trim())()
}

function extractConst(name) {
  // 行首锚定 + 全局扫描唯一性:防注释/示例代码中的同名字样静默错抓
  const pattern = new RegExp('^const ' + name + " = '([^']*)'", 'm')
  const all = CLIENT_SOURCE.match(new RegExp(pattern.source, 'gm'))
  assert.ok(all && all.length >= 1, 'client.js 缺少常量: ' + name)
  assert.equal(all.length, 1, 'client.js 常量声明不唯一: ' + name)
  return all[0].match(pattern)[1]
}

function extractNumberConst(name) {
  const pattern = new RegExp('^const ' + name + ' = ([0-9 *]+)$', 'm')
  const all = CLIENT_SOURCE.match(new RegExp(pattern.source, 'gm'))
  assert.ok(all && all.length >= 1, 'client.js 缺少常量: ' + name)
  assert.equal(all.length, 1, 'client.js 常量声明不唯一: ' + name)
  return eval(all[0].match(pattern)[1])
}

const clientShouldReload = extractLogic('shouldReloadAfterRestart')
const clientIsValidRegistryBase = extractLogic('isValidRegistryBase')

const RELOAD_CASES = [
  { params: { lost: true, pidBefore: 1, pidAfter: 1 }, expected: true },
  { params: { lost: false, pidBefore: 7, pidAfter: 8 }, expected: true },
  { params: { lost: false, pidBefore: 7, pidAfter: 7 }, expected: false },
  { params: { lost: false, pidBefore: null, pidAfter: 8 }, expected: false },
  { params: { lost: false, pidBefore: 7, pidAfter: null }, expected: false },
  { params: { lost: false, pidBefore: undefined, pidAfter: undefined }, expected: false },
  { params: { lost: true, pidBefore: null, pidAfter: null }, expected: true },
]

const REGISTRY_CASES = [
  { value: 'https://registry.npmjs.org', expected: true },
  { value: 'http://localhost:4873', expected: true },
  { value: 'HTTPS://MIRROR.EXAMPLE', expected: true },
  { value: '  https://padded.example  ', expected: true },
  { value: 'ftp://registry.example', expected: false },
  { value: 'registry.npmjs.org', expected: false },
  { value: '', expected: false },
  { value: null, expected: false },
  { value: undefined, expected: false },
  { value: 123, expected: false },
]

test('parity: shouldReloadAfterRestart 双实现全场景一致', () => {
  for (const { params, expected } of RELOAD_CASES) {
    assert.equal(coreShouldReload(params), expected, 'core ' + JSON.stringify(params))
    assert.equal(clientShouldReload(params), expected, 'client ' + JSON.stringify(params))
  }
})

test('parity: isValidRegistryBase 双实现全场景一致', () => {
  for (const { value, expected } of REGISTRY_CASES) {
    assert.equal(coreIsValidRegistryBase(value), expected, 'core ' + JSON.stringify(value))
    assert.equal(clientIsValidRegistryBase(value), expected, 'client ' + JSON.stringify(value))
  }
})

test('parity: VERDICT 三常量 client 与 core 一致', () => {
  assert.equal(extractConst('VERDICT_OUTDATED'), VERDICT_OUTDATED)
  assert.equal(extractConst('VERDICT_UP_TO_DATE'), VERDICT_UP_TO_DATE)
  assert.equal(extractConst('VERDICT_UNKNOWN'), VERDICT_UNKNOWN)
})

// host 侧锚点直接 import index.js 实现,防测试内手抄字面量漂移假绿
import { DEFAULT_UPGRADE_TEMPLATE, DEFAULT_POLL_INTERVAL_SEC, DEFAULT_REGISTRY_BASE, TICK_MS } from '../src/index.js'

test('parity: 默认升级命令模板 client 字面量与 host 实现一致', () => {
  assert.equal(extractConst('DEFAULT_UPGRADE_TEMPLATE'), DEFAULT_UPGRADE_TEMPLATE)
})

test('parity: 默认轮询间隔与镜像地址 client 与 host 实现一致', () => {
  assert.equal(extractNumberConst('DEFAULT_POLL_INTERVAL_SEC'), DEFAULT_POLL_INTERVAL_SEC)
  assert.equal(extractConst('DEFAULT_REGISTRY_BASE'), DEFAULT_REGISTRY_BASE)
})

test('parity: client 轮询粒度提示与 host TICK_MS 换算一致', () => {
  assert.equal(extractNumberConst('POLL_MIN_TICK_SECONDS'), TICK_MS / 1000)
})
