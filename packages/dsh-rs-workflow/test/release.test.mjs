// release BDD(node --test,v5):全场景临时目录,经参数传 dshHome;锚定=orchestrator 行 templateId(组合名承载)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  flowPresetDest,
  presetRoot,
  releaseFlowTemplate,
  unreleaseFlowTemplate,
  releasedTemplateIds,
} from '../lib/release.mjs'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_VERSION = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version
const PACKAGE_NAME = '@mzzsfy/dsh-rs-workflow'
const MARKER_NAME = '.dsh-rs-workflow-source.json'
const FLOW_FILE = 'flow.json'
const PRESET_YML = 'preset.yml'
const AGENT_YAML = 'agent.cordis.yml'
const PRESET_DIR = '.agent-presets'
const RS_PREFIX = 'rs-'
const KIND_FLOW = 'flow'
const KIND_COLLAB = 'collab'
const FOREIGN_PACKAGE = '@other/pkg'
const LEGACY_VERSION = '0.3.0'
const TEMPLATE_ANCHOR = 'TPL_ANCHOR'
const FLOW_MARKER = (version) => ({ package: PACKAGE_NAME, kind: KIND_FLOW, version })

const ENTRY = {
  id: 'novel',
  label: '小说',
  description: '小说创作流程\n从大纲到成稿的编排',
  json: JSON.stringify({ id: 'novel', label: '小说', description: '小说创作流程', steps: [{ id: 'a', prompt: '{request}', outputs: { o: 'o' } }] }),
}

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'rsww-release-test-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

const flowDirOf = (home, id) => join(home, PRESET_DIR, RS_PREFIX + id)

function putFile(home, id, name, content) {
  mkdirSync(flowDirOf(home, id), { recursive: true })
  writeFileSync(join(flowDirOf(home, id), name), content, 'utf8')
}

const writeMarker = (home, id, marker) => putFile(home, id, MARKER_NAME, JSON.stringify(marker, null, 2) + '\n')

const readMarkerOf = (home, id) => JSON.parse(readFileSync(join(flowDirOf(home, id), MARKER_NAME), 'utf8'))

test('Given 显式 dshHome When 求预设根与创建目标 Then 返回 .agent-presets 下 rs- 前缀路径', (t) => {
  const home = tempHome(t)
  assert.equal(presetRoot(home), join(home, PRESET_DIR))
  assert.equal(flowPresetDest('novel', home), join(home, PRESET_DIR, RS_PREFIX + 'novel'))
})

// 锚定守卫:包内 preset/rs-workflow/agent.cordis.yml 的 templateId 锚定串必须恰一处
test('Given 包内主组合骨架 When 检查 templateId 锚定串 Then 恰出现一处(骨架单源守卫)', () => {
  const skeleton = readFileSync(join(PKG_ROOT, 'preset', 'rs-workflow', AGENT_YAML), 'utf8')
  assert.equal(skeleton.split(TEMPLATE_ANCHOR).length - 1, 1)
  // 双实现同源:骨架含 orchestrator 与 template-tool 行,无 takeover/flowFile(v5 形态)
  assert.ok(skeleton.includes('role: orchestrator'))
  assert.ok(skeleton.includes('role: template-tool'))
  assert.equal(skeleton.includes('role: takeover'), false)
  assert.equal(skeleton.includes('flowFile'), false)
})


test('Given 合法模板 entry When releaseFlowTemplate Then created 且四文件产物符合契约', (t) => {
  const home = tempHome(t)
  assert.equal(releaseFlowTemplate(ENTRY, home), 'created')
  const dir = flowDirOf(home, 'novel')
  for (const name of [FLOW_FILE, PRESET_YML, AGENT_YAML, MARKER_NAME]) {
    assert.equal(existsSync(join(dir, name)), true, `缺少产物 ${name}`)
  }
  assert.equal(readFileSync(join(dir, FLOW_FILE), 'utf8'), ENTRY.json)
  // v5 锚定:orchestrator 行 templateId=组合承载的模板 id;无 flowFile 锚定
  const agent = readFileSync(join(dir, AGENT_YAML), 'utf8')
  assert.ok(agent.includes('templateId: novel'))
  assert.ok(!agent.includes('TPL_ANCHOR'))
  assert.ok(!agent.includes('flowFile'))
  assert.ok(agent.includes('role: orchestrator'))
  assert.ok(agent.includes('prefix: |-'))
  assert.ok(agent.includes('suffix: '))
  const marker = readMarkerOf(home, 'novel')
  assert.deepEqual(Object.keys(marker).sort(), ['kind', 'package', 'version'])
  assert.equal(marker.package, PACKAGE_NAME)
  assert.equal(marker.kind, KIND_FLOW)
  assert.equal(marker.version, PKG_VERSION)
  const preset = readFileSync(join(dir, PRESET_YML), 'utf8')
  assert.ok(preset.includes(`name: "若水·${ENTRY.label}"`))
  assert.ok(preset.includes('description: >-'))
  assert.ok(preset.includes('小说创作流程 从大纲到成稿的编排'))
})

test('Given 已创建 When 同 entry 再 release Then updated;改 label 再 release Then agent 等价且 preset.yml name 更新', (t) => {
  const home = tempHome(t)
  releaseFlowTemplate(ENTRY, home)
  const dir = flowDirOf(home, 'novel')
  const agentV1 = readFileSync(join(dir, AGENT_YAML), 'utf8')
  assert.equal(releaseFlowTemplate(ENTRY, home), 'updated')
  assert.equal(readFileSync(join(dir, AGENT_YAML), 'utf8'), agentV1)
  assert.equal(releaseFlowTemplate({ ...ENTRY, label: '小说家' }, home), 'updated')
  assert.ok(readFileSync(join(dir, PRESET_YML), 'utf8').includes('name: "若水·小说家"'))
  assert.equal(readFileSync(join(dir, AGENT_YAML), 'utf8'), agentV1)
})

test('Given 非法 id 或坏模板 When release Then throw 且校验错误逐条 target:message', (t) => {
  const home = tempHome(t)
  assert.throws(() => releaseFlowTemplate({ ...ENTRY, id: 'Bad_Id' }, home), /流程 id 非法/)
  const brokenNoOutputs = JSON.stringify({ id: 'novel', label: '小说', steps: [{ id: 'a', prompt: '{request}' }] })
  assert.throws(() => releaseFlowTemplate({ ...ENTRY, json: brokenNoOutputs }, home), (error) => {
    return error.message.includes('模板校验失败') && error.message.includes('step:a:')
  })
  assert.throws(() => releaseFlowTemplate({ ...ENTRY, json: '{ id:' }, home), /模板 JSON 解析失败/)
})

test('Given 目标目录被外来 marker 占用 When release Then throw 且原目录未动', (t) => {
  const home = tempHome(t)
  putFile(home, 'novel', 'user-file.txt', 'foreign data')
  writeMarker(home, 'novel', { package: FOREIGN_PACKAGE, kind: KIND_FLOW, version: PKG_VERSION })
  assert.throws(() => releaseFlowTemplate(ENTRY, home), /目标目录归属他人,拒绝覆盖/)
  assert.equal(readFileSync(join(flowDirOf(home, 'novel'), 'user-file.txt'), 'utf8'), 'foreign data')
  assert.equal(readMarkerOf(home, 'novel').package, FOREIGN_PACKAGE)
})

test('Given 目标目录存在但 marker 缺失 When release Then throw 归属防线', (t) => {
  const home = tempHome(t)
  putFile(home, 'novel', 'user-file.txt', 'no marker')
  assert.throws(() => releaseFlowTemplate(ENTRY, home), /目标目录归属他人,拒绝覆盖/)
  assert.equal(readFileSync(join(flowDirOf(home, 'novel'), 'user-file.txt'), 'utf8'), 'no marker')
})

test('Given 已创建 When unrelease Then removed 且目录消失;再 unrelease Then missing;外来目录 Then foreign 不删', (t) => {
  const home = tempHome(t)
  releaseFlowTemplate(ENTRY, home)
  assert.equal(unreleaseFlowTemplate('novel', home), 'removed')
  assert.equal(existsSync(flowDirOf(home, 'novel')), false)
  assert.equal(unreleaseFlowTemplate('novel', home), 'missing')
  writeMarker(home, 'other', { package: FOREIGN_PACKAGE, kind: KIND_FLOW, version: PKG_VERSION })
  assert.equal(unreleaseFlowTemplate('other', home), 'foreign')
  assert.equal(existsSync(flowDirOf(home, 'other')), true)
})

test('Given rs-default 与 rs-novel 均本包 flow、rs-collab 为 collab When releasedTemplateIds Then 仅返回两个 flow id', (t) => {
  const home = tempHome(t)
  writeMarker(home, 'default', FLOW_MARKER(PKG_VERSION))
  writeMarker(home, 'novel', FLOW_MARKER(PKG_VERSION))
  writeMarker(home, 'collab', { package: PACKAGE_NAME, kind: KIND_COLLAB, version: PKG_VERSION })
  assert.deepEqual(releasedTemplateIds(home).sort(), ['default', 'novel'])
})

