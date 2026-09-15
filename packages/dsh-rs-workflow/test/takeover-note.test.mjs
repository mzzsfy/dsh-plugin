// takeover 拦截的用户可见反馈单测:reject 前后必须向会话流写 user/message
// (data 为扁平原生形状;system/message 被 SystemPromptProjection 强占,
// 嵌套形状会使会话标题投影 data.source 读 undefined 崩溃——spawn 全链失败)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'takeover.mjs'), 'utf8')

test('拦截路径写 user/message(surfaceOp append)', () => {
	assert.ok(src.includes('agent.session.append("user/message"'), '必须用官方 user/message 通道(notice 投影)')
	assert.ok(!src.includes('agent.session.append("system/message"'), '禁止 system/message(SystemPromptProjection 会清洗)')
	assert.ok(src.includes('surfaceOp: "append"'), 'surface 事件必须声明 append 标记')
})

test('user/message data 为扁平原生形状(对齐 agent-loop 写入口径)', () => {
	const appendBody = src.slice(src.indexOf('agent.session.append("user/message"'), src.indexOf('surfaceOp: "append"'))
	assert.ok(!appendBody.includes('message: {'), 'data 禁止嵌套 message 包装(会话标题投影会崩)')
	assert.ok(!appendBody.includes('turn:') && !appendBody.includes('step:'), 'data 不带 turn/step(原生 user/message 无此字段)')
	assert.ok(appendBody.includes('role: "user"'), 'role 必须 user')
	assert.ok(appendBody.includes('kind: "plugin"') && appendBody.includes('form: "notice"'), 'source 必须是 plugin+notice 形态')
	assert.ok(appendBody.includes('summary: text.split("\\n")[0].slice(0, 120)'), 'summary 必须取首行且截断到 120 官方上限')
	assert.ok(appendBody.includes('content: [{ type: "text", text }]'), 'content 必须分段数组')
	assert.ok(appendBody.includes('id: randomUUID()'), 'message 必须带 id')
})

test('三个反馈位齐全:接管提示 / 在飞忽略 / 落定结果', () => {
	assert.ok(src.includes('若水编排已接管本请求'), '启动拦截必须有可见接管提示')
	assert.ok(src.includes('该消息已忽略'), '在飞拦截必须有可见忽略提示')
	assert.ok(src.includes('若水编排完成'), '完成必须回写会话流')
	assert.ok(src.includes('若水编排失败'), '失败必须回写会话流')
})

test('note 失败降级不阻断拦截(catch 包裹)', () => {
	const noteBody = src.slice(src.indexOf('function note('), src.indexOf('function note(') + 900)
	assert.ok(noteBody.includes('try {'), 'note 必须 try 包裹')
	assert.ok(noteBody.includes('} catch'), 'note 必须 catch 降级')
})

test('workflow/* 生命周期事件实时上报 runs.json(页签实时细节来源)', () => {
	for (const eventName of ['workflow/phase', 'workflow/log', 'workflow/agent-start', 'workflow/agent-end']) {
		assert.ok(src.includes(`trace("${eventName}"`), `必须监听 ${eventName}`)
	}
	assert.ok(src.includes('appendNode({ runId: String(info.id)'), '上报必须用事件 info.id 对位 store.runId')
	assert.ok(src.includes('.catch(() => {})'), '未接管 run 的上报失败必须静默弃')
})
