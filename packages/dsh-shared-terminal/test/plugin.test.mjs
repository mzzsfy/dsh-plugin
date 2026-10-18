import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply, registerTerminalTool, SUPPORTED_VERSIONS } from '../src/index.js'
import { defineTool } from './host.mjs'

function context(controller = { owners: new Map(), terminal() {}, shells() {}, list() {}, create() {}, write() {}, close() {} }) {
  const registrations = []
  const warnings = []
  let dispose
  const ctx = {
    get(key) { return key === 'terminalController' ? controller : key === 'tools' ? { register(tool) { registrations.push(tool); return () => registrations.pop() } } : undefined },
    logger: { warn(text) { warnings.push(text) } },
    effect(factory) { dispose = factory() },
  }
  return { ctx, registrations, warnings, dispose: () => dispose?.() }
}

test('Given each tested Controller runtime, When installing, Then one terminal tool registers and disposes', () => {
  for (const version of ['0.2.0-rc.2', '0.2.1-alpha.2']) {
    const fixture = context()
    registerTerminalTool(fixture.ctx, { version, defineTool })
    assert.equal(fixture.registrations.length, 1)
    assert.equal(fixture.registrations[0].name, 'terminal')
    fixture.dispose()
    assert.equal(fixture.registrations.length, 0)
  }
})

test('Given an untested Controller version, When installing, Then there is no registration even with identical private fields', () => {
  const fixture = context()
  registerTerminalTool(fixture.ctx, { version: '0.2.1-alpha.1', defineTool })
  assert.equal(fixture.registrations.length, 0)
  assert.equal(fixture.warnings.length, 1)
})

test('Given missing public or private methods, When installing, Then host disables without throwing', () => {
  for (const controller of [{}, { owners: new Map(), terminal() {} }]) {
    const fixture = context(controller)
    registerTerminalTool(fixture.ctx, { version: '0.2.0-rc.2', defineTool })
    assert.equal(fixture.registrations.length, 0)
    assert.equal(fixture.warnings.length, 1)
  }
})

test('Given the package manifest, When the support table evolves, Then peer range covers the support table and release metadata stay in lockstep', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const supported = [...SUPPORTED_VERSIONS].sort()
  // peer 是装载面(允许干净禁用的宿主代际),SUPPORTED 是功能面(实测私有结构):
  // 功能面必须被装载面覆盖,dshReleases 的 compatible 集合与功能面精确对账
  const peerRange = manifest.peerDependencies['@deepseek-ai/dsh-api-terminal-controller']
  for (const version of supported) assert.ok(peerRange.split(' || ').includes(version), `peer 缺功能面版本 ${version}`)
  assert.deepEqual(
    Object.entries(manifest.dsh.compatibility.dshReleases)
      .filter(([, status]) => status === 'compatible').map(([version]) => version).sort(),
    supported,
  )
})

test('Given the actual installed dependencies, When applying, Then runtime metadata resolution and one-tool registration succeed', async () => {
  const fixture = context()
  await apply(fixture.ctx)
  assert.equal(fixture.registrations.length, 1)
  fixture.dispose()
})
