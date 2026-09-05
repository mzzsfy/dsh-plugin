// parity 测试:client.js LOGIC 标记段与 src/logic.mjs 同源逻辑对照
// (think-expand / capability-editor 模式)。覆盖替换决策全部分支 +
// 两份实现全量同源断言(ICONS/GLYPHS/FALLBACK/NAME_RULES 逐项 deepEqual)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as logic from '../src/logic.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 从 client.js 提取标记段,构造同接口的纯逻辑实现;注入常量从源码解析,
// 单边改常量时对表立即失真而非静默验证过时值。
function clientLogic() {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const begin = source.indexOf('/* LOGIC-BEGIN */')
  const end = source.indexOf('/* LOGIC-END */')
  assert.ok(begin >= 0 && end > begin, 'client.js 缺少逻辑标记段')
  const section = source.slice(begin + '/* LOGIC-BEGIN */'.length, end)
  const pick = (name) => {
    const m = source.match(new RegExp('const ' + name + " = '([^']+)'"))
    assert.ok(m, 'client.js 缺少常量 ' + name)
    return m[1]
  }
  const factory = new Function(
    'ATTR_MARK', 'SELECTOR_LABEL', 'SELECTOR_ICON',
    section + '; return { ICONS, DECLARED_ICONS, FALLBACK, GLYPHS, GEAR_PATH, SVG_MAX_CHARS, STROKE_ATTRS, NAME_RULES, ATTR_MARK, poolIndexOf, resolveIcon, themedIcon, decide, applyDecision, decideAvatar, applyAvatar };',
  )
  return factory(pick('ATTR_MARK'), pick('SELECTOR_LABEL'), pick('SELECTOR_ICON'))
}

// 假 DOM:单元格 + label + svg 的最小接口。svg 的 path 探测按选择器里的
// d 前缀与节点实际存储路径比对,防探测逻辑退化为恒真断言。
function makeSvg({ gear = false, ours = false } = {}) {
  const removed = []
  const node = {
    dataset: ours ? { navic: '1' } : {},
    paths: gear ? ['M14.0861 3.2c-.9.4-1.4 1-1.6 1.9'] : ['M8 2.2a4 4 0 0 1 4 4'],
    next: null,
    nextElementSibling: null,
    insertAdjacentHTML(_pos, html) { this.next = html },
    remove() { removed.push('svg') },
    querySelector(sel) {
      const m = sel.match(/^path\[d\^="(.+)"\]$/)
      if (m === null) return null
      return this.paths.some((d) => d.startsWith(m[1])) ? { d: m[1] } : null
    },
  }
  node._removed = removed
  return node
}

function makeCell(labelText, { marked = false, ours = false, noSvg = false, gear } = {}) {
  // 现役图标语义:本插件所贴(ours)必然不是官方齿轮;gear 未指定时默认官方齿轮
  const svgNode = makeSvg({ gear: gear !== undefined ? gear : !ours, ours })
  const cell = {
    dataset: marked ? { navic: labelText } : {},
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
    const cell = makeCell('某新装插件分区', { gear: true })
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

  test(prefix + '幂等与注入内容解耦:外部裸 svg 无标记也短路', () => {
    // 外部声明内容不含 data-navic 属性时,记账匹配 + 现役非齿轮即视为已处理
    const cell = makeCell('插件市场', { marked: true, gear: false })
    assert.equal(decide(cell), null, '裸声明 svg 不应触发重贴循环')
  })

  test(prefix + 'label 变化时重贴(语言切换)', () => {
    const cell = makeCell('General', { marked: true, ours: true })
    assert.equal(decide(cell), null, 'General 已按 General 替换')
    cell.dataset.navic = '通用设置'
    const d = decide(cell)
    assert.ok(d, 'label 与记账不符时必须按新 label 重贴')
    assert.equal(d.label, 'General')
    assert.equal(d.html, ICONS['General'])
  })

  test(prefix + '语言切换后新 label 无映射:本插件所贴重贴,官方原生保留', () => {
    const ours = makeCell('某无规则分区', { marked: true, ours: true })
    ours.dataset.navic = '认证'
    const d = decide(ours)
    assert.ok(d, '记账失配的本插件图标按新 label 重贴(清账失效场景)')
    assert.ok(FALLBACK.includes(d.html), '重贴走哈希兜底')
    const native = makeCell('某无规则分区', { marked: true, gear: false })
    native.dataset.navic = '认证'
    assert.equal(decide(native), null, '官方原生图形不被改写')
  })

  test(prefix + 'label 取 trim,空白 label 不进哈希池', () => {
    const padded = makeCell('  认证  ')
    const d = decide(padded)
    assert.equal(d.label, '认证', '带空白 label 应 trim 后匹配')
    assert.equal(decide(makeCell('   ')), null, '纯空白 label 直接跳过')
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
    assert.deepEqual(cell._svg._removed, ['svg'], '旧 svg 移除')
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
    try {
      DECLARED_ICONS['插件市场'] = 'git'
      const d = decide(makeCell('插件市场'))
      assert.equal(d.html, resolveIcon('git'), '声明覆盖内置映射')
    } finally {
      delete DECLARED_ICONS['插件市场']
    }
  })

  test(prefix + '声明机制:glyph 解析与安全门', () => {
    const { DECLARED_ICONS, GLYPHS, resolveIcon, FALLBACK, SVG_MAX_CHARS } = L
    try {
      assert.equal(resolveIcon('bell'), GLYPHS.bell)
      assert.ok(resolveIcon('<svg data-navic="1"></svg>').startsWith('<svg'))
      assert.equal(resolveIcon(' <svg></svg> '), '<svg></svg>', '首尾空白容忍')
      assert.equal(resolveIcon('no-such-glyph'), undefined)
      assert.equal(resolveIcon(42), undefined)
      // 安全门:残串开标签/事件属性/内嵌载体/超长一律拒绝
      assert.equal(resolveIcon('<svgx onload>'), undefined)
      assert.equal(resolveIcon('<svg onload="x"></svg>'), undefined)
      assert.equal(resolveIcon('<svg><foreignObject/></svg>'), undefined)
      assert.equal(resolveIcon('<svg><a href="javascript:1"/></svg>'), undefined)
      assert.equal(resolveIcon('<svg>' + 'x'.repeat(SVG_MAX_CHARS + 1) + '</svg>'), undefined)
      // 原型链成员不可能被当 html 注入
      assert.equal(resolveIcon('constructor'), undefined)
      assert.equal(resolveIcon('toString'), undefined)
      DECLARED_ICONS['某分区'] = 'no-such-glyph'
      assert.ok(FALLBACK.includes(decide(makeCell('某分区')).html), '非法声明值回退哈希兜底')
    } finally {
      delete DECLARED_ICONS['某分区']
    }
  })

  test(prefix + '声明机制:themedIcon 优先读声明(市场卡片名取图)', () => {
    const { DECLARED_ICONS, GLYPHS, themedIcon } = L
    try {
      DECLARED_ICONS['某品牌插件'] = 'wrench'
      assert.equal(themedIcon('某品牌插件'), GLYPHS.wrench)
    } finally {
      delete DECLARED_ICONS['某品牌插件']
    }
  })

  test(prefix + '关键词规则整词边界:不误伤包含命中词的更长词', () => {
    const { themedIcon, FALLBACK } = L
    assert.equal(themedIcon('important'), FALLBACK[poolIndexOf('important')], 'im 不命中 important')
    assert.equal(themedIcon('dbtool'), FALLBACK[poolIndexOf('dbtool')], 'db 不命中 dbtool')
    assert.equal(themedIcon('my db tool'), themedIcon('db'), '独立词 db 命中')
    // 英文复数为已知盲区(单数规则不命中复数词形),现状:落哈希池
    assert.equal(themedIcon('Notifications'), FALLBACK[poolIndexOf('Notifications')])
  })

  test(prefix + '头像槽:img 隐藏记账不移除,换名清旧注入', () => {
    const { decideAvatar, applyAvatar } = L
    const img = { tagName: 'IMG', dataset: {}, hidden: false, nextElementSibling: null, inserted: null, insertAdjacentHTML(pos, html) { this.inserted = pos + ':' + html } }
    const d1 = decideAvatar(img, '某插件')
    assert.ok(d1, '首次应产出决策')
    applyAvatar(img, d1)
    assert.equal(img.hidden, true, 'img 隐藏保留(React 持引用)')
    assert.equal(img.dataset.navic, '某插件')
    assert.ok(img.inserted.startsWith('afterend:'), '注入跟随其后')
    // 换名:上次注入的 svg(带标记)应先移除防重复
    const stale = { dataset: { navic: '1' }, removed: 0, remove() { this.removed += 1 } }
    img.nextElementSibling = stale
    const d2 = decideAvatar(img, '改名插件')
    applyAvatar(img, d2)
    assert.equal(stale.removed, 1, '旧注入图标清理')
    assert.equal(img.dataset.navic, '改名插件')
    assert.equal(decideAvatar(img, '改名插件'), null, '同名幂等')
  })

  test(prefix + '头像槽:div 清空内嵌与空名守卫', () => {
    const { decideAvatar, applyAvatar } = L
    const div = { tagName: 'DIV', dataset: {}, textContent: 'X', inserted: null, insertAdjacentHTML(pos, html) { this.inserted = pos + ':' + html } }
    const d = decideAvatar(div, '另一插件')
    applyAvatar(div, d)
    assert.equal(div.textContent, '', '字母色块清空')
    assert.ok(div.inserted.startsWith('beforeend:'), '图标内嵌')
    assert.equal(div.dataset.navic, '另一插件')
    assert.equal(decideAvatar(div, ''), null, '空名不决策')
  })
}

defineScenarios('logic.mjs: ', logic)
defineScenarios('client.js LOGIC: ', clientLogic())

// 两份实现全量同源:任何一张表单边修改立即失真
const client = clientLogic()

test('两份实现常量同源', () => {
  assert.equal(logic.STROKE_ATTRS, client.STROKE_ATTRS)
  assert.equal(logic.ATTR_MARK, client.ATTR_MARK)
  assert.equal(logic.GEAR_PATH, client.GEAR_PATH)
  assert.equal(logic.SVG_MAX_CHARS, client.SVG_MAX_CHARS)
})

test('两份实现 ICONS/GLYPHS/FALLBACK 全量同源', () => {
  assert.deepEqual(logic.ICONS, client.ICONS)
  assert.deepEqual(logic.GLYPHS, client.GLYPHS)
  assert.deepEqual(logic.FALLBACK, client.FALLBACK)
  assert.equal(logic.poolIndexOf('某新装插件分区'), client.poolIndexOf('某新装插件分区'))
})

test('两份实现 NAME_RULES 全量同源', () => {
  assert.equal(logic.NAME_RULES.length, client.NAME_RULES.length)
  for (let i = 0; i < logic.NAME_RULES.length; i += 1) {
    assert.equal(logic.NAME_RULES[i].re.source, client.NAME_RULES[i].re.source, '规则 ' + i + ' 正则漂移')
    assert.equal(logic.NAME_RULES[i].icon, client.NAME_RULES[i].icon, '规则 ' + i + ' 图标漂移')
  }
})

test('README 契约数量锁定', () => {
  // README 声明的内置表规模,扩表须同步改 README
  assert.equal(Object.keys(logic.GLYPHS).length, 28)
  assert.equal(logic.NAME_RULES.length, 19)
})
