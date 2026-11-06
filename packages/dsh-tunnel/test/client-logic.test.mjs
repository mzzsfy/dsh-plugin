// client 纯逻辑 BDD: 访问地址派生(域名/IP/localhost/路径前缀)与剪贴板降级;
// 常量与 host 半区同源, 防止两侧各写一份后漂移。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientSource = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
const hostSource = readFileSync(join(PKG_ROOT, 'src', 'index.js'), 'utf8')

function loadLogic(navigator) {
  const start = clientSource.indexOf('/* LOGIC-BEGIN */')
  const end = clientSource.indexOf('/* LOGIC-END */')
  assert.ok(start >= 0 && end > start, '缺少 LOGIC 标记')
  const code = clientSource.slice(start, end)
  return new Function('navigator', code + '\nreturn { accessUrlOf, accessLocalOnly, copyText, createRefreshGate, isPageVisible, PATH_PREFIX, NAME_RE, NAME_HAS_LETTER_RE, ENTRY_PATH, ENTRY_SUBDOMAIN, PORT_MIN, PORT_MAX }')(navigator)
}

function constantOf(source, name) {
  const match = source.match(new RegExp('const ' + name + ' = ([^\\n]+)'))
  assert.ok(match, '缺少常量 ' + name)
  return match[1].trim().replace(/;$/, '')
}

test('常量同源: 路径前缀/名字规则/入口枚举/端口范围 host 与 client 完全一致', () => {
  const pairs = [['PATH_PREFIX', 'PATH_PREFIX'], ['NAME_RE', 'TUNNEL_NAME_RE'], ['NAME_HAS_LETTER_RE', 'NAME_HAS_LETTER_RE'],
    ['ENTRY_PATH', 'ENTRY_PATH'], ['ENTRY_SUBDOMAIN', 'ENTRY_SUBDOMAIN'], ['PORT_MIN', 'PORT_MIN'], ['PORT_MAX', 'PORT_MAX']]
  for (const [clientName, hostName] of pairs) {
    assert.equal(constantOf(clientSource, clientName), constantOf(hostSource, hostName), clientName + ' 两侧不一致')
  }
})

test('路径模式地址: 同源 + /p/<名>/, 不受入口路径前缀影响', () => {
  const logic = loadLogic(undefined)
  assert.equal(
    logic.accessUrlOf({ name: 'app', entry: 'path' }, { origin: 'http://10.0.0.5:3080', hostname: '10.0.0.5', port: '3080', protocol: 'http:' }),
    'http://10.0.0.5:3080/p/app/',
  )
})

test('子域名地址: 域名入口按 <名>.<域名>[:端口] 派生', () => {
  const logic = loadLogic(undefined)
  assert.equal(
    logic.accessUrlOf({ name: 'app', entry: 'subdomain' }, { protocol: 'https:', hostname: 'dsh.example.com', port: '', origin: 'https://dsh.example.com' }),
    'https://app.dsh.example.com/',
  )
  assert.equal(
    logic.accessUrlOf({ name: 'app', entry: 'subdomain' }, { protocol: 'http:', hostname: 'dsh.example.com', port: '3080', origin: 'http://dsh.example.com:3080' }),
    'http://app.dsh.example.com:3080/',
  )
})

test('子域名地址: IP/localhost 入口退回 <名>.localhost 并标注仅本机', () => {
  const logic = loadLogic(undefined)
  for (const hostname of ['10.0.0.5', '127.0.0.1', 'localhost', '[::1]']) {
    const location = { protocol: 'http:', hostname, port: '3080', origin: 'http://' + hostname + ':3080' }
    assert.equal(logic.accessUrlOf({ name: 'app', entry: 'subdomain' }, location), 'http://app.localhost:3080/', hostname)
    assert.equal(logic.accessLocalOnly({ entry: 'subdomain' }, location), true, hostname)
  }
  const domain = { protocol: 'http:', hostname: 'dsh.example.com', port: '3080', origin: 'http://dsh.example.com:3080' }
  assert.equal(logic.accessLocalOnly({ entry: 'subdomain' }, domain), false)
  assert.equal(logic.accessLocalOnly({ entry: 'path' }, domain), false)
})

function fakeDocument(execResult) {
  const appended = []
  return {
    appended,
    createElement: () => ({ style: {}, setAttribute() {}, select() {}, value: '' }),
    body: { appendChild: (node) => appended.push(node), removeChild: () => {} },
    execCommand: () => execResult,
  }
}

test('剪贴板: 非安全上下文无 navigator.clipboard 时降级 execCommand', async () => {
  const logic = loadLogic({})
  const document = fakeDocument(true)
  assert.equal(await logic.copyText('http://app.localhost/', document), true)
  assert.equal(document.appended.length, 1, '必须真正走选区复制路径')
})

test('剪贴板: writeText 失败时同样降级, 全失败返回 false', async () => {
  const document = fakeDocument(true)
  const logic = loadLogic({ clipboard: { writeText: async () => { throw new Error('denied') } } })
  assert.equal(await logic.copyText('x', document), true)
  const failing = fakeDocument(false)
  assert.equal(await logic.copyText('x', failing), false)
})

test('刷新闸门: 可见时立即执行, 隐藏时只记脏并在恢复后补一次', () => {
  const logic = loadLogic(undefined)
  let visible = true
  let runs = 0
  const gate = logic.createRefreshGate(() => visible, () => { runs += 1 })

  gate.request()
  assert.equal(runs, 1, '可见时直接执行')
  assert.equal(gate.pending, false)

  visible = false
  gate.request()
  gate.request()
  assert.equal(runs, 1, '隐藏期间不得执行')
  assert.equal(gate.pending, true)

  gate.flush()
  assert.equal(runs, 1, '仍隐藏时 flush 不动')

  visible = true
  assert.equal(gate.flush(), true)
  assert.equal(runs, 2, '恢复可见补一次')
  assert.equal(gate.pending, false)
  assert.equal(gate.flush(), false, '无脏标记时 flush 幂等')
  assert.equal(runs, 2)
})

test('页面可见性判定: 仅 hidden 视为不可见', () => {
  const logic = loadLogic(undefined)
  assert.equal(logic.isPageVisible({ visibilityState: 'visible' }), true)
  assert.equal(logic.isPageVisible({ visibilityState: 'hidden' }), false)
  assert.equal(logic.isPageVisible(undefined), true, '无 document 环境按可见处理')
})
