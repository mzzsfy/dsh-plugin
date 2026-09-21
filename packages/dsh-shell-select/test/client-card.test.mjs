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

function cardModel() {
  const lastSegment = extractLogic('lastSegment')
  const displayCwd = extractLogic('displayCwd', { lastSegment })
  return extractLogic('shellCardModel', { displayCwd, lastSegment, parseExitTail: extractLogic('parseExitTail'), hasSpillNotice: extractLogic('hasSpillNotice') })
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

test('S12c 后台 ack 与 isError 仍走 generic(回归)', () => {
  const background = cardModel()(
    settledBlock(JSON.stringify({ ...JSON.parse(ARGS), run_in_background: true }), 'started', { isError: false }),
    SESSION_CWD,
  )
  assert.equal(background.kind, 'generic')
  const errored = cardModel()(settledBlock(ARGS, 'boom', { isError: true }), SESSION_CWD)
  assert.equal(errored.kind, 'generic')
})

test('S13 注册面:shell/pwsh/bash 三 key 且 priority -1(文本守卫)', () => {
  assert.match(source, /const TOOLVIEW_KEYS = \['shell', 'pwsh', 'bash'\]/)
  assert.match(source, /key: toolKey, priority: -1/)
})
