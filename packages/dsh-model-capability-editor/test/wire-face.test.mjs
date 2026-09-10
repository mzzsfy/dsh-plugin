// BDD:settings 传输适配 — 两种宿主形态统一为插件内部 RPC 面:
// - dsh 0.1.2+ typed remote 面(remote.settings):方法直返 RemoteResult 信封 {ok,value|error}
// - dsh 0.1.1+ connection.api 面:settings.describe() 无参,settings.mutate({ns,ops,...})
//   单对象参数,返回 {rpcId,result:{ok,value|error}} 信封
// 保存流经适配层端到端保持冲突重放语义。

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

test('connection.api 面(0.1.1):describe 走 {rpcId,result} 信封', async () => {
  let calls = 0
  const face = makeSettingsFace({ api: { settings: {
    describe: async (payload) => {
      calls += 1
      assert.deepEqual(payload, {})
      return { rpcId: 'r1', result: { ok: true, value: { writable: true, namespaces: [] } } }
    },
    mutate: async () => { throw new Error('不应调用') },
  } } })
  const value = await face.describe()
  assert.equal(calls, 1)
  assert.deepEqual(value, { writable: true, namespaces: [] })
})

test('connection.api 面(0.1.1):mutate 单对象参数,result.ok 解包', async () => {
  const calls = []
  const face = makeSettingsFace({ api: { settings: {
    describe: async () => ({ rpcId: 'r', result: { ok: true, value: {} } }),
    mutate: async (payload) => {
      calls.push(payload)
      return { rpcId: 'r', result: { ok: true, value: { ns: payload.ns, revision: 8 } } }
    },
  } } })
  const written = await face.mutate('llm-pi-ai', [{ op: 'set', path: ['a'], value: 1 }], 7)
  await face.mutate('llm-pi-ai', [{ op: 'unset', path: ['b'] }], undefined)
  assert.deepEqual(calls, [
    { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['a'], value: 1 }], expectedRevision: 7 },
    { ns: 'llm-pi-ai', ops: [{ op: 'unset', path: ['b'] }] },
  ])
  assert.deepEqual(written, { ns: 'llm-pi-ai', revision: 8 })
})

test('connection.api 面:result.ok false 以 code 透传冲突', async () => {
  const face = makeSettingsFace({ api: { settings: {
    describe: async () => ({ rpcId: 'r', result: { ok: true, value: {} } }),
    mutate: async () => ({ rpcId: 'r', result: { ok: false, error: { code: CONFLICT_CODE, message: 'stale' } } }),
  } } })
  await assert.rejects(
    () => face.mutate('llm-pi-ai', [], 1),
    (error) => error.code === CONFLICT_CODE,
  )
})

test('面选择:describe+mutate 双全即 typed 面,api 形状不再探测', async () => {
  let apiCalls = 0
  const face = makeSettingsFace({
    describe: async () => ({ ok: true, value: {} }),
    mutate: async () => ({ ok: true, value: {} }),
    api: { settings: { describe: async () => { apiCalls += 1; return {} }, mutate: async () => ({}) } },
  })
  await face.describe()
  assert.equal(apiCalls, 0, 'typed 面命中后不得触达 connection.api')
})

test('connection.api 端到端:保存流走 HTTP 信封,冲突一次重放成功', async () => {
  let describeCount = 0
  let mutateCount = 0
  const face = makeSettingsFace({ api: { settings: {
    describe: async () => {
      describeCount += 1
      const revision = describeCount === 1 ? 1 : 2
      return {
        rpcId: 'r',
        result: {
          ok: true,
          value: {
            writable: true,
            namespaces: [{ ns: 'llm-pi-ai', revision, value: { providers: { 'new-api': { models: [{ id: 'auto' }] } } } }],
          },
        },
      }
    },
    mutate: async (payload) => {
      mutateCount += 1
      if (mutateCount === 1) return { rpcId: 'r', result: { ok: false, error: { code: CONFLICT_CODE, message: 'stale' } } }
      assert.equal(payload.expectedRevision, 2)
      return { rpcId: 'r', result: { ok: true, value: { ns: payload.ns, revision: 3 } } }
    },
  } } })
  const result = await saveModels(face, 'new-api', new Map([['auto', draft]]))
  assert.equal(mutateCount, 2)
  assert.deepEqual(result.models[0].reasoningEfforts, { high: 'ultra' })
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

test('适配面畸形信封兜底:默认文案 + code undefined,绝不静默成功', async () => {
  const malformed = [null, undefined, 'str', 42, {}, { ok: false }]
  for (const envelope of malformed) {
    const face = makeSettingsFace({
      async describe() { return envelope },
      async mutate() { return envelope },
    })
    await assert.rejects(
      () => face.describe(),
      (error) => error.message === 'settings RPC 调用失败' && error.code === undefined,
      '信封 ' + JSON.stringify(envelope) + ' 必须 reject 且走兜底文案',
    )
  }
})

test('适配面 ok:false 带 code 无 message:code 透传且 message 兜底', async () => {
  const face = makeSettingsFace({
    async describe() { return { ok: false, error: { code: 'x' } } },
    async mutate() { return { ok: false, error: { code: 'x' } } },
  })
  await assert.rejects(
    () => face.describe(),
    (error) => error.code === 'x' && error.message === 'settings RPC 调用失败',
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
