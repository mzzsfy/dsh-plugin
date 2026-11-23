import test from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()
const t = key => key
const cell = (over = {}) => ({ tokens: 893050462, requests: 6885, cacheHit: 66, cacheMiss: 34, cost: 90.75, ...over })

test('热力图悬浮 token 读数按带单位缩写', () => {
  const rows = core.heatTipRows(cell(), t, true, '¥')
  assert.equal(rows[0].key, 'tokens')
  assert.equal(rows[0].value, '893.05M')
})

test('热力图悬浮 token 读数跨单位档位与千以内', () => {
  const value = tokens => core.heatTipRows(cell({ tokens }), t, false, '¥')[0].value
  assert.equal(value(1200), '1.20K')
  assert.equal(value(134100000000), '134.10B')
  assert.equal(value(999), '999')
})

test('热力图悬浮请求数走千分位', () => {
  const rows = core.heatTipRows(cell(), t, false, '¥')
  assert.equal(rows[1].value, '6,885')
})

test('热力图悬浮缓存命中率与费用行跟随开关', () => {
  const rows = core.heatTipRows(cell(), t, true, '¥')
  assert.equal(rows[2].value, '66.0%')
  assert.equal(rows[3].key, 'cost')
  assert.equal(rows[3].value, '≈ ¥90.75')
  assert.equal(core.heatTipRows(cell(), t, false, '¥').length, 3)
  assert.equal(core.heatTipRows(cell({ cost: 0 }), t, true, '¥').length, 3)
})
