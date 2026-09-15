// d3:store v3 runs.json 归档
// 猜想 3a:归档幂等/重入(二次启动又见 runs.json → 再归档,内容不丢)
// 猜想 3b:归档目标已存在时直接删 legacy(契约原文"归档名已存在则跳过重命名直接删"——验证是否真丢数据)
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createStore } from '../lib/store.mjs'

const root = join(tmpdir(), `rsww-t2-d3-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const findings = []
const LEGACY = JSON.stringify({ runs: [{ runId: 'legacy-1', status: 'completed', request: '旧数据' }] })
try {
  // 3a 正常归档 + 重入
  const dirA = join(root, 'a')
  mkdirSync(dirA, { recursive: true })
  writeFileSync(join(dirA, 'runs.json'), LEGACY, 'utf8')
  createStore({ dir: dirA }).list()
  assert.equal(existsSync(join(dirA, 'runs.json')), false)
  const archives1 = readdirSync(dirA).filter((n) => n.startsWith('runs.json.archived-'))
  assert.equal(archives1.length, 1)
  assert.equal(readFileSync(join(dirA, archives1[0]), 'utf8'), LEGACY)
  // 重入:v3 复活再次写 runs.json,二次启动再归档
  writeFileSync(join(dirA, 'runs.json'), LEGACY, 'utf8')
  createStore({ dir: dirA }).list()
  const archives2 = readdirSync(dirA).filter((n) => n.startsWith('runs.json.archived-'))
  assert.equal(archives2.length, 2)
  findings.push('PASS 3a v3 runs.json 启动即归档改名,重入(二次启动再遇 runs.json)再次归档,两份归档内容完好不丢')

  // 3b 归档目标已存在:冻结时钟使 archive 路径可预测,预置同名目录
  const dirB = join(root, 'b')
  mkdirSync(dirB, { recursive: true })
  writeFileSync(join(dirB, 'runs.json'), LEGACY, 'utf8')
  const realNow = Date.now
  const frozen = realNow()
  Date.now = () => frozen
  try {
    mkdirSync(join(dirB, `runs.json.archived-${frozen}`), { recursive: true })
    const sb = createStore({ dir: dirB })
    const listB = sb.list()
    const legacyStillExists = existsSync(join(dirB, 'runs.json'))
    if (!legacyStillExists) {
      const archives = readdirSync(dirB).filter((n) => n.startsWith('runs.json.archived-'))
      const legacyContentAnywhere = archives.some((n) => {
        const p = join(dirB, n)
        try { return readFileSync(p, 'utf8') === LEGACY } catch { return false }
      })
      findings.push(legacyContentAnywhere
        ? 'PASS 3b 归档目标已存在时 legacy 数据仍在某归档中,未丢失'
        : 'CONFIRMED 3b 归档目标已存在时走 rmSync 分支:v3 legacy runs.json 被直接删除且未留任何归档副本(数据销毁;契约原文如此,实现与契约一致,属设计性数据销毁)')
    } else {
      findings.push('PASS 3b 归档目标已存在时 legacy 保留')
    }
    assert.deepEqual(listB, [])
  } finally {
    Date.now = realNow
  }
} catch (e) {
  findings.push(`INCONCLUSIVE 探针异常:${e && e.stack ? e.stack.split('\n')[0] : e}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(findings.join('\n'))
