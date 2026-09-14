// takeover pre-step 消息文本提取的单测:双形态 content(纯串/分段数组)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 提取函数与 registerTakeover 内联,无法直接导入;这里用源码形态断言 + 手工复刻驱动引擎测试兜底。
// 直接复刻 handler 的提取语义做行为验证,并用源码字符串锚定实现一致性(parity 思路)。
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'takeover.mjs'), 'utf8')

function extractText(messages) {
	return (messages || [])
		.map((m) => {
			if (!m) return ""
			if (typeof m.content === "string") return m.content.trim()
			if (Array.isArray(m.content)) {
				return m.content
					.map((part) => (part && typeof part.text === "string" ? part.text : ""))
					.filter(Boolean)
					.join("\n")
					.trim()
			}
			return ""
		})
		.filter(Boolean)
		.join("\n")
}

test('纯字符串 content 提取', () => {
	assert.equal(extractText([{ content: "hello" }]), "hello")
})

test('分段数组 content 提取(宿主实际形态)', () => {
	const msg = { content: [{ type: "text", text: "【若水流程验证】创建文件" }] }
	assert.equal(extractText([msg]), "【若水流程验证】创建文件")
})

test('数组形态混入非 text 段不炸', () => {
	const msg = { content: [{ type: "image", url: "x" }, { type: "text", text: "带图任务" }] }
	assert.equal(extractText([msg]), "带图任务")
})

test('空 content 数组 -> 空串 -> next() 放行路径', () => {
	assert.equal(extractText([{ content: [] }]), "")
})

test('实现一致性:takeover.mjs 使用同一提取语义(分段数组分支存在)', () => {
	assert.ok(src.includes('Array.isArray(m.content)'), 'takeover.mjs 必须处理分段数组形态')
	assert.ok(src.includes('typeof m.content === "string"'), 'takeover.mjs 必须处理字符串形态')
	assert.ok(src.includes('part.text'), 'takeover.mjs 必须取 text 段')
})
