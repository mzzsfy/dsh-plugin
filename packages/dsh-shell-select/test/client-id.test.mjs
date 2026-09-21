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

test('deny 黑名单进设置页数据链:逐条规则编辑器(deny 绝对,allow 已移除)', () => {
  // 数据链:state 数组 → 保存直落 deny;加载侧 patternText 按条解析(Trim 去空白)
  assert.match(source, /denyRules/)
  assert.match(source, /deny: denyRules/)
  assert.match(source, /patternText\(section\.deny\)/)
  // 行级即时校验 LOGIC 段 + 保存侧复用
  assert.match(source, /denyPatternIssues/)
  assert.match(source, /LOGIC-BEGIN denyPatternIssues/)
  // 交互结构:规则行 + 删除 + 添加 + 空态提示
  assert.match(source, /sls-rule/)
  assert.match(source, /添加规则/)
  assert.match(source, /未配置.*命中拦截不生效/)
  // 术语与僵尸防线
  assert.match(source, /命令黑名单/)
  assert.doesNotMatch(source, /denyText/)
  assert.doesNotMatch(source, /allowText|豁免名单|拒绝名单/)
})

// LOGIC 段行为测试:行级正则校验(提取形态照 client-card.test.mjs)
function extractLogic(name) {
  const pattern = new RegExp('// LOGIC-BEGIN ' + name + '\\n([\\s\\S]*?)\\n\\s*// LOGIC-END ' + name)
  const match = source.match(pattern)
  if (!match) throw new Error('client.js 缺少 LOGIC 段: ' + name)
  return new Function('return (' + match[1].trim() + ')')()
}

test('denyPatternIssues:合法与空规则无问题', () => {
  const issues = extractLogic('denyPatternIssues')(['^format\\s', 'rm -rf\\s+(?!\\S*node_modules)', ''])
  assert.deepEqual(issues, [])
})

test('denyPatternIssues:非法规则定位到行(行号 = 规则序)', () => {
  const issues = extractLogic('denyPatternIssues')(['^format\\s', 'rm -rf\\s+(?!', 'shutdown'])
  assert.equal(issues.length, 1)
  assert.equal(issues[0].index, 1)
  assert.match(issues[0].error, /Invalid|regular|正则/)
})