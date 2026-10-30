import test from 'node:test'
import assert from 'node:assert/strict'
import { createExecutor } from '../src/executor.mjs'
import { createRegistry } from '../src/provider-registry.mjs'
const instance = { id: 'a', adapterId: 'fake', credentialEnv: 'TEST_TOKEN', quotaGroup: 'one' }
test('取消同额度组在途请求可终止等待，适配器只得到Host凭据', async () => {
  let calls = 0
  const fake = { descriptor: { adapterId: 'fake', capabilities: ['quotes'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 }, probe() {}, async quotes(req, ctx) { calls++; assert.equal(ctx.credential(), 'fake'); return { items: [1] } } }
  const executor = createExecutor({ registry: createRegistry([fake]), budget: { reserve() {} }, env: { TEST_TOKEN: 'fake' } })
  const result = await executor.run(instance, 'quotes', {}, { signal: new AbortController().signal })
  assert.deepEqual(result.items, [1]); assert.equal(calls, 1)
  executor.dispose()
})
