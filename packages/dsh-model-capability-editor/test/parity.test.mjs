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
      + '; return { NS, CONFLICT_CODE, EFFORT_LEVELS, OFF_LEVEL, INPUT_UNSET, INPUT_TEXT, INPUT_TEXT_IMAGE,'
      + ' COMPETITOR_MARKERS, effortsToDrafts, draftsToEfforts, isExpressibleEfforts, inputToMode, modeToInput,'
      + ' applyDraft, mergeBaselineModels, detectCompetitorTraces, stashDrafts, restoreDrafts, isModelsTitle,'
      + ' anchorsBroken, resolveTargetId, unwrapResult, unwrapWire, makeSettingsFace, describeNs, modelsOf,'
      + ' writeModels, saveModels, draftsFromModels };',
  )
  return factory()
}

// 常量对拍:两副本共享常量各自字面量,漂移即失败(UI 渲染与写回判定直接消费这些值)
test('parity: 共享常量双副本一致', () => {
  const C = clientLogic()
  assert.deepEqual(C.EFFORT_LEVELS, logic.EFFORT_LEVELS)
  assert.equal(C.OFF_LEVEL, logic.OFF_LEVEL)
  assert.deepEqual(C.COMPETITOR_MARKERS, logic.COMPETITOR_MARKERS)
  assert.equal(C.NS, logic.NS)
  assert.equal(C.CONFLICT_CODE, logic.CONFLICT_CODE)
  assert.equal(C.INPUT_UNSET, logic.INPUT_UNSET)
  assert.equal(C.INPUT_TEXT, logic.INPUT_TEXT)
  assert.equal(C.INPUT_TEXT_IMAGE, logic.INPUT_TEXT_IMAGE)
})

function defineScenarios(prefix, L) {
  const { effortsToDrafts, draftsToEfforts, inputToMode, modeToInput, applyDraft, mergeBaselineModels, stashDrafts, restoreDrafts, isModelsTitle, anchorsBroken, resolveTargetId } = L

  test(prefix + '目标模型解析:改名落盘(原 id 消失)采信新 ID;撞名兄弟 id 回落原 ID', () => {
    assert.equal(resolveTargetId('auto-v2', 'auto', new Set(['auto-v2'])), 'auto-v2', '原 id 已从基线消失 = 改名已落盘')
    assert.equal(resolveTargetId('auto-v2', 'auto', new Set(['auto', 'auto-v2'])), 'auto', '原 id 仍在基线 = 撞名,回落')
    assert.equal(resolveTargetId('auto-v2', 'auto', new Set(['auto'])), 'auto')
    assert.equal(resolveTargetId('auto', 'auto', new Set(['auto'])), 'auto', '未改名零风险路径')
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

  test(prefix + '合并:有草稿条目重写两字段,其余原样保留;孤儿草稿可观测', () => {
    const draft = {
      checked: { high: true },
      spellings: { high: '' },
      inputMode: 'text',
    }
    const baseline = [
      { id: 'm1', name: '模型一', reasoningEfforts: { off: null }, input: ['text', 'image'] },
      { id: 'm2', name: '模型二' },
    ]
    const drafts = new Map([['m1', draft]])
    const { models: merged, droppedDraftIds } = mergeBaselineModels(baseline, drafts)
    // m1:reasoningEfforts 按 off 档位外勾选重写,input 收窄为 text
    assert.deepEqual(merged[0].reasoningEfforts, { high: 'high' })
    assert.deepEqual(merged[0].input, ['text'])
    assert.equal(merged[0].name, '模型一')
    // m2 无草稿原样保留
    assert.deepEqual(merged[1], baseline[1])
    assert.deepEqual(droppedDraftIds, [])
    // 草稿 id 不在基线:不落盘且可观测,不静默
    const orphan = mergeBaselineModels(baseline, new Map([['ghost', draft]]))
    assert.deepEqual(orphan.droppedDraftIds, ['ghost'])
    assert.deepEqual(orphan.models.map((model) => model.id), ['m1', 'm2'])
  })

  test(prefix + '基线不可表达形态(字符串/数组)跳过档位重写', () => {
    const { isExpressibleEfforts } = L
    const draft = { checked: { low: true }, spellings: {}, inputMode: 'unset' }
    assert.equal(isExpressibleEfforts('high'), false)
    assert.equal(isExpressibleEfforts(['low']), false)
    assert.equal(isExpressibleEfforts(undefined), true, '未声明必须可表达:添加档位是核心场景')
    assert.equal(isExpressibleEfforts(false), true)
    assert.equal(isExpressibleEfforts(null), true)
    assert.equal(isExpressibleEfforts({}), true)
    const weird = [{ id: 'x', reasoningEfforts: 'high', input: ['text'] }]
    const { models } = mergeBaselineModels(weird, new Map([['x', draft]]))
    assert.equal(models[0].reasoningEfforts, 'high')
    assert.equal('input' in models[0], false)
  })

  test(prefix + 'draftsFromModels: 种子投影与 id 键 String 归一', () => {
    const { draftsFromModels } = L
    const drafts = draftsFromModels([
      { id: 1, reasoningEfforts: { off: null }, input: ['text'] },
      { id: 'b', input: ['text', 'image'] },
    ])
    assert.deepEqual(drafts.get('1'), { checked: { off: true }, spellings: { off: '' }, inputMode: 'text' })
    assert.deepEqual(drafts.get('b'), { checked: {}, spellings: {}, inputMode: 'text-image' })
    assert.equal(drafts.get(1), undefined, '键一律字符串,与 DOM/UI 侧标识对齐')
  })

  test(prefix + '草稿分桶:切换不丢弃,切回恢复,null 路由不存', () => {
    const buckets = new Map()
    const draftsA = new Map([['m1', { checked: { off: true }, spellings: {}, inputMode: 'text' }]])
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

// 保存流双副本守卫:client.js 的 unwrapWire/makeSettingsFace/describeNs/modelsOf/
// writeModels/saveModels/draftsFromModels 全段与 logic.mjs 必须逐字符一致(单文件
// 格式无法 require,靠此测试防漂移;client 终点 LOGIC-END,logic 侧到文件尾)。
test('client.js wire 适配与保存流段与 logic.mjs 同源', () => {
  const sectionOf = (source, label) => {
    const begin = source.indexOf('// 宿主 wire 信封')
    assert.ok(begin >= 0, label + ' 缺少守卫段起点')
    // 终点:client 侧守卫段以 LOGIC-END 收束;logic 侧守卫段即文件尾
    const end = source.indexOf('/* LOGIC-END */')
    return (end > begin ? source.slice(begin, end) : source.slice(begin)).replace(/^export /gm, '').trim()
  }
  const client = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const logic = readFileSync(join(PKG_ROOT, 'src', 'logic.mjs'), 'utf8')
  assert.equal(sectionOf(client, 'client.js'), sectionOf(logic, 'logic.mjs'))
})
