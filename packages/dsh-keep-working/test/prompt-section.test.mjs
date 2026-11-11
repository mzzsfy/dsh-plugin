import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROMPT_TEXT, SECTION_NAME, buildSection } from '../src/index.js'

/** 宿主文件引用段的真实位置,取自 dsh-system-prompt 的 SECTION_ORDERS。 */
const FILE_REFERENCE_ORDER = 900

const systemPrompt = { getSectionOrder: () => FILE_REFERENCE_ORDER }

test('结案段落排在文件引用建议之后', () => {
  const section = buildSection(systemPrompt)
  assert.equal(section.name, SECTION_NAME)
  assert.ok(section.order > FILE_REFERENCE_ORDER, '结案规则必须压在被覆盖的建议之后')
})

test('结案段落保留显式提交要求', () => {
  for (const marker of ['(TASK_DONE)', '(TASK_BLOCKED: 原因)', 'present']) {
    assert.ok(PROMPT_TEXT.includes(marker), `缺少 ${marker}`)
  }
})

test('结案段落声明 present 时机不受文件引用建议约束', () => {
  assert.ok(PROMPT_TEXT.includes('present 的时机以本段为准'))
})
