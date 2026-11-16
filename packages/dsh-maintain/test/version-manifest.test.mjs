// version-manifest:目标版本清单拉取,用于 Node engines 与磁盘体积预检。
// Given registry 返回单版本清单 When 拉取 Then 只提取 engines 与体积字段。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchVersionManifest } from '../src/core.mjs'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader: () => {
        const chunks = [new TextEncoder().encode(JSON.stringify(body))]
        return {
          read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true, value: undefined }),
          cancel: async () => {},
        }
      },
    },
  }
}

test('fetchVersionManifest:提取 engines 与 dist.unpackedSize', async () => {
  const calls = []
  const result = await fetchVersionManifest({
    version: '0.2.2-rc.3',
    registryBase: 'https://registry.example',
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return jsonResponse({
        name: '@deepseek-ai/dsh',
        version: '0.2.2-rc.3',
        engines: { node: '>=24.9.0' },
        dist: { unpackedSize: 123456 },
      })
    },
  })
  assert.equal(result.version, '0.2.2-rc.3')
  assert.equal(result.engines.node, '>=24.9.0')
  assert.equal(result.unpackedSize, 123456)
  assert.match(calls[0].url, /registry\.example\/%40deepseek-ai%2Fdsh\/0\.2\.2-rc\.3/)
})

test('fetchVersionManifest:非 200 抛错', async () => {
  await assert.rejects(
    fetchVersionManifest({
      version: '9.9.9',
      registryBase: 'https://registry.example',
      timeoutMs: 1000,
      fetchImpl: async () => jsonResponse({}, 404),
    }),
    /HTTP 404/,
  )
})
