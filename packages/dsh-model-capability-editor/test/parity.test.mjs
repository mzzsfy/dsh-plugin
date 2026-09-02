// parity 测试:client.js LOGIC 标记段与 src/logic.mjs 同源逻辑对照(think-expand 模式)。
// 覆盖档位四态映射、input 三态、合并主干与草稿分桶。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as logic from '../src/logic.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 从 client.js 提取标记段,构造同接口的纯逻辑实现。
function clientLogic() {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const begin = source.indexOf('/* LOGIC-BEGIN */')
  const end = source.indexOf('/* LOGIC-END */')
  assert.ok(begin >= 0 && end > begin, 'client.js 缺少逻辑标记段')
  const section = source.slice(begin + '/* LOGIC-BEGIN */'.length, end)
  const factory = new Function(
    section
      + '; return { EFFORT_LEVELS, OFF_LEVEL, COMPETITOR_MARKERS, effortsToDrafts, draftsToEfforts,'
      + ' inputToMode, modeToInput, applyDraft, mergeBaselineModels, detectCompetitorTraces,'
      + ' stashDrafts, restoreDrafts, isModelsTitle, anchorsBroken, resolveTargetId };',
  )
  return factory()
}

function defineScenarios(prefix, L) {
  const { effortsToDrafts, draftsToEfforts, inputToMode, modeToInput, applyDraft, mergeBaselineModels, stashDrafts, restoreDrafts, isModelsTitle, anchorsBroken, resolveTargetId } = L

  test(prefix + '目标模型解析:活动 ID 在基线用活动 ID,否则回落原 ID', () => {
    assert.equal(resolveTargetId('auto-v2', 'auto', new Set(['auto', 'auto-v2'])), 'auto-v2')
    assert.equal(resolveTargetId('auto-v2', 'auto', new Set(['auto'])), 'auto')
    assert.equal(resolveTargetId('', 'auto', new Set(['auto'])), 'auto')
  })

  test(prefix + '标题标记与锚点破坏判定', () => {
    assert.equal(isModelsTitle('模型'), true)
    assert.equal(isModelsTitle('Models'), true)
    assert.equal(isModelsTitle('模型能力'), false)
    assert.equal(anchorsBroken({ titleMatched: true, hasEditor: true, modelIdInputCount: 0 }), true)
    assert.equal(anchorsBroken({ titleMatched: true, hasEditor: true, modelIdInputCount: 1 }), false)
    assert.equal(anchorsBroken({ titleMatched: false, hasEditor: true, modelIdInputCount: 0 }), false)
  })

  test(prefix + '四态映射:未声明 / false / 对象含 null / 对象含拼写', () => {
    // 未声明 → 无勾选
    assert.deepEqual(effortsToDrafts(undefined), { checked: {}, spellings: {} })
    assert.deepEqual(effortsToDrafts(null), { checked: {}, spellings: {} })
    // false → 仅勾 off,拼写为空
    assert.deepEqual(effortsToDrafts(false), { checked: { off: true }, spellings: {} })
    // 对象 → 键勾选,null 拼写空,值转字符串
    assert.deepEqual(effortsToDrafts({ off: null, low: 'low-1' }), {
      checked: { off: true, low: true },
      spellings: { off: '', low: 'low-1' },
    })
  })

  test(prefix + '四态写回:删除字段 / false / 对象回写', () => {
    // 全不勾 → undefined(删除字段)
    assert.equal(draftsToEfforts({ checked: {}, spellings: {} }, { off: null }), undefined)
    // 仅勾 off 无拼写 → false
    assert.equal(draftsToEfforts({ checked: { off: true }, spellings: { off: '' } }, null), false)
    // 仅勾 off 有拼写 → 对象
    assert.deepEqual(draftsToEfforts({ checked: { off: true }, spellings: { off: '关闭' } }, null), { off: '关闭' })
    // 勾选档位无拼写 → 拼写回落档位名;词汇表外基线档位原样保留
    assert.deepEqual(
      draftsToEfforts({ checked: { low: true }, spellings: { low: '' } }, { custom: 'keep' }),
      { custom: 'keep', low: 'low' },
    )
  })

  test(prefix + 'input 三态映射', () => {
    assert.equal(inputToMode(undefined), 'unset')
    assert.equal(inputToMode([]), 'unset')
    assert.equal(inputToMode(['text']), 'text')
    assert.equal(inputToMode(['text', 'image']), 'text-image')
    assert.deepEqual(modeToInput('text'), ['text'])
    assert.deepEqual(modeToInput('text-image'), ['text', 'image'])
    assert.equal(modeToInput('unset'), undefined)
  })

  test(prefix + '合并:有草稿条目重写两字段,其余原样保留', () => {
    const draft = {
      checked: { high: true },
      spellings: { high: '' },
      baselineEfforts: undefined,
      inputMode: 'text',
    }
    const baseline = [
      { id: 'm1', name: '模型一', reasoningEfforts: { off: null }, input: ['text', 'image'] },
      { id: 'm2', name: '模型二' },
    ]
    const drafts = new Map([['m1', draft]])
    const merged = mergeBaselineModels(baseline, drafts)
    // m1:reasoningEfforts 按 off 档位外勾选重写,input 收窄为 text
    assert.deepEqual(merged[0].reasoningEfforts, { high: 'high' })
    assert.deepEqual(merged[0].input, ['text'])
    assert.equal(merged[0].name, '模型一')
    // m2 无草稿原样保留
    assert.deepEqual(merged[1], baseline[1])
  })

  test(prefix + '草稿分桶:切换不丢弃,切回恢复,null 路由不存', () => {
    const buckets = new Map()
    const draftsA = new Map([['m1', { checked: { off: true }, spellings: {}, baselineEfforts: false, inputMode: 'text' }]])
    const draftsB = new Map()
    stashDrafts(buckets, 'provider-a', draftsA)
    stashDrafts(buckets, 'provider-b', draftsB)
    assert.equal(restoreDrafts(buckets, 'provider-c'), null)
    stashDrafts(buckets, null, draftsA)
    assert.equal(buckets.has(null), false)
    assert.equal(restoreDrafts(buckets, 'provider-a'), draftsA)
    assert.equal(restoreDrafts(buckets, 'provider-b'), draftsB)
  })
}

defineScenarios('[logic.mjs] ', logic)
defineScenarios('[client.js] ', clientLogic())

test('client.js 语法可被 node 解析', () => {
  execFileSync(process.execPath, ['--check', join(PKG_ROOT, 'src', 'client.js')])
})

// wire 适配段双副本守卫:client.js 中 LOGIC 段外的 unwrapWire/makeSettingsFace
// 与 logic.mjs 导出必须逐字符一致(单文件格式无法 require,靠此测试防漂移)。
test('client.js wire 适配段与 logic.mjs 同源', () => {
  const sectionOf = (source, label) => {
    const begin = source.indexOf('// 宿主 wire 信封')
    const end = source.indexOf('async function describeNs')
    assert.ok(begin >= 0 && end > begin, label + ' 缺少 wire 适配段')
    return source.slice(begin, end).replace(/^export function/gm, 'function').trim()
  }
  const client = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const logic = readFileSync(join(PKG_ROOT, 'src', 'logic.mjs'), 'utf8')
  assert.equal(sectionOf(client, 'client.js'), sectionOf(logic, 'logic.mjs'))
})
