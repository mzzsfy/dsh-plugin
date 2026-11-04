import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../src/application.mjs'
import { memoryStorage } from './helpers.mjs'

test('vendorAvailable=false 透传快照', async () => {
  const app = await createApplication({ storageDomain: memoryStorage(), vendorAvailable: false, publish: () => {} })
  assert.equal(app.snapshot().vendorAvailable, false)
})

test('vendorAvailable 缺省 true', async () => {
  const app = await createApplication({ storageDomain: memoryStorage(), publish: () => {} })
  assert.equal(app.snapshot().vendorAvailable, true)
})
