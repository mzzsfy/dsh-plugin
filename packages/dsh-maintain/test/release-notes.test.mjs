// release notes 纯逻辑测试:标签构建、API 地址构建、GitHub release 拉取与响应校验。
// 数据源:https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v<版本>

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildReleaseTag,
  buildReleaseNotesUrl,
  fetchReleaseNotes,
  parseReleaseNotes,
  RELEASE_REPO,
} from '../src/core.mjs'

// fetchReleaseNotes 走 response.body.getReader() 流式读取;mock 按单块提供全部字节
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

const RELEASE_JSON = {
  html_url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1',
  published_at: '2026-09-10T03:09:00Z',
  body: '## 更新内容\n\n- 修复若干问题',
}

test('场景:合法版本构建发布标签与 API 地址', () => {
  assert.equal(buildReleaseTag('0.1.5-rc.1'), 'dsh-v0.1.5-rc.1')
  assert.equal(
    buildReleaseNotesUrl('0.1.5-rc.1'),
    'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v0.1.5-rc.1',
  )
  assert.equal(RELEASE_REPO, 'deepseek-ai/deepseek-harness')
})

test('场景:非法版本拒绝构建标签,空白版本归一后放行', () => {
  assert.throws(() => buildReleaseTag(null), /semver/)
  assert.throws(() => buildReleaseTag('not-semver'), /semver/)
  assert.throws(() => buildReleaseTag('1;rm -rf /'), /semver/)
  assert.equal(buildReleaseTag(' 0.1.5-rc.1 '), 'dsh-v0.1.5-rc.1', '首尾空白归一,防拼接出残缺标签')
})

test('场景:拉取成功返回发布说明,请求形态与上游纪律一致', async () => {
  let requestedUrl = null
  let capturedOptions = null
  const notes = await fetchReleaseNotes({
    version: '0.1.5-rc.1',
    fetchImpl: async (url, options) => {
      requestedUrl = url
      capturedOptions = options
      return { ok: true, status: 200, body: streamBody(JSON.stringify(RELEASE_JSON)) }
    },
    timeoutMs: 1000,
  })
  assert.deepEqual(notes, {
    url: RELEASE_JSON.html_url,
    publishedAt: RELEASE_JSON.published_at,
    body: RELEASE_JSON.body,
  })
  assert.equal(requestedUrl, buildReleaseNotesUrl('0.1.5-rc.1'))
  // 选项透传断言:redirect:'error' 的实际拒跟行为由平台 fetch 保证,mock 只验证参数到达
  assert.equal(capturedOptions.redirect, 'error')
  assert.ok(capturedOptions.signal instanceof AbortSignal)
  assert.match(String(capturedOptions.headers.accept), /json/)
  assert.ok(capturedOptions.headers['user-agent'], 'GitHub API 要求显式 User-Agent')
})

test('场景:HTTP 404 报未找到发布说明,403 报限流指引,其余非 2xx 报状态码', async () => {
  await assert.rejects(
    () => fetchReleaseNotes({ version: '9.9.9', fetchImpl: fakeFetch({}, { ok: false, status: 404 }), timeoutMs: 1000 }),
    /未找到/,
  )
  await assert.rejects(
    () => fetchReleaseNotes({ version: '9.9.9', fetchImpl: fakeFetch({}, { ok: false, status: 403 }), timeoutMs: 1000 }),
    /限流/,
  )
  await assert.rejects(
    () => fetchReleaseNotes({ version: '9.9.9', fetchImpl: fakeFetch({}, { ok: false, status: 502 }), timeoutMs: 1000 }),
    /502/,
  )
})

test('场景:响应不是 JSON 或不是对象抛错', async () => {
  await assert.rejects(
    () => fetchReleaseNotes({ version: '9.9.9', fetchImpl: fakeFetch('not-json'), timeoutMs: 1000 }),
    /JSON/,
  )
  await assert.rejects(
    () => fetchReleaseNotes({ version: '9.9.9', fetchImpl: fakeFetch('[]'), timeoutMs: 1000 }),
    /对象/,
  )
})

test('场景:body 为 null 视为空说明,html_url 缺失为 null', async () => {
  const notes = await fetchReleaseNotes({
    version: '9.9.9',
    fetchImpl: fakeFetch({ tag_name: 'dsh-v9.9.9' }),
    timeoutMs: 1000,
  })
  assert.deepEqual(notes, { url: null, publishedAt: null, body: '' })
})

test('场景:html_url 白名单,仅官方仓库 releases 路径放行', () => {
  const base = { published_at: null, body: '' }
  // 回流为 <a href> 的远端字段:scheme/域/路径三重白名单,不匹配一律 null 交客户端隐藏
  assert.equal(parseReleaseNotes({ ...base, html_url: 'javascript:alert(1)' }).url, null, '伪协议必须拦截')
  assert.equal(parseReleaseNotes({ ...base, html_url: 'data:text/html,<script>' }).url, null)
  assert.equal(parseReleaseNotes({ ...base, html_url: 'http://github.com/deepseek-ai/deepseek-harness/releases/tag/x' }).url, null, '明文 http 必须拦截')
  assert.equal(parseReleaseNotes({ ...base, html_url: 'https://evil.example/deepseek-ai/deepseek-harness/releases/tag/x' }).url, null, '异域必须拦截')
  assert.equal(parseReleaseNotes({ ...base, html_url: 'https://github.com/evil/repo/releases/tag/x' }).url, null, '他仓库路径必须拦截')
  assert.equal(parseReleaseNotes({ ...base, html_url: 'https://github.com/deepseek-ai/deepseek-harness/releases-evil/x' }).url, null, '路径前缀必须含分隔符边界')
  assert.equal(
    parseReleaseNotes({ ...base, html_url: 'https://GITHUB.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v9.9.9' }).url,
    'https://GITHUB.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v9.9.9',
    'host 大小写经 URL 归一后放行',
  )
  assert.equal(
    parseReleaseNotes({ ...base, html_url: 'https://github.com/deepseek-ai/deepseek-harness/releases' }).url,
    'https://github.com/deepseek-ai/deepseek-harness/releases',
  )
})

test('场景:上游网络异常原样抛出由调用方归一', async () => {
  await assert.rejects(
    () => fetchReleaseNotes({ version: '9.9.9', fetchImpl: async () => { throw new Error('ECONNRESET') }, timeoutMs: 1000 }),
    /ECONNRESET/,
  )
})

test('场景:超限响应体中途断开,不整量入内存', async () => {
  const chunk = 'x'.repeat(64 * 1024)
  let cancelled = false
  const oversized = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => ({ done: false, value: new TextEncoder().encode(chunk) }),
        cancel: async () => { cancelled = true },
      }),
    },
  }
  await assert.rejects(
    () => fetchReleaseNotes({ version: '9.9.9', fetchImpl: async () => oversized, timeoutMs: 1000 }),
    /上限/,
  )
  assert.equal(cancelled, true, '流必须被取消')
})

test('场景:timeoutMs 缺失或非正数拒绝', async () => {
  await assert.rejects(
    () => fetchReleaseNotes({ version: '9.9.9', fetchImpl: fakeFetch(RELEASE_JSON) }),
    /timeoutMs/,
  )
  await assert.rejects(
    () => fetchReleaseNotes({ version: '9.9.9', fetchImpl: fakeFetch(RELEASE_JSON), timeoutMs: 0 }),
    /timeoutMs/,
  )
})
