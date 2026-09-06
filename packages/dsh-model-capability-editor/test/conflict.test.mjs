// BDD:保存流 — 冲突重读后按字段级 diff 重放一次,再冲突报错终止,绝不静默覆盖;
// 只读降级。

import test from 'node:test'
import assert from 'node:assert/strict'
import { saveModels, CONFLICT_CODE, INPUT_TEXT_IMAGE } from '../src/logic.mjs'

const draft = {
  checked: { high: true },
  spellings: { high: 'ultra' },
  inputMode: INPUT_TEXT_IMAGE,
}

const nsValue = (models) => ({ providers: { 'new-api': { models } } })

// mock settings 面:适配层已解包,describe 返回描述值,mutate 直接返回 namespace view 或抛错。
// 冲突注入由各用例包装 mutate 实现(与记账计数对齐),此处不做隐式失败分支。
function mockSettings({ revisions, latestModels }) {
  let describeCount = 0
  const calls = { describe: 0, mutate: 0, revisions: [], values: [] }
  const describe = async () => {
    calls.describe += 1
    const revision = revisions[Math.min(describeCount, revisions.length - 1)]
    describeCount += 1
    return { writable: true, namespaces: [{ ns: 'llm-pi-ai', revision, value: nsValue(latestModels) }] }
  }
  const mutate = async (_ns, ops, expectedRevision) => {
    calls.mutate += 1
    calls.revisions.push(expectedRevision)
    calls.values.push(ops[0].value)
    return { ns: 'llm-pi-ai', revision: expectedRevision + 1 }
  }
  return {
    calls,
    describe,
    mutate,
  }
}

test('无冲突:一次 describe + 一次 mutate,整组写回', async () => {
  const settings = mockSettings({ revisions: [7], latestModels: [{ id: 'auto' }] })
  const result = await saveModels(settings, 'new-api', new Map([['auto', draft]]))
  assert.equal(settings.calls.describe, 1)
  assert.equal(settings.calls.mutate, 1)
  assert.equal(settings.calls.revisions[0], 7)
  assert.deepEqual(result.models[0].reasoningEfforts, { high: 'ultra' })
})

test('冲突一次:重读新 revision,重放仅含本次修改的字段', async () => {
  // 他人并发改动:auto 补了 maxTokens,plain 改动保留最新值
  const latestModels = [
    { id: 'auto', maxTokens: 4096 },
    { id: 'plain', name: 'renamed-by-other' },
  ]
  const settings = mockSettings({ revisions: [1, 2], latestModels })
  // 冲突注入:首次 mutate 抛 conflict,重放成功;注入层自行计数,与旧 mock 的 baseMutate 计数对齐
  let conflictThrown = false
  const realMutate = settings.mutate
  settings.mutate = async (...args) => {
    if (!conflictThrown) {
      conflictThrown = true
      settings.calls.mutate += 1
      settings.calls.revisions.push(args[2])
      settings.calls.values.push(args[1][0].value)
      const error = new Error('stale')
      error.code = CONFLICT_CODE
      throw error
    }
    return realMutate(...args)
  }
  const result = await saveModels(settings, 'new-api', new Map([['auto', draft]]))
  assert.equal(settings.calls.describe, 2)
  assert.equal(settings.calls.mutate, 2)
  assert.deepEqual(settings.calls.revisions, [1, 2])
  const written = settings.calls.values[1]
  assert.deepEqual(written[0], { id: 'auto', maxTokens: 4096, reasoningEfforts: { high: 'ultra' }, input: ['text', 'image'] })
  assert.deepEqual(written[1], { id: 'plain', name: 'renamed-by-other' })
  assert.deepEqual(result.models[0].reasoningEfforts, { high: 'ultra' })
})

test('孤儿草稿:目标模型在保存前被他方删除,mutate 成功但 droppedDraftIds 报告未落盘', async () => {
  // 保存流内部 describe 时 auto 已消失,只剩 plain
  const settings = mockSettings({ revisions: [7], latestModels: [{ id: 'plain' }] })
  const result = await saveModels(settings, 'new-api', new Map([['auto', draft]]))
  assert.equal(settings.calls.mutate, 1)
  assert.deepEqual(result.droppedDraftIds, ['auto'])
  assert.deepEqual(result.models.map((model) => model.id), ['plain'])
})

test('重放后再冲突:报错终止且携带冲突码,不改写文档', async () => {
  const settings = mockSettings({ revisions: [1], latestModels: [{ id: 'auto' }] })
  // mutate 恒冲突
  settings.mutate = async () => {
    settings.calls.mutate += 1
    const error = new Error('stale')
    error.code = CONFLICT_CODE
    throw error
  }
  await assert.rejects(
    () => saveModels(settings, 'new-api', new Map([['auto', draft]])),
    (error) => error.code === CONFLICT_CODE && /冲突/.test(error.message),
    '终态冲突错误必须携带 settings-conflict 码(与 readonly 错误契约对称)',
  )
  assert.equal(settings.calls.mutate, 2)
})

test('冲突重读后发现已转只读:抛只读语义错误而非原始冲突错误', async () => {
  const settings = mockSettings({ revisions: [1, 2], latestModels: [{ id: 'auto' }] })
  let conflictThrown = false
  const realDescribe = settings.describe
  settings.describe = async () => {
    const value = await realDescribe()
    // 首轮可写,冲突重读轮转只读
    if (conflictThrown) return { ...value, writable: false }
    return value
  }
  const realMutate = settings.mutate
  settings.mutate = async () => {
    if (!conflictThrown) {
      conflictThrown = true
      settings.calls.mutate += 1
      const error = new Error('stale')
      error.code = CONFLICT_CODE
      throw error
    }
    return realMutate()
  }
  await assert.rejects(
    () => saveModels(settings, 'new-api', new Map([['auto', draft]])),
    (error) => error.code === 'settings-readonly' && /只读/.test(error.message),
  )
  assert.equal(settings.calls.mutate, 1, '只读后不得重放写回')
})

test('基线 providers 缺失或 models 异型:拒绝保存,不发起 mutate', async () => {
  // providers 整体缺失(modelsOf 会静默归 [],一次保存即覆写空数组)
  const noProviders = mockSettings({ revisions: [1], latestModels: [] })
  noProviders.describe = async () => ({
    writable: true,
    namespaces: [{ ns: 'llm-pi-ai', revision: 1, value: {} }],
  })
  await assert.rejects(() => saveModels(noProviders, 'new-api', new Map()), /providers/)
  assert.equal(noProviders.calls.mutate, 0)
  // models 非数组(他方写坏/损坏)
  const badModels = mockSettings({ revisions: [1], latestModels: [] })
  badModels.describe = async () => ({
    writable: true,
    namespaces: [{ ns: 'llm-pi-ai', revision: 1, value: { providers: { 'new-api': { models: 'broken' } } } }],
  })
  await assert.rejects(() => saveModels(badModels, 'new-api', new Map()), /models 不是数组/)
  assert.equal(badModels.calls.mutate, 0)
})

test('describe 命名空间缺 revision:拒绝盲写(宿主对 undefined revision 跳过冲突检查)', async () => {
  const settings = mockSettings({ revisions: [1], latestModels: [{ id: 'auto' }] })
  settings.describe = async () => ({
    writable: true,
    namespaces: [{ ns: 'llm-pi-ai', value: nsValue([{ id: 'auto' }]) }],
  })
  await assert.rejects(() => saveModels(settings, 'new-api', new Map([['auto', draft]])), /revision/)
  assert.equal(settings.calls.mutate, 0)
})

test('writable=false:只读报错,不发起 mutate', async () => {
  const settings = mockSettings({ revisions: [1], latestModels: [] })
  settings.describe = async () => ({
    writable: false,
    namespaces: [{ ns: 'llm-pi-ai', revision: 1, value: nsValue([]) }],
  })
  await assert.rejects(() => saveModels(settings, 'new-api', new Map()), /只读/)
  assert.equal(settings.calls.mutate, 0)
})

test('非冲突错误直接上抛,不重试', async () => {
  const settings = mockSettings({ revisions: [1], latestModels: [] })
  settings.mutate = async () => {
    settings.calls.mutate += 1
    const error = new Error('bad op')
    error.code = 'settings-rejected'
    throw error
  }
  await assert.rejects(
    () => saveModels(settings, 'new-api', new Map([['auto', draft]])),
    (error) => error.code === 'settings-rejected',
  )
  assert.equal(settings.calls.mutate, 1)
})
