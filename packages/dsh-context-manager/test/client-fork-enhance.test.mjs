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
// - 消费侧 autoSubmit 时经 prompt 通道提交,提交即无草稿(官方发送语义:发送后输入框
//   不残留原文,残留会诱导用户再次发送造成重复消息);prompt 失败才回填文本供手动重发
// - prompt 不可用(旧宿主)时 submitPrompt 为 null,自动降级仅回填

test('源码契约:自动重发开关经新路由拉取且默认关', () => {
  assert.ok(CLIENT_SRC.includes("api(FORK_AUTO_RESEND_URL)"), '应经 fork-auto-resend-enabled 拉开关')
  assert.ok(CLIENT_SRC.includes('setAutoResend(Boolean(payload && payload.enabled === true))'), '开关默认必须是关(严格 true 才开)')
})

test('源码契约:autoSubmit 消费即提交不留草稿,失败才回填', () => {
  const consume = CLIENT_SRC.slice(CLIENT_SRC.indexOf('const draft = pendingForkDrafts.get(sessionId)'), CLIENT_SRC.indexOf('return h(ForkDock'))
  const autoIdx = consume.indexOf('if (autoSubmit && submitRef.current)')
  assert.ok(autoIdx >= 0, 'autoSubmit 且通道可用时应走提交分支')
  const draftIdx = consume.indexOf('inputActions.setDraft(text)')
  assert.ok(draftIdx > autoIdx, '回填不得先于 prompt(提交成功路径输入框必须无残留)')
  const autoBranch = consume.slice(autoIdx)
  assert.ok(autoBranch.includes('submitRef.current({ sessionId, text })'), 'autoSubmit 时应经 prompt 通道提交')
  assert.ok(autoBranch.includes("toast('自动重发失败"), 'prompt 失败应 toast 提示')
  assert.ok(autoBranch.indexOf('setDraft(text)') > autoBranch.indexOf('catch'), '失败兜底回填必须落在 catch 分支内')
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

// F4 回填不得覆盖用户输入 的客户端契约(实测 bug:点分叉后 200ms 内用户输入被 setDraft 吞掉;
// 且消费删除草稿后 effect 依赖变化再跑一次,取到 undefined 走进 setDraft("") 空写清空输入框):
// - 消费即删草稿后,该会话必须标记为「已消费」,effect 重跑直接短路,绝不空写
// - 回填走单次投递:非空输入框不覆盖(用户已输入优先),改为 toast 提示

test('源码契约:草稿消费后不得再对同会话写草稿(杜绝空写清空)', () => {
  const consume = CLIENT_SRC.slice(CLIENT_SRC.indexOf('const draft = pendingForkDrafts.get(sessionId)'), CLIENT_SRC.indexOf('return h(ForkDock'))
  const guardIdx = CLIENT_SRC.indexOf('consumedForkDrafts.has(sessionId)')
  const addIdx = CLIENT_SRC.indexOf('consumedForkDrafts.add(sessionId)')
  assert.ok(guardIdx >= 0, '消费后应经 consumedForkDrafts 短路重跑')
  assert.ok(addIdx >= 0, '删除草稿的同时应登记已消费')
  assert.ok(guardIdx < addIdx, '短路判断必须先于登记(登记发生在有草稿分支内)')
  assert.ok(guardIdx < CLIENT_SRC.indexOf('const draft = pendingForkDrafts.get(sessionId)'), '短路必须先于取草稿')
  assert.ok(consume.includes('consumedForkDrafts.add(sessionId)'), '登记应落在消费分支内')
})

test('源码契约:回填前经 useInput 快照探测输入框,非空不覆盖', () => {
  const consume = CLIENT_SRC.slice(CLIENT_SRC.indexOf('const draft = pendingForkDrafts.get(sessionId)'), CLIENT_SRC.indexOf('return h(ForkDock'))
  assert.ok(consume.includes('draftOccupied'), '应经 useInput 快照判定输入框是否已被用户占用')
  assert.ok(consume.includes('原输入未回填'), '被占用时应 toast 说明未回填')
  assert.ok(consume.includes('原输入未自动发送'), '自动重发被占用时应 toast 说明未发送')
  assert.ok(consume.indexOf('draftOccupied') < consume.indexOf('inputActions.setDraft(text)'), '占用探测必须先于回填')
})

test('源码契约:fork dock 订阅官方 input 快照取草稿', () => {
  assert.ok(CLIENT_SRC.includes('useInput'), 'dock 应订阅宿主注入的 useInput 快照')
})
