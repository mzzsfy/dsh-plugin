// 环境变量同名多值展开测试(青龙多账号语义,设计 §4.2)。

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
