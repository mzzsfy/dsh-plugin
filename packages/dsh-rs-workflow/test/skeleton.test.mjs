// skeleton BDD(node --test):骨架单一源(skeletonRows)与目录形态载体
// (agent.cordis.yml)经 emitRows 逐字节对拍,防两形态漂移
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEMPLATE_ANCHOR, emitRows, skeletonRows } from '../lib/skeleton.mjs'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKELETON_YML = join(PKG_ROOT, 'preset', 'rs-workflow', 'agent.cordis.yml')

test('Given 规范化骨架 When emitRows Then 与 agent.cordis.yml 正文逐字节一致(首行生成声明除外)', () => {
  const content = readFileSync(SKELETON_YML, 'utf8')
  const lines = content.split('\n')
  assert.match(lines[0], /^# 由 lib\/skeleton\.mjs/)
  assert.equal(lines.slice(1).join('\n'), emitRows(skeletonRows(TEMPLATE_ANCHOR)))
})

test('Given templateId When skeletonRows Then 恰一 orchestrator 行承载该 id 且无锚串残留', () => {
  const rows = skeletonRows('novel')
  assert.ok(!JSON.stringify(rows).includes(TEMPLATE_ANCHOR))
  const children = rows.flatMap((row) => Array.isArray(row.config) ? row.config : [])
  const orchestrators = children.filter((child) => child.id === 'rs-workflow-orchestrator')
  assert.equal(orchestrators.length, 1)
  assert.deepEqual(orchestrators[0].config, { role: 'orchestrator', templateId: 'novel' })
})

test('Given 顶层行集 When skeletonRows Then 行 id 序固定(目录形态产物同源)', () => {
  const rows = skeletonRows(TEMPLATE_ANCHOR)
  assert.deepEqual(rows.map((row) => row.id), [
    'persona', 'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search',
    'tool-jobs', 'skill-filesystem', 'tool-skill', 'tool-web', 'compaction', 'delegation',
    'tool-ask-user', 'tool-todo',
  ])
})

test('Given 条件禁用行 When skeletonRows Then disabled 为 __jsExpr 形态', () => {
  const rows = skeletonRows(TEMPLATE_ANCHOR)
  const toolBash = rows.find((row) => row.id === 'tool-bash')
  const toolPwsh = rows.find((row) => row.id === 'tool-pwsh')
  assert.deepEqual(toolBash.disabled, { __jsExpr: 'process.platform === \'win32\'' })
  assert.deepEqual(toolPwsh.disabled, { __jsExpr: 'process.platform !== \'win32\'' })
})

test('Given 非法 templateId When skeletonRows Then 拒绝', () => {
  assert.throws(() => skeletonRows(''), /骨架 templateId 非法/)
  assert.throws(() => skeletonRows(undefined), /骨架 templateId 非法/)
})

test('Given 骨架行集 When 校验模板变量 Then 只引用宿主注册变量', () => {
  // 宿主渲染期严格校验 prompt 模板且仅注册 provider/model,未知变量使会话补全即失败
  const registered = ['provider', 'model']
  const templates = []
  const walk = (value) => {
    if (typeof value === 'string') templates.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(skeletonRows(TEMPLATE_ANCHOR))
  for (const template of templates) {
    for (const m of template.matchAll(/\{\{(\w+)\}\}/g)) {
      assert.ok(registered.includes(m[1]), `模板引用未注册变量 ${m[1]}`)
    }
  }
})
