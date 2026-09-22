// 归档行操作按钮显隐与顺序契约:恢复常显,删除跟随行悬停,删除在恢复之前。
// 文案与行为同源锁定,防重构把恢复键重新藏进行悬停。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

// Given 非悬停归档行, When 渲染, Then 恢复常显、删除隐藏;行悬停或键盘聚焦时删除显现
test('源码契约:恢复常显,删除跟随行悬停与聚焦显现', () => {
  // 操作容器基础常显:不带整体 opacity:0(整体隐藏会让子级无法单独显形)
  assert.ok(CLIENT_SRC.includes('.sm-row__actions { display:flex; gap:2px; justify-content:flex-end; }'),
    '操作容器未改为常显基础形态')
  // 删除按钮默认隐藏;隐藏规则须位于 .sm-btn:disabled 之后(同特异度后出者胜),
  // 否则 busy 禁用态被禁用半透明规则压过而幽灵显形
  assert.ok(/\.sm-btn--danger[^{]*\{ opacity:0/.test(CLIENT_SRC), '删除按钮未默认隐藏')
  // 锚点取规则体而非选择器名,对提及选择器的注释文本免疫
  assert.ok(CLIENT_SRC.indexOf('.sm-btn--danger:disabled { opacity:0') > CLIENT_SRC.indexOf('.sm-btn:disabled { opacity'),
    '删除隐藏规则未置于 .sm-btn:disabled 之后,禁用态会被半透明压过')
  // 行悬停与键盘聚焦显现删除按钮
  assert.ok(CLIENT_SRC.includes('.sm-row:hover .sm-btn--danger'), '行悬停未显现删除按钮')
  assert.ok(CLIENT_SRC.includes('.sm-row:focus-within .sm-btn--danger'), '键盘聚焦未显现删除按钮')
})

// Given 归档行动作渲染, When 构建按钮序列, Then 删除在恢复之前(换位后恢复贴最右)
test('源码契约:删除按钮先于恢复按钮', () => {
  // 断言限定在 ArchiveRow 片段内,避免文件级首次命中漂移到其他行的同名按钮
  const rowSrc = CLIENT_SRC.slice(CLIENT_SRC.indexOf('function ArchiveRow'), CLIENT_SRC.indexOf('function DeleteDialog'))
  const dangerAt = rowSrc.indexOf("className: 'sm-btn sm-btn--danger'")
  const restoreAt = rowSrc.indexOf("className: 'sm-btn sm-btn--restore'")
  assert.ok(dangerAt >= 0 && restoreAt >= 0, '缺删除或恢复按钮')
  assert.ok(dangerAt < restoreAt, '删除按钮未换位到恢复按钮之前')
})

// Given 已删除区与减弱动效环境, When 渲染, Then 已删除行操作保持悬停显现且动效可关
test('源码契约:已删除区保持悬停显现且减弱动效覆盖新选择器', () => {
  // 已删除区行操作悬停显现(作用域规则,不回归容器整体隐藏)
  assert.ok(CLIENT_SRC.includes('.sm-deleted .sm-row__actions { opacity:0'), '已删除区未保持悬停显现')
  assert.ok(CLIENT_SRC.includes('.sm-deleted .sm-row:hover .sm-row__actions'), '已删除区缺行悬停显现规则')
  assert.ok(CLIENT_SRC.includes('.sm-deleted .sm-row:focus-within .sm-row__actions'), '已删除区缺键盘聚焦显现规则')
  // 减弱动效覆盖删除按钮与已删除区两处过渡
  assert.ok(/prefers-reduced-motion: reduce.*\{ \.sm-btn--danger, \.sm-deleted \.sm-row__actions \{ transition:none/.test(CLIENT_SRC),
    '减弱动效未覆盖删除按钮与已删除区过渡')
})
