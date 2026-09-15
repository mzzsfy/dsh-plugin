// d1:store 索引损伤与并发写交错
// 猜想 1a:index.json 整体损坏 → 重建一致(证伪预期)
// 猜想 1b:index.json 合法 JSON 但与 runs/ 文件集合发散(幽灵行+漏行)→ 无收敛机制
// 猜想 1c:同目录两个 store 实例交错写 index.json → 后写覆盖丢行
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createStore } from '../lib/store.mjs'

const root = join(tmpdir(), `rsww-t2-d1-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const findings = []
try {
  // 1a 整体损坏
  const dirA = join(root, 'a')
  mkdirSync(join(dirA, 'runs'), { recursive: true })
  const sa = createStore({ dir: dirA, keepRuns: 200 })
  sa.start({ runId: 'r-a1', request: 'x' })
  sa.finish({ runId: 'r-a1', status: 'completed', summary: 'ok' })
  writeFileSync(join(dirA, 'index.json'), '{corrupt!!', 'utf8')
  const sa2 = createStore({ dir: dirA, keepRuns: 200 })
  const listA = sa2.list()
  assert.equal(listA.length, 1)
  assert.equal(listA[0].runId, 'r-a1')
  const idxA = JSON.parse(readFileSync(join(dirA, 'index.json'), 'utf8'))
  assert.equal(idxA.runs.length, 1)
  findings.push('PASS 1a index.json 整体损坏后自动按 runs/ 重建,list 与文件集合一致')

  // 1b 合法 JSON 但内容发散:幽灵行 + 漏行
  const dirB = join(root, 'b')
  mkdirSync(join(dirB, 'runs'), { recursive: true })
  const sb = createStore({ dir: dirB, keepRuns: 200 })
  sb.start({ runId: 'r-b1', request: 'x' })
  sb.finish({ runId: 'r-b1', status: 'completed', summary: 'ok' })
  sb.start({ runId: 'r-b2', request: 'y' })
  sb.finish({ runId: 'r-b2', status: 'completed', summary: 'ok' })
  // 手工构造:索引含幽灵 r-ghost,漏掉 r-b2
  writeFileSync(join(dirB, 'index.json'), JSON.stringify({
    runs: [
      { runId: 'r-ghost', sessionId: '', workspace: '', templateId: '', status: 'completed', createdAt: '2020-01-01T00:00:00.000Z', finishedAt: '2020-01-01T00:00:01.000Z', summary: '', request: '' },
      sb.get('r-b1') && { runId: 'r-b1', sessionId: '', workspace: '', templateId: '', status: 'completed', createdAt: '2020-01-01T00:00:00.000Z', finishedAt: '2020-01-01T00:00:01.000Z', summary: 'ok', request: 'x' },
    ].filter(Boolean),
  }), 'utf8')
  const sb2 = createStore({ dir: dirB, keepRuns: 200 })
  const listB = sb2.list()
  const idsB = listB.map((e) => e.runId).sort()
  const ghostListed = idsB.includes('r-ghost')
  const missingReal = !idsB.includes('r-b2')
  const ghostGetThrows = (() => { try { sb2.get('r-ghost'); return false } catch { return true } })()
  const realGetWorks = sb2.get('r-b2').runId === 'r-b2'
  if (ghostListed && missingReal && ghostGetThrows && realGetWorks) {
    findings.push('CONFIRMED 1b 索引为合法 JSON 但与文件集合发散时无收敛:list 列出幽灵行(详情 404),磁盘存在的 run 不进 list(get 可用),发散永久保留')
  } else {
    findings.push(`PASS 1b 索引发散被收敛(ghostListed=${ghostListed} missingReal=${missingReal})`)
  }

  // 1c 双实例交错写
  const dirC = join(root, 'c')
  mkdirSync(join(dirC, 'runs'), { recursive: true })
  const c1 = createStore({ dir: dirC, keepRuns: 200 })
  const c2 = createStore({ dir: dirC, keepRuns: 200 })
  c1.start({ runId: 'r-c1', request: 'x' }); c1.finish({ runId: 'r-c1', status: 'completed', summary: '' })
  // c2 在 c1 写入 r-c1 之前加载(此处按时间线:先 c2 建实例,不触发加载;随后交错)
  c2.start({ runId: 'r-c2a', request: 'y' }); c2.finish({ runId: 'r-c2a', status: 'completed', summary: '' })
  c1.start({ runId: 'r-c2b', request: 'z' }); c1.finish({ runId: 'r-c2b', status: 'completed', summary: '' })
  c2.start({ runId: 'r-c3', request: 'w' }); c2.finish({ runId: 'r-c3', status: 'completed', summary: '' })
  const fresh = createStore({ dir: dirC, keepRuns: 200 })
  const diskIds = existsSync(join(dirC, 'runs')) ? fresh.list().map((e) => e.runId).sort() : []
  const lostRow = !diskIds.includes('r-c2b')
  if (lostRow) {
    findings.push('CONFIRMED 1c 同目录双 store 实例交错写 index.json 后写整文件覆盖:r-c2b 的行从索引丢失(文件仍在),全量重启后该 run 从 list 消失')
  } else {
    findings.push('PASS 1c 双实例交错未丢行')
  }
} catch (e) {
  findings.push(`INCONCLUSIVE 探针异常:${e && e.stack ? e.stack.split('\n')[0] : e}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(findings.join('\n'))
