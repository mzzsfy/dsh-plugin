// BDD:宿主 wire 面适配 — connection.api.settings 的 {result:{ok,value|error}} 信封
// 适配为插件内部 RPC 面 {ok,value|error};保存流经适配层端到端保持冲突重放语义。

import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSettingsFace, unwrapWire, saveModels, CONFLICT_CODE, INPUT_TEXT_IMAGE } from '../src/logic.mjs'

const draft = {
  checked: { high: true },
  spellings: { high: 'ultra' },
  inputMode: INPUT_TEXT_IMAGE,
}

test('unwrapWire:ok 信封解包,value 透传', () => {
  assert.deepEqual(
    unwrapWire({ result: { ok: true, value: { writable: true } } }),
    { ok: true, value: { writable: true } },
  )
})

test('unwrapWire:error 信封透传 code 与 message', () => {
  const unwrapped = unwrapWire({ result: { ok: false, error: { code: CONFLICT_CODE, message: 'stale' } } })
  assert.equal(unwrapped.ok, false)
  assert.equal(unwrapped.error.code, CONFLICT_CODE)
  assert.equal(unwrapped.error.message, 'stale')
})

test('unwrapWire:响应非对象或 result 缺失,归一为统一失败信封', () => {
  for (const bad of [null, undefined, {}, { result: null }, { result: { ok: false } }]) {
    const unwrapped = unwrapWire(bad)
    assert.equal(unwrapped.ok, false)
    assert.equal(unwrapped.error.code, undefined)
    assert.equal(unwrapped.error.message, 'settings RPC 调用失败')
  }
})

test('适配面:transport 抛错原样上抛,不被吞成假信封', async () => {
  const boom = new Error('network down')
  const face = makeSettingsFace({
    describe: async () => { throw boom },
    mutate: async () => { throw boom },
  })
  await assert.rejects(() => face.describe(), (error) => error === boom)
  await assert.rejects(() => face.mutate('llm-pi-ai', [], 1), (error) => error === boom)
})

test('makeSettingsFace:wire 缺失或形状不完整返回 null', () => {
  for (const wire of [null, undefined, {}, { describe: () => {} }, { mutate: () => {} }]) {
    assert.equal(makeSettingsFace(wire), null)
  }
})

test('适配面 describe:以空载荷调用 wire 并解包', async () => {
  const calls = []
  const wire = {
    async describe(payload) {
      calls.push(payload)
      return { result: { ok: true, value: { writable: true, namespaces: [] } } }
    },
    async mutate() { throw new Error('不应调用') },
  }
  const face = makeSettingsFace(wire)
  const result = await face.describe()
  assert.deepEqual(calls, [{}])
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { writable: true, namespaces: [] })
})

test('适配面 mutate:ns/ops 映射为 ns/ops/expectedRevision;无 revision 不携带该键', async () => {
  const calls = []
  const wire = {
    async describe() { return { result: { ok: true, value: {} } } },
    async mutate(request) {
      calls.push(request)
      return { result: { ok: true, value: {} } }
    },
  }
  const face = makeSettingsFace(wire)
  await face.mutate('llm-pi-ai', [{ op: 'set', path: ['a'], value: 1 }], 7)
  await face.mutate('llm-pi-ai', [{ op: 'unset', path: ['b'] }], undefined)
  assert.deepEqual(calls, [
    { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['a'], value: 1 }], expectedRevision: 7 },
    { ns: 'llm-pi-ai', ops: [{ op: 'unset', path: ['b'] }] },
  ])
})

test('端到端:保存流经适配层,冲突一次重放成功', async () => {
  let describeCount = 0
  let mutateCount = 0
  const wire = {
    async describe() {
      describeCount += 1
      const revision = describeCount === 1 ? 1 : 2
      return {
        result: {
          ok: true,
          value: {
            writable: true,
            namespaces: [{ ns: 'llm-pi-ai', revision, value: { providers: { 'new-api': { models: [{ id: 'auto' }] } } } }],
          },
        },
      }
    },
    async mutate(request) {
      mutateCount += 1
      if (mutateCount === 1) {
        return { result: { ok: false, error: { code: CONFLICT_CODE, message: 'stale' } } }
      }
      assert.equal(request.expectedRevision, 2)
      return { result: { ok: true, value: {} } }
    },
  }
  const result = await saveModels(makeSettingsFace(wire), 'new-api', new Map([['auto', draft]]))
  assert.equal(mutateCount, 2)
  assert.deepEqual(result.models[0].reasoningEfforts, { high: 'ultra' })
})
