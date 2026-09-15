// takeover 孤儿收敛单测:新编排启动前必须把遗留 running 记录落定,
// 防止进程重启后页签永久显示"运行中"(无监听主体的记录不可能再推进)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'takeover.mjs'), 'utf8')

test('孤儿收敛:启动新编排前 sweep 遗留 running 记录', () => {
	assert.ok(src.includes('await orphansSweep(store)'), 'startRun 必须先收敛孤儿运行')
	const sweepBody = src.slice(src.indexOf('async function orphansSweep('), src.indexOf('async function orphansSweep(') + 800)
	assert.ok(sweepBody.includes("run.status !== \"running\""), '只落定 running 记录')
	assert.ok(sweepBody.includes('编排被中断'), '落定摘要必须说明中断原因')
	assert.ok(sweepBody.includes('} catch {'), '收敛失败不阻断新编排')
})
