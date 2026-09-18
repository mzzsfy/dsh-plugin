// BDD:保存随动纯判定逻辑——官方「保存」按钮判定、草稿编辑判定、随动快照分组、
// 补写就绪判定。编排(监听/武装/补写)由源码契约守卫覆盖(save-follow 末段)。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SAVE_BUTTON_LABELS,
  SAVE_BUTTON_BUSY_LABELS,
  isSaveButton,
  isSaveCommitButton,
  draftEdited,
  collectSaveFollowDrafts,
  saveFollowReady,
  saveFollowArms,
  saveFollowDismissible,
} from '../src/logic.mjs'

test('保存按钮判定:BUTTON 且文案精确为 保存/Apply', () => {
  assert.deepEqual(SAVE_BUTTON_LABELS, ['保存', 'Apply'])
  assert.equal(isSaveButton({ tagName: 'BUTTON', textContent: '保存' }), true)
  assert.equal(isSaveButton({ tagName: 'BUTTON', textContent: ' Apply ' }), true, '文案两侧空白容忍')
  assert.equal(isSaveButton({ tagName: 'BUTTON', textContent: 'Apply' }), true)
})

test('保存按钮判定:busy 态与其他元素/空值不命中', () => {
  assert.deepEqual(SAVE_BUTTON_BUSY_LABELS, ['保存中…', 'Applying…'])
  assert.equal(isSaveButton({ tagName: 'BUTTON', textContent: '保存中…' }), false)
  assert.equal(isSaveButton({ tagName: 'BUTTON', textContent: 'Applying…' }), false)
  assert.equal(isSaveButton({ tagName: 'BUTTON', textContent: '取消' }), false)
  assert.equal(isSaveButton({ tagName: 'BUTTON', textContent: '保存并继续' }), false, '非本卡文案不命中')
  assert.equal(isSaveButton({ tagName: 'DIV', textContent: '保存' }), false)
  assert.equal(isSaveButton(null), false)
  assert.equal(isSaveButton(undefined), false)
})

test('提交判定(点击分类用):空闲与 busy 态文案均视为保存按钮', () => {
  assert.equal(isSaveCommitButton({ tagName: 'BUTTON', textContent: '保存' }), true)
  assert.equal(isSaveCommitButton({ tagName: 'BUTTON', textContent: '保存中…' }), true, '点击瞬间官方已置 busy,冒泡到文档级时文案已改写')
  assert.equal(isSaveCommitButton({ tagName: 'BUTTON', textContent: 'Applying…' }), true)
  assert.equal(isSaveCommitButton({ tagName: 'BUTTON', textContent: '取消' }), false)
  assert.equal(isSaveCommitButton({ tagName: 'BUTTON', textContent: '恢复默认模型' }), false)
  assert.equal(isSaveCommitButton({ tagName: 'DIV', textContent: '保存' }), false)
  assert.equal(isSaveCommitButton(null), false)
})

test('草稿编辑判定:任一字段偏离冻结种子即已编辑', () => {
  const seed = { checked: { low: true }, spellings: { low: 'low' }, inputMode: 'text' }
  assert.equal(draftEdited({ ...seed, seed }), false, '零编辑 = 与种子全等')
  assert.equal(draftEdited({ checked: { low: true, high: true }, spellings: { low: 'low' }, inputMode: 'text', seed }), true, '勾选变化')
  assert.equal(draftEdited({ checked: { low: true }, spellings: { low: 'x' }, inputMode: 'text', seed }), true, '拼写变化')
  assert.equal(draftEdited({ checked: { low: true }, spellings: { low: 'low' }, inputMode: 'text-image', seed }), true, '模态变化')
  assert.equal(draftEdited({ ...seed, seed: null }), true, 'seed 显式 null 与无 seed 同形,保守按已编辑')
})

test('草稿编辑判定:无种子裸草稿按已编辑;非对象按未编辑', () => {
  assert.equal(draftEdited({ checked: {}, spellings: {}, inputMode: 'unset' }), true, '无种子保守按已编辑')
  assert.equal(draftEdited(null), false)
  assert.equal(draftEdited(undefined), false)
})

test('随动快照:已编辑草稿按路由分组,id String 归一', () => {
  const edited = { checked: { low: true }, spellings: {}, inputMode: 'unset' }
  const routes = collectSaveFollowDrafts([
    { route: 'a', modelId: 'm1', draft: edited },
    { route: 'a', modelId: 7, draft: edited },
    { route: 'b', modelId: 'm9', draft: edited },
  ])
  assert.equal(routes.size, 2)
  assert.deepEqual([...routes.get('a').keys()], ['m1', '7'])
  assert.ok(routes.get('a').get('m1') === edited)
  assert.ok(routes.get('b').get('m9') === edited)
})

test('随动快照:未编辑草稿剔除;非对象条目跳过', () => {
  const seed = { checked: {}, spellings: {}, inputMode: 'unset' }
  const untouched = { ...seed, seed }
  const routes = collectSaveFollowDrafts([
    { route: 'a', modelId: 'kept', draft: { checked: { high: true }, spellings: {}, inputMode: 'unset' } },
    { route: 'a', modelId: 'untouched', draft: untouched },
    { route: 'a', modelId: 'nodraft', draft: null },
    null,
    'junk',
  ])
  assert.equal(routes.size, 1)
  assert.deepEqual([...routes.get('a').keys()], ['kept'])
})

test('随动快照:全部未编辑返回空表(武装方据此跳过)', () => {
  const seed = { checked: {}, spellings: {}, inputMode: 'unset' }
  const routes = collectSaveFollowDrafts([{ route: 'a', modelId: 'm', draft: { ...seed, seed } }])
  assert.equal(routes.size, 0)
})

test('补写就绪:已武装且全部武装卡脱离文档', () => {
  const armed = { cards: ['cardA', 'cardB'], routes: new Map() }
  assert.equal(saveFollowReady(armed, (card) => card === 'cardA'), false, '任一武装卡仍在文档 = 官方保存未成功,不补写')
  assert.equal(saveFollowReady(armed, () => true), false, '卡仍在文档 = 官方保存未成功,不补写')
  assert.equal(saveFollowReady(armed, () => false), true)
})

test('补写就绪:未武装/空卡集/异型武装包不补写', () => {
  assert.equal(saveFollowReady(null, () => false), false)
  assert.equal(saveFollowReady({ cards: [], routes: new Map() }, () => false), false)
  assert.equal(saveFollowReady(undefined, () => false), false)
  assert.equal(saveFollowReady({ routes: new Map() }, () => false), false)
})

test('点击分类:仅"在册卡内的保存按钮"武装,其余一切点击解除', () => {
  const saveBtn = { tagName: 'BUTTON', textContent: '保存' }
  const busyBtn = { tagName: 'BUTTON', textContent: '保存中…' }
  const applyBtn = { tagName: 'BUTTON', textContent: 'Apply' }
  const cancelBtn = { tagName: 'BUTTON', textContent: '取消' }
  const card = { contains(button) { return button === saveBtn || button === busyBtn } }
  const entries = [{ cardEl: card }]
  assert.equal(saveFollowArms(entries, saveBtn), true, '在册卡内保存按钮 → 武装')
  assert.equal(saveFollowArms(entries, busyBtn), true, 'busy 态(点击冒泡途中被官方改写)→ 仍武装')
  assert.equal(saveFollowArms(entries, applyBtn), false, '卡外 Apply(卡含判定为否)→ 解除')
  assert.equal(saveFollowArms(entries, cancelBtn), false, '取消按钮 → 解除')
  assert.equal(saveFollowArms(entries, null), false, '点非按钮(输入框/空白)→ 解除')
  assert.equal(saveFollowArms([], saveBtn), false, '无在册行 → 解除')
  assert.equal(saveFollowArms([{ cardEl: null }], saveBtn), false)
  assert.equal(saveFollowArms([null, 'junk', undefined], saveBtn), false)
  assert.equal(saveFollowArms(undefined, saveBtn), false)
})

test('解除允许:已武装且武装卡全部在文档;卡卸载后点击不得撤销待补写', () => {
  const armed = { cards: ['cardA'], routes: new Map() }
  assert.equal(saveFollowDismissible(armed, (card) => card === 'cardA'), true, '卡仍在文档 → 取消/换卡点击可解除')
  assert.equal(saveFollowDismissible(armed, () => false), false, '卡已卸载 = 保存已终局,快速后续点击不丢写')
  assert.equal(saveFollowDismissible(null, () => true), false, '未武装无可解除')
  assert.equal(saveFollowDismissible({ cards: [], routes: new Map() }, () => true), false)
  const mixed = { cards: ['cardA', 'cardB'], routes: new Map() }
  assert.equal(saveFollowDismissible(mixed, (card) => card === 'cardA'), false, '部分断连中间态不可解除,防误判终局')
})

// 编排契约守卫:client.js 侧监听/武装/补写/清偿的接线存在性(纯函数行为已单测,
// 此处锁编排漂移——命名重构成段删除时守卫即失败)。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client.js'), 'utf8')

test('随动契约:文档级点击分类(武装/解除)接线存在', () => {
  assert.ok(CLIENT_SOURCE.includes("document.addEventListener('click', onDocClick)"), '点击分类必须挂文档级监听')
  assert.ok(CLIENT_SOURCE.includes("document.removeEventListener('click', onDocClick)"), '监听必须随实例清理')
  assert.ok(CLIENT_SOURCE.includes("document.addEventListener('keydown', onDocKeyDown)"), 'Escape 关面板不派发 click,必须挂 keydown 监听')
  assert.ok(CLIENT_SOURCE.includes("document.removeEventListener('keydown', onDocKeyDown)"), 'keydown 监听必须随实例清理')
  assert.ok(/if \(saveFollowArms\(/.test(CLIENT_SOURCE), '武装必须经分类判定')
  assert.ok(/else if \(saveFollowDismissible\(saveFollowArmed/.test(CLIENT_SOURCE), '解除必须经允许判定')
  assert.ok(/onDocKeyDown = \(event\) => \{\s*if \(event\.key !== 'Escape'\) return/.test(CLIENT_SOURCE), 'keydown 只认 Escape,不得退化为任意按键解除')
  assert.ok(/onDocKeyDown[\s\S]*?saveFollowDismissible\(saveFollowArmed[\s\S]*?saveFollowDrafts\.clear\(\)/.test(CLIENT_SOURCE), 'Escape 解除必须同时丢弃持久草稿')
})

test('随动契约:分区关闭放弃出口与 climb 排除插件按钮', () => {
  assert.ok(/else if \(saveFollowArmed === null && saveFollowDrafts\.size > 0\) saveFollowDrafts\.clear\(\)/.test(CLIENT_SOURCE), '分区关闭且未武装必须清持久表(放弃出口)')
  assert.ok(/isSaveCommitButton\(button\) &&\s*button\.closest\('\.mce-fallback-root, \.mce-card'\) === null/.test(CLIENT_SOURCE), 'climb 必须排除插件自有按钮防锚点漂移')
})

test('随动契约:补写挂 scan 回调且先于分区出场门(关卡即分区卸载不得挡补写)', () => {
  const scan = CLIENT_SOURCE.indexOf('function scheduleScan')
  const fire = CLIENT_SOURCE.indexOf('saveFollowReady(saveFollowArmed')
  const gate = CLIENT_SOURCE.indexOf('data-slot="settings.section"', scan)
  assert.ok(scan >= 0 && fire > scan, '补写判定必须位于 scheduleScan')
  assert.ok(gate > fire, '补写判定必须先于分区出场门')
  assert.ok(CLIENT_SOURCE.includes('if (saveFollowReady(saveFollowArmed'), '补写必须经就绪判定')
  assert.ok(CLIENT_SOURCE.includes('fireSaveFollow()'), '补写出口必须存在')
})

test('随动契约:RowEditor 注册卡锚并上报持久草稿,实例终止清偿武装', () => {
  assert.ok(CLIENT_SOURCE.includes('saveFollow.watch()'), 'RowEditor 必须注册卡锚')
  assert.ok(CLIENT_SOURCE.includes('saveFollow.report(next)'), '编辑必须同步上报持久草稿表')
  assert.ok(CLIENT_SOURCE.includes('saveFollow.lookup()'), '重展开必须回显未落盘编辑')
  assert.ok(CLIENT_SOURCE.includes('collectSaveFollowDrafts([...saveFollowDrafts.values()])'), '武装必须从持久表冻结快照')
  assert.ok(CLIENT_SOURCE.includes('未识别官方「保存」按钮'), '锚点失效必须告警停用,防编辑后无法落盘')
  assert.ok(/disposed = true[^}]*saveFollowArmed = null/s.test(CLIENT_SOURCE), '实例终止必须清偿武装,防禁用后补写')
  assert.ok(/saveFollowDismissible\(saveFollowArmed[\s\S]*?\)\) \{[\s\S]*?saveFollowDrafts\.clear\(\)/.test(CLIENT_SOURCE), '解除必须同时丢弃持久草稿(取消不写)')
})
