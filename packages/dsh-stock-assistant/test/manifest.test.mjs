import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
const read = path => readFile(new URL(path, import.meta.url), 'utf8')
test('装配守卫：生产client无打包依赖/React副本，公共依赖external，独立数据域不写settings', async () => {
  const manifest = JSON.parse(await read('../package.json'))
  const client = await read('../src/client.js'), host = await read('../src/index.js')
  assert.match(client, /id: '@mzzsfy\/dsh-stock-assistant'/)
  assert.ok(manifest.dsh.client.external.includes('@mzzsfy/dsh-common-tools/client'))
  assert.equal(manifest.dependencies.react, undefined)
  assert.equal(manifest.dependencies.esbuild, undefined)
  assert.equal((client.match(/createElement\('style', \{/g) || []).length, (client.match(/createElement\('style', \{ 'data-plugin': '@mzzsfy\/dsh-stock-assistant'/g) || []).length)
  assert.doesNotMatch(host, /export const Config|configEditor|settings\.register|settings\.update/)
  assert.doesNotMatch(client, /sidebarRight|sessionId|new WebSocket|localStorage/)
  assert.match(client, /\.ssb-switch input\[type="checkbox"\]:checked/)
  assert.match(client, /\.ssb-switch input\[type="checkbox"\]:focus-visible/)
  assert.match(client, /\.ssb-switch input\[type="checkbox"\]:disabled/)
})

test('vendor lightweight-charts 落地防漂移', async () => {
  const manifest = JSON.parse(await read('../package.json'))
  assert.equal(manifest.dependencies['lightweight-charts'], '^5.2.1')
  const vendorPath = new URL('../vendor/lightweight-charts.standalone.production.js', import.meta.url)
  const bytes = (await stat(vendorPath)).size
  assert.ok(bytes > 150 * 1024 && bytes < 300 * 1024, '体积 150-300KB 区间防误替换')
  // standalone UMD 必须暴露全局 LWC 工厂(设计: window.LightweightCharts 或 createChart 挂全局)
  const head = await read('../vendor/lightweight-charts.standalone.production.js')
  assert.ok(head.includes('createChart'), 'UMD 必须含 createChart 工厂')
})
