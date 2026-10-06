// shellCardModel 行为测试:LOGIC 段提取(client.js 工厂内纯函数,形态照
// dsh-maintain/test/logic-extract.mjs)。BDD 场景见 docs/feat-shell-select-optim/plan.md S11-S13。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')

function extractLogic(name, deps = {}) {
  const pattern = new RegExp('// LOGIC-BEGIN ' + name + '\\n([\\s\\S]*?)\\n\\s*// LOGIC-END ' + name)
  const match = source.match(pattern)
  if (!match) throw new Error('client.js 缺少 LOGIC 段: ' + name)
  const keys = Object.keys(deps)
  return new Function(...keys, 'return (' + match[1].trim() + ')')(...keys.map((key) => deps[key]))
}

function cardModel(catalog = null) {
  const lastSegment = extractLogic('lastSegment')
  const displayCwd = extractLogic('displayCwd', { lastSegment })
  return extractLogic('shellCardModel', {
    displayCwd,
    lastSegment,
    parseExitTail: extractLogic('parseExitTail'),
    hasSpillNotice: extractLogic('hasSpillNotice'),
    parseShellMark: extractLogic('parseShellMark'),
    stripShellMark: extractLogic('stripShellMark'),
    clientDisplayName: extractLogic('clientDisplayName', { clientCatalog: catalog }),
  })
}

function parseEnvText() {
  return extractLogic('parseEnvText')
}

test('运行时长格式:秒→m:ss,一小时以上→h:mm:ss,负值钳 0', () => {
  const formatDuration = extractLogic('formatDuration')
  assert.equal(formatDuration(0), '0:00')
  assert.equal(formatDuration(42_000), '0:42')
  assert.equal(formatDuration(61_000), '1:01')
  assert.equal(formatDuration(3600_000), '1:00:00')
  assert.equal(formatDuration(3661_000), '1:01:01')
  assert.equal(formatDuration(-5), '0:00')
})

function invalidEnvLines() {
  return extractLogic('invalidEnvLines')
}

// 运行中调用块(官方形态:无 kind 字段)
function runningBlock(argsRaw) {
  return { callId: 'c1', name: 'shell', argsRaw }
}

// 已定调用块(官方形态:kind 字段在)
function settledBlock(argsRaw, text, options = {}) {
  return {
    kind: 'tool',
    callId: 'c1',
    call: { callId: 'c1', name: 'shell', argsRaw },
    content: [{ type: 'text', text }],
    isError: options.isError,
  }
}

const ARGS = JSON.stringify({ command: 'git status', description: 'Show working tree status', workdir: 'sub' })
const SESSION_CWD = 'C:\\repo'

test('S11 running 且无 description(persistent 形):全量卡不回退(阻塞时展开必有命令)', () => {
  const model = cardModel()(runningBlock(JSON.stringify({ command: 'interactive session' })), SESSION_CWD)
  assert.equal(model.kind, 'terminal')
  assert.equal(model.status, 'running')
  assert.equal(model.description, undefined)
})

test('S11b settled 无 description(persistent 结束)回退 generic', () => {
  const model = cardModel()(settledBlock(JSON.stringify({ command: 'interactive session' }), 'out\n[exit code: 0]'), SESSION_CWD)
  assert.equal(model.kind, 'generic')
})

test('S12 官方 pwsh 形 settled:terminal 卡派生退出码与输出', () => {
  const model = cardModel()(settledBlock(ARGS, 'On branch main\n[exit code: 2]', { isError: false }), SESSION_CWD)
  assert.equal(model.kind, 'terminal')
  assert.equal(model.status, 'failed')
  assert.equal(model.exitCode, 2)
  assert.equal(model.output, 'On branch main')
  assert.equal(model.cwdDir, 'sub')
})

test('S12b running 完整参数:terminal running 卡', () => {
  const model = cardModel()(runningBlock(ARGS), SESSION_CWD)
  assert.equal(model.kind, 'terminal')
  assert.equal(model.status, 'running')
})

test('S15 shell 徽章命名:显式参数按 id 取用户命名,缺省落 default 客户端命名', () => {
  const catalog = { default: 'git-bash', byId: { 'git-bash': 'Git Bash', pwsh: 'PowerShell' } }
  const explicit = cardModel(catalog)(
    settledBlock(JSON.stringify({ command: 'ls', description: 'list', shell: 'pwsh' }), 'out\n[exit code: 0]'), SESSION_CWD)
  assert.equal(explicit.shellName, 'PowerShell')
  const fallback = cardModel(catalog)(
    settledBlock(ARGS, 'out\n[exit code: 0]'), SESSION_CWD)
  assert.equal(fallback.shellName, 'Git Bash')
  const unknown = cardModel(catalog)(
    settledBlock(JSON.stringify({ command: 'ls', description: 'list', shell: 'ghost' }), 'out\n[exit code: 0]'), SESSION_CWD)
  assert.equal(unknown.shellName, undefined)
})

test('S15b cwd 悬浮全路径:model 携带 cwdFull', () => {
  const model = cardModel()(
    settledBlock(JSON.stringify({ command: 'git status', description: 'Show working tree status', workdir: 'sub' }), 'out\n[exit code: 0]'), SESSION_CWD)
  assert.equal(model.cwdDir, 'sub')
  assert.equal(model.cwdFull, 'C:\\repo\\sub')
  const noWorkdir = cardModel()(
    settledBlock(JSON.stringify({ command: 'git status', description: 'Show working tree status' }), 'out\n[exit code: 0]'), SESSION_CWD)
  assert.equal(noWorkdir.cwdFull, SESSION_CWD)
})

test('S16 cwd 悬浮说明:可见文本为 basename,title 为 pwd: + 全路径(渲染守卫)', () => {
  // BDD:Given shell 调用带 workdir,When 悬浮 cwd 元数据,Then 可见文本为 basename,title 为 'pwd: <全路径>' 单段说明
  assert.match(source, /title: 'pwd: ' \+ \(model\.cwdFull \?\? model\.cwdDir\)/)
  assert.match(source, /\}, model\.cwdDir\)/)
})

test('S17 后台 ack:派生 background 卡,命令在场且解析出 jobId', () => {
  // BDD:Given run_in_background 调用已定,When 派生卡片模型,Then kind=background,jobId 取自 ack 标记,命令与 ack 原文保留
  const model = cardModel()(settledBlock(
    JSON.stringify({ command: 'node server.js', description: 'Boot server', run_in_background: true }),
    'started background job shell-11'), SESSION_CWD)
  assert.equal(model.kind, 'background')
  assert.equal(model.jobId, 'shell-11')
  assert.equal(model.command, 'node server.js')
  assert.equal(model.output, 'started background job shell-11')
})

test('S17b 后台 ack 异常文本:仍 background,jobId 缺省不冒充', () => {
  const model = cardModel()(settledBlock(
    JSON.stringify({ command: 'x', description: 'd', run_in_background: true }), 'other'), SESSION_CWD)
  assert.equal(model.kind, 'background')
  assert.equal(model.jobId, undefined)
})

test('S17c 后台行默认收起,收起行携带任务号徽标(渲染守卫)', () => {
  // BDD:Given 后台 ack 卡,When 行渲染,Then 默认收起与其余行一致,收起态可见 job id 徽标
  assert.match(source, /case 'background':/)
  assert.match(source, /sls-tv__pill--bg/)
  assert.doesNotMatch(source, /useState\(model\.kind === 'background'\)/)
  assert.match(source, /model\.status === 'background' && model\.jobId !== undefined/)
})

test('S17d 后台状态中性:不断言运行中,点为中性图标(渲染守卫)', () => {
  // BDD:Given ack 块静态且不反映 job 生命周期,When 渲染后台状态,Then 文案与点均不断言 ongoing
  assert.doesNotMatch(source, /case 'background':\s*\r?\n\s*dot: 'ongoing'/)
  assert.doesNotMatch(source, /case 'background': return en \? 'Background' : '后台运行'/)
})

test('S18 头部单行:cwd 与客户端徽章强制不换行(渲染守卫)', () => {
  // BDD:Given 头部行宽受限,When cwd 或客户端名过长,Then 二者均不内部折行(cwd 压缩出省略号,徽章保持完整)
  assert.match(source, /\.sls-tv__cwd \{[^}]*white-space:nowrap/)
  assert.match(source, /\.sls-tv__cwd \{[^}]*overflow:hidden/)
  assert.match(source, /\.sls-tv__cwd \{[^}]*text-overflow:ellipsis/)
  assert.match(source, /\.sls-tv__badge \{[^}]*white-space:nowrap/)
  assert.match(source, /\.sls-tv__pill \{[^}]*white-space:nowrap/)
  assert.match(source, /\.sls-tv__duration \{[^}]*white-space:nowrap/)
  assert.match(source, /\.sls-tv__pulse \{[^}]*white-space:nowrap/)
})

test('S19 行首无展开箭头:官方组件无展开箭头,可展开性由指针与整行点击承载(渲染守卫)', () => {
  // BDD:Given 官方 ToolRow 无展开箭头,When 行渲染,Then 不存在 chevron 节点及其样式与状态钩子
  assert.doesNotMatch(source, /sls-tv__chev/)
  assert.doesNotMatch(source, /IconChevron/)
  assert.doesNotMatch(source, /data-open/)
})

test('S20 徽章执行事实:结果标记优先于查看时配置读数', () => {
  // BDD:Given 缺省客户端调用时 default 为 pwsh,查看时配置 default 已改 git-bash,When 派生卡片模型,Then 徽章显示标记承载的 pwsh,输出不含标记行
  const model = cardModel({ default: 'git-bash', byId: { 'git-bash': 'git-bash' } })(
    settledBlock(ARGS, 'out\n[shell: pwsh]\n[exit code: 0]'), SESSION_CWD)
  assert.equal(model.kind, 'terminal')
  assert.equal(model.shellName, 'pwsh')
  assert.equal(model.output, 'out')
})

test('S20b 徽章执行事实:标记在场不依赖配置面,catalog 缺失仍显示', () => {
  // BDD:Given 配置读取失败(catalog null),When 块带执行事实标记,Then 徽章仍按标记显示(执行事实不依赖查看时读数)
  const model = cardModel(null)(
    settledBlock(ARGS, 'out\n[shell: git-bash]\n[exit code: 2]'), SESSION_CWD)
  assert.equal(model.shellName, 'git-bash')
  assert.equal(model.exitCode, 2)
})

test('S20c 旧块无标记:回退显式参数 → 查看时 default(S15 链不回归)', () => {
  // BDD:Given 历史块无标记时代产物,When 派生模型,Then 沿用显式参数/查看时 default 推导
  const catalog = { default: 'git-bash', byId: { 'git-bash': 'git-bash', pwsh: 'pwsh' } }
  const fallback = cardModel(catalog)(settledBlock(ARGS, 'out\n[exit code: 0]'), SESSION_CWD)
  assert.equal(fallback.shellName, 'git-bash')
  const explicit = cardModel(catalog)(
    settledBlock(JSON.stringify({ command: 'ls', description: 'list', shell: 'pwsh' }), 'out\n[exit code: 0]'), SESSION_CWD)
  assert.equal(explicit.shellName, 'pwsh')
})

test('S20d 后台 ack:标记入徽章,输出剥离标记行', () => {
  // BDD:Given 后台调用 ack 携带执行事实标记,When 派生模型,Then shellName 按标记,输出仅剩 ack 原文
  const model = cardModel({ default: 'git-bash', byId: {} })(settledBlock(
    JSON.stringify({ command: 'node server.js', description: 'Boot server', run_in_background: true }),
    'started background job shell-11\n[shell: pwsh]'), SESSION_CWD)
  assert.equal(model.kind, 'background')
  assert.equal(model.jobId, 'shell-11')
  assert.equal(model.shellName, 'pwsh')
  assert.equal(model.output, 'started background job shell-11')
})

test('S20e generic 输出剥离标记行(isError 路径)', () => {
  // BDD:Given isError 块文本含标记,When 回退 generic,Then 输出不含标记行
  const model = cardModel(null)(settledBlock(ARGS, 'boom\n[shell: pwsh]', { isError: true }), SESSION_CWD)
  assert.equal(model.kind, 'generic')
  assert.equal(model.output, 'boom')
})

test('S20f 运行中块:无结果文本,徽章按显式参数/查看时 default 推导(现状)', () => {
  // BDD:Given 调用进行中无结果,When 派生模型,Then 徽章沿用配置读数(执行事实落定后由标记校正)
  const catalog = { default: 'git-bash', byId: { 'git-bash': 'git-bash' } }
  const model = cardModel(catalog)(runningBlock(ARGS), SESSION_CWD)
  assert.equal(model.shellName, 'git-bash')
})

test('S12c isError 与空结果仍走 generic(回归)', () => {
  const errored = cardModel()(settledBlock(ARGS, 'boom', { isError: true }), SESSION_CWD)
  assert.equal(errored.kind, 'generic')
  const empty = cardModel()(settledBlock(ARGS, ''), SESSION_CWD)
  assert.equal(empty.kind, 'generic')
})

test('S13 注册面:shell/pwsh/bash 三 key 且 priority -1(文本守卫)', () => {
  assert.match(source, /const TOOLVIEW_KEYS = \['shell', 'pwsh', 'bash'\]/)
  assert.match(source, /key: toolKey, priority: -1/)
})

test('K=V 往返:值含 = 与空格无损,空行忽略,重复键后行胜', () => {
  const parse = parseEnvText()
  assert.deepEqual(parse('A=1\nB=x=y z\n\nA=2'), { A: '2', B: 'x=y z' })
  assert.deepEqual(parse(''), {})
  assert.deepEqual(parse(undefined), {})
})

test('invalidEnvLines:缺 = 行报出,空行不报', () => {
  const invalid = invalidEnvLines()
  assert.deepEqual(invalid('A=1\nbroken\n\n  noSep  '), ['broken', 'noSep'])
  assert.deepEqual(invalid('A=1'), [])
})
