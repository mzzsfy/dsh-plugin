// parity 测试:client.js LOGIC 标记段与 src/logic.mjs 同源逻辑对照
// (think-expand / capability-editor 模式)。覆盖替换决策全部分支。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
  // 标记段引用外层选择器/标记常量(client.js LOGIC-BEGIN 之前定义),以形参注入避免 TDZ
  const factory = new Function('ATTR_MARK', 'SELECTOR_LABEL', 'SELECTOR_ICON', section + '; return { ICONS, DECLARED_ICONS, FALLBACK, GLYPHS, GEAR_PATH, poolIndexOf, resolveIcon, themedIcon, decide, applyDecision, decideAvatar, applyAvatar };')
  return factory('data-navic', '.VOzbGW_navLabel', 'svg')
}

// 假 DOM:单元格 + label + svg 的最小接口。
function makeCell(labelText, { marked = false, ours = false, noSvg = false, gear = true } = {}) {
  const removed = []
  const svgNode = {
    dataset: ours ? { navic: '1' } : {},
    insertAdjacentHTML(_pos, html) { this.next = html },
    remove() { removed.push('svg') },
    querySelector(sel) {
      // 齿轮探测:按 d 前缀命中;非齿轮 svg 不含该路径
      if (sel.startsWith('path[d^=')) return gear ? { d: 'gear-path' } : null
      return null
    },
  }
  const cell = {
    dataset: marked ? { navic: labelText } : {},
    removed,
    querySelector(sel) {
      if (sel.includes('navLabel')) return { textContent: labelText }
      if (sel === 'svg') return noSvg ? null : svgNode
      return null
    },
  }
  cell._svg = svgNode
  return cell
}

function defineScenarios(prefix, L) {
  const { ICONS, FALLBACK, GEAR_PATH, poolIndexOf, themedIcon, decide, applyDecision } = L

  test(prefix + '收录分区返回替换决策', () => {
    const cell = makeCell('插件市场')
    const d = decide(cell)
    assert.ok(d, '收录分区应有决策')
    assert.equal(d.label, '插件市场')
    assert.equal(d.html, ICONS['插件市场'])
    assert.equal(d.old, cell._svg)
  })

  test(prefix + '未收录但现役是官方齿轮:从备用池取图标', () => {
    const cell = makeCell('某新装插件分区')
    const d = decide(cell)
    assert.ok(d, '齿轮兜底应有决策')
    assert.ok(FALLBACK.includes(d.html), '兜底图标必须来自备用池')
    assert.equal(d.html, FALLBACK[poolIndexOf('某新装插件分区')])
  })

  test(prefix + '未收录且现役是官方原生图标:不干预', () => {
    assert.equal(decide(makeCell('模型', { gear: false })), null, '模型分区自带柱状/原生图标')
    assert.equal(decide(makeCell('未知官方分区', { gear: false })), null)
  })

  test(prefix + '兜底哈希稳定:同 label 恒定,不同 label 有区分', () => {
    assert.equal(poolIndexOf('插件A'), poolIndexOf('插件A'))
    assert.equal(FALLBACK[poolIndexOf('x')], FALLBACK[poolIndexOf('x')])
    // 池内每个图标都应可达(顺序随机但覆盖完整)
    const reached = new Set(['插件一', '插件二', '插件三', '插件四', '插件五', '插件六'].map(poolIndexOf))
    assert.ok(reached.size >= 2, '哈希应在池内产生区分,reached=' + reached.size)
  })

  test(prefix + 'GEAR_PATH 是官方齿轮路径前缀', () => {
    assert.equal(GEAR_PATH, 'M14.0861')
  })

  test(prefix + '已按同 label 替换过返回 null(幂等)', () => {
    assert.equal(decide(makeCell('认证', { marked: true, ours: true })), null)
    assert.equal(decide(makeCell('某新装插件分区', { marked: true, ours: true })), null, '兜底分区同样幂等')
  })

  test(prefix + 'label 变化时重贴(语言切换)', () => {
    const cell = makeCell('General', { marked: true, ours: true })
    assert.equal(decide(cell), null, 'General 已按 General 替换')
    // 现役 svg 已是本插件产物但记账 label 与显示文本不符:按新 label 重贴(语言切换场景)
    cell.dataset.navic = '通用设置'
    const d = decide(cell)
    assert.ok(d, 'label 与记账不符时必须按新 label 重贴')
    assert.equal(d.label, 'General')
    assert.equal(d.html, ICONS['General'])
  })

  test(prefix + '语言切换后新 label 无映射且非齿轮:保留现役图标', () => {
    // 记账为中文 label,现役 svg 是插件所贴(非官方齿轮),新 label 无声明/内置映射,不干预
    const cell = makeCell('某无规则分区', { marked: true, ours: true, gear: false })
    cell.dataset.navic = '认证'
    assert.equal(decide(cell), null, '无映射时不重贴,保留现役语义图形')
  })

  test(prefix + '无 svg 返回 null;ours 无记账按当前 label 重贴(声明变更场景)', () => {
    assert.equal(decide(makeCell('MCP 服务', { noSvg: true })), null)
    const d = decide(makeCell('MCP 服务', { ours: true }))
    assert.ok(d, '记账被清(声明变更强制重贴)后应按当前 label 重贴')
    assert.equal(d.label, 'MCP 服务')
  })

  test(prefix + 'applyDecision 注入新 svg、移除旧 svg、记账 label', () => {
    const cell = makeCell('侧边卡片')
    const d = decide(cell)
    applyDecision(cell, d)
    assert.ok(cell._svg.next.startsWith('<svg data-navic="1"'), '新 svg 注入')
    assert.deepEqual(cell.removed, ['svg'], '旧 svg 移除')
    assert.equal(cell.dataset.navic, '侧边卡片')
  })

  test(prefix + '映射表仅收官方与第三方分区,自有插件分区走声明', () => {
    assert.deepEqual(Object.keys(ICONS).sort(), [
      'Agent Plugins 市场', 'General', 'IM机器人', 'MCP 服务', 'Theme / 外观',
      '认证', '侧边卡片', '插件市场', '通用设置',
    ].sort())
  })

  test(prefix + '声明机制:label 命中声明时覆盖内置与关键词', () => {
    const { DECLARED_ICONS, resolveIcon } = L
    DECLARED_ICONS['插件市场'] = 'git'
    const d = decide(makeCell('插件市场'))
    assert.equal(d.html, resolveIcon('git'), '声明覆盖内置映射')
    delete DECLARED_ICONS['插件市场']
  })

  test(prefix + '声明机制:glyph 名称解析与非法值回退', () => {
    const { DECLARED_ICONS, GLYPHS, resolveIcon, FALLBACK } = L
    assert.equal(resolveIcon('bell'), GLYPHS.bell)
    assert.ok(resolveIcon('<svg data-navic="1"></svg>').startsWith('<svg'))
    assert.equal(resolveIcon('no-such-glyph'), undefined)
    assert.equal(resolveIcon(42), undefined)
    DECLARED_ICONS['某分区'] = 'no-such-glyph'
    const d = decide(makeCell('某分区'))
    assert.ok(FALLBACK.includes(d.html), '非法声明值回退哈希兜底')
    delete DECLARED_ICONS['某分区']
  })

  test(prefix + '声明机制:themedIcon 优先读声明(市场卡片名取图)', () => {
    const { DECLARED_ICONS, GLYPHS, themedIcon } = L
    DECLARED_ICONS['某品牌插件'] = 'wrench'
    assert.equal(themedIcon('某品牌插件'), GLYPHS.wrench)
    delete DECLARED_ICONS['某品牌插件']
  })
}

defineScenarios('logic.mjs: ', logic)
defineScenarios('client.js LOGIC: ', clientLogic())

test('两份实现 ICONS 完全同源', () => {
  assert.equal(logic.ICONS['插件市场'], clientLogic().ICONS['插件市场'])
})

test('两份实现 FALLBACK 池同源', () => {
  assert.deepEqual(logic.FALLBACK, clientLogic().FALLBACK)
  assert.equal(logic.poolIndexOf('某新装插件分区'), clientLogic().poolIndexOf('某新装插件分区'))
})
