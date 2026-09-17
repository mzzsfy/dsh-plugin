// release notes 纯逻辑测试:标签构建、发布页地址构建、页面拉取与正文提取。
// 数据源:https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v<版本>(页面正文,规避 api.github.com 未认证限流)

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildReleaseTag,
  buildReleaseNotesUrl,
  fetchReleaseNotes,
  extractReleaseNotesFromHtml,
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

function makeReleaseHtml(inner, { datetime = '2026-09-10T03:09:00Z' } = {}) {
  return '<!doctype html><html><body>'
    + (datetime ? '<relative-time datetime="' + datetime + '"></relative-time>' : '')
    + '<div data-test-selector="body-content" class="markdown-body">' + inner + '</div>'
    + '</body></html>'
}

const RELEASE_INNER = '<h3 id="user-content-note">更新内容</h3>'
  + '<ul>'
  + '<li>新增 A 功能 &amp; B 修复</li>'
  + '<li>支持 <code>fast</code> 模式 &#39;引号&#39; 与 &lt;标签&gt;</li>'
  + '</ul>'
  + '<div class="markdown-body-inner"><p>嵌套段落保持在外层容器内</p></div>'
  + '<p>详情见发布页。</p>'
const RELEASE_BODY = [
  '### 更新内容',
  '- 新增 A 功能 & B 修复',
  '- 支持 fast 模式 \'引号\' 与 <标签>',
  '',
  '嵌套段落保持在外层容器内',
  '',
  '详情见发布页。',
].join('\n')
const RELEASE_HTML = makeReleaseHtml(RELEASE_INNER)

test('场景:合法版本构建发布标签与发布页地址', () => {
  assert.equal(buildReleaseTag('0.1.5-rc.1'), 'dsh-v0.1.5-rc.1')
  assert.equal(
    buildReleaseNotesUrl('0.1.5-rc.1'),
    'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1',
  )
  assert.equal(RELEASE_REPO, 'deepseek-ai/deepseek-harness')
})

test('场景:非法版本拒绝构建标签,空白版本归一后放行', () => {
  assert.throws(() => buildReleaseTag(null), /semver/)
  assert.throws(() => buildReleaseTag('not-semver'), /semver/)
  assert.throws(() => buildReleaseTag('1;rm -rf /'), /semver/)
  assert.equal(buildReleaseTag(' 0.1.5-rc.1 '), 'dsh-v0.1.5-rc.1', '首尾空白归一,防拼接出残缺标签')
})

test('场景:拉取成功提取正文与发布时间,请求形态与上游纪律一致', async () => {
  let requestedUrl = null
  let capturedOptions = null
  const notes = await fetchReleaseNotes({
    version: '0.1.5-rc.1',
    fetchImpl: async (url, options) => {
      requestedUrl = url
      capturedOptions = options
      return { ok: true, status: 200, body: streamBody(RELEASE_HTML) }
    },
    timeoutMs: 1000,
  })
  assert.deepEqual(notes, {
    url: buildReleaseNotesUrl('0.1.5-rc.1'),
    publishedAt: '2026-09-10T03:09:00Z',
    body: RELEASE_BODY,
  })
  assert.equal(requestedUrl, buildReleaseNotesUrl('0.1.5-rc.1'))
  // 选项透传断言:redirect:'error' 的实际拒跟行为由平台 fetch 保证,mock 只验证参数到达
  assert.equal(capturedOptions.redirect, 'error')
  assert.ok(capturedOptions.signal instanceof AbortSignal)
  assert.match(String(capturedOptions.headers.accept), /html/)
  assert.ok(capturedOptions.headers['user-agent'], '页面拉取须带显式 User-Agent')
})

test('场景:HTTP 404 报未找到发布说明,其余非 2xx 报状态码', async () => {
  await assert.rejects(
    () => fetchReleaseNotes({ version: '9.9.9', fetchImpl: fakeFetch('<html></html>', { ok: false, status: 404 }), timeoutMs: 1000 }),
    /未找到/,
  )
  await assert.rejects(
    () => fetchReleaseNotes({ version: '9.9.9', fetchImpl: fakeFetch('<html></html>', { ok: false, status: 502 }), timeoutMs: 1000 }),
    /502/,
  )
})

test('场景:页面缺 markdown-body 锚点或容器未闭合报结构解析失败', () => {
  assert.throws(() => extractReleaseNotesFromHtml('<html><body><p>没有正文容器</p></body></html>'), /结构无法解析/)
  assert.throws(() => extractReleaseNotesFromHtml('<div class="markdown-body"><p>容器未闭合</p>'), /结构无法解析/)
  assert.throws(() => extractReleaseNotesFromHtml(null), /结构无法解析/)
})

test('场景:空正文容器返回空说明,缺发布时间为 null', async () => {
  const notes = await fetchReleaseNotes({
    version: '9.9.9',
    fetchImpl: fakeFetch(makeReleaseHtml('   ', { datetime: '' })),
    timeoutMs: 1000,
  })
  assert.deepEqual(notes, {
    url: buildReleaseNotesUrl('9.9.9'),
    publishedAt: null,
    body: '',
  })
})

test('场景:上游网络异常原样抛出由调用方归一', async () => {
  await assert.rejects(
    () => fetchReleaseNotes({ version: '9.9.9', fetchImpl: async () => { throw new Error('ECONNRESET') }, timeoutMs: 1000 }),
    /ECONNRESET/,
  )
})

test('场景:超限响应体中途断开,不整量入内存', async () => {
  const chunk = 'x'.repeat(128 * 1024)
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
    () => fetchReleaseNotes({ version: '9.9.9', fetchImpl: fakeFetch(RELEASE_HTML) }),
    /timeoutMs/,
  )
  await assert.rejects(
    () => fetchReleaseNotes({ version: '9.9.9', fetchImpl: fakeFetch(RELEASE_HTML), timeoutMs: 0 }),
    /timeoutMs/,
  )
})
