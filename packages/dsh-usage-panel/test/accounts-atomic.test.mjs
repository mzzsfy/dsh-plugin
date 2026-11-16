// F1 回归:accounts.json 落盘必须原子。临时文件 + rename 保证写入被截断/写满/改名失败时
// 旧文件保持完整(直接 writeFile 会先截断目标,损坏守卫随后把坏文件备份并永久拒写,
// 账号 Key 全丢);临时名按实例唯一,多实例(HMR 换插件)不互相抢路径。
// 单元级用注入 io 制造故障,host 级验证真实落盘路径无残留临时文件且旧临时文件不干扰。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAtomicWriter } from '../src/atomicFile.mjs'

const PACKAGE_DIR = dirname(fileURLToPath(new URL('../src/index.js', import.meta.url)))
const OLD_BODY = JSON.stringify({ version: 1, accounts: [{ id: 'acct-old', key: 'sk-old-plaintext' }] })
const NEW_BODY = JSON.stringify({ version: 1, accounts: [{ id: 'acct-new', key: 'sk-new-plaintext' }] })

async function tempFileOf(name) {
  const dir = await mkdtemp(join(tmpdir(), 'usage-panel-atomic-'))
  return { dir, file: join(dir, name) }
}

test('场景: 成功落盘经临时文件再改名,目标内容为最新且目录不留临时文件', async () => {
  const { dir, file } = await tempFileOf('accounts.json')
  const io = {
    writeFile: async (target, text, encoding) => {
      // 目标文件此刻必须尚未被创建:直接写目标的实现会在此刻就有目标文件
      assert.match(target, /\.tmp\.[a-z0-9]+$/, '写入必须落在临时文件上')
      await writeFile(target, text, encoding)
    },
    rename,
  }
  try {
    await createAtomicWriter(file, io)(NEW_BODY)
    assert.equal(await readFile(file, 'utf8'), NEW_BODY)
    assert.deepEqual((await readdir(dir)).filter((name) => name.includes('.tmp.')), [], '临时文件必须已被改名消耗')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('场景: 成功替换保留目标原 mode', async () => {
  const { dir, file } = await tempFileOf('accounts.json')
  try {
    await writeFile(file, OLD_BODY, { encoding: 'utf8', mode: 0o600 })
    const before = (await stat(file)).mode & 0o777
    await createAtomicWriter(file)(NEW_BODY)
    assert.equal(await readFile(file, 'utf8'), NEW_BODY)
    assert.equal((await stat(file)).mode & 0o777, before, 'rename 不得把目标权限换成进程默认值')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('场景: 写入中途失败(写满)时旧文件完整保留,不留半截配置', async () => {
  const { dir, file } = await tempFileOf('accounts.json')
  const io = {
    // 模拟写满:先落一部分内容再抛错(直接写目标的实现会毁掉旧文件)
    writeFile: async (target, text, encoding) => {
      await writeFile(target, text.slice(0, 8), encoding)
      throw new Error('ENOSPC')
    },
    rename,
  }
  try {
    await writeFile(file, OLD_BODY, 'utf8')
    await assert.rejects(createAtomicWriter(file, io)(NEW_BODY), /ENOSPC/)
    assert.equal(await readFile(file, 'utf8'), OLD_BODY, '旧文件必须保持完整')
    assert.deepEqual((await readdir(dir)).filter((name) => name.includes('.tmp.')), [], '写入失败必须删除含明文 Key 的临时文件')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('场景: 改名失败(占用/权限)时旧文件完整保留,且后续重试可成功', async () => {
  const { dir, file } = await tempFileOf('accounts.json')
  const failing = {
    writeFile,
    rename: async () => {
      const error = new Error('EPERM: operation not permitted')
      error.code = 'EPERM'
      throw error
    },
  }
  try {
    await writeFile(file, OLD_BODY, 'utf8')
    await assert.rejects(createAtomicWriter(file, failing)(NEW_BODY), /EPERM/)
    assert.equal(await readFile(file, 'utf8'), OLD_BODY, '改名失败不得把半截临时文件留在目标位置')
    assert.deepEqual((await readdir(dir)).filter((name) => name.includes('.tmp.')), [], '改名失败必须删除含明文 Key 的临时文件')
    // 换一次实例重试(等价下一次保存):旧临时文件不阻塞新写入
    await createAtomicWriter(file)(NEW_BODY)
    assert.equal(await readFile(file, 'utf8'), NEW_BODY)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('场景: 临时名按实例唯一且与目标同目录(rename 不跨卷)', async () => {
  const { dir, file } = await tempFileOf('accounts.json')
  const seen = []
  const io = {
    writeFile: async (target) => { seen.push(target) },
    rename: async () => {},
  }
  try {
    const first = createAtomicWriter(file, io)
    const second = createAtomicWriter(file, io)
    await first(NEW_BODY)
    await second(NEW_BODY)
    assert.notEqual(seen[0], seen[1], '两实例临时名不得相同(否则互相抢 rename)')
    for (const target of seen) {
      assert.equal(dirname(target), dirname(file), '临时文件必须与目标同目录')
      assert.notEqual(target, file, '不得直接写目标')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// host 级:env 注入数据目录须在 import src/index.js 之前设置
const dataDir = await mkdtemp(join(tmpdir(), 'usage-panel-atomic-host-'))
process.env.DSH_USAGE_PANEL_DATA_DIR = dataDir
const { apply } = await import('../src/index.js')

after(async () => {
  delete process.env.DSH_USAGE_PANEL_DATA_DIR
  await rm(dataDir, { recursive: true, force: true })
})

function makeCtx() {
  const routes = new Map()
  const settings = { register() {}, get: () => ({ notify: { enabled: false } }), update: async () => {} }
  const ctx = {
    get: (name) => (name === 'settings' ? settings : undefined),
    effect: (fn) => { fn() },
    inject: (_deps, fn) => fn({ settings, interval: () => {} }),
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
      },
    },
  }
  return { ctx, routes }
}

async function saveAccounts(routes, accounts) {
  const { EventEmitter } = await import('node:events')
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { host: 'localhost:3000', 'content-type': 'application/json' }
  const body = JSON.stringify({ accounts })
  process.nextTick(() => {
    req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => { res.payload = text ? JSON.parse(text) : null }
  await routes.get('/api/usage-panel/accounts')(req, res)
  return res
}

test('场景: host 保存后目标文件为完整 JSON,数据目录不留临时文件', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = await saveAccounts(routes, [{ id: 'acct-host', name: '主机账号', type: 'deepseek', apiKey: 'sk-host' }])
  assert.equal(res.status, 200)
  const saved = JSON.parse(await readFile(join(dataDir, 'accounts.json'), 'utf8'))
  assert.deepEqual(saved.accounts.map((item) => item.id), ['acct-host'])
  const leftovers = (await readdir(dataDir)).filter((name) => name.startsWith('accounts.json.tmp.'))
  assert.deepEqual(leftovers, [], '改名成功后不得残留临时文件')
})

test('场景: 目录里已有旧崩溃留下的临时文件时保存照常成功,旧临时文件不被当成目标', async () => {
  const stale = join(dataDir, 'accounts.json.tmp.deadbeef')
  await writeFile(stale, '半截临时内容', 'utf8')
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = await saveAccounts(routes, [{ id: 'acct-stale', name: '旧临时', type: 'kimi', apiKey: 'sk-stale' }])
  assert.equal(res.status, 200)
  assert.equal(await readFile(stale, 'utf8'), '半截临时内容', '别人的临时文件不得被改名成目标')
  const saved = JSON.parse(await readFile(join(dataDir, 'accounts.json'), 'utf8'))
  assert.equal(saved.accounts.some((item) => item.id === 'acct-stale'), true)
  await rm(stale, { force: true })
})

// 接线守卫:持久化必须走原子写模块,防回退成直接写目标文件
test('场景: persistConfig 接线原子写,不再直接 writeFile(DATA_FILE)', () => {
  const source = readFileSync(join(PACKAGE_DIR, 'index.js'), 'utf8')
  assert.match(source, /createAtomicWriter\(DATA_FILE\)/, '缺少原子写实例')
  assert.doesNotMatch(source, /writeFile\(DATA_FILE/, '不得直接写目标文件')
})
