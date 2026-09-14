// preset-sync.mjs 单测:临时 DSH_HOME + 真实 fs,覆盖 collab 同步快慢路径与流程模板释放全部分支。
// 不改包内 preset 源:updated 路径统一以伪造 marker.fingerprint 触发。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { presetDest, flowPresetDest, removePreset, syncPreset, releaseFlowTemplate, unreleaseFlowTemplate } from '../lib/preset-sync.mjs'

const MARKER = '.dsh-rs-workflow-source.json'
const MANAGED = [
  'preset.yml',
  'agent.cordis.yml',
]

const NEWS_FLOW = `{
  id: "news", label: "新闻生产", description: "收集信息交叉核对后成稿",
  steps: [
    { id: "plan", prompt: "定计划", outputs: { keywords: "关键词" } },
    { id: "write", prompt: "成稿", outputs: { article: "稿件" } },
  ],
}`

/** 每用例独立假 home;DSH_HOME 的恢复放 finally,防 env 泄漏写真实 home */
function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'rs-workflow-sync-test-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    fn(home)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
}

const dest = () => presetDest()

test('首跑 created:产物齐全且 marker 记录归属与指纹', () => {
  withHome(() => {
    assert.equal(syncPreset(), 'created')
    for (const rel of MANAGED) assert.ok(existsSync(join(dest(), rel)), '缺 ' + rel)
    assert.ok(!existsSync(join(dest(), 'skills')), '技能目录形态已废弃')
    const marker = JSON.parse(readFileSync(join(dest(), MARKER), 'utf8'))
    assert.equal(marker.package, '@mzzsfy/dsh-rs-workflow')
    assert.equal(marker.kind, 'collab')
    assert.notEqual(marker.version, 'unknown')
    assert.ok(marker.fingerprint.length > 0)
  })
})

test('二跑 unchanged:哨兵存活,marker 字节不变', () => {
  withHome(() => {
    syncPreset()
    writeFileSync(join(dest(), '__sentinel__'), 'x')
    const before = readFileSync(join(dest(), MARKER))
    assert.equal(syncPreset(), 'unchanged')
    assert.ok(existsSync(join(dest(), '__sentinel__')), 'unchanged 不得触发 rewrite')
    assert.ok(readFileSync(join(dest(), MARKER)).equals(before))
  })
})

test('指纹失真走 updated:rewrite 后指纹归位', () => {
  withHome(() => {
    syncPreset()
    const markerPath = join(dest(), MARKER)
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    writeFileSync(markerPath, JSON.stringify({ ...marker, fingerprint: 'stale' }, null, 2) + '\n')
    assert.equal(syncPreset(), 'updated')
    assert.notEqual(JSON.parse(readFileSync(markerPath, 'utf8')).fingerprint, 'stale')
    assert.ok(JSON.parse(readFileSync(markerPath, 'utf8')).fingerprint.length > 0)
  })
})

test('marker.root 归属不同:unchanged 且 root 原地归位(双副本 root 交替不重写)', () => {
  withHome(() => {
    syncPreset()
    const markerPath = join(dest(), MARKER)
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    writeFileSync(markerPath, JSON.stringify({ ...marker, root: 'D:/other-root' }, null, 2) + '\n')
    assert.equal(syncPreset(), 'unchanged')
    assert.notEqual(JSON.parse(readFileSync(markerPath, 'utf8')).root, 'D:/other-root')
  })
})

test('残缺自愈:删任一受管文件触发 updated 补齐', () => {
  withHome(() => {
    syncPreset()
    rmSync(join(dest(), MANAGED[0]))
    assert.equal(syncPreset(), 'updated')
    assert.ok(existsSync(join(dest(), MANAGED[0])))
  })
})

test('外来目录(无 marker)skipped-foreign 且内容原样', () => {
  withHome(() => {
    mkdirSync(dest(), { recursive: true })
    writeFileSync(join(dest(), 'preset.yml'), '# user custom\n')
    assert.equal(syncPreset(), 'skipped-foreign')
    assert.equal(readFileSync(join(dest(), 'preset.yml'), 'utf8'), '# user custom\n')
  })
})

test('marker 损坏与归属他人同义:skipped-foreign', () => {
  withHome(() => {
    mkdirSync(dest(), { recursive: true })
    writeFileSync(join(dest(), MARKER), '{ broken json')
    assert.equal(syncPreset(), 'skipped-foreign')
  })
  withHome(() => {
    mkdirSync(dest(), { recursive: true })
    writeFileSync(join(dest(), MARKER), JSON.stringify({ package: 'someone/else' }))
    assert.equal(syncPreset(), 'skipped-foreign')
  })
})

test('staging/备份残留清理:前缀目录启动即删', () => {
  withHome(() => {
    const parent = join(process.env.DSH_HOME, '.agent-presets')
    mkdirSync(join(parent, '.rs-workflow-staging-abc', 'out'), { recursive: true })
    mkdirSync(join(parent, '.rs-workflow-old-123'), { recursive: true })
    syncPreset()
    assert.deepEqual(
      readdirSync(parent).filter((n) => n.startsWith('.rs-workflow-staging-') || n.startsWith('.rs-workflow-old-')),
      [],
      '残留应清空',
    )
  })
})

test('removePreset 三态:归属内删除/目录不存在/外来拒绝', () => {
  withHome(() => {
    assert.equal(removePreset(), 'missing', '目录不存在')
    syncPreset()
    assert.equal(removePreset(), 'removed')
    assert.ok(!existsSync(dest()))
    assert.equal(removePreset(), 'missing', '删除后再调')
  })
  withHome(() => {
    mkdirSync(dest(), { recursive: true })
    writeFileSync(join(dest(), 'preset.yml'), 'x')
    assert.equal(removePreset(), 'foreign', '外来目录拒绝删除')
    assert.ok(existsSync(dest()))
  })
})

// ── 流程模板释放 ──────────────────────────────────────────────────────────────

test('释放首跑 created:产物齐全,marker kind=flow;重释放 updated;撤下 removed', () => {
  withHome(() => {
    const entry = { id: 'news', label: '新闻生产', description: '收集成稿', json5: NEWS_FLOW }
    assert.equal(releaseFlowTemplate(entry), 'created')
    const flowDest = flowPresetDest('news')
    for (const rel of ['flow.json5', 'preset.yml', 'agent.cordis.yml', MARKER]) {
      assert.ok(existsSync(join(flowDest, rel)), '缺 ' + rel)
    }
    assert.ok(readFileSync(join(flowDest, 'flow.json5'), 'utf8').includes('id: "news"'), 'flow 定义原样落盘')
    const marker = JSON.parse(readFileSync(join(flowDest, MARKER), 'utf8'))
    assert.equal(marker.kind, 'flow')
    assert.equal(marker.flowId, 'news')
    assert.equal(marker.package, '@mzzsfy/dsh-rs-workflow')

    assert.equal(releaseFlowTemplate(entry), 'updated')
    assert.equal(unreleaseFlowTemplate('news'), 'removed')
    assert.ok(!existsSync(flowDest))
  })
})

test('释放校验:非法 id/非法定义/非法 JSON5 拒绝', () => {
  withHome(() => {
    assert.throws(() => releaseFlowTemplate({ id: 'Bad_ID', json5: NEWS_FLOW }), /流程 id 非法/)
    assert.throws(() => releaseFlowTemplate({ id: 'broken', json5: '{ id: "broken", steps: [] }' }), /校验失败/)
    assert.throws(() => releaseFlowTemplate({ id: 'broken', json5: '{ not json5:' }), /JSON5/)
    assert.equal(existsSync(join(flowPresetDest('broken'))), false, '拒绝后不落盘')
  })
})

test('释放所有权:外来同名目录拒绝覆盖;unrelease 三态', () => {
  withHome(() => {
    const foreign = flowPresetDest('news')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'preset.yml'), '# user custom\n')
    assert.throws(() => releaseFlowTemplate({ id: 'news', label: 'n', json5: NEWS_FLOW }), /归属他人/)
    assert.equal(unreleaseFlowTemplate('news'), 'foreign', '外来目录拒绝删除')
    assert.equal(unreleaseFlowTemplate('ghost'), 'missing')
  })
})

test('释放的组合含 takeover 行且锚定释放目录内 flow.json5', () => {
  withHome(() => {
    releaseFlowTemplate({ id: 'news', label: '新闻生产', description: 'd', json5: NEWS_FLOW })
    const yaml = readFileSync(join(flowPresetDest('news'), 'agent.cordis.yml'), 'utf8')
    assert.ok(yaml.includes('role: takeover'), 'takeover 行在组合内')
    assert.ok(yaml.includes("role: report"), 'report 行在组合内')
    assert.ok(yaml.includes("flowFile:"), 'flow.json5 经组合 baseUrl 锚定')
    assert.ok(yaml.includes('workflowEngine: true'), 'delegation 组 isolate workflowEngine')
  })
})

test('DSH_HOME 未设时回退 ~/.dsh(presetDest 路径断言)', () => {
  const saved = process.env.DSH_HOME
  delete process.env.DSH_HOME
  try {
    const p = presetDest()
    assert.ok(p.endsWith(join('.dsh', '.agent-presets', 'rs-workflow')), '实得 ' + p)
  } finally {
    if (saved !== undefined) process.env.DSH_HOME = saved
  }
})

test('空串 DSH_HOME 视同未设', () => {
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = '   '
  try {
    assert.ok(presetDest().endsWith(join('.dsh', '.agent-presets', 'rs-workflow')))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})
