// 内置流程模板(novel/news/default)单测:定义合法、默认值接线、释放产物闭环
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import JSON5 from 'json5'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FLOWS_DIR = join(PKG_ROOT, 'flows')

const { validateFlow, parseFlowJson5 } = await import('../lib/flows.mjs')
const { builtinTemplates } = await import('../lib/builtin-templates.mjs')
const { SETTINGS_SCHEMA, releaseFlowTemplate, unreleaseFlowTemplate } = await import('../lib/index.js')

test('U1 三份内置模板 JSON5 解析 + validateFlow 零错误', () => {
	const files = readdirSync(FLOWS_DIR).filter((f) => f.endsWith('.json5')).sort()
	assert.deepEqual(files, ['default.json5', 'news.json5', 'novel.json5'])
	for (const file of files) {
		const flow = JSON5.parse(readFileSync(join(FLOWS_DIR, file), 'utf8'))
		assert.deepEqual(validateFlow(flow), [], `${file} 校验失败`)
	}
})

test('U2 文件名与 flow.id 一致', () => {
	for (const file of readdirSync(FLOWS_DIR).filter((f) => f.endsWith('.json5'))) {
		const flow = JSON5.parse(readFileSync(join(FLOWS_DIR, file), 'utf8'))
		assert.equal(flow.id, file.replace('.json5', ''))
		assert.match(flow.id, /^[a-z][a-z0-9-]*$/)
	}
})

test('U3 settings 默认 templates 恰含三个内置 id', () => {
	const value = SETTINGS_SCHEMA({})
	const ids = (value.templates || []).map((t) => t.id).sort()
	assert.deepEqual(ids, ['default', 'news', 'novel'])
	for (const entry of value.templates) {
		assert.equal(entry.enabled, true)
		assert.ok(entry.json5.includes(`id: "${entry.id}"`), `${entry.id} 的 json5 应内嵌定义全文`)
	}
})

test('U4 builtinTemplates() 与 flows/ 目录一致(往返同源)', () => {
	const items = builtinTemplates().sort((a, b) => a.id.localeCompare(b.id))
	assert.deepEqual(items.map((t) => t.id), ['default', 'news', 'novel'])
	for (const item of items) {
		const errors = validateFlow(JSON5.parse(item.json5))
		assert.deepEqual(errors, [], `${item.id} 经 builtinTemplates 后仍须合法`)
	}
})

test('U5 释放三模板到临时 home:产物四件齐全 + marker.kind=flow', async () => {
	process.env.DSH_HOME = join(tmpdir(), `rsww-builtin-test-${Date.now()}`)
	const { discoverFlowRegistry } = await import('../lib/takeover.mjs')
	try {
		for (const item of builtinTemplates()) {
			const outcome = releaseFlowTemplate(item)
			assert.equal(outcome, 'created', `${item.id} 首次释放应为 created`)
			const dest = join(process.env.DSH_HOME, '.agent-presets', 'rs-' + item.id)
			for (const file of ['flow.json5', 'preset.yml', 'agent.cordis.yml', '.dsh-rs-workflow-source.json']) {
				assert.ok(existsSync(join(dest, file)), `${dest} 缺 ${file}`)
			}
			const marker = JSON.parse(readFileSync(join(dest, '.dsh-rs-workflow-source.json'), 'utf8'))
			assert.equal(marker.kind, 'flow')
			assert.equal(marker.package, '@mzzsfy/dsh-rs-workflow')
		}
		test('U6 discoverFlowRegistry 可发现三个释放模式', () => {
			const registry = discoverFlowRegistry(process.env.DSH_HOME)
			for (const id of ['default', 'news', 'novel']) {
				assert.ok(registry[id], `注册表缺少 ${id}`)
				assert.equal(registry[id].id, id)
			}
		})
	} finally {
		for (const id of ['default', 'news', 'novel']) unreleaseFlowTemplate(id)
		delete process.env.DSH_HOME
	}
})

test('U7 释放产物中的 flow.json5 与源定义往返一致', async () => {
	process.env.DSH_HOME = join(tmpdir(), `rsww-builtin-rt-${Date.now()}`)
	try {
		for (const item of builtinTemplates()) {
			releaseFlowTemplate(item)
			const dest = join(process.env.DSH_HOME, '.agent-presets', 'rs-' + item.id)
			const released = JSON5.parse(readFileSync(join(dest, 'flow.json5'), 'utf8'))
			const source = JSON5.parse(item.json5)
			assert.deepEqual(released, source, `${item.id} 释放后定义应与源一致`)
		}
	} finally {
		for (const id of ['default', 'news', 'novel']) unreleaseFlowTemplate(id)
		delete process.env.DSH_HOME
	}
})

test('U8 模板占位符引用自洽(prompt 引用的产出均有来源)', () => {
	for (const item of builtinTemplates()) {
		const flow = parseFlowJson5(item.json5)
		const byId = new Map(flow.steps.map((s) => [s.id, s]))
		for (const step of flow.steps) {
			const refs = [...(step.prompt || '').matchAll(/\{([a-zA-Z0-9_.-]+)\}/g)].map((m) => m[1])
			for (const ref of refs) {
				const [head, second] = ref.split('.')
				const valid = head === 'request' || head === 'input' || head === 'item'
					|| (byId.has(head) && byId.get(head).outputs && second && byId.get(head).outputs[second] !== undefined)
				assert.ok(valid, `[${flow.id}] 步骤 ${step.id} 引用 {%${ref}%} 无来源`)
			}
		}
	}
})
