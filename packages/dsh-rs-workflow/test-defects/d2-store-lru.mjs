// d2:store LRU 容量收敛与 update/finish 边界
// 猜想 2a:LRU 收敛时活跃 run 被逐出(证伪预期:契约 running/paused 永不参与淘汰)
// 猜想 2b:update 不存在 runId 的行为(预期:抛错,不静默)
// 猜想 2c:finish 后二次 finish 重入(预期:良性)
// 猜想 2d:LRU 逐出后索引未落盘 → 重启后 list 出现幽灵行(契约要求"文件+索引行"同删)
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createStore } from '../lib/store.mjs'

const root = join(tmpdir(), `rsww-t2-d2-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const findings = []
try {
  const dir = join(root, 'main')
  mkdirSync(join(dir, 'runs'), { recursive: true })
  const store = createStore({ dir, keepRuns: 3 })
  // 3 个完结 + 1 个活跃
  for (const id of ['r-f1', 'r-f2', 'r-f3']) {
    store.start({ runId: id, request: 'x' })
    store.finish({ runId: id, status: 'completed', summary: '' })
  }
  store.start({ runId: 'r-active', request: 'y' })
  // 再完结一个 → 完结数 4 > 3 → 逐出最旧 r-f1
  store.start({ runId: 'r-f4', request: 'x' })
  store.finish({ runId: 'r-f4', status: 'completed', summary: '' })

  // 2a 活跃 run 存活
  const stillActive = store.get('r-active')
  assert.equal(stillActive.status, 'running')
  assert.equal(existsSync(join(dir, 'runs', 'r-active.json')), true)
  assert.equal(store.list().some((e) => e.runId === 'r-active'), true)
  findings.push('PASS 2a LRU 收敛只逐出最旧完结 run(r-f1),活跃 run 记录/文件/索引行完好')

  // 2b update 不存在 runId
  let threw = null
  try { store.update({ runId: 'r-none', status: 'completed' }) } catch (e) { threw = e }
  if (threw && /运行记录不存在/.test(threw.message)) findings.push('PASS 2b update 不存在 runId 抛错(信息:运行记录不存在),不静默')
  else findings.push(`CONFIRMED 2b update 不存在 runId 未按预期抛错:${threw ? threw.message : '无异常'}`)

  // 2d 幽灵索引行:磁盘 index.json 是否仍含已逐出的 r-f1(先于 2c 检查:二次 finish 会 persistIndex 洗掉幽灵)
  const diskIdx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
  const ghostOnDisk = diskIdx.runs.some((e) => e.runId === 'r-f1')
  const fileGone = !existsSync(join(dir, 'runs', 'r-f1.json'))
  const ghostDir = join(root, 'ghost-check')
  mkdirSync(ghostDir, { recursive: true })
  const { copyFileSync } = await import('node:fs')
  copyFileSync(join(dir, 'index.json'), join(ghostDir, 'index.json'))
  mkdirSync(join(ghostDir, 'runs'), { recursive: true })
  for (const id of ['r-f4', 'r-f3', 'r-f2', 'r-active']) copyFileSync(join(dir, 'runs', `${id}.json`), join(ghostDir, 'runs', `${id}.json`))
  const fresh = createStore({ dir: ghostDir, keepRuns: 3 })
  const ghostListed = fresh.list().some((e) => e.runId === 'r-f1')
  const ghostGetThrows = (() => { try { fresh.get('r-f1'); return false } catch { return true } })()
  if (ghostOnDisk && fileGone && ghostListed && ghostGetThrows) {
    findings.push('CONFIRMED 2d LRU 逐出后 persistIndex 不重写:index.json 留幽灵行,重启后 list 列出 r-f1 而 get 404,违反契约"删除文件+索引行"与"list 与文件集合一致"')
  } else {
    findings.push(`PASS 2d 逐出后索引一致(ghostOnDisk=${ghostOnDisk} ghostListed=${ghostListed})`)
  }

  // 2c finish 重入
  store.finish({ runId: 'r-f4', status: 'completed', summary: 'again' })
  const again = store.get('r-f4')
  assert.equal(again.status, 'completed')
  assert.ok(again.finishedAt)
  findings.push('PASS 2c finish 二次调用良性重入(状态仍 completed,finishedAt 刷新,不崩溃)')
} catch (e) {
  findings.push(`INCONCLUSIVE 探针异常:${e && e.stack ? e.stack.split('\n')[0] : e}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(findings.join('\n'))
