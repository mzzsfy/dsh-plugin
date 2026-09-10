// logger 测试:日志文件按 logs/<jobId>/<runId>.log 落盘。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLogger } from '../src/logger.mjs'

async function makeLogger(t) {
  const root = await mkdtemp(join(tmpdir(), 'cron-board-logs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, logger: createLogger({ rootDir: root }) }
}

test('logger:追加后按任务按次读回,任务间目录隔离', async (t) => {
  // Given 两个任务各一次运行
  const { logger } = await makeLogger(t)
  // When 各写一行输出
  await logger.append('j1', 'r1', 'hello from j1\n')
  await logger.append('j2', 'r9', 'hello from j2\n')
  // Then 各自读回互不串
  assert.equal(await logger.read('j1', 'r1'), 'hello from j1\n')
  assert.equal(await logger.read('j2', 'r9'), 'hello from j2\n')
})

test('logger:tail 只读尾部 N 行', async (t) => {
  // Given 一个 5 行日志
  const { logger } = await makeLogger(t)
  await logger.append('j1', 'r1', 'l1\nl2\nl3\nl4\nl5\n')
  // When 读尾部 2 行
  const text = await logger.read('j1', 'r1', { tailLines: 2 })
  // Then 仅最后两行
  assert.equal(text, 'l4\nl5\n')
})

test('logger:不存在的日志读为空字符串', async (t) => {
  // Given 无任何日志
  const { logger } = await makeLogger(t)
  // When 读
  // Then 空串
  assert.equal(await logger.read('none', 'none'), '')
})

test('logger:清空单条日志后读回为空', async (t) => {
  // Given 已有日志
  const { logger } = await makeLogger(t)
  await logger.append('j1', 'r1', 'content\n')
  // When 清空
  await logger.clear('j1', 'r1')
  // Then 读回空
  assert.equal(await logger.read('j1', 'r1'), '')
})

test('logger:prune 按文件修改时间裁剪,字典序倒挂不误删(runId 为随机 UUID 与时间无关)', async (t) => {
  // Given 三份日志按时间序写入,名字典序与写入序刻意相反;写入间隔保证 mtime 可分
  const { logger } = await makeLogger(t)
  await logger.append('j1', 'z-oldest', 'z-oldest\n')
  await new Promise((resolve) => setTimeout(resolve, 20))
  await logger.append('j1', 'a-middle', 'a-middle\n')
  await new Promise((resolve) => setTimeout(resolve, 20))
  await logger.append('j1', 'm-newest', 'm-newest\n')
  // When 保留最新 2 份
  await logger.prune('j1', 2)
  // Then 最早写入的 z-oldest 被裁,名字典序最小的 a-middle 保留(旧字典序实现会反着删)
  assert.equal(await logger.read('j1', 'z-oldest'), '')
  assert.equal(await logger.read('j1', 'a-middle'), 'a-middle\n')
  assert.equal(await logger.read('j1', 'm-newest'), 'm-newest\n')
})

test('logger:超出保留数裁掉最旧日志文件', async (t) => {
  // Given 同任务 3 份日志,保留上限 2
  const { logger } = await makeLogger(t)
  for (const runId of ['r1', 'r2', 'r3']) {
    await logger.append('j1', runId, runId + '\n')
  }
  // When 写第 4 份触发裁剪
  await logger.append('j1', 'r4', 'r4\n')
  await logger.prune('j1', 2)
  // Then 最旧两份消失,最新两份保留
  assert.equal(await logger.read('j1', 'r1'), '')
  assert.equal(await logger.read('j1', 'r2'), '')
  assert.equal(await logger.read('j1', 'r3'), 'r3\n')
  assert.equal(await logger.read('j1', 'r4'), 'r4\n')
})

test('logger:删除任务连带删除整个日志目录', async (t) => {
  // Given 两任务各一份日志
  const { logger } = await makeLogger(t)
  await logger.append('j1', 'r1', 'a\n')
  await logger.append('j2', 'r1', 'b\n')
  // When 删除 j1
  await logger.removeJob('j1')
  // Then j1 目录消失,j2 不受影响
  assert.equal(await logger.read('j1', 'r1'), '')
  assert.equal(await logger.read('j2', 'r1'), 'b\n')
})
