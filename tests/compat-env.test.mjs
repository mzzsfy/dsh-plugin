import test from 'node:test'
import assert from 'node:assert/strict'
import { compatEnv } from '../scripts/compat/env.mjs'

/**
 * 兼容工位环境隔离:生产 DSH_HOME/各包 DATA_DIR/凭据变量与 NODE_OPTIONS 一律不得穿透。
 */
test('compatEnv:清除 DSH_/STOCK_/ECHO_/NODE_OPTIONS,保留系统变量', () => {
  const saved = {}
  const injected = {
    DSH_HOME: 'C:\\Users\\real\\.dsh',
    DSH_USAGE_PANEL_DATA_DIR: 'C:\\Users\\real\\usage',
    DSH_CRON_BOARD_DATA_DIR: 'C:\\Users\\real\\cron',
    STOCK_ASSISTANT_TOKEN: 'secret',
    ECHO_KEY: 'real-key',
    NODE_OPTIONS: '--require evil.js',
    NODE_PATH: 'C:\\evil',
    PATH: process.env.PATH,
  }
  for (const [key, value] of Object.entries(injected)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  try {
    const env = compatEnv({ DSH_HOME: 'C:\\work\\home', DSH_CRON_BOARD_DATA_DIR: 'C:\\work\\cron' })
    assert.equal(env.DSH_HOME, 'C:\\work\\home')
    assert.equal(env.DSH_CRON_BOARD_DATA_DIR, 'C:\\work\\cron')
    assert.equal(env.DSH_USAGE_PANEL_DATA_DIR, undefined)
    assert.equal(env.STOCK_ASSISTANT_TOKEN, undefined)
    assert.equal(env.ECHO_KEY, undefined)
    assert.equal(env.NODE_OPTIONS, undefined)
    assert.equal(env.NODE_PATH, undefined)
    assert.equal(env.PATH, process.env.PATH)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('compatEnv:空 extra 不引入任何敏感键', () => {
  process.env.DSH_TEST_DIR = 'C:\\real'
  try {
    const env = compatEnv()
    assert.equal(env.DSH_TEST_DIR, undefined)
  } finally {
    delete process.env.DSH_TEST_DIR
  }
})
