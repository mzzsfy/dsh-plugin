// 环境变量同名多值展开测试(多账号语义,设计 §4.2)。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { expandEnvMatrix } from '../src/env-expand.mjs'

test('env-expand:同名多值展开为笛卡尔积,单值名称每组携带', () => {
  // Given 启用变量 A=1/A=2(同名多值)与 B=x
  const envs = [
    { name: 'A', value: '1', enabled: true },
    { name: 'A', value: '2', enabled: true },
    { name: 'B', value: 'x', enabled: true },
  ]
  // When 展开
  const { combinations, truncated } = expandEnvMatrix({ envs, maxExpansion: 20 })
  // Then 两组:第一次 A=1,B=x;第二次 A=2,B=x
  assert.equal(truncated, false)
  assert.deepEqual(combinations, [
    { A: '1', B: 'x' },
    { A: '2', B: 'x' },
  ])
})

test('env-expand:禁用变量不注入', () => {
  // Given 含禁用变量 C=3
  const envs = [
    { name: 'A', value: '1', enabled: true },
    { name: 'C', value: '3', enabled: false },
  ]
  // When 展开
  const { combinations } = expandEnvMatrix({ envs, maxExpansion: 20 })
  // Then C 不出现
  assert.deepEqual(combinations, [{ A: '1' }])
})

test('env-expand:空集合产出单组空组合,shell 任务无变量也可运行', () => {
  // Given 无启用变量
  // When 展开
  const { combinations } = expandEnvMatrix({ envs: [], maxExpansion: 20 })
  // Then 一组空组合
  assert.deepEqual(combinations, [{}])
})

test('env-expand:组合数超上限截断并标记', () => {
  // Given 三个名称各 4 个启用值 = 64 组,上限 20
  const names = ['A', 'B', 'C']
  const envs = []
  for (const name of names) {
    for (let i = 1; i <= 4; i++) envs.push({ name, value: String(i), enabled: true })
  }
  // When 展开
  const { combinations, truncated } = expandEnvMatrix({ envs, maxExpansion: 20 })
  // Then 仅前 20 组且 truncated=true
  assert.equal(combinations.length, 20)
  assert.equal(truncated, true)
})

test('env-expand:大组合限量生成,不物化指数级全量', () => {
  // Given 两个名称各 30 值 = 900 组,上限 10
  const envs = []
  for (const name of ['A', 'B']) {
    for (let i = 1; i <= 30; i++) envs.push({ name, value: String(i), enabled: true })
  }
  // When 展开
  const { combinations, truncated } = expandEnvMatrix({ envs, maxExpansion: 10 })
  // Then 恰好 10 组且每组结构完整(前缀组合,而非部分展开的残缺组)
  assert.equal(truncated, true)
  assert.equal(combinations.length, 10)
  for (const row of combinations) {
    assert.ok(row.A !== undefined && row.B !== undefined)
  }
})

test('env-expand:multi 行按换行拆值,空行与首尾空白剔除', () => {
  // Given 单行 multi 存储形态(客户端 values 数组经 API 折叠为换行拼接)
  const envs = [
    { name: 'TOKEN', value: 'aaa\n\n bbb \n', multi: true, enabled: true },
    { name: 'MODE', value: 'run', enabled: true },
  ]
  // When 展开
  const { combinations, truncated } = expandEnvMatrix({ envs, maxExpansion: 20 })
  // Then 拆出两值,单值名称每组携带
  assert.equal(truncated, false)
  assert.deepEqual(combinations, [
    { TOKEN: 'aaa', MODE: 'run' },
    { TOKEN: 'bbb', MODE: 'run' },
  ])
})

test('env-expand:multi 行与同名单行合并贡献组合', () => {
  // Given multi 行两值 + 同名单行一值
  const envs = [
    { name: 'A', value: '1\n2', multi: true, enabled: true },
    { name: 'A', value: '3', enabled: true },
  ]
  // When 展开
  const { combinations } = expandEnvMatrix({ envs, maxExpansion: 20 })
  // Then 三组按序
  assert.deepEqual(combinations.map((row) => row.A), ['1', '2', '3'])
})
