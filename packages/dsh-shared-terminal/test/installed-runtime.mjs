import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [host, profile, home] = process.argv.slice(2).map((path) => resolve(path))
if (!host || !profile || !home) throw new Error('Required: host directory, isolated profile directory, isolated DSH_HOME')
const hostRoot = join(host, 'node_modules/@deepseek-ai')
const boot = await import(pathToFileURL(join(hostRoot, 'dsh-app-boot/lib/index.js')).href)
const { Context } = await import(pathToFileURL(join(hostRoot, 'cordis/lib/index.js')).href)
const resolution = await boot.createRuntimeResolution({
  installAnchor: join(hostRoot, 'dsh/package.json'), home,
  profile: { dir: profile, skippedBundles: [], layers: [] },
})
const root = new Context()
let registered = 0
try {
  await root.plugin(boot.PluginPackages, { resolution })
  root.provide('terminalController', { owners: new Map(), terminal() {}, shells() {}, list() {}, create() {}, write() {}, close() {} })
  root.provide('tools', { register(tool) {
    assert.equal(tool.name, 'terminal')
    registered++
    return () => { registered-- }
  } })
  const entry = join(profile, 'node_modules/@mzzsfy/dsh-shared-terminal/src/index.js')
  const fiber = root.plugin(await import(pathToFileURL(entry).href))
  await fiber
  assert.equal(registered, 1)
  await fiber.dispose()
  assert.equal(registered, 0)
  console.log('Installed runtime: one terminal registered, then disposed; official resolver active')
} finally {
  await root.fiber.dispose()
}
