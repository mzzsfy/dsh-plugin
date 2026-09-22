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
    clientDisplayName: extractLogic('clientDisplayName', { clientCatalog: catalog }),
  })
}

function parseEnvText() {
  return extractLogic('parseEnvText')
}

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

test('S11 running 且无 description(persistent 形)回退 generic', () => {
  const model = cardModel()(runningBlock(JSON.stringify({ command: 'interactive session' })), SESSION_CWD)
  assert.equal(model.kind, 'generic')
  assert.equal(model.running, true)
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
