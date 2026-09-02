// BDD:保存流 — 冲突重读后按字段级 diff 重放一次,再冲突报错终止,绝不静默覆盖;
// 只读降级。

import test from 'node:test'
import assert from 'node:assert/strict'
import { saveModels, CONFLICT_CODE, INPUT_TEXT_IMAGE } from '../src/logic.mjs'

const draft = {
  checked: { high: true },
  spellings: { high: 'ultra' },
  baselineEfforts: undefined,
  inputMode: INPUT_TEXT_IMAGE,
}

const nsValue = (models) => ({ providers: { 'new-api': { models } } })

// mock settings RPC:describe 返回 {ok, value},mutate 可注入失败序列。
function mockSettings({ revisions, failFirst, latestModels }) {
  let describeCount = 0
  let mutateCount = 0
  const calls = { describe: 0, mutate: 0, revisions: [], values: [] }
  return {
    calls,
    async describe() {
      calls.describe += 1
      const revision = revisions[Math.min(describeCount, revisions.length - 1)]
      describeCount += 1
      return {
        ok: true,
        value: { writable: true, namespaces: [{ ns: 'llm-pi-ai', revision, value: nsValue(latestModels) }] },
      }
    },
    async mutate(_ns, ops, expectedRevision) {
      calls.mutate += 1
      calls.revisions.push(expectedRevision)
      calls.values.push(ops[0].value)
      if (mutateCount === 0 && failFirst) {
        mutateCount += 1
        return { ok: false, error: { code: CONFLICT_CODE, message: 'stale' } }
      }
      return { ok: true, value: {} }
    },
  }
}

test('无冲突:一次 describe + 一次 mutate,整组写回', async () => {
  const settings = mockSettings({ revisions: [7], failFirst: false, latestModels: [{ id: 'auto' }] })
  const result = await saveModels(settings, 'new-api', new Map([['auto', draft]]))
  assert.equal(settings.calls.describe, 1)
  assert.equal(settings.calls.mutate, 1)
  assert.equal(settings.calls.revisions[0], 7)
  assert.deepEqual(result[0].reasoningEfforts, { high: 'ultra' })
})

test('冲突一次:重读新 revision,重放仅含本次修改的字段', async () => {
  // 他人并发改动:auto 补了 maxTokens,plain 改动保留最新值
  const latestModels = [
    { id: 'auto', maxTokens: 4096 },
    { id: 'plain', name: 'renamed-by-other' },
  ]
  const settings = mockSettings({ revisions: [1, 2], failFirst: true, latestModels })
  const result = await saveModels(settings, 'new-api', new Map([['auto', draft]]))
  assert.equal(settings.calls.describe, 2)
  assert.equal(settings.calls.mutate, 2)
  assert.deepEqual(settings.calls.revisions, [1, 2])
  const written = settings.calls.values[1]
  assert.deepEqual(written[0], { id: 'auto', maxTokens: 4096, reasoningEfforts: { high: 'ultra' }, input: ['text', 'image'] })
  assert.deepEqual(written[1], { id: 'plain', name: 'renamed-by-other' })
  assert.deepEqual(result[0].reasoningEfforts, { high: 'ultra' })
})

test('重放后再冲突:报错终止,不改写文档', async () => {
  const settings = mockSettings({ revisions: [1], failFirst: true, latestModels: [{ id: 'auto' }] })
  // mutate 恒冲突
  settings.mutate = async () => {
    settings.calls.mutate += 1
    return { ok: false, error: { code: CONFLICT_CODE, message: 'stale' } }
  }
  await assert.rejects(
    () => saveModels(settings, 'new-api', new Map([['auto', draft]])),
    /冲突/,
  )
  assert.equal(settings.calls.mutate, 2)
})

test('writable=false:只读报错,不发起 mutate', async () => {
  const settings = mockSettings({ revisions: [1], failFirst: false, latestModels: [] })
  settings.describe = async () => ({
    ok: true,
    value: { writable: false, namespaces: [{ ns: 'llm-pi-ai', revision: 1, value: nsValue([]) }] },
  })
  await assert.rejects(() => saveModels(settings, 'new-api', new Map()), /只读/)
  assert.equal(settings.calls.mutate, 0)
})

test('非冲突错误直接上抛,不重试', async () => {
  const settings = mockSettings({ revisions: [1], failFirst: false, latestModels: [] })
  settings.mutate = async () => {
    settings.calls.mutate += 1
    return { ok: false, error: { code: 'settings-rejected', message: 'bad op' } }
  }
  await assert.rejects(
    () => saveModels(settings, 'new-api', new Map([['auto', draft]])),
    (error) => error.code === 'settings-rejected',
  )
  assert.equal(settings.calls.mutate, 1)
})
