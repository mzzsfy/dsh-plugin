import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
