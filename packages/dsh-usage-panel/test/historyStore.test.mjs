// 历史文件持久化守卫 BDD:坏文件备份与写入拒绝、恢复解除损坏标记。真实 fs + 临时目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHistoryStore, HISTORY_BROKEN_MESSAGE } from '../src/historyStore.mjs'

test('场景: 坏 JSON 注入触发落盘保护,坏文件备份为 .bak 且 persist 拒绝写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-panel-history-'))
  const file = join(dir, 'history.json')
  try {
    await writeFile(file, '{broken json', 'utf8')
    const store = createHistoryStore({ file })
    await store.ensure()
    assert.equal(store.broken, true)
    await assert.rejects(store.persist(), (error) => error.message === HISTORY_BROKEN_MESSAGE)
    const backup = await readFile(file + '.bak', 'utf8')
    assert.equal(backup, '{broken json', '坏文件完整保留在备份中')
    await assert.rejects(readFile(file, 'utf8'), (error) => error.code === 'ENOENT', '原坏文件已被移走')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('场景: 备份后重读成功解除损坏标记,写入恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-panel-history-'))
  const file = join(dir, 'history.json')
  try {
    await writeFile(file, 'not json', 'utf8')
    const store = createHistoryStore({ file })
    await store.ensure()
    assert.equal(store.broken, true)
    await store.ensure()
    assert.equal(store.broken, false, '坏文件已备份,重读 ENOENT 视为恢复')
    store.sequences['acct-1:balance'] = { granularity: '1h', points: [] }
    await store.persist()
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.ok(saved.sequences['acct-1:balance'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('场景: 文件不存在视为首次使用,不标记损坏', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-panel-history-'))
  const file = join(dir, 'history.json')
  try {
    const store = createHistoryStore({ file })
    await store.ensure()
    assert.equal(store.broken, false)
    await store.persist()
    assert.ok(JSON.parse(await readFile(file, 'utf8')).sequences)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
