// BDD:dsh 0.1.2 remote.settings 服务面适配 — 官方 RemoteResult 信封 {ok,value|error}
// 适配为插件内部 RPC 面;保存流经适配层端到端保持冲突重放语义。

import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSettingsFace, saveModels, CONFLICT_CODE, INPUT_TEXT_IMAGE } from '../src/logic.mjs'

const draft = {
  checked: { high: true },
  spellings: { high: 'ultra' },
  inputMode: INPUT_TEXT_IMAGE,
}

test('适配面:transport 抛错原样上抛,不被吞成假信封', async () => {
  const boom = new Error('network down')
  const face = makeSettingsFace({
    describe: async () => { throw boom },
    mutate: async () => { throw boom },
  })
  await assert.rejects(() => face.describe(), (error) => error === boom)
  await assert.rejects(() => face.mutate('llm-pi-ai', [], 1), (error) => error === boom)
})

test('makeSettingsFace:remote 缺失或形状不完整返回 null', () => {
  for (const remote of [null, undefined, {}, { describe: () => {} }, { mutate: () => {} }]) {
    assert.equal(makeSettingsFace(remote), null)
  }
})

test('适配面 describe:RemoteResult 信封解包为 value', async () => {
  const remote = {
    async describe() {
      return { ok: true, value: { writable: true, namespaces: [] } }
    },
    async mutate() { throw new Error('不应调用') },
  }
  const face = makeSettingsFace(remote)
  const value = await face.describe()
  assert.deepEqual(value, { writable: true, namespaces: [] })
})

test('适配面 mutate:ns/ops/expectedRevision 位置参数直传;无 revision 传 undefined', async () => {
  const calls = []
  const remote = {
    async describe() { return { ok: true, value: {} } },
    async mutate(ns, ops, expectedRevision) {
      calls.push({ ns, ops, expectedRevision })
      return { ok: true, value: { ns, revision: 8 } }
    },
  }
  const face = makeSettingsFace(remote)
  const written = await face.mutate('llm-pi-ai', [{ op: 'set', path: ['a'], value: 1 }], 7)
  await face.mutate('llm-pi-ai', [{ op: 'unset', path: ['b'] }], undefined)
  assert.deepEqual(calls, [
    { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['a'], value: 1 }], expectedRevision: 7 },
    { ns: 'llm-pi-ai', ops: [{ op: 'unset', path: ['b'] }], expectedRevision: undefined },
  ])
  assert.deepEqual(written, { ns: 'llm-pi-ai', revision: 8 })
})

test('适配面 mutate:settings-conflict 拒绝以 code 透传', async () => {
  const remote = {
    async describe() { return { ok: true, value: {} } },
    async mutate() {
      return { ok: false, error: { code: CONFLICT_CODE, message: 'stale' } }
    },
  }
  const face = makeSettingsFace(remote)
  await assert.rejects(
    () => face.mutate('llm-pi-ai', [], 1),
    (error) => error.code === CONFLICT_CODE,
  )
})

test('端到端:保存流经适配层,冲突一次重放成功', async () => {
  let describeCount = 0
  let mutateCount = 0
  const remote = {
    async describe() {
      describeCount += 1
      const revision = describeCount === 1 ? 1 : 2
      return {
        ok: true,
        value: {
          writable: true,
          namespaces: [{ ns: 'llm-pi-ai', revision, value: { providers: { 'new-api': { models: [{ id: 'auto' }] } } } }],
        },
      }
    },
    async mutate(ns, ops, expectedRevision) {
      mutateCount += 1
      if (mutateCount === 1) {
        return { ok: false, error: { code: CONFLICT_CODE, message: 'stale' } }
      }
      assert.equal(expectedRevision, 2)
      return { ok: true, value: { ns, revision: 3 } }
    },
  }
  const result = await saveModels(makeSettingsFace(remote), 'new-api', new Map([['auto', draft]]))
  assert.equal(mutateCount, 2)
  assert.deepEqual(result.models[0].reasoningEfforts, { high: 'ultra' })
})
