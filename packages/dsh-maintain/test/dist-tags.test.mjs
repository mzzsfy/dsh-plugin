import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchDistTags, resolveHostVersion, hostPackageCandidates, TARGET_PACKAGE } from '../src/core.mjs'

const REGISTRY = 'https://registry.npmmirror.com'

function fakeFetch(body, { ok = true, status = 200 } = {}) {
  return async (url, options) => ({
    ok,
    status,
    json: async () => (typeof body === 'function' ? body(url) : body),
  })
}

test('场景:dist-tags 拉取走轻量端点', async () => {
  let requestedUrl = null
  const tags = await fetchDistTags({
    registryBase: REGISTRY,
    fetchImpl: async (url) => {
      requestedUrl = url
      return { ok: true, status: 200, json: async () => ({ latest: '0.1.1-rc.2' }) }
    },
    timeoutMs: 1000,
  })
  assert.deepEqual(tags, { latest: '0.1.1-rc.2' })
  assert.equal(requestedUrl, REGISTRY + '/-/package/' + encodeURIComponent(TARGET_PACKAGE) + '/dist-tags')
})

test('场景:registry 基地址尾部斜杠容忍', async () => {
  const tags = await fetchDistTags({
    registryBase: REGISTRY + '/',
    fetchImpl: fakeFetch({ latest: '1.0.0' }),
    timeoutMs: 1000,
  })
  assert.deepEqual(tags, { latest: '1.0.0' })
})

test('场景:registry 地址非法拒绝', async () => {
  await assert.rejects(
    () => fetchDistTags({ registryBase: 'ftp://x', fetchImpl: fakeFetch({}), timeoutMs: 1000 }),
    /registry/,
  )
})

test('场景:registry 不可达时抛错由调用方保留上次结果', async () => {
  await assert.rejects(
    () => fetchDistTags({ registryBase: REGISTRY, fetchImpl: async () => { throw new Error('ECONNREFUSED') }, timeoutMs: 1000 }),
    /ECONNREFUSED/,
  )
})

test('场景:HTTP 非 2xx 抛错', async () => {
  await assert.rejects(
    () => fetchDistTags({ registryBase: REGISTRY, fetchImpl: fakeFetch({}, { ok: false, status: 502 }), timeoutMs: 1000 }),
    /502/,
  )
})

test('场景:响应不是对象抛错', async () => {
  await assert.rejects(
    () => fetchDistTags({ registryBase: REGISTRY, fetchImpl: fakeFetch('not-json'), timeoutMs: 1000 }),
    /dist-tags/,
  )
  await assert.rejects(
    () => fetchDistTags({ registryBase: REGISTRY, fetchImpl: fakeFetch([]), timeoutMs: 1000 }),
    /dist-tags/,
  )
})

test('场景:非字符串值被过滤,空表抛错', async () => {
  await assert.rejects(
    () => fetchDistTags({ registryBase: REGISTRY, fetchImpl: fakeFetch({ latest: 3 }), timeoutMs: 1000 }),
    /dist-tags/,
  )
})

test('场景:宿主版本定位 win32 全局布局', async () => {
  const files = {
    'C:\\nvm\\v24.14.1\\node_modules\\@deepseek-ai\\dsh\\package.json': JSON.stringify({ version: '0.1.1-rc.2' }),
  }
  const version = await resolveHostVersion({
    execPath: 'C:\\nvm\\v24.14.1\\node.exe',
    platform: 'win32',
    readFileImpl: async (path) => {
      if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error('ENOENT')
      return files[path]
    },
    resolveImpl: () => { throw new Error('MODULE_NOT_FOUND') },
  })
  assert.equal(version, '0.1.1-rc.2')
})

test('场景:宿主版本定位 posix 全局布局', async () => {
  const files = {
    '/home/u/.nvm/versions/node/v24/lib/node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ version: '1.2.3' }),
  }
  const version = await resolveHostVersion({
    execPath: '/home/u/.nvm/versions/node/v24/bin/node',
    platform: 'linux',
    readFileImpl: async (path) => {
      if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error('ENOENT')
      return files[path]
    },
    resolveImpl: () => { throw new Error('MODULE_NOT_FOUND') },
  })
  assert.equal(version, '1.2.3')
})

test('场景:候选布局失败时走 require 解析兜底', async () => {
  const version = await resolveHostVersion({
    execPath: '/usr/bin/node',
    platform: 'linux',
    readFileImpl: async (path) => {
      if (path === '/opt/dsh/package.json') return JSON.stringify({ version: '2.0.0' })
      throw new Error('ENOENT')
    },
    resolveImpl: () => '/opt/dsh/package.json',
  })
  assert.equal(version, '2.0.0')
})

test('场景:全部途径失败返回 null 不抛错', async () => {
  const version = await resolveHostVersion({
    execPath: '/usr/bin/node',
    platform: 'linux',
    readFileImpl: async () => { throw new Error('ENOENT') },
    resolveImpl: () => { throw new Error('MODULE_NOT_FOUND') },
  })
  assert.equal(version, null)
})

test('候选路径推导:win32 与 posix 布局', () => {
  assert.deepEqual(
    hostPackageCandidates({ execPath: 'C:\\nvm\\v24\\node.exe', platform: 'win32' }),
    ['C:\\nvm\\v24\\node_modules\\@deepseek-ai\\dsh\\package.json'],
  )
  assert.deepEqual(
    hostPackageCandidates({ execPath: '/prefix/bin/node', platform: 'linux' }),
    ['/prefix/lib/node_modules/@deepseek-ai/dsh/package.json'],
  )
})
