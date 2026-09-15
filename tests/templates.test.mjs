// 仓库级内置模板测试:七份 flows 与 template-v4 校验契约
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { validateTemplate, validateTemplateSet } from '../packages/dsh-rs-workflow/lib/template-v4.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pkgDir = join(repoRoot, 'packages', 'dsh-rs-workflow')
const JSON5 = createRequire(join(pkgDir, 'package.json'))('json5')

const FLOW_IDS = ['default', 'news', 'novel', 'lite', 'plan-final', 'step-review', 'multi-plan']
const MIN_STEPS = 3
const MAX_STEPS = 6

const templates = new Map(FLOW_IDS.map((id) => [id, JSON5.parse(readFileSync(join(pkgDir, 'flows', `${id}.json5`), 'utf8'))]))

const placeholdersOf = (text) => [...String(text).matchAll(/\{([^{}]+)\}/g)].map((m) => m[1])
const stepById = (t, id) => t.steps.find((s) => s.id === id)
// 升级出口:approve 步 onExhausted 指向的步骤(与校验器 escalate-only 语义一致)
const escalateExitsOf = (t) => t.steps.filter((s) => s.type === 'approve' && typeof s.onExhausted === 'string' && s.onExhausted !== 'blocked')
const ancestorsOf = (t, id) => {
  const acc = new Set()
  const walk = (cur) => {
    for (const dep of Array.isArray(stepById(t, cur)?.after) ? stepById(t, cur).after : []) {
      if (!acc.has(dep)) { acc.add(dep); walk(dep) }
    }
  }
  walk(id)
  return acc
}

test('Given 七份模板 When validateTemplate 逐份 Then 全部零错误', () => {
  for (const id of FLOW_IDS) {
    const errors = validateTemplate(templates.get(id))
    assert.deepEqual(errors, [], `${id} 校验错误:${JSON.stringify(errors)}`)
  }
})

test('Given 七份模板 When validateTemplateSet Then 零错误', () => {
  assert.deepEqual(validateTemplateSet([...templates.values()]), [])
})

test('Given step-review When 审批结构断言 Then review 审批契约齐备且 escalate 仅审批耗尽触发', () => {
  const t = templates.get('step-review')
  const review = stepById(t, 'review')
  assert.equal(review.type, 'approve')
  assert.equal(review.rounds, 2)
  assert.equal(review.onExhausted, 'escalate')
  const escalate = stepById(t, 'escalate')
  assert.equal(escalate.after, undefined, '升级步不可声明 after')
  for (const s of t.steps) assert.ok(!Array.isArray(s.after) || !s.after.includes('escalate'), `步骤 ${s.id} after 引用升级步`)
  assert.ok(placeholdersOf(escalate.prompt).every((ph) => !ph.startsWith('execute.')), '升级步 prompt 引用审批对象 execute 产出')
})

test('Given novel When inputs 断言 Then chapterCount 已声明且 write-chapter 为顺序循环', () => {
  const t = templates.get('novel')
  assert.ok(Object.hasOwn(t.inputs, 'chapterCount'))
  const writeChapter = stepById(t, 'write-chapter')
  assert.equal(writeChapter.for_each, 'outline.chapters')
  assert.equal(writeChapter.mode, 'sequential')
})

test('Given multi-plan When 分诊结构断言 Then run 动态路由携带 brief 且 deliver 在 run 之后', () => {
  const t = templates.get('multi-plan')
  const run = stepById(t, 'run')
  assert.equal(run.type, 'flow')
  assert.equal(run.flow, '{triage.route}')
  assert.equal(run.input.brief, '{triage.brief}')
  assert.deepEqual(stepById(t, 'deliver').after, ['run'])
})

test('Given default When 审批结构断言 Then review 耗尽即 blocked 且审批对象为 execute', () => {
  const review = stepById(templates.get('default'), 'review')
  assert.equal(review.onExhausted, 'blocked')
  assert.equal(review.target, 'execute')
})

test('Given 每份模板 When 步骤数断言 Then 步骤数在 3~6 之间', () => {
  for (const id of FLOW_IDS) {
    const count = templates.get(id).steps.length
    assert.ok(count >= MIN_STEPS && count <= MAX_STEPS, `${id} 步骤数 ${count} 越界`)
  }
})

test('Given lite 与 default 的升级出口 When 占位符抽查 Then 升级步只引用审批对象上游产出', () => {
  for (const id of ['lite', 'default']) {
    const t = templates.get(id)
    for (const approve of escalateExitsOf(t)) {
      const escalate = stepById(t, approve.onExhausted)
      const upstream = ancestorsOf(t, approve.target)
      for (const ph of placeholdersOf(escalate.prompt)) {
        if (ph === 'request' || ph.startsWith('input.') || ph === 'item' || ph === 'item.index') continue
        const refId = ph.slice(0, ph.indexOf('.'))
        assert.ok(upstream.has(refId), `${id} 升级步占位符 {${ph}} 非审批对象 ${approve.target} 上游产出`)
      }
    }
  }
})
