// 镜像逻辑 parity:client.js 与 core.mjs 双实现同源(仓库规约"双实现同源必须 parity 测试")。
// client.js 为单文件自包含格式无法 import,此处按标记切片提取镜像函数段,
// 经 new Function 实例化后与 core.mjs 同输入断言同输出。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  filterHistoryInputs as coreFilterHistoryInputs,
  forkFailureText as coreForkFailureText,
  HISTORY_SCOPES,
} from '../src/core.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SRC = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
const INDEX_SRC = readFileSync(join(PKG_ROOT, 'src', 'index.js'), 'utf8')

// 切片:filterHistoryInputs 与 forkFailureText 均为无外部依赖纯函数,
// 以「历史范围常量声明」为起点、「历史浮层组件声明」为终点
const MIRROR_START = CLIENT_SRC.indexOf('const HISTORY_SCOPES = ')
const MIRROR_END = CLIENT_SRC.indexOf('function HistoryDock(')
assert.ok(MIRROR_START >= 0 && MIRROR_END > MIRROR_START, 'client.js 镜像函数切片定位失败')

const mirror = new Function(
  CLIENT_SRC.slice(MIRROR_START, MIRROR_END)
  + '; return { filterHistoryInputs: filterHistoryInputs, forkFailureText: forkFailureText, HISTORY_SCOPES: HISTORY_SCOPES }',
)()

test('parity 历史搜索:子串/空白/空查询/非数组同输入同输出', () => {
  const rows = [
    { text: '修复归档面板', at: 1 },
    { text: 'Fix Fork Anchor', at: 2 },
    { text: '无关条目', at: 3 },
  ]
  for (const query of ['归档', 'fork', 'FIX', '  ', '', '不存在']) {
    assert.deepEqual(mirror.filterHistoryInputs(rows, query), coreFilterHistoryInputs(rows, query))
  }
  assert.deepEqual(mirror.filterHistoryInputs(undefined, 'a'), coreFilterHistoryInputs(undefined, 'a'))
})

test('parity fork 错误文案:未知码/挂载失败/未完成轮同输入同输出', () => {
  for (const code of ['session/fork-unavailable', 'session/workspace-attach-failed', 'gateway/internal', undefined, '']) {
    assert.equal(mirror.forkFailureText(code), coreForkFailureText(code))
  }
})

test('parity 历史范围:client 与 core 的 HISTORY_SCOPES 同序同值', () => {
  assert.deepEqual(mirror.HISTORY_SCOPES, HISTORY_SCOPES)
})

test('源码契约:client fetchInputs 必须解包 host 响应信封 { inputs, aligned }', () => {
  // host 与 client 对信封各自测试自洽时,信封形状漂移只会以运行时 TypeError 暴露;
  // 此守卫锁定解包点存在,防消费侧把信封对象当数组使用
  const guard = /Array\.isArray\((\w+)\.inputs\)/
  assert.ok(guard.test('Array.isArray(payload.inputs)'), '守卫正则必须命中合规样本')
  const fetchStart = CLIENT_SRC.indexOf('function fetchInputs(')
  const fetchBody = fetchStart >= 0 ? CLIENT_SRC.slice(fetchStart, CLIENT_SRC.indexOf('\n  }', fetchStart)) : ''
  assert.ok(fetchBody.includes('api(INPUTS_URL'), '未找到 fetchInputs 的 host 请求')
  assert.ok(guard.test(fetchBody), 'fetchInputs 缺少 payload.inputs 数组解包')
  assert.ok(fetchBody.includes('payload.aligned'), 'fetchInputs 缺少 aligned 字段解包')
})

test('parity API 路径:client 字面量与 host 路由注册互为镜像', () => {
  // 跨半区契约拼错只会在运行时 404,双向集合相等断言防漂移
  const clientUrls = new Set([...CLIENT_SRC.matchAll("'(/api/context/[^']*)'")].map((m) => m[1])
    .filter((url) => !url.endsWith('/*')))
  assert.ok(clientUrls.size >= 5, 'client.js API 路径字面量异常减少')
  const hostPaths = new Set([...INDEX_SRC.matchAll(/path: '(\/api\/context\/[^']*)'/g)].map((m) => m[1]))
  assert.deepEqual([...hostPaths].sort(), [...clientUrls].sort(), 'client 与 host 的 API 路径集合不一致')
})
