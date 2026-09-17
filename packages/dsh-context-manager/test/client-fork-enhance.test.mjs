import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

// F2 进行中轮分叉 的客户端契约(源码切片锁定,与既有 fork 契约测试同构):
// - 进行中轮条目在 loadTurnEnds 映射中以 seq:null + open:true 登记
// - 注入资格的锚点查找跳过 open 轮(锚必须是闭合轮 turn/end)
// - 分叉 resolve 后,open 轮触发 cancelSession 停原会话,闭合轮不触发

test('源码契约:进行中轮登记为 open 且无闭合锚', () => {
  const slice = CLIENT_SRC.slice(CLIENT_SRC.indexOf('const map = new Map()'), CLIENT_SRC.indexOf('return map'))
  assert.ok(slice.includes("map.set(turn, { seq: null, text: turnText, open: true })"), '流末尾无 turn/end 的轮应登记 seq:null + open:true')
  assert.ok(slice.includes("map.set(turn, { seq: event.seq, text: turnText, open: false })"), '闭合轮应登记 open:false')
})

test('源码契约:分叉锚点查找只接受闭合轮(seq 非 null)', () => {
  assert.ok(CLIENT_SRC.includes('candidate && candidate.seq !== null'), '锚点查找必须跳过进行中轮(null seq)')
})

test('源码契约:进行中轮分叉后停原会话,闭合轮分叉不停', () => {
  const click = CLIENT_SRC.slice(CLIENT_SRC.indexOf('forkSessionFn({ sessionId: current.sessionId'), CLIENT_SRC.indexOf(".catch((error) => {\n              const code = error && error.code"))
  assert.ok(click.includes('currentEntry.open === true'), 'cancel 应以 open 标记为条件')
  assert.ok(click.includes('cancelSessionFn({ sessionId: current.sessionId })'), 'open 轮分叉成功后应停原会话')
})

test('源码契约:进行中轮的按钮说明标注进行中语义', () => {
  assert.ok(CLIENT_SRC.includes("entry.open\n          ? '重写该轮(进行中)"), '按钮 title 应区分进行中轮')
})

// F3 分叉后自动重发 的客户端契约:
// - 开关经 fork-auto-resend-enabled 路由拉取,默认关
// - 点击登记的草稿带 autoSubmit(跟随开关)
// - 消费侧 autoSubmit 时经 prompt 通道提交,prompt 失败仅 toast
// - prompt 不可用(旧宿主)时 submitPrompt 为 null,自动降级仅回填

test('源码契约:自动重发开关经新路由拉取且默认关', () => {
  assert.ok(CLIENT_SRC.includes("api(FORK_AUTO_RESEND_URL)"), '应经 fork-auto-resend-enabled 拉开关')
  assert.ok(CLIENT_SRC.includes('setAutoResend(Boolean(payload && payload.enabled === true))'), '开关默认必须是关(严格 true 才开)')
})

test('源码契约:autoSubmit 草稿消费时回填后经 prompt 提交', () => {
  const consume = CLIENT_SRC.slice(CLIENT_SRC.indexOf('const draft = pendingForkDrafts.get(sessionId)'), CLIENT_SRC.indexOf('return h(ForkDock'))
  assert.ok(consume.includes('inputActions.setDraft(text)'), '回填必须先行(prompt 前,失败也有兜底文本)')
  assert.ok(consume.includes('submitRef.current({ sessionId, text })'), 'autoSubmit 时应经 prompt 通道提交')
  assert.ok(consume.includes("toast('自动重发失败"), 'prompt 失败应 toast 且文本保留')
})

test('源码契约:prompt 通道参数形态(requestId 幂等 + queue + text 段)', () => {
  assert.ok(CLIENT_SRC.includes('requestId: (typeof crypto'), 'prompt 请求应携带幂等 requestId')
  assert.ok(CLIENT_SRC.includes("content: [{ type: 'text', text }]"), 'prompt 内容应为 text 分段数组(宿主 hasPromptContent 校验形态)')
  assert.ok(CLIENT_SRC.includes("mode: 'queue'"), 'prompt 应带 mode=queue(无进行中轮即开跑)')
  assert.ok(CLIENT_SRC.includes('clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone'), 'prompt 应带本地时区(官方 client face 同形态)')
})

test('源码契约:旧宿主无 prompt 时通道降级为 null(仅回填)', () => {
  assert.ok(CLIENT_SRC.includes("(remoteSession && typeof remoteSession.prompt === 'function')"), 'prompt 通道应以能力探测守门(含面缺失)')
})
