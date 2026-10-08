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

test('运行时长格式:秒→m:ss,一小时以上→h:mm:ss,负值钳 0', () => {
  const formatDuration = extractLogic('formatDuration')
  assert.equal(formatDuration(0), '0:00')
  assert.equal(formatDuration(42_000), '0:42')
  assert.equal(formatDuration(61_000), '1:01')
  assert.equal(formatDuration(3600_000), '1:00:00')
  assert.equal(formatDuration(3661_000), '1:01:01')
  assert.equal(formatDuration(-5), '0:00')
})

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

// ── S21 六态徽章矩阵:前台/后台 × shell(git-bash/pwsh) × pwsh 官方 ──
// 背景:官方 pwsh 工具调用被增强卡接管,但其输出无 [shell: ...] 标记、参数无
// shell 字段,徽章兜底落查看时默认客户端读数 → 官方 pwsh 调用误标 git-bash。

const BG_ARGS = JSON.stringify({ command: 'node server.js', description: 'Boot server', run_in_background: true })

test('S21a shell 前台 git-bash:执行事实标记入徽章', () => {
  // BDD:Given shell 工具经 git-bash 客户端前台执行,When 派生卡片模型,Then 徽章显示标记承载的 git-bash
  const model = cardModel(null)(settledBlock(ARGS, 'out\n[shell: git-bash]\n[exit code: 0]'), SESSION_CWD, 'shell')
  assert.equal(model.kind, 'terminal')
  assert.equal(model.shellName, 'git-bash')
})

test('S21b shell 前台 pwsh:执行事实标记入徽章', () => {
  // BDD:Given shell 工具经 pwsh 客户端前台执行失败,When 派生卡片模型,Then 徽章 pwsh 且退出码保留
  const model = cardModel(null)(settledBlock(ARGS, 'out\n[shell: pwsh]\n[exit code: 2]'), SESSION_CWD, 'shell')
  assert.equal(model.shellName, 'pwsh')
  assert.equal(model.exitCode, 2)
})

test('S21c shell 后台 git-bash:ack 标记入徽章,jobId 解析', () => {
  // BDD:Given shell 工具后台启动于 git-bash,When 派生 ack 卡,Then 徽章 git-bash 且 jobId 取自 ack
  const model = cardModel(null)(settledBlock(BG_ARGS, 'started background job shell-4\n[shell: git-bash]'), SESSION_CWD, 'shell')
  assert.equal(model.kind, 'background')
  assert.equal(model.jobId, 'shell-4')
  assert.equal(model.shellName, 'git-bash')
})

test('S21d shell 后台 pwsh:ack 标记入徽章', () => {
  // BDD:Given shell 工具后台启动于 pwsh,When 派生 ack 卡,Then 徽章 pwsh
  const model = cardModel(null)(settledBlock(BG_ARGS, 'started background job shell-5\n[shell: pwsh]'), SESSION_CWD, 'shell')
  assert.equal(model.kind, 'background')
  assert.equal(model.jobId, 'shell-5')
  assert.equal(model.shellName, 'pwsh')
})

test('S21e pwsh 官方前台:徽章钉死 pwsh,不落默认客户端读数', () => {
  // BDD:Given 官方 pwsh 工具调用(无标记无 shell 参数)且查看时默认客户端为 git-bash,
  // When 派生卡片模型,Then 徽章 pwsh(工具名即执行事实,读数兜底只属 shell 工具历史块)
  const model = cardModel({ default: 'git-bash', byId: { 'git-bash': 'git-bash' } })(
    settledBlock(ARGS, 'On branch main\n[exit code: 0]'), SESSION_CWD, 'pwsh')
  assert.equal(model.kind, 'terminal')
  assert.equal(model.shellName, 'pwsh')
})

test('S21f pwsh 官方后台:徽章钉死 pwsh,官方 pwsh 前缀 jobId 解析', () => {
  // BDD:Given 官方 pwsh 工具后台启动(kind pwsh → 任务号 pwsh-N),When 派生 ack 卡,Then 徽章 pwsh 且 jobId=pwsh-3
  const model = cardModel({ default: 'git-bash', byId: { 'git-bash': 'git-bash' } })(
    settledBlock(BG_ARGS, 'started background job pwsh-3'), SESSION_CWD, 'pwsh')
  assert.equal(model.kind, 'background')
  assert.equal(model.jobId, 'pwsh-3')
  assert.equal(model.shellName, 'pwsh')
})

test('S21g pwsh 官方运行中:徽章钉死 pwsh(落定前不误标)', () => {
  // BDD:Given 官方 pwsh 调用进行中无结果文本,When 派生 running 卡,Then 徽章 pwsh 而非默认客户端读数
  const model = cardModel({ default: 'git-bash', byId: { 'git-bash': 'git-bash' } })(runningBlock(ARGS), SESSION_CWD, 'pwsh')
  assert.equal(model.status, 'running')
  assert.equal(model.shellName, 'pwsh')
})

test('S21h bash 官方 key 同规钉死(同类预防)', () => {
  // BDD:Given 官方 bash 工具调用且默认客户端读数为 git-bash,When 派生卡片模型,Then 徽章 bash
  const model = cardModel({ default: 'git-bash', byId: { 'git-bash': 'git-bash' } })(
    settledBlock(ARGS, 'out\n[exit code: 0]'), SESSION_CWD, 'bash')
  assert.equal(model.shellName, 'bash')
})

test('S21i toolKey 贯通:注册循环注入 + 行组件传入模型(渲染守卫)', () => {
  // BDD:Given 卡片按 key 注册,When 渲染,Then key 以 toolKey 注入组件并传入模型派生(漏任何一环徽章退回读数兜底)
  assert.match(source, /React\.createElement\(ShellToolRow, \{ \.\.\.props, toolKey \}\)/)
  assert.match(source, /shellCardModel\(block, cwd, toolKey\)/)
})

test('S21j 钉死键集与注册键集同源:PINNED_CLIENT 恒等于 TOOLVIEW_KEYS 去 shell(渲染守卫)', () => {
  // BDD:Given 官方钉死客户端事实在 client.js 双处字面编码(TOOLVIEW_KEYS 与 PINNED_CLIENT),
  // When 派生两处键集,Then 钉死键集恒等于注册键集去掉 shell——注册面新增官方工具 key 而
  // 漏配钉死映射时此处红,误标 bug 不静默复发
  const toolviewKeys = /const TOOLVIEW_KEYS = \[([^\]]*)\]/.exec(source)[1]
    .split(',').map((item) => item.trim().replace(/^'|'$/g, '')).filter((key) => key !== '' && key !== 'shell')
  const pinnedKeys = /const PINNED_CLIENT = \{([^}]*)\}/.exec(source)[1]
    .split(',').map((pair) => pair.trim().split(':')[0].trim().replace(/^'|'$/g, '')).filter((key) => key !== '')
  assert.deepEqual(pinnedKeys.sort(), toolviewKeys.sort())
})
