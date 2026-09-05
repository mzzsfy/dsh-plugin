// parity 测试:client.js LOGIC 标记段与 src/logic.mjs 同源逻辑对照。
// 覆盖替换决策全部分支 + 安全门矩阵 + 两份实现全量同源断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as logic from '../src/logic.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SELECTOR_LABEL = '.VOzbGW_navLabel'

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
    'ATTR_MARK', 'SELECTOR_LABEL',
    section + '; return { ICONS, DECLARED_ICONS, FALLBACK, GLYPHS, GEAR_PATH, SVG_MAX_CHARS, STROKE_ATTRS, NAME_RULES, ATTR_MARK, SELECTOR_LABEL, poolIndexOf, resolveIcon, themedIcon, decide, applyDecision, decideAvatar, applyAvatar };',
  )
  return factory(pick('ATTR_MARK'), pick('SELECTOR_LABEL'))
}

// 假 DOM:单元格 + label + svg 的最小接口。svg 的 path 探测按选择器里的
// d 前缀与节点实际存储路径比对,防探测逻辑退化为恒真断言。
// 隐藏语义与真实浏览器一致:SVGElement 无 hidden 访问器,实现走 style.display,
// 桩以 style 对象模拟。单元格形态:官方 svg 恒为首个;贴图语义 = 隐藏官方 +
// 注入跟随,hidden 选项直接构造"已处理形态"(记账匹配 + 官方已隐藏)。
function makeSvg({ gear = false } = {}) {
  const node = {
    dataset: {},
    style: { display: '' },
    paths: gear ? ['M14.0861 3.2c-.9.4-1.4 1-1.6 1.9'] : ['M8 2.2a4 4 0 0 1 4 4'],
    insertAdjacentHTML() {},
    remove() {},
    querySelector(sel) {
      const m = sel.match(/^path\[d\^="(.+)"\]$/)
      if (m === null) return null
      return this.paths.some((d) => d.startsWith(m[1])) ? { d: m[1] } : null
    },
  }
  return node
}

function makeCell(labelText, { marked = false, hidden = false, gear, noSvg = false } = {}) {
  const official = makeSvg({ gear: gear !== undefined ? gear : !hidden })
  if (hidden) official.style.display = 'none'
  const cell = {
    dataset: marked ? { navic: labelText } : {},
    svgs: noSvg ? [] : [official],
    querySelector(sel) {
      if (sel === SELECTOR_LABEL) return { textContent: labelText }
      return null
    },
    querySelectorAll(sel) {
      if (sel === 'svg') return cell.svgs
      if (sel === '[data-navic="1"]') return cell.svgs.filter((s) => s !== official && s.dataset.navic === '1')
      return []
    },
  }
  // applyDecision 经 official.insertAdjacentHTML('afterend') 注入,桩同步进 svgs
  official.insertAdjacentHTML = (pos, html) => {
    const injected = makeSvg({ gear: false })
    injected.dataset.navic = '1'
    injected.html = html
    cell.svgs.push(injected)
  }
  cell._official = official
  return cell
}
// 官方已隐藏的判定口径与实现一致(style.display)
const isHidden = (svg) => svg.style.display === 'none'

function defineScenarios(prefix, L) {
  const { ICONS, FALLBACK, GEAR_PATH, poolIndexOf, themedIcon, decide, applyDecision } = L

  test(prefix + '收录分区返回替换决策', () => {
    const cell = makeCell('插件市场')
    const d = decide(cell)
    assert.ok(d, '收录分区应有决策')
    assert.equal(d.label, '插件市场')
    assert.equal(d.html, ICONS['插件市场'])
    assert.equal(d.official, cell._official)
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

  test(prefix + '兜底哈希:固定 label 手算期望值锁定 31 进制累加', () => {
    // 'A' 的 charCode 为 65,h = 65,|65| % 4 = 1
    assert.equal(poolIndexOf('A'), 1)
    const reached = new Set(['插件一', '插件二', '插件三', '插件四', '插件五', '插件六'].map(poolIndexOf))
    assert.ok(reached.size >= 2, '哈希应在池内产生区分,reached=' + reached.size)
  })

  test(prefix + 'GEAR_PATH 是官方齿轮路径前缀', () => {
    assert.equal(GEAR_PATH, 'M14.0861')
  })

  test(prefix + '已处理形态(记账匹配且官方已隐藏)返回 null', () => {
    assert.equal(decide(makeCell('认证', { marked: true, hidden: true })), null)
    assert.equal(decide(makeCell('某新装插件分区', { marked: true, hidden: true })), null, '兜底分区同样幂等')
  })

  test(prefix + '幂等与注入内容解耦:官方隐藏即短路,不看注入内容', () => {
    // 官方已隐藏 + 记账匹配:即使注入图标缺失(极端外部干预)也不重贴死循环
    const cell = makeCell('插件市场', { marked: true, hidden: true, gear: true })
    assert.equal(decide(cell), null)
  })

  test(prefix + 'label 变化时重贴(语言切换)', () => {
    const cell = makeCell('General', { marked: true, hidden: true })
    assert.equal(decide(cell), null, 'General 已按 General 替换')
    cell.dataset.navic = '通用设置'
    const d = decide(cell)
    assert.ok(d, 'label 与记账不符时必须按新 label 重贴')
    assert.equal(d.label, 'General')
    assert.equal(d.html, ICONS['General'])
  })

  test(prefix + '语言切换后新 label 无映射:已隐藏的重贴,官方原生保留', () => {
    const ours = makeCell('某无规则分区', { marked: true, hidden: true })
    ours.dataset.navic = '认证'
    const d = decide(ours)
    assert.ok(d, '记账失配的已处理单元格按新 label 重贴(清账失效场景)')
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

  test(prefix + '无 svg 返回 null;无记账有映射按当前 label 重贴(声明变更场景)', () => {
    assert.equal(decide(makeCell('MCP 服务', { noSvg: true })), null)
    const d = decide(makeCell('MCP 服务'))
    assert.ok(d, '记账被清(声明变更强制重贴)后应按当前 label 重贴')
    assert.equal(d.label, 'MCP 服务')
  })

  test(prefix + 'applyDecision 隐藏官方、注入跟随、记账 label,再扫幂等', () => {
    const cell = makeCell('侧边卡片')
    const d = decide(cell)
    applyDecision(cell, d)
    assert.equal(isHidden(cell._official), true, '官方 svg 隐藏不移除(React 受管)')
    assert.equal(cell.svgs.length, 2, '官方 + 注入图标')
    assert.equal(cell.svgs[1].dataset.navic, '1', '注入图标带标记')
    assert.equal(cell.svgs[1].html, d.html, '注入内容为决策 html')
    assert.equal(cell.dataset.navic, '侧边卡片', '记账')
    assert.equal(decide(cell), null, '贴后再扫幂等')
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

  test(prefix + '声明机制:glyph 解析与合法值原样通过', () => {
    const { DECLARED_ICONS, GLYPHS, resolveIcon, FALLBACK, SVG_MAX_CHARS } = L
    try {
      assert.equal(resolveIcon('bell'), GLYPHS.bell)
      assert.equal(resolveIcon(' <svg></svg> '), '<svg></svg>', '首尾空白容忍')
      assert.equal(resolveIcon('<svg x="1"><path/></svg>'), '<svg x="1"><path/></svg>', '合法值原样返回不篡改')
      // 恰好等于上界的合法 svg 接受(<= 边界锁定)
      const exact = '<svg>' + 'x'.repeat(SVG_MAX_CHARS - 11) + '</svg>'
      assert.equal(exact.length, SVG_MAX_CHARS)
      assert.equal(resolveIcon(exact), exact, '上界值接受')
      assert.equal(resolveIcon('no-such-glyph'), undefined)
      assert.equal(resolveIcon(42), undefined)
      assert.equal(resolveIcon('constructor'), undefined, '原型链成员不可能被当 html 注入')
      assert.equal(resolveIcon('toString'), undefined)
      DECLARED_ICONS['某分区'] = 'no-such-glyph'
      assert.ok(FALLBACK.includes(decide(makeCell('某分区')).html), '非法声明值回退哈希兜底')
    } finally {
      delete DECLARED_ICONS['某分区']
    }
  })

  test(prefix + '安全门矩阵:事件属性/脚本/样式/动画/载体/外联/尾缀/超长', () => {
    const { resolveIcon, SVG_MAX_CHARS } = L
    assert.equal(resolveIcon('<svgx onload>'), undefined, '残串开标签')
    assert.equal(resolveIcon('<svg onload="x"></svg>'), undefined)
    assert.equal(resolveIcon('<svg/OnLoAd="x"></svg>'), undefined, '斜杠分隔与大小写混淆')
    assert.equal(resolveIcon('<svg foo="1"/onload="x"></svg>'), undefined, '斜杠属性分隔绕过')
    assert.equal(resolveIcon('<SVG ONLOAD="x"></SVG>'), undefined, '全大写载荷')
    assert.equal(resolveIcon('<svg><foreignObject/></svg>'), undefined)
    assert.equal(resolveIcon('<svg><FOREIGNOBJECT/></svg>'), undefined)
    assert.equal(resolveIcon('<svg><script>1</script></svg>'), undefined, 'SVG 命名空间 script')
    assert.equal(resolveIcon('<svg><SCRIPT/></svg>'), undefined)
    assert.equal(resolveIcon('<svg><style>@import url("https://evil/x.css")</style></svg>'), undefined, '内联样式 @import 外联')
    assert.equal(resolveIcon('<svg><animate attributeName="href" to="javascript:1"/></svg>'), undefined, 'SMIL 动画注入')
    assert.equal(resolveIcon('<svg><set attributeName="onload"/></svg>'), undefined)
    assert.equal(resolveIcon('<svg><use href="https://evil/x.svg#a"/></svg>'), undefined, 'use 外联')
    assert.equal(resolveIcon('<svg><image xlink:href="https://evil/p.png"/></svg>'), undefined, 'image 外联')
    assert.equal(resolveIcon('<svg><a href="javascript:1"/></svg>'), undefined, 'javascript: 外联')
    assert.equal(resolveIcon('<svg><a xlink:href="JAVASCRIPT:1"/></svg>'), undefined)
    assert.equal(resolveIcon('<svg></svg><img src="https://evil/x.png">'), undefined, '闭合标签尾缀活动 HTML')
    assert.equal(resolveIcon('<svg></svg><iframe src="https://evil">'), undefined, '尾缀内嵌框架')
    assert.equal(resolveIcon('<svg>' + 'x'.repeat(SVG_MAX_CHARS + 1) + '</svg>'), undefined, '超长')
    // 合法边界:恰为上界、嵌套 svg、大写标签接受
    const exact = '<svg>' + 'x'.repeat(SVG_MAX_CHARS - 11) + '</svg>'
    assert.equal(exact.length, SVG_MAX_CHARS)
    assert.equal(resolveIcon(exact), exact, '上界值接受')
    assert.equal(resolveIcon('<svg><svg></svg></svg>'), '<svg><svg></svg></svg>', '嵌套 svg 单根闭合接受')
    assert.equal(resolveIcon('<SVG></SVG>'), '<SVG></SVG>', '大写标签接受')
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

  test(prefix + '关键词规则整词边界与跨规则优先级', () => {
    const { themedIcon, FALLBACK } = L
    assert.equal(themedIcon('important'), FALLBACK[poolIndexOf('important')], 'im 不命中 important')
    assert.equal(themedIcon('dbtool'), FALLBACK[poolIndexOf('dbtool')], 'db 不命中 dbtool')
    assert.equal(themedIcon('my db tool'), themedIcon('db'), '独立词 db 命中')
    // 英文复数为已知盲区(单数规则不命中复数词形),现状:落哈希池
    assert.equal(themedIcon('Notifications'), FALLBACK[poolIndexOf('Notifications')])
    // 顺序即优先级,具体语义在前:双规则同打名取靠前者
    assert.equal(themedIcon('search-bot'), themedIcon('search'), 'search 先于 bot')
    assert.equal(themedIcon('git-notify'), themedIcon('git'), 'git 先于 notify')
  })

  test(prefix + '头像槽:原子节点隐藏记账,换名清旧注入不误删外来兄弟', () => {
    const { decideAvatar, applyAvatar } = L
    const removed = []
    const img = {
      tagName: 'IMG',
      dataset: {},
      hidden: false,
      parentInjections: [],
      parentElement: {
        querySelectorAll(sel) {
          return sel === '[data-navic="1"]' ? img.parentInjections.filter((n) => n.dataset.navic === '1') : []
        },
      },
      inserted: null,
      insertAdjacentHTML(pos, html) { img.inserted = pos + ':' + html },
    }
    const d1 = decideAvatar(img, '某插件')
    assert.ok(d1, '首次应产出决策')
    applyAvatar(img, d1)
    assert.equal(img.hidden, true, '原子节点隐藏保留(React 持引用)')
    assert.equal(img.dataset.navic, '某插件')
    assert.ok(img.inserted.startsWith('afterend:'), '注入跟随其后')
    // 换名:行内带标记的旧注入清理,无标记外来兄弟不动
    const stale = { dataset: { navic: '1' }, remove() { removed.push('stale') } }
    const foreign = { dataset: {}, remove() { removed.push('foreign') } }
    img.parentInjections.push(stale, foreign)
    const d2 = decideAvatar(img, '改名插件')
    applyAvatar(img, d2)
    assert.deepEqual(removed, ['stale'], '旧注入清理,外来兄弟保留')
    assert.equal(img.dataset.navic, '改名插件')
    assert.equal(decideAvatar(img, '改名插件'), null, '同名幂等')
    assert.equal(decideAvatar(img, ''), null, '空名不决策')
  })

  test(prefix + '头像槽:div 与 img 同构(隐藏+跟随),不再清空子树', () => {
    const { decideAvatar, applyAvatar } = L
    const div = {
      tagName: 'DIV',
      dataset: {},
      textContent: 'X',
      hidden: false,
      parentElement: { querySelectorAll(sel) { return sel === '[data-navic="1"]' ? [] : [] } },
      inserted: null,
      insertAdjacentHTML(pos, html) { div.inserted = pos + ':' + html },
    }
    const d = decideAvatar(div, '另一插件')
    applyAvatar(div, d)
    assert.equal(div.hidden, true, '色块节点隐藏(React 受管子树不触碰)')
    assert.equal(div.textContent, 'X', '子树不清空(与 IMG 同构)')
    assert.ok(div.inserted.startsWith('afterend:'), '图标跟随其后')
    assert.equal(div.dataset.navic, '另一插件')
  })
}

defineScenarios('logic.mjs: ', logic)
defineScenarios('client.js LOGIC: ', clientLogic())

// 两份实现全量同源:任何一张表单边修改立即失真
const client = clientLogic()

test('两份实现常量同源', () => {
  assert.equal(logic.STROKE_ATTRS, client.STROKE_ATTRS)
  assert.equal(logic.ATTR_MARK, client.ATTR_MARK)
  assert.equal(logic.SELECTOR_LABEL, client.SELECTOR_LABEL, 'label 选择器同源(精确匹配桩防子串容忍)')
  assert.equal(logic.GEAR_PATH, client.GEAR_PATH)
  assert.equal(logic.SVG_MAX_CHARS, client.SVG_MAX_CHARS)
})

test('两份实现 ICONS/GLYPHS/FALLBACK 全量同源', () => {
  assert.deepEqual(logic.ICONS, client.ICONS)
  assert.deepEqual(logic.GLYPHS, client.GLYPHS)
  assert.deepEqual(logic.FALLBACK, client.FALLBACK)
  assert.equal(logic.poolIndexOf('某新装插件分区'), client.poolIndexOf('某新装插件分区'))
})

test('两份实现 NAME_RULES 全量同源(含标志位)', () => {
  assert.equal(logic.NAME_RULES.length, client.NAME_RULES.length)
  for (let i = 0; i < logic.NAME_RULES.length; i += 1) {
    assert.equal(logic.NAME_RULES[i].re.source, client.NAME_RULES[i].re.source, '规则 ' + i + ' 正则漂移')
    assert.equal(logic.NAME_RULES[i].re.flags, client.NAME_RULES[i].re.flags, '规则 ' + i + ' 标志漂移')
    assert.equal(logic.NAME_RULES[i].icon, client.NAME_RULES[i].icon, '规则 ' + i + ' 图标漂移')
  }
})

test('README 契约数量锁定', () => {
  // README 声明的内置表规模,扩表须同步改 README
  assert.equal(Object.keys(logic.GLYPHS).length, 28)
  assert.equal(logic.NAME_RULES.length, 19)
})

test('LOGIC 段与 logic.mjs 决策函数逐函数源码一致(归一化注释与空白)', () => {
  const normalize = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, '')
  for (const name of ['resolveIcon', 'themedIcon', 'decide', 'applyDecision', 'decideAvatar', 'applyAvatar', 'poolIndexOf']) {
    assert.equal(
      normalize(client[name].toString()),
      normalize(logic[name].toString()),
      'LOGIC 段与 logic.mjs 漂移: ' + name,
    )
  }
})
