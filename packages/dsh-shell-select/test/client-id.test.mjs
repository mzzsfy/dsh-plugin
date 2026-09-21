// client-id 守卫:样式注入点必须伴随 data-plugin=@mzzsfy/dsh-shell-select 标记
// (仓库契约,守卫形态照 dsh-cron-board/test/client-id.test.mjs:createElement('style')
// 与 setAttribute('data-plugin') 计数相等)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')

test('head 注入样式全部带 data-plugin 标记', () => {
  const createElementStyle = (source.match(/createElement\('style'/g) ?? []).length
    + (source.match(/createElement\("style"/g) ?? []).length
  const marked = (source.match(/'data-plugin'/g) ?? []).length + (source.match(/"data-plugin"/g) ?? []).length
  assert.ok(createElementStyle > 0, 'client.js 应至少有一个样式注入点')
  assert.equal(marked, createElementStyle, '每个 createElement(\'style\') 必须伴随一个 data-plugin 标记')
})

test('标记值为完整 npm 包名', () => {
  assert.match(source, /setAttribute\('data-plugin', '@mzzsfy\/dsh-shell-select'\)/)
})

test('settings.section 注册与 id', () => {
  assert.match(source, /settings\.section/)
  assert.match(source, /id: 'shell-select'/)
})

test('tool.call.toolview 注册:shell 族三 key + priority -1', () => {
  assert.match(source, /'tool\.call\.toolview'/)
  assert.match(source, /const TOOLVIEW_KEYS = \['shell', 'pwsh', 'bash'\]/)
  assert.match(source, /key: toolKey, priority: -1/)
})

test('卡片数据链:官方同构派生(argsRaw + content 尾部退出标记)+ generic 回退', () => {
  assert.match(source, /parseExitTail/)
  assert.ok(source.includes("[exit code: ("), '缺少 exit 尾标解析')
  assert.match(source, /kind: 'generic'/)
})

test('primitives 缺席时图标降级自绘(require 有 try/catch 兜底)', () => {
  assert.match(source, /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/)
  assert.match(source, /catch \{\s*return null\s*\}/)
})

test('扩展字段守卫:login/distro/env 进设置页数据链(wholesale replace 防静默重置)', () => {
  // toSection(保存)与 toEntries(加载)必须同时携带 login/distro;
  // env 走 envText(K=V 每行)编辑态往返:保存侧 parseEnvText,加载侧 envText
  for (const field of ['login', 'distro']) {
    const writes = (source.match(new RegExp(`^\\s*${field}: .*$`, 'gm')) ?? []).length
    assert.ok(writes >= 2, `toSection/toEntries 应各携带 ${field}(发现 ${writes} 处)`)
  }
  assert.match(source, /env: parseEnvText\(entry\.envText\)/)
  assert.match(source, /envText: Object\.entries\(entry\.env \?\? \{\}\)/)
  assert.match(source, /登录壳/)
  assert.match(source, /发行版/)
})

test('deny/allow 名单进设置页数据链:state/toSection/校验/往返', () => {
  assert.match(source, /denyText/)
  assert.match(source, /allowText/)
  assert.match(source, /deny: splitPatternLines\(denyText\)/)
  assert.match(source, /allow: splitPatternLines\(allowText\)/)
  assert.match(source, /名单正则非法/)
  assert.match(source, /拒绝名单/)
  assert.match(source, /豁免名单/)
})
