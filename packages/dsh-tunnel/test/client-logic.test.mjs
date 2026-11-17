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
  return new Function('navigator', code + '\nreturn { accessUrlOf, accessLocalOnly, copyText, createRefreshGate, isPageVisible, entryLabelOf, isEntryLabelConflict, defaultEntryFor, entryHintOf, relativeTime, statusOf, statusTextOf, statusToneOf, statsTextOf, tunnelRowVM, portView, suggestName, tunnelBodyOf, liveTunnels, openAgeText, statusBarSummary, statusBarRowVM, PATH_PREFIX, NAME_RE, NAME_HAS_LETTER_RE, ENTRY_PATH, ENTRY_SUBDOMAIN, PORT_MIN, PORT_MAX, STALE_OPEN_MS }')(navigator)
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

/* 入口域首标签冲突(P2-44): 子域名隧道名等于入口域首标签会把整个 GUI 劫持到隧道目标。
   服务端以宿主信任面为准;client 侧用 location.hostname 先拦一次,提交按钮同步禁用。 */
test('入口域首标签: 取 hostname 首段, 无点主机名不产生标签', () => {
  const logic = loadLogic(undefined)
  assert.equal(logic.entryLabelOf('dsh.example.com'), 'dsh')
  assert.equal(logic.entryLabelOf('gui.a.example.com'), 'gui', '多级域名同样取首标签(与 host 侧 firstLabelOf 同构)')
  assert.equal(logic.entryLabelOf('DSH.Example.com'), 'dsh', '大小写归一')
  assert.equal(logic.entryLabelOf('localhost'), '', '裸 localhost 没有子域名入口')
  assert.equal(logic.entryLabelOf(undefined), '')
  assert.equal(logic.entryLabelOf('127.0.0.1'), '127', '与 host 同构: 纯数字名已被字母规则排除')
})

test('入口域首标签冲突判定: 只有同名才算冲突', () => {
  const logic = loadLogic(undefined)
  assert.equal(logic.isEntryLabelConflict('dsh', 'dsh.example.com'), true)
  assert.equal(logic.isEntryLabelConflict('app', 'dsh.example.com'), false)
  assert.equal(logic.isEntryLabelConflict('app2', 'app.example.com'), false, '前缀相同不算')
  assert.equal(logic.isEntryLabelConflict('dsh', 'localhost'), false)
  assert.equal(logic.isEntryLabelConflict('', 'dsh.example.com'), false)
})

test('弹窗入口默认值: 本机访问优先子域名, 远程 IP 选路径', () => {
  const logic = loadLogic(undefined)
  assert.equal(logic.defaultEntryFor({ hostname: '127.0.0.1', port: '3080', protocol: 'http:', origin: 'http://127.0.0.1:3080' }), logic.ENTRY_SUBDOMAIN)
  assert.equal(logic.defaultEntryFor({ hostname: 'localhost', port: '3080', protocol: 'http:', origin: 'http://localhost:3080' }), logic.ENTRY_SUBDOMAIN)
  assert.equal(logic.defaultEntryFor({ hostname: '10.0.0.5', port: '3080', protocol: 'http:', origin: 'http://10.0.0.5:3080' }), logic.ENTRY_PATH)
  assert.equal(logic.defaultEntryFor({ hostname: 'dsh.example.com', port: '', protocol: 'https:', origin: 'https://dsh.example.com' }), logic.ENTRY_SUBDOMAIN)
  assert.match(logic.entryHintOf(logic.ENTRY_SUBDOMAIN, { hostname: '127.0.0.1' }), /仅本机/)
  assert.match(logic.entryHintOf(logic.ENTRY_PATH, { hostname: '10.0.0.5' }), /手机/)
})

test('弹窗名称建议: 进程名转 slug 并用端口做后缀, 无字母进程回退 app', () => {
  const logic = loadLogic(undefined)
  assert.equal(logic.suggestName(8090, 'collectord.exe'), 'collectord-8090')
  assert.equal(logic.suggestName(3000, 'My App'), 'my-app-3000')
  assert.equal(logic.suggestName(5173, '12345'), 'app-5173')
  const long = logic.suggestName(65535, 'a'.repeat(80))
  assert.ok(long.length <= 32)
  assert.match(long, new RegExp('^[a-z0-9-]+-' + 65535 + '$'))
})

test('提交体: 创建与编辑都带名称(编辑可改名)', () => {
  const logic = loadLogic(undefined)
  const draft = { name: 'app', targetPort: '8090', entry: 'path' }
  assert.deepEqual(logic.tunnelBodyOf('create', draft, 'app'), { targetPort: 8090, entry: 'path', name: 'app' })
  assert.deepEqual(logic.tunnelBodyOf('create', draft, ''), { targetPort: 8090, entry: 'path' })
  assert.deepEqual(logic.tunnelBodyOf('edit', draft, 'app'), { targetPort: 8090, entry: 'path', name: 'app' })
})

test('状态模型: 停用优先于路由错误, 路由错误优先于健康探测', () => {
  const logic = loadLogic(undefined)
  assert.equal(logic.statusOf({ enabled: false, error: 'x', health: { state: 'online' } }), 'disabled')
  assert.equal(logic.statusOf({ enabled: true, error: 'x', health: { state: 'online' } }), 'route_error')
  assert.equal(logic.statusOf({ enabled: true, health: { state: 'online' } }), 'online')
  assert.equal(logic.statusOf({ enabled: true, health: { state: 'offline' } }), 'offline')
  assert.equal(logic.statusOf({ enabled: true }), 'unknown')
  assert.equal(logic.statusTextOf('online'), '在监听')
  assert.equal(logic.statusToneOf('route_error'), 'danger')
})

test('运行期统计: 零访问与有访问显示不同文案, 最近访问用相对时间', () => {
  const logic = loadLogic(undefined)
  const now = Date.parse('2026-11-15T10:10:00.000Z')
  assert.equal(logic.statsTextOf(undefined, now), '本次运行暂无访问')
  assert.equal(logic.statsTextOf({ requests: 0, lastAccessAt: null }, now), '本次运行暂无访问')
  assert.match(logic.statsTextOf({ requests: 12, lastAccessAt: '2026-11-15T10:09:30.000Z' }, now), /12 次 · 30 秒前/)
})

test('端口视图: 默认过滤非候选, 搜索进程与端口, 容器转发器排后, 超量折叠', () => {
  const logic = loadLogic(undefined)
  const items = [
    { port: 3000, process: 'node.exe', dev: true, bind: '127.0.0.1' },
    { port: 8090, process: 'collectord.exe', dev: true, bind: '0.0.0.0' },
    { port: 8080, process: 'wslrelay.exe', dev: true, bind: '0.0.0.0' },
    { port: 445, process: 'System', dev: false, bind: '0.0.0.0' },
  ]
  const normal = logic.portView(items, { limit: 2 })
  assert.deepEqual(normal.visible.map((item) => item.port), [3000, 8090])
  assert.equal(normal.rest.length, 1)
  assert.equal(normal.total, 3)
  assert.deepEqual(logic.portView(items, { query: 'collect' }).visible.map((item) => item.port), [8090])
  assert.deepEqual(logic.portView(items, { query: '3000' }).visible.map((item) => item.port), [3000])
  assert.deepEqual(logic.portView(items, { showAll: true }).visible.map((item) => item.port), [3000, 8090, 445, 8080])
})

test('行视图模型: 地址/状态/统计一次派生, 供列表与菜单共用', () => {
  const logic = loadLogic(undefined)
  const location = { protocol: 'http:', hostname: '127.0.0.1', port: '3080', origin: 'http://127.0.0.1:3080' }
  const vm = logic.tunnelRowVM({ name: 'app', entry: 'path', targetPort: 3000, status: 'online', stats: { requests: 2, lastAccessAt: null } }, location, Date.now())
  assert.equal(vm.url, 'http://127.0.0.1:3080/p/app/')
  assert.equal(vm.status, 'online')
  assert.equal(vm.statusText, '在监听')
  assert.equal(vm.statsText, '本次运行 2 次')
  assert.equal(vm.localOnly, false)
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

// 底部状态条: 停用隧道不算开放; 摘要取最久的一条, 超过阈值标提醒。
test('状态条: 只统计已启用且运行期激活的隧道', () => {
  const logic = loadLogic(undefined)
  const rows = [
    { name: 'app', enabled: true },
    { name: 'off', enabled: false },
    { name: 'legacy' },
    { name: 'api', enabled: true, status: 'route_error', active: false },
  ]
  assert.deepEqual(logic.liveTunnels(rows).map((row) => row.name), ['app', 'legacy'])
  assert.deepEqual(logic.liveTunnels(undefined), [])
})

test('状态条: 开放时长文案按 秒/分钟/小时/天 收敛, 非法时间返回空', () => {
  const logic = loadLogic(undefined)
  const now = Date.parse('2026-11-17T12:00:00.000Z')
  const ago = (ms) => new Date(now - ms).toISOString()
  assert.equal(logic.openAgeText(now, ago(30 * 1000)), '不到 1 分钟')
  assert.equal(logic.openAgeText(now, ago(12 * 60 * 1000)), '12 分钟')
  assert.equal(logic.openAgeText(now, ago(3 * 60 * 60 * 1000)), '3 小时')
  assert.equal(logic.openAgeText(now, ago(25 * 60 * 60 * 1000)), '1 天')
  assert.equal(logic.openAgeText(now, ''), '')
  assert.equal(logic.openAgeText(now, 'not-a-date'), '')
})

test('状态条: 单条给名称与时长, 多条只报数量; 超过 24 小时标记 stale', () => {
  const logic = loadLogic(undefined)
  const now = Date.parse('2026-11-17T12:00:00.000Z')
  const at = (ms) => new Date(now - ms).toISOString()
  const single = logic.statusBarSummary([{ name: 'app', enabled: true, createdAt: at(12 * 60 * 1000) }], now)
  assert.equal(single.count, 1)
  assert.equal(single.headline, '隧道开放中')
  assert.equal(single.detail, 'app · 已开放 12 分钟')
  assert.equal(single.stale, false)
  const fresh = logic.statusBarSummary([{ name: 'app', enabled: true, createdAt: at(30 * 1000) }], now)
  assert.equal(fresh.detail, 'app · 已开放不到 1 分钟', '短时长不出现「已开放 不到」的空格断句')
  const many = [
    { name: 'app', enabled: true, createdAt: at(12 * 60 * 1000) },
    { name: 'api', enabled: true, createdAt: at(25 * 60 * 60 * 1000) },
  ]
  const summary = logic.statusBarSummary(many, now)
  assert.equal(summary.count, 2)
  assert.equal(summary.headline, '隧道 2 条运行中')
  assert.equal(summary.detail, '有隧道开放超过 24 小时', '多条只报数量, 但超时仍需提醒')
  assert.equal(summary.stale, true)
  assert.equal(logic.statusBarSummary([{ name: 'off', enabled: false }], now), null)
  assert.equal(logic.statusBarSummary([], now), null)
})

test('状态条: 行视图给出地址与超时标记', () => {
  const logic = loadLogic(undefined)
  const now = Date.parse('2026-11-17T12:00:00.000Z')
  const location = { protocol: 'http:', hostname: '127.0.0.1', port: '3080', origin: 'http://127.0.0.1:3080' }
  const fresh = logic.statusBarRowVM({ name: 'app', entry: 'path', createdAt: new Date(now - 60 * 1000).toISOString() }, now, location)
  assert.equal(fresh.url, 'http://127.0.0.1:3080/p/app/')
  assert.equal(fresh.openText, '已开放 1 分钟')
  assert.equal(fresh.stale, false)
  const justNow = logic.statusBarRowVM({ name: 'app', entry: 'path', createdAt: new Date(now - 30 * 1000).toISOString() }, now, location)
  assert.equal(justNow.openText, '已开放不到 1 分钟')
  const stale = logic.statusBarRowVM({ name: 'api', entry: 'path', createdAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() }, now, location)
  assert.equal(stale.stale, true)
  assert.equal(stale.openText, '已开放 1 天')
})

test('页面可见性判定: 仅 hidden 视为不可见', () => {
  const logic = loadLogic(undefined)
  assert.equal(logic.isPageVisible({ visibilityState: 'visible' }), true)
  assert.equal(logic.isPageVisible({ visibilityState: 'hidden' }), false)
  assert.equal(logic.isPageVisible(undefined), true, '无 document 环境按可见处理')
})
