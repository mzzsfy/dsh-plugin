// 历史文件持久化守卫 BDD:坏文件备份与写入拒绝、恢复解除损坏标记。真实 fs + 临时目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
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

test('场景: 写链毒化防护——单次写入失败不永久断写', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-panel-history-'))
  const file = join(dir, 'history.json')
  const writes = []
  try {
    const store = createHistoryStore({
      file,
      io: {
        mkdir: async () => {},
        readFile: async () => { const e = new Error('no'); e.code = 'ENOENT'; throw e },
        rename: async () => {},
        // 首次写失败(模拟瞬时 ENOSPC/占用),之后成功;写入内容记录供断言
        writeFile: (() => {
          let calls = 0
          return async (_file, text) => {
            calls += 1
            if (calls === 1) throw new Error('ENOSPC')
            writes.push(text)
          }
        })(),
      },
    })
    await store.ensure()
    store.sequences['a:balance'] = { granularity: '1h', points: [] }
    await assert.rejects(store.persist(), /ENOSPC/, '调用方感知单次失败')
    store.sequences['b:balance'] = { granularity: '1h', points: [] }
    await store.persist()
    // 后续写入不受毒化链影响,内容含两次写入的全部序列
    assert.equal(writes.length, 1)
    const saved = JSON.parse(writes[0])
    assert.ok(saved.sequences['a:balance'] && saved.sequences['b:balance'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('场景: 合法 JSON 但形状不符按损坏处理(备份 + 拒写)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-panel-history-'))
  const file = join(dir, 'history.json')
  try {
    await writeFile(file, '{"sequences":[]}', 'utf8')
    const store = createHistoryStore({ file })
    await store.ensure()
    assert.equal(store.broken, true, 'sequences 非对象必须按损坏处理')
    await assert.rejects(store.persist(), (error) => error.message === HISTORY_BROKEN_MESSAGE)
    assert.equal(await readFile(file + '.bak', 'utf8'), '{"sequences":[]}', '原始内容完整备份')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('场景: 序列条目缺少 points/granularity 按损坏处理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-panel-history-'))
  const file = join(dir, 'history.json')
  try {
    await writeFile(file, '{"sequences":{"acct-1:balance":{"granularity":"1h"}}}', 'utf8')
    const store = createHistoryStore({ file })
    await store.ensure()
    assert.equal(store.broken, true)
    await assert.rejects(store.persist(), (error) => error.message === HISTORY_BROKEN_MESSAGE)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('场景: 序列档位与键后缀不一致按损坏处理(注释与磁盘同口径)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-panel-history-'))
  const file = join(dir, 'history.json')
  const body = '{"sequences":{"acct-1:balance":{"granularity":"10m","points":[]}}}'
  try {
    // :balance 对应 1h;声明 10m 会让留存修剪按 7 天算,丢掉本应保留的 30 天余额点
    await writeFile(file, body, 'utf8')
    const store = createHistoryStore({ file })
    await store.ensure()
    assert.equal(store.broken, true, 'granularity 与键后缀不符必须按损坏处理')
    await assert.rejects(store.persist(), (error) => error.message === HISTORY_BROKEN_MESSAGE)
    assert.equal(await readFile(file + '.bak', 'utf8'), body, '原始内容完整备份,不覆盖')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('场景: 键后缀无对应档位(残缺键/未知档)按损坏处理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-panel-history-'))
  const file = join(dir, 'history.json')
  const cases = [
    ['缺档位后缀', { sequences: { 'acct-1': { granularity: '1h', points: [] } } }],
    ['未知档位', { sequences: { 'acct-1:nope': { granularity: '1h', points: [] } } }],
  ]
  try {
    for (const [label, payload] of cases) {
      await writeFile(file, JSON.stringify(payload), 'utf8')
      const store = createHistoryStore({ file })
      await store.ensure()
      assert.equal(store.broken, true, label + ' 必须按损坏处理')
      await rm(file + '.bak', { force: true })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('场景: 各档位合法声明正常加载(5h=10m,7d/month/balance=1h)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-panel-history-'))
  const file = join(dir, 'history.json')
  const body = JSON.stringify({
    sequences: {
      'acct-1:5h': { granularity: '10m', points: [{ t: 1, v: 2 }] },
      'acct-1:7d': { granularity: '1h', points: [] },
      'acct-1:month': { granularity: '1h', points: [] },
      'acct-1:balance': { granularity: '1h', points: [] },
    },
  })
  try {
    await writeFile(file, body, 'utf8')
    const store = createHistoryStore({ file })
    await store.ensure()
    assert.equal(store.broken, false)
    assert.deepEqual(Object.keys(store.sequences).sort(),
      ['acct-1:5h', 'acct-1:7d', 'acct-1:balance', 'acct-1:month'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('场景: 落盘为紧凑 JSON(无缩进)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-panel-history-'))
  const file = join(dir, 'history.json')
  try {
    const store = createHistoryStore({ file })
    await store.ensure()
    await store.persist()
    const text = await readFile(file, 'utf8')
    assert.equal(text, JSON.stringify({ sequences: {} }), '序列化无第三参缩进')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// P-D1:并发 ensure 此前会在读盘完成前就把 loaded 置真,第二个调用拿到空表并
// persist 出去(32MB 历史被空表覆盖且无 .bak);ensure 必须共享在途读盘
test('场景: 并发 ensure 共享在途读盘,不回退成空表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-panel-history-'))
  const file = join(dir, 'history.json')
  const body = JSON.stringify({ sequences: { 'acct-1:balance': { granularity: '1h', points: [{ t: 1, v: 2 }] } } })
  try {
    await writeFile(file, body, 'utf8')
    const store = createHistoryStore({
      file,
      io: {
        mkdir,
        // 读盘让出事件循环:第二个 ensure 会在第一个完成前发起
        readFile: async (target, encoding) => {
          await new Promise((resolve) => setTimeout(resolve, 20))
          return readFile(target, encoding)
        },
        rename,
        writeFile,
      },
    })
    const [first, second] = await Promise.all([store.ensure(), store.ensure()])
    assert.deepEqual(Object.keys(first), ['acct-1:balance'], '并发调用都必须拿到磁盘内容')
    assert.equal(second, first, '共享同一次读盘结果')
    // 随后落盘不得覆盖成空表
    await store.persist()
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).sequences, JSON.parse(body).sequences)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('场景: 落盘写失败时旧 history.json 保持完整(临时文件 + rename)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-panel-history-'))
  const file = join(dir, 'history.json')
  const body = JSON.stringify({ sequences: { 'acct-1:balance': { granularity: '1h', points: [{ t: 1, v: 2 }] } } })
  try {
    await writeFile(file, body, 'utf8')
    const store = createHistoryStore({
      file,
      io: {
        mkdir,
        readFile,
        rename,
        // 模拟写满:先截断目标文件再抛错(直接写 history.json 的实现会毁掉历史)
        writeFile: async (target, text) => {
          await writeFile(target, text.slice(0, 8), 'utf8')
          throw new Error('ENOSPC')
        },
      },
    })
    await store.ensure()
    store.sequences['acct-2:balance'] = { granularity: '1h', points: [] }
    await assert.rejects(store.persist(), /ENOSPC/)
    assert.equal(await readFile(file, 'utf8'), body, '写失败不得留下半截历史')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
