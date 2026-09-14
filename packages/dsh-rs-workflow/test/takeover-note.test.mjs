// takeover 拦截的用户可见反馈单测:reject 前后必须向会话流写 system/message
// (没有它被拦截会话在 GUI 完全空白——停止继续/历史浏览问题的根因)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'takeover.mjs'), 'utf8')

test('拦截路径写 system/message(surfaceOp append)', () => {
	assert.ok(src.includes('agent.session.append("system/message"'), '必须用官方 system/message 通道')
	assert.ok(src.includes('surfaceOp: "append"'), 'surface 事件必须声明 append 标记')
})

test('system/message 形态符合官方校验(plugin source + role + content 数组)', () => {
	assert.ok(src.includes('kind: "plugin", plugin: "@mzzsfy/dsh-rs-workflow"'), 'source 必须是 plugin 形态')
	assert.ok(src.includes('role: "system"'), 'role 必须 system')
	assert.ok(src.includes('content: [{ type: "text", text }]'), 'content 必须分段数组')
	assert.ok(src.includes('id: randomUUID()'), 'message 必须带 id')
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
