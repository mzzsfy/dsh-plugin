// 看板失效广播接线:写入口收敛在 store 层,host apply 经公共总线发布
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTaskStore } from '../lib/store.mjs'
import { createTask } from '../lib/core/task.mjs'
import { registerControl, getControlRuntime, setControlRuntime } from '../lib/control.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(join(root, path), 'utf8')

// 桩表:镜像 storageDomain 单记录 update 原子读改写,missing-key 抛错
function tableFixture() {
  const records = new Map()
  const serialize = value => JSON.parse(JSON.stringify(value))
  return {
    get(key) { return records.has(key) ? serialize(records.get(key)) : undefined },
    async put(key, value) { records.set(key, serialize(value)) },
    async update(key, fn) {
      if (!records.has(key)) throw Object.assign(new Error(`missing-key ${key}`), { code: 'missing-key' })
      const next = fn(serialize(records.get(key)))
      records.set(key, serialize(next))
      return serialize(next)
    },
    entries() { return records.entries() },
  }
}

test('Given 公共依赖清单 When 检查 manifest Then 声明 common-tools 依赖与 client external', () => {
  const pkg = JSON.parse(read('package.json'))
  // 范围锁在库的同一 minor 内且下限不高于库 patch(库发 patch 不要求消费方重发),
  // 不在测试里硬编码具体版本
  const lib = JSON.parse(readFileSync(join(root, '../dsh-common-tools/package.json'), 'utf8'))
  const [major, minor, patch] = lib.version.split('.').map(Number)
  const range = pkg.dependencies['@mzzsfy/dsh-common-tools']
  const match = new RegExp(`^\\^${major}\\.${minor}\\.(\\d+)$`).exec(range)
  assert.ok(match, `依赖范围 ${range} 应锁在 ${major}.${minor}.x`)
  assert.ok(Number(match[1]) <= patch, `依赖范围 ${range} 下限高于库版本 ${lib.version}`)
  assert.deepEqual(pkg.dsh.client.external, ['@mzzsfy/dsh-common-tools/client'])
})

test('Given host apply When 控制室装配 Then 公共总线发布失效且写入口注入 onChange', () => {
  const source = read('lib/index.js')
  assert.match(source, /export const inject = \['webServer'\]/)
  assert.match(source, /const tools = setupCommonTools\(ctx\)/)
  assert.match(source, /const changes = createChangeNotifier\(\(\) => tools\.publish\(\)\)/)
  assert.match(source, /ctx\.effect\(\(\) => \(\) => changes\.dispose\(\)/)
  assert.match(source, /registerControl\(ctx, \{ onChange: changes\.refresh \}\)/)
  const control = read('lib/control.mjs')
  assert.match(control, /createTaskStore\(table, \{ onChange \}\)/)
  assert.match(control, /onChange\(\)/)
})

test('Given 看板写路径 When 任务/控制/管理员绑定写入成功 Then onChange 各触发一次;读取不触发', async () => {
  let changes = 0
  const store = createTaskStore(tableFixture(), { now: () => 100, onChange: () => { changes += 1 } })
  const task = createTask({ taskId: 't1', title: '任务', projectWorkspaceId: 'ws1', definition: { goal: '目标' }, now: () => 100 }).result
  await store.saveAggregate(task)
  assert.equal(changes, 1)
  await store.loadAggregate('t1')
  await store.listAggregates()
  await store.loadControl()
  assert.equal(changes, 1, '读取不得广播')
  await store.updateAggregate('t1', current => ({ ...current, title: '改名' }))
  assert.equal(changes, 2)
  await store.updateControl(control => control)
  assert.equal(changes, 3)
})

test('Given 存储写失败 When 更新被拒 Then 不广播失效', async () => {
  let changes = 0
  const store = createTaskStore(tableFixture(), { onChange: () => { changes += 1 } })
  await assert.rejects(store.updateAggregate('missing', current => current))
  assert.equal(changes, 0)
})

test('Given 控制室装配 When 路由/工具写入聚合 Then onChange 经 store 冒泡', async () => {
  let changes = 0
  const disposers = []
  let opening = null
  const table = tableFixture()
  const services = {
    storageDomain: { open: async () => ({ table: () => table, close() {} }) },
    webServer: { register: () => () => {} },
  }
  const ctx = {
    async inject(names, activate) {
      if (names.every(name => services[name])) {
        const result = await activate(services)
        if (names.includes('storageDomain')) opening = Promise.resolve(result)
      }
    },
    effect(effect) { if (typeof effect === 'function') { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose) } },
    provide() {}, on() {},
  }
  try {
    registerControl(ctx, { onChange: () => { changes += 1 } })
    await opening
    const runtime = getControlRuntime()
    assert.ok(runtime?.store, '控制室运行时未装配')
    const task = createTask({ taskId: 't1', title: '任务', projectWorkspaceId: 'ws1', definition: { goal: '目标' }, now: () => 100 }).result
    await runtime.store.saveAggregate(task)
    assert.equal(changes, 1)
    await runtime.store.loadAggregate('t1')
    assert.equal(changes, 1)
  } finally {
    setControlRuntime(null)
    disposers.reverse().forEach(dispose => dispose())
  }
})
