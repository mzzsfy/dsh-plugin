import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchDistTags, resolveHostVersion, hostPackageCandidates, TARGET_PACKAGE } from '../src/core.mjs'

const REGISTRY = 'https://registry.npmmirror.com'

// fetchDistTags 走 response.body.getReader() 流式读取;mock 按单块提供全部字节
function streamBody(text) {
  const chunks = [new TextEncoder().encode(text)]
  return {
    getReader: () => ({
      read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true, value: undefined }),
      cancel: async () => {},
    }),
  }
}

function fakeFetch(body, { ok = true, status = 200 } = {}) {
  return async (url, options) => {
    const text = typeof body === 'function' ? body(url) : typeof body === 'string' ? body : JSON.stringify(body)
    return { ok, status, body: streamBody(text) }
  }
}

test('场景:dist-tags 拉取走轻量端点且透传 redirect/signal 选项', async () => {
  let requestedUrl = null
  let capturedOptions = null
  const tags = await fetchDistTags({
    registryBase: REGISTRY,
    fetchImpl: async (url, options) => {
      requestedUrl = url
      capturedOptions = options
      return { ok: true, status: 200, body: streamBody(JSON.stringify({ latest: '0.1.1-rc.2' })) }
    },
    timeoutMs: 1000,
  })
  assert.deepEqual(tags, { latest: '0.1.1-rc.2' })
  assert.equal(requestedUrl, REGISTRY + '/-/package/' + encodeURIComponent(TARGET_PACKAGE) + '/dist-tags')
  // 选项透传断言:redirect:'error' 的实际拒跟行为由平台 fetch 保证,mock 只验证参数到达
  assert.equal(capturedOptions.redirect, 'error')
  assert.ok(capturedOptions.signal instanceof AbortSignal)
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
    /JSON/,
  )
  await assert.rejects(
    () => fetchDistTags({ registryBase: REGISTRY, fetchImpl: fakeFetch([]), timeoutMs: 1000 }),
    /dist-tags/,
  )
})

test('场景:响应体超限时流式读取中途断开', async () => {
  const huge = JSON.stringify({ latest: '1.0.0', pad: 'x'.repeat(80 * 1024) })
  let cancelled = false
  const bytes = new TextEncoder().encode(huge)
  await assert.rejects(
    () => fetchDistTags({
      registryBase: REGISTRY,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: {
          getReader() {
            let sent = 0
            return {
              read: async () => {
                if (sent >= bytes.byteLength) return { done: true, value: undefined }
                const chunk = bytes.subarray(sent, sent + 8 * 1024)
                sent += chunk.byteLength
                return { done: false, value: chunk }
              },
              cancel: async () => {
                cancelled = true
              },
            }
          },
        },
      }),
      timeoutMs: 1000,
    }),
    /超过上限/,
  )
  assert.equal(cancelled, true, '超限后必须 cancel 断开上游,不得读完全量')
})

test('场景:timeoutMs 缺省快速失败不发起请求', async () => {
  let called = false
  await assert.rejects(
    () => fetchDistTags({
      registryBase: REGISTRY,
      fetchImpl: async () => { called = true; return { ok: true, text: async () => '{}' } },
    }),
    /timeoutMs/,
  )
  assert.equal(called, false)
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

test('场景:候选文件可读但 version 非法时静默换下一候选', async () => {
  const files = {
    '/prefix/lib/node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: 'x' }),
    '/opt/dsh/package.json': JSON.stringify({ version: '2.0.0' }),
  }
  const version = await resolveHostVersion({
    execPath: '/prefix/bin/node',
    platform: 'linux',
    readFileImpl: async (path) => {
      if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error('ENOENT')
      return files[path]
    },
    resolveImpl: () => '/opt/dsh/package.json',
  })
  assert.equal(version, '2.0.0')
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
