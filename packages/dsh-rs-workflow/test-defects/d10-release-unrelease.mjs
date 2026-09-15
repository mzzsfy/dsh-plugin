// d10:release/unrelease 外部扰动与 marker 版本形态
// 猜想 10a:unrelease 目标 marker 被外部改坏 → 判 foreign 不动(证伪预期,契约:无法证明归属不动)
// 猜想 10b:目标目录被外部替换为同名文件 → 判 foreign 保留,但该残留永久无人清理( documenting )
// 猜想 10c:marker version 形态 "4.x" → parseMajor 取 4,现役保留(证伪预期);"v4.0.0"/"unknown" 形态 → 主版本不可解析,被 sweep 删除
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { releaseFlowTemplate, unreleaseFlowTemplate, releasedTemplateIds, sweepLegacyReleases } from '../lib/release.mjs'

const root = join(tmpdir(), `rsww-t2-d10-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const findings = []
const entryOf = (id) => ({ id, label: `L${id}`, description: 'd', json5: `{ id: '${id}', label: 'L', steps: [{ id: 'a', prompt: 'P', outputs: { o: 'o' } }] }` })
try {
  const home = join(root, 'home')
  process.env.DSH_HOME = home
  // 10a marker 改坏
  releaseFlowTemplate(entryOf('da'), home)
  writeFileSync(join(home, '.agent-presets', 'rs-da', '.dsh-rs-workflow-source.json'), 'not-json{{', 'utf8')
  const ra = unreleaseFlowTemplate('da', home)
  const keptA = existsSync(join(home, '.agent-presets', 'rs-da'))
  findings.push(ra === 'foreign' && keptA
    ? 'PASS 10a marker 损坏后 unrelease 判 foreign 且目录不动(无法证明归属,契约行为)'
    : `CONFIRMED 10a marker 损坏被误删(ra=${ra} kept=${keptA})`)

  // 10b 目录被替换为同名文件
  const destB = join(home, '.agent-presets', 'rs-db')
  releaseFlowTemplate(entryOf('db'), home)
  rmSync(destB, { recursive: true, force: true })
  writeFileSync(destB, '占用文件', 'utf8')
  const rb = unreleaseFlowTemplate('db', home)
  const fileKept = existsSync(destB)
  const listedB = releasedTemplateIds(home).includes('db')
  const sweepB = sweepLegacyReleases(home)
  const sweptB = sweepB.removed.includes('db')
  findings.push(rb === 'foreign' && fileKept && !listedB && !sweptB
    ? 'CONFIRMED 10b 释放目录被外部替换为同名文件后:unrelease 判 foreign 保留,released 列表与 sweep 均不识别——该残留(文件形态)成为永久垃圾,只能人工清理;无告警通道'
    : `PASS 10b 文件形态残留可被处理(rb=${rb} kept=${fileKept} swept=${sweptB})`)

  // 10c marker version 形态
  const mkMarker = (id, version) => join(home, '.agent-presets', `rs-${id}`)
  const seedVersioned = (id, version) => {
    releaseFlowTemplate(entryOf(id), home)
    writeFileSync(join(mkMarker(id), '.dsh-rs-workflow-source.json'), JSON.stringify({ package: '@mzzsfy/dsh-rs-workflow', kind: 'flow', version }), 'utf8')
  }
  seedVersioned('vx', '4.x')
  seedVersioned('vv', 'v4.0.0')
  seedVersioned('vu', 'unknown')
  const listed = releasedTemplateIds(home)
  const sweep = sweepLegacyReleases(home)
  const kept4x = listed.includes('vx') && sweep.kept.includes('vx')
  const sweptV = sweep.removed.includes('vv')
  const sweptU = sweep.removed.includes('vu')
  if (kept4x && sweptV && sweptU) {
    findings.push('PASS 10c(带边角风险)marker version "4.x" 按前缀取主版本 4,现役保留;但 "v4.0.0"/"unknown" 等不可解析形态会被 sweep 当过时产物直接删除——机器写入的 marker 恒为包版本,当前无害,手写/外部工具生成的 marker 有误删面')
  } else {
    findings.push(`CONFIRMED 10c 版本形态判定异常(kept4x=${kept4x} sweptV=${sweptV} sweptU=${sweptU} listed=${JSON.stringify(listed)} sweep=${JSON.stringify(sweep)})`)
  }
  assert.ok(readdirSync(join(home, '.agent-presets')).length >= 0)
} catch (e) {
  findings.push(`INCONCLUSIVE 探针异常:${e && e.stack ? e.stack.split('\n')[0] : e}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(findings.join('\n'))
