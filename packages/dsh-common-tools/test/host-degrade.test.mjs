import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'

/**
 * host 半区降级契约:ws 不可解析时 setupCommonTools 必须返回 noop 门面而非抛错。
 * 消费方在 apply 里硬 import 本模块,降级失败会直接拖垮整棵插件树的激活。
 */
const hostSource = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')

test('Given ws 半装(有清单无入口) When 加载 host Then 降级为 noop 且各门面可调用', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'common-tools-degrade-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  writeFileSync(join(dir, 'host.js'), hostSource)
  mkdirSync(join(dir, 'node_modules', 'ws'), {recursive: true})
  writeFileSync(join(dir, 'node_modules', 'ws', 'package.json'), JSON.stringify({name: 'ws', version: '0.0.0'}))
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const mod = await import(pathToFileURL(join(dir, 'host.js')).href)
    const facade = mod.setupCommonTools({fiber: {entry: {options: {name: '@mzzsfy/test-plugin'}}}})
    assert.equal(typeof facade.publish, 'function')
    assert.equal(typeof facade.subscribe, 'function')
    assert.equal(typeof facade.onPresence, 'function')
    assert.ok(warnings.some((line) => line.includes('总线不可用')), '应打印降级告警')
    facade.publish({probe: true})
    facade.onPresence(() => {})()
    facade.subscribe(() => {})()
  } finally {
    console.warn = original
  }
})
