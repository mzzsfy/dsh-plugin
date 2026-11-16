// parity 测试:client.js LOGIC 标记段与 src/logic.mjs 同源逻辑对照。
// 替换决策全部分支 + 安全门矩阵 + 两份实现全量同源断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as logic from '../src/logic.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SELECTOR_LABEL = '.VOzbGW_navLabel'

// 从 client.js 提取标记段,构造同接口的纯逻辑实现;注入常量从源码解析,
// 单边改常量时对表立即失真而非静默验证过时值。mutateSection 供负向验证用:
// 只改 client 侧源码段,同源断言必须变红(见文末突变用例)。
function clientLogic({ mutateSection = (section) => section } = {}) {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const begin = source.indexOf('/* LOGIC-BEGIN */')
  const end = source.indexOf('/* LOGIC-END */')
  assert.ok(begin >= 0 && end > begin, 'client.js 缺少逻辑标记段')
  const section = mutateSection(source.slice(begin + '/* LOGIC-BEGIN */'.length, end))
  const pick = (name) => {
    const m = source.match(new RegExp('const ' + name + " = '([^']+)'"))
    assert.ok(m, 'client.js 缺少常量 ' + name)
    return m[1]
  }
  const factory = new Function(
    'ATTR_MARK', 'SELECTOR_LABEL',
    section + '; return { ICONS, DECLARED_ICONS, ALIAS_GROUPS, FALLBACK, GLYPHS, GEAR_PATHS, SVG_MAX_CHARS, SVG_GATE_CACHE_MAX, STROKE_ATTRS, NAME_RULES, SVG_TAG_ALLOW, SVG_ATTR_GLOBAL, SVG_ATTR_BY_TAG, SVG_COLOR_ATTRS, SVG_SHAPE_ATTRS, SVG_NON_RENDERED, SVG_POINTS_MIN_PAIRS, SVG_PATH_PARAMS, SVG_PATH_COMMAND_RE, SVG_PATH_TOKEN_RE, SVG_FRAGMENT_TAG_RE, SVG_FRAGMENT_ATTR_RE, SVG_NS, SVG_WS, SVG_NAME_MAX, SVG_MAX_DEPTH, SVG_ID_RE, SVG_HEX_RE, SVG_FUNC_RE, SVG_KEYWORD_RE, SVG_LOCAL_REF_RE, SVG_SPRITE_ID_RE, ATTR_MARK, SELECTOR_LABEL, poolIndexOf, resolveIcon, svgInner, svgInnerDraws, resolveForLabel, themedIcon, lookupWithAlias, aliasKeysOf, svgMarkupAllowed, svgAttributeAllowed, svgColorAllowed, pathDraws, svgShapeDraws, officialSpriteRestore, isGear, clearInjected, decide, applyDecision, decideAvatar, avatarApplied, applyAvatar };',
  )
  return factory(pick('ATTR_MARK'), pick('SELECTOR_LABEL'))
}

// 安全门文法常量与文法正则的同源断言面:纯标量与正则(source+flags)逐项对表。
// 抽成函数供突变负向验证复用:单边改常量/正则必须在此变红。
const SAFETY_SCALARS = ['SVG_NS', 'SVG_WS', 'SVG_NAME_MAX', 'SVG_MAX_DEPTH', 'SVG_MAX_CHARS', 'SVG_GATE_CACHE_MAX']
const SAFETY_PATTERNS = ['SVG_ID_RE', 'SVG_HEX_RE', 'SVG_FUNC_RE', 'SVG_KEYWORD_RE', 'SVG_LOCAL_REF_RE', 'SVG_SPRITE_ID_RE']

function assertSafetyParity(clientLike) {
  for (const name of SAFETY_SCALARS) {
    assert.deepEqual(clientLike[name], logic[name], '安全常量漂移: ' + name)
  }
  for (const name of SAFETY_PATTERNS) {
    assert.ok(logic[name] instanceof RegExp, 'logic.mjs 侧 ' + name + ' 应为正则')
    assert.ok(clientLike[name] instanceof RegExp, 'client.js 侧 ' + name + ' 应为正则')
    assert.deepEqual(clientLike[name], logic[name], '安全正则漂移(source+flags): ' + name)
  }
}

// 假 DOM:单元格 + label + svg 的最小接口。svg 的 path 探测按选择器里的
// d 前缀与节点实际存储路径比对,防探测逻辑退化为恒真断言。
// 内容改写制:决策直接写 official.innerHTML 与 official.dataset.navic,
// 不新建节点、不动官方呈现属性;桩以普通属性承接 innerHTML 写入。
// marked 桩模拟「已改写且内容可绘制」,stale 桩模拟「记账在场但内容是旧版本写下的
// 零绘制内容」(空串/仅 defs/仅 title),不自愈即永久空白。
const MARKED_INNER = '<path d="M0 0L1 1"/>'

function makeSvg({ gear = false } = {}) {
  // 两代官方齿轮桩路径:0.1.x 内联齿轮 / 0.1.7 primitives 齿体(实文前缀)
  const GEAR_STUB_PATHS = {
    legacy: 'M14.0861 3.2c-.9.4-1.4 1-1.6 1.9',
    rc1: 'M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951',
  }
  const node = {
    dataset: {},
    style: { display: '' },
    innerHTML: '',
    paths: gear ? [GEAR_STUB_PATHS[gear === 'rc1' ? 'rc1' : 'legacy']] : ['M8 2.2a4 4 0 0 1 4 4'],
    insertAdjacentHTML() {},
    remove() {},
    contains(node) { return node === this },
    querySelector(sel) {
      const m = sel.match(/^path\[d\^="(.+)"\]$/)
      if (m === null) return null
      return this.paths.some((d) => d.startsWith(m[1])) ? { d: m[1] } : null
    },
  }
  return node
}

function makeCell(labelText, { marked = false, stale = null, gear, noSvg = false } = {}) {
  const official = makeSvg({ gear: gear !== undefined ? gear : true })
  if (marked) {
    official.dataset.navic = labelText
    official.innerHTML = MARKED_INNER
  }
  if (stale !== null) {
    official.dataset.navic = labelText
    official.innerHTML = stale
  }
  const cell = {
    dataset: {},
    svgs: noSvg ? [] : [official],
    querySelector(sel) {
      if (sel === SELECTOR_LABEL) return { textContent: labelText }
      return null
    },
    querySelectorAll(sel) {
      if (sel === 'svg') return cell.svgs
      if (sel === '[data-navic="1"]') return cell.svgs.filter((s) => s.dataset.navic === '1')
      return []
    },
  }
  cell._official = official
  return cell
}

// 恰好等于长度上界的合法声明:图元门要求含图元,填充只能是 d 的坐标
function exactMaxMarkup(maxChars) {
  const head = '<svg><path d="M0 0 '
  const tail = '"/></svg>'
  const fill = maxChars - head.length - tail.length
  return head + '1 '.repeat(Math.ceil(fill / 2)).slice(0, fill) + tail
}

function defineScenarios(prefix, L) {
  const { ICONS, FALLBACK, GEAR_PATHS, poolIndexOf, themedIcon, decide, applyDecision, clearInjected, resolveForLabel, resolveIcon, svgInner } = L

  test(prefix + '收录分区返回改写决策:剥壳 inner,不建节点', () => {
    const cell = makeCell('插件市场')
    const d = decide(cell)
    assert.ok(d, '收录分区应有决策')
    assert.equal(d.label, '插件市场')
    assert.equal(d.inner, svgInner(ICONS['插件市场']), '决策为剥壳内容')
    assert.equal(d.official, cell._official)
  })

  test(prefix + '未收录但现役是官方齿轮:从备用池取图标', () => {
    const cell = makeCell('某新装分区', { gear: true })
    const d = decide(cell)
    assert.ok(d, '齿轮兜底应有决策')
    assert.equal(d.inner, svgInner(FALLBACK[poolIndexOf('某新装分区')]))
  })

  test(prefix + '非齿轮官方一律不动:映射或声明命中也不例外', () => {
    // 只对官方齿轮做强补;官方原生图标(模型/使用统计)与第三方供给形态不干预
    assert.equal(decide(makeCell('模型', { gear: false })), null, '模型分区自带原生图标')
    assert.equal(decide(makeCell('Agent 扩展', { gear: false })), null, '分类兜底不得覆盖非齿轮官方图标')
    assert.equal(decide(makeCell('插件市场', { gear: false })), null, '映射命中非齿轮同样不动')
    assert.equal(decide(makeCell('未知官方分区', { gear: false })), null)
  })

  test(prefix + '第三方 dshmarket 供给优先于分类兜底', () => {
    const cell = makeCell('Agent 扩展', { gear: 'rc1' })
    cell.dataset.dshMarketNavIcon = ''
    assert.equal(decide(cell), null, '外部供给标记存在时不接管,交给 dshmarket 的 mask 图标')
  })

  test(prefix + '兜底哈希:固定 label 手算期望值锁定 31 进制累加', () => {
    // 'A' 的 charCode 为 65,h = 65,|65| % 4 = 1
    assert.equal(poolIndexOf('A'), 1)
    const reached = new Set(['插件一', '插件二', '插件三', '插件四', '插件五', '插件六'].map(poolIndexOf))
    assert.ok(reached.size >= 2, '哈希应在池内产生区分,reached=' + reached.size)
  })

  test(prefix + 'GEAR_PATHS 收两代官方齿轮前缀(0.1.x 内联 / rc.1 primitives 齿体)', () => {
    assert.deepEqual(GEAR_PATHS, ['M14.0861', 'M13.0107 7.79377'])
  })

  test(prefix + 'rc.1 primitives 齿轮 fallback 同样强补(新代齿轮识别)', () => {
    const cell = makeCell('某新装分区', { gear: 'rc1' })
    const d = decide(cell)
    assert.ok(d, '新代齿轮兜底应有决策')
    assert.equal(d.inner, svgInner(FALLBACK[poolIndexOf('某新装分区')]))
  })

  test(prefix + '已改写形态(svg 记账等于 label)返回 null', () => {
    assert.equal(decide(makeCell('认证', { marked: true })), null)
    assert.equal(decide(makeCell('某新装分区', { marked: true })), null, '兜底分区同样幂等')
  })

  test(prefix + 'svg 记账变化时按新 label 重写(语言切换)', () => {
    const cell = makeCell('General', { marked: true })
    assert.equal(decide(cell), null, 'General 已按 General 改写')
    cell._official.dataset.navic = '通用设置'
    const d = decide(cell)
    assert.ok(d, 'label 与记账不符时必须按新 label 重写')
    assert.equal(d.label, 'General')
    assert.equal(d.inner, svgInner(ICONS['General']))
  })

  test(prefix + '语言切换后新 label 无映射:已改写的重写,官方原生保留', () => {
    const ours = makeCell('某无规则分区', { marked: true })
    ours._official.dataset.navic = '认证'
    const d = decide(ours)
    assert.ok(d, '记账失配的已改写 svg 按新 label 重写')
    assert.equal(d.inner, svgInner(FALLBACK[poolIndexOf('某无规则分区')]), '重写走哈希兜底')
    const native = makeCell('某无规则分区', { gear: false })
    assert.equal(decide(native), null, '官方原生图形不被改写')
  })

  test(prefix + 'label 取 trim,空白 label 不进哈希池', () => {
    const padded = makeCell('  认证  ')
    const d = decide(padded)
    assert.equal(d.label, '认证', '带空白 label 应 trim 后匹配')
    assert.equal(decide(makeCell('   ')), null, '纯空白 label 直接跳过')
  })

  test(prefix + '无 svg 返回 null;无记账的官方齿轮按当前 label 改写', () => {
    assert.equal(decide(makeCell('MCP 服务', { noSvg: true })), null)
    const d = decide(makeCell('MCP 服务'))
    assert.ok(d, '无记账的官方齿轮属于强补范围')
    assert.equal(d.label, 'MCP 服务')
  })

  test(prefix + 'applyDecision 只改内容与 data-* 记账:节点数、其余属性、style 均不动', () => {
    const cell = makeCell('侧边卡片')
    const official = cell._official
    const svgCountBefore = cell.svgs.length
    const styleBefore = official.style.display
    const d = decide(cell)
    applyDecision(d)
    assert.equal(official.innerHTML, svgInner(ICONS['侧边卡片']), '官方 svg 内容被改写')
    assert.equal(official.dataset.navic, '侧边卡片', '记账迁到官方 svg')
    assert.deepEqual(Object.keys(official.dataset).sort(), ['navic', 'navicOrig'], '改写路径只落记账与官方原样备份两条,呈现属性不动')
    assert.equal(cell.svgs.length, svgCountBefore, '不新建 svg 节点')
    assert.equal(official.style.display, styleBefore, '呈现属性与 style 不驱动')
    assert.equal(decide(cell), null, '改写后再扫幂等')
  })

  test(prefix + '升级残留清理:clearInjected 移除主节点之外的 0.1.x 注入节点', () => {
    const cell = makeCell('侧边卡片')
    const official = cell._official
    const stale = makeSvg({ gear: false })
    stale.dataset.navic = '1'
    cell.svgs.push(stale)
    const removed = []
    official.remove = () => { removed.push('official') }
    stale.remove = () => { removed.push('stale') }
    clearInjected(cell)
    assert.deepEqual(removed, ['stale'], '只清注入残留,官方首节点豁免')
  })

  test(prefix + '升级残留清理:单元格主 svg 记账恰为纯标记时也不移除(React 持引用)', () => {
    const cell = makeCell('某分区')
    const official = cell._official
    official.dataset.navic = '1'
    const removed = []
    official.remove = () => { removed.push('official') }
    clearInjected(cell)
    assert.deepEqual(removed, [], '首个 svg 是官方节点本身,移除即 reconcile NotFoundError')
  })

  test(prefix + '外部供给格:决策为 null 时残留同样清理(清理在裁决之前)', () => {
    const cell = makeCell('Agent 扩展', { gear: 'rc1' })
    cell.dataset.dshMarketNavIcon = ''
    const stale = makeSvg({ gear: false })
    stale.dataset.navic = '1'
    cell.svgs.push(stale)
    const removed = []
    stale.remove = () => { removed.push('stale') }
    clearInjected(cell)
    assert.equal(decide(cell), null, '外部供给格不产生决策')
    assert.deepEqual(removed, ['stale'], '无决策路径的残留必须由裁决入口清理')
    assert.deepEqual(Object.keys(cell._official.dataset), [], '官方 svg 记账未被写入')
  })

  test(prefix + '升级残留清理:图标内部嵌套 svg(带纯标记)不被误删', () => {
    const root = {}
    const primary = makeSvg({ gear: false })
    primary.parentElement = root
    // 图标内容里的嵌套 svg:安全门允许嵌套 svg 与 data-navic,删了即掏空当前图标
    const nested = makeSvg({ gear: false })
    nested.dataset.navic = '1'
    nested.parentElement = primary
    primary.contains = (node) => node === nested
    const sibling = makeSvg({ gear: false })
    sibling.dataset.navic = '1'
    sibling.parentElement = root
    // 非直接兄弟的纯标记节点(其他容器里的外来节点)同样不归本函数处置
    const foreign = makeSvg({ gear: false })
    foreign.dataset.navic = '1'
    foreign.parentElement = {}
    const removed = []
    primary.remove = () => { removed.push('primary') }
    nested.remove = () => { removed.push('nested') }
    sibling.remove = () => { removed.push('sibling') }
    foreign.remove = () => { removed.push('foreign') }
    const cell = {
      querySelectorAll(sel) {
        if (sel === 'svg') return [primary, nested]
        if (sel === '[data-navic="1"]') return [nested, sibling, foreign]
        return []
      },
    }
    clearInjected(cell)
    assert.deepEqual(removed, ['sibling'], '只清 primary 之外的直接兄弟,嵌套/外来节点保留')
  })

  test(prefix + '回退路径:外部供给格有残留时按 navicOrig 恢复官方原样并留 yield', () => {
    const cell = makeCell('插件市场', { marked: true })
    cell.dataset.dshMarketNavIcon = ''
    const official = cell._official
    official.dataset.navicOrig = '<use href="#orig"></use>'
    const removed = []
    official.remove = () => { removed.push('official') }
    const d = decide(cell)
    assert.ok(d, '外部供给格有我方残留时必须回退')
    assert.equal(d.revert, true, '回退决策标记')
    assert.equal(d.label, '插件市场', '回退记账沿用原 label')
    assert.equal(d.inner, '<use href="#orig"></use>', 'navicOrig 备份优先')
    applyDecision(d)
    assert.equal(official.innerHTML, '<use href="#orig"></use>', '官方原样恢复')
    assert.equal(official.dataset.navic, undefined, '改写记账清除')
    assert.equal(official.dataset.navicYield, '插件市场', '让位记账落 label')
    assert.deepEqual(Object.keys(official.dataset).sort(), ['navicOrig', 'navicYield'], '回退路径三条 data-* 中的两条在场(navic 已删)')
    assert.deepEqual(removed, [], '不移除官方节点')
    assert.equal(decide(cell), null, 'yield 记账永不重入')
  })

  test(prefix + '回退路径:无 navicOrig 备份且非自描述形态时不回退(不猜官方原样)', () => {
    const cell = makeCell('插件市场', { marked: true })
    cell.dataset.dshMarketNavIcon = ''
    assert.equal(decide(cell), null, '内联齿轮无备份:无法重建,零动作')
    assert.equal(cell._official.dataset.navic, '插件市场', '记账不被动')
  })

  test(prefix + '原型链键不是分区图:resolveForLabel/decide 不取继承成员', () => {
    // 内置映射是普通字面量对象,ICONS['constructor'] 等会取到继承值(函数/对象),
    // 进入 svgInner 的 .replace 即抛;全部 Object.prototype 自有键逐一锁定。
    for (const key of Object.getOwnPropertyNames(Object.prototype)) {
      const resolved = resolveForLabel(key)
      assert.equal(typeof resolved, 'string', '原型键 ' + key + ' 必须落到图形字符串')
      const cell = makeCell(key)
      const d = decide(cell)
      assert.ok(d, '原型键 label 仍按默认管线改写: ' + key)
      assert.equal(d.inner, svgInner(resolved), '原型键 label 取图为兜底链结果: ' + key)
    }
  })

  test(prefix + '内置 glyph 查表只认自有键:原型链字符串不得绕过安全门', () => {
    // 原型污染注入的字符串若被当作内置 glyph 返回,就等于绕过四重白名单直接进 innerHTML
    const protoKey = 'navicProtoGlyph'
    Object.defineProperty(Object.prototype, protoKey, {
      value: '<svg onload="alert(1)"><path d="M0 0L1 1"/></svg>',
      configurable: true,
    })
    try {
      assert.equal(resolveIcon(protoKey), undefined, '原型链字符串不得当作内置 glyph')
      assert.equal(resolveIcon(' ' + protoKey + ' '), undefined, 'trim 后同样不可达')
    } finally {
      delete Object.prototype[protoKey]
    }
    assert.equal(resolveIcon('bell'), L.GLYPHS.bell, '自有 glyph 正常命中')
    assert.equal(resolveIcon('toString'), undefined, '原型方法不是 glyph')
    assert.equal(resolveIcon('__proto__'), undefined, '原型对象不是 glyph')
  })

  test(prefix + 'svgInner 剥壳:属性/嵌套/大写(纯剥壳语义,合法性由 resolveIcon 的图元门收口)', () => {
    assert.equal(svgInner('<svg x="1"><path/></svg>'), '<path/>')
    assert.equal(svgInner('<svg><svg></svg></svg>'), '<svg></svg>', '嵌套只剥最外层')
    assert.equal(svgInner('<SVG></SVG>'), '')
  })

  test(prefix + '映射表仅收官方与第三方分区,自有插件分区走声明', () => {
    assert.deepEqual(Object.keys(ICONS).sort(), [
      'Agent Plugins 市场', 'General', 'IM机器人', 'MCP 服务', 'Theme / 外观',
      '认证', '侧边卡片', '插件市场', '通用设置',
    ].sort())
  })

  test(prefix + '声明机制:label 命中声明时压过内置与关键词', () => {
    const { DECLARED_ICONS, resolveIcon } = L
    try {
      DECLARED_ICONS['插件市场'] = 'git'
      const d = decide(makeCell('插件市场'))
      assert.equal(d.inner, svgInner(resolveIcon('git')), '声明压过内置映射')
    } finally {
      delete DECLARED_ICONS['插件市场']
    }
  })

  test(prefix + '声明撤销:内置映射分区回退到内置映射而非哈希(取图链一致)', () => {
    const { DECLARED_ICONS, ICONS, resolveIcon, resolveForLabel } = L
    try {
      DECLARED_ICONS['插件市场'] = 'git'
      assert.equal(resolveForLabel('插件市场'), resolveIcon('git'), '声明在')
      delete DECLARED_ICONS['插件市场']
      assert.equal(resolveForLabel('插件市场'), ICONS['插件市场'], '撤销后回内置映射')
    } finally {
      delete DECLARED_ICONS['插件市场']
    }
  })

  // 零绘制声明按「非法声明」处理:图元门拒收后取图链视该层未命中,回落默认管线。
  // 旧行为是原样放行 → decide 给出 inner='' → 记账写入后官方图标永久空白。
  test(prefix + '零绘制声明回落默认管线:分区与头像槽都不产出空内容', () => {
    const { DECLARED_ICONS, themedIcon, decideAvatar } = L
    try {
      DECLARED_ICONS['某新装分区'] = '<svg width="16" height="16" viewBox="0 0 16 16"></svg>'
      DECLARED_ICONS['插件市场'] = '<svg><defs><linearGradient id="g"/></defs></svg>'
      DECLARED_ICONS['某零绘制插件'] = '<svg><title>零绘制</title><desc>说明</desc></svg>'
      const hashed = decide(makeCell('某新装分区'))
      assert.equal(hashed.inner, svgInner(FALLBACK[poolIndexOf('某新装分区')]), '未收录分区回落哈希')
      assert.notEqual(hashed.inner, '', '决策内容非空')
      const mapped = decide(makeCell('插件市场'))
      assert.equal(mapped.inner, svgInner(ICONS['插件市场']), '内置映射分区回落内置映射')
      applyDecision(mapped)
      assert.notEqual(mapped.official.innerHTML, '', '写入官方 svg 的内容非空')
      const avatar = decideAvatar({ dataset: {}, style: { display: '' } }, '某零绘制插件')
      assert.equal(avatar.html, themedIcon('某零绘制插件'), '头像槽回落默认管线')
      assert.notEqual(svgInner(avatar.html), '', '头像槽注入内容非空')
    } finally {
      delete DECLARED_ICONS['某新装分区']
      delete DECLARED_ICONS['插件市场']
      delete DECLARED_ICONS['某零绘制插件']
    }
  })

  // 空内容不可视为已完成改写:记账相等只是必要条件,内容必须还在场。
  // R2-I2:旧版本写下的零绘制内容(空串、仅 defs、仅 title)都不得视为已完成改写
  test(prefix + '零绘制残留记账按默认管线重写(空串/仅 defs/仅 title 三种自愈)', () => {
    const staleCases = ['', '<defs><path d="M0 0L1 1"/></defs>', '<title>零绘制</title>']
    for (const stale of staleCases) {
      const cell = makeCell('某新装分区', { stale })
      const d = decide(cell)
      assert.ok(d, '零绘制残留必须重出决策: ' + JSON.stringify(stale))
      assert.equal(d.inner, svgInner(FALLBACK[poolIndexOf('某新装分区')]), '重写走默认管线')
      assert.notEqual(d.inner, '', '重写内容非空')
      applyDecision(d)
      assert.equal(cell._official.dataset.navicOrig, stale, '旧内容留作官方原样备份')
      assert.equal(cell._official.innerHTML, d.inner, '零绘制内容被真实图标替换')
      assert.equal(decide(cell), null, '内容可绘制后恢复幂等')
    }
    const mapped = makeCell('插件市场', { stale: '<defs/>' })
    assert.equal(decide(mapped).inner, svgInner(ICONS['插件市场']), '内置映射分区同样自愈')
    assert.equal(decide(makeCell('插件市场', { marked: true })), null, '已改写且可绘制仍幂等')
  })

  test(prefix + '声明机制:glyph 解析与合法值原样通过', () => {
    const { DECLARED_ICONS, GLYPHS, resolveIcon, FALLBACK, SVG_MAX_CHARS, poolIndexOf, svgInner } = L
    try {
      assert.equal(resolveIcon('bell'), GLYPHS.bell)
      assert.equal(resolveIcon(' <svg><path d="M0 0L1 1"/></svg> '), '<svg><path d="M0 0L1 1"/></svg>', '首尾空白容忍')
      assert.equal(resolveIcon('<svg viewBox="0 0 16 16"><path d="M0 0L1 1"/></svg>'), '<svg viewBox="0 0 16 16"><path d="M0 0L1 1"/></svg>', '合法值原样返回不篡改')
      // 恰好等于上界的合法 svg 接受(<= 边界锁定)
      const exact = exactMaxMarkup(SVG_MAX_CHARS)
      assert.equal(exact.length, SVG_MAX_CHARS)
      assert.equal(resolveIcon(exact), exact, '上界值接受')
      assert.equal(resolveIcon('no-such-glyph'), undefined)
      assert.equal(resolveIcon(42), undefined)
      assert.equal(resolveIcon('constructor'), undefined, '原型链成员不可能被当 html 注入')
      assert.equal(resolveIcon('toString'), undefined)
      DECLARED_ICONS['某分区'] = 'no-such-glyph'
      assert.equal(
        decide(makeCell('某分区')).inner,
        svgInner(FALLBACK[poolIndexOf('某分区')]),
        '非法声明值回退哈希兜底',
      )
    } finally {
      delete DECLARED_ICONS['某分区']
    }
  })

  test(prefix + '安全门矩阵(标签门):载体/动画/事件标签与文法外形态一律拒收', () => {
    const { resolveIcon, SVG_MAX_CHARS } = L
    assert.equal(resolveIcon('<svgx onload>'), undefined, '残串开标签')
    assert.equal(resolveIcon('<svg foo="1"/onload="x"></svg>'), undefined, '斜杠分隔属性')
    assert.equal(resolveIcon('<svg><foreignObject/></svg>'), undefined)
    assert.equal(resolveIcon('<svg><FOREIGNOBJECT/></svg>'), undefined)
    assert.equal(resolveIcon('<svg><script>1</script></svg>'), undefined, 'SVG 命名空间 script')
    assert.equal(resolveIcon('<svg><SCRIPT/></svg>'), undefined)
    assert.equal(resolveIcon('<svg><style>@import url("https://evil/x.css")</style></svg>'), undefined, '内联样式 @import 外联')
    assert.equal(resolveIcon('<svg><animate attributeName="href" to="javascript:1"/></svg>'), undefined, 'SMIL 动画注入')
    assert.equal(resolveIcon('<svg><animateTransform attributeName="transform"/></svg>'), undefined)
    assert.equal(resolveIcon('<svg><set attributeName="onload"/></svg>'), undefined)
    assert.equal(resolveIcon('<svg><discard/></svg>'), undefined)
    assert.equal(resolveIcon('<svg><use href="https://evil/x.svg#a"/></svg>'), undefined, 'use 外联')
    assert.equal(resolveIcon('<svg><use href="#a"/></svg>'), undefined, 'use 引用页内 sprite 同样拒收(标签门)')
    assert.equal(resolveIcon('<svg><image xlink:href="https://evil/p.png"/></svg>'), undefined, 'image 外联')
    assert.equal(resolveIcon('<svg><a href="javascript:1"/></svg>'), undefined, 'javascript: 外联')
    assert.equal(resolveIcon('<svg><a xlink:href="JAVASCRIPT:1"/></svg>'), undefined)
    assert.equal(resolveIcon('<svg><template><path/></template></svg>'), undefined)
    assert.equal(resolveIcon('<!-- x --><svg></svg>'), undefined, '注释不入子集')
    assert.equal(resolveIcon('<svg><!-- x --><path/></svg>'), undefined, '内部注释不入子集')
    assert.equal(resolveIcon('<svg><![CDATA[x]]></svg>'), undefined, 'CDATA 不入子集')
    assert.equal(resolveIcon('<?xml version="1.0"?><svg></svg>'), undefined, '处理指令不入子集')
    assert.equal(resolveIcon('<!DOCTYPE svg><svg></svg>'), undefined, 'DOCTYPE 不入子集')
    assert.equal(resolveIcon('<svg><title>a&amp;b</title></svg>'), undefined, '实体引用不入子集')
    assert.equal(resolveIcon('<svg><path d=M0 0/></svg>'), undefined, '未加引号属性值')
    assert.equal(resolveIcon("<svg><path d='M0 0'/></svg>"), undefined, '单引号属性值')
    assert.equal(resolveIcon('<svg><path></svg>'), undefined, '开闭不配对')
    assert.equal(resolveIcon('</svg><svg></svg>'), undefined, '前置闭合标签')
    assert.equal(resolveIcon('<path></path>'), undefined, '根不是 svg')
    assert.equal(resolveIcon('<svg></svg><img src="https://evil/x.png">'), undefined, '闭合标签尾缀活动 HTML')
    assert.equal(resolveIcon('<svg></svg><iframe src="https://evil">'), undefined, '尾缀内嵌框架')
    assert.equal(resolveIcon(exactMaxMarkup(SVG_MAX_CHARS + 1)), undefined, '超长')
    // 合法边界:恰为上界、嵌套 svg、大写标签、描述文字(图元在场)接受
    const exact = exactMaxMarkup(SVG_MAX_CHARS)
    assert.equal(exact.length, SVG_MAX_CHARS)
    assert.equal(resolveIcon(exact), exact, '上界值接受')
    assert.equal(resolveIcon('<svg><svg><path d="M0 0L1 1"/></svg></svg>'), '<svg><svg><path d="M0 0L1 1"/></svg></svg>', '嵌套 svg 单根闭合接受')
    assert.equal(resolveIcon('<SVG><path d="M0 0L1 1"/></SVG>'), '<SVG><path d="M0 0L1 1"/></SVG>', '大写标签接受')
    assert.equal(resolveIcon('<svg><title>股票</title><desc>说明</desc><path d="M0 0L1 1"/></svg>'), '<svg><title>股票</title><desc>说明</desc><path d="M0 0L1 1"/></svg>', '描述文字接受')
  })

  // 零绘制内容不是图标:空壳、只有结构/描述、几何缺失或退化——写进官方 innerHTML
  // 只会把齿轮清空,且记账后不再重试。图元门在四重白名单之外追加这一判定。
  test(prefix + '图元门:零绘制声明判非法,含非退化图元的声明照常接受', () => {
    const { resolveIcon, pathDraws, svgShapeDraws, svgInner, svgInnerDraws, SVG_SHAPE_ATTRS, SVG_NON_RENDERED } = L
    const zeroDraw = [
      '<svg/>', '<svg></svg>', '<svg width="16" height="16" viewBox="0 0 16 16"/>',
      '<svg><title>股票</title><desc>说明</desc></svg>',
      '<svg><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs></svg>',
      '<svg><defs/></svg>', '<svg><g transform="translate(1 2)"/></svg>',
      '<svg><stop offset="0" stop-color="#fff"/></svg>',
      '<svg><svg></svg></svg>',
      '<svg><path/></svg>', '<svg><path d=""/></svg>',
      // R2-I1:非渲染子树内的图元不画像素,仅 moveto 的 d 也没有线段
      '<svg><defs><path d="M0 0L1 1"/></defs></svg>',
      '<svg><defs><circle r="2"/></defs></svg>',
      '<svg><defs><svg><path d="M0 0L1 1"/></svg></defs></svg>',
      '<svg><title><path d="M0 0L1 1"/></title></svg>',
      '<svg><path d="M0 0"/></svg>', '<svg><path d="M 8 8 "/></svg>', '<svg><path d="M0 0z"/></svg>',
      // R3-I3-1:零长度段(polyline 单点 / path 原地指令 / 退化弧)同样不画
      '<svg><polyline points="1 1"/></svg>', '<svg><polygon points="1,1"/></svg>',
      '<svg><polyline points=""/></svg>', '<svg><polygon points=""/></svg>',
      '<svg><path d="M3 3h0"/></svg>', '<svg><path d="M0 0L0 0"/></svg>',
      '<svg><path d="M0 0v0"/></svg>', '<svg><path d="M0 0 0 0"/></svg>',
      '<svg><path d="M0 0c0 0 0 0 0 0"/></svg>', '<svg><path d="M0 0a5 5 0 0 1 0 0"/></svg>',
      '<svg><circle cx="8" cy="8"/></svg>', '<svg><circle r="0"/></svg>',
      '<svg><rect x="1" y="1"/></svg>', '<svg><rect width="0" height="2"/></svg>',
      '<svg><ellipse rx="2"/></svg>', '<svg><line/></svg>',
    ]
    for (const markup of zeroDraw) {
      assert.equal(resolveIcon(markup), undefined, '零绘制声明必须判非法: ' + markup)
    }
    // 反向边界:同类几何只要非退化就必须放行(防图元门过度拒收)
    const draws = [
      '<svg><path d="M0 0L1 1"/></svg>',
      '<svg><polyline points="0,0 1,1"/></svg>',
      '<svg><polygon points="0,0 1,1 2,2"/></svg>',
      '<svg><circle r="1"/></svg>',
      '<svg><rect width="1" height="1"/></svg>',
      '<svg><ellipse rx="1" ry="1"/></svg>',
      '<svg><line x2="1"/></svg>',
      '<svg><defs><linearGradient id="g"/></defs><path fill="url(#g)" d="M0 0L1 1"/></svg>',
      '<svg><defs><path d="M0 0L1 1"/></defs><circle r="2"/></svg>',
      '<svg><g transform="translate(1 2)"><circle r="1"/></g></svg>',
      '<svg><svg><path d="M0 0L1 1"/></svg></svg>',
      '<svg><path d="M0 0 1 1"/></svg>',
      '<svg><path d="M0 0h4"/></svg>',
      '<svg><path d="M0 0v4"/></svg>',
      '<svg><path d="M0 0h4v4z"/></svg>',
      '<svg><path d="M3 3a5 5 0 0 1 1 1"/></svg>',
      '<svg><path d="M3 3c0 0 1 1 2 2"/></svg>',
      '<svg><path d="M3 3q1 1 2 2"/></svg>',
    ]
    for (const markup of draws) {
      assert.equal(resolveIcon(markup), markup, '含非退化图元必须接受: ' + markup)
      // 门放行的声明写入 DOM 后,内容判据必须同样认它在画——否则自愈判据会每帧重写
      assert.equal(svgInnerDraws(svgInner(markup)), true, '门与内容判据必须一致: ' + markup)
    }
    // 判定单元:几何按标签取,结构标签(g/defs/title/desc)永不算图元
    assert.deepEqual(Object.keys(SVG_SHAPE_ATTRS).sort(), ['circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect'])
    assert.deepEqual([...SVG_NON_RENDERED].sort(), ['defs', 'desc', 'lineargradient', 'radialgradient', 'stop', 'title'], '非渲染子树集锁定')
    assert.equal(svgShapeDraws('path', { d: 'M0 0' }), false, '只有 moveto 无线段')
    assert.equal(svgShapeDraws('path', { d: 'M0 0L1 1' }), true)
    assert.equal(svgShapeDraws('path', { d: 'M0 0 1 1' }), true, '隐式 lineto 同样成段')
    assert.equal(svgShapeDraws('path', { d: 'M0 0z' }), false, 'Z 不单独成段')
    assert.equal(svgShapeDraws('path', { d: 'M3 3h0' }), false, '零长度水平段不画')
    assert.equal(svgShapeDraws('polyline', { points: '1 1' }), false, '单点没有长度')
    assert.equal(svgShapeDraws('polyline', { points: '1 1 2 2' }), true)
    // 逐段判定单元:命令大小写、隐式重复、弧与曲线控制点
    const pathCases = {
      'M0 0': false,
      'M3 3h0': false,
      'M0 0L0 0': false,
      'M0 0v0': false,
      'M0 0 0 0': false,
      'M1 1z': false,
      'M1 1c0 0 0 0 0 0': false,
      'M1 1a4 4 0 0 1 0 0': false,
      'M0 0 0 1': true,
      'M0 0h1': true,
      'M0 0v-2': true,
      'M1 1h1z': true,
      'M1 1q0 0 1 1': true,
      'm1 1l0 0l1 0': true,
      'm1 1l0 0': false,
    }
    for (const [d, expected] of Object.entries(pathCases)) {
      assert.equal(pathDraws(d), expected, 'pathDraws(' + d + ')')
    }
    assert.equal(pathDraws(''), false)
    assert.equal(pathDraws(undefined), false, '非字符串不判绘制')
    assert.equal(pathDraws('L1 1'), false, '缺 moveto 的词法外输入不判绘制')
    assert.equal(pathDraws('M0 0L'), false, '参数不全不判绘制')
    assert.equal(svgShapeDraws('path', {}), false)
    assert.equal(svgShapeDraws('rect', { width: '2', height: '1' }), true)
    assert.equal(svgShapeDraws('rect', { width: '2' }), false, '缺一边不构成矩形')
    assert.equal(svgShapeDraws('circle', { r: '-1' }), false, '负半径退化')
    assert.equal(svgShapeDraws('line', { x1: '0', y1: '0' }), false, '零长度线')
    assert.equal(svgShapeDraws('line', { x1: '0', y1: '0', x2: '0', y2: '2' }), true)
    assert.equal(svgShapeDraws('g', { transform: 'translate(1 2)' }), false, 'g 只承载结构')
    assert.equal(svgShapeDraws('svg', { width: '16', height: '16' }), false, '根 svg 自身不画像素')
    // 已写入 DOM 的内容判据(宽松扫描):序列化形态与自闭合差异不影响结论
    assert.equal(svgInnerDraws(''), false)
    assert.equal(svgInnerDraws(null), false, '非字符串不判绘制')
    assert.equal(svgInnerDraws('<defs><path d="M0 0L1 1"/></defs>'), false, 'defs 残留不算绘制')
    assert.equal(svgInnerDraws('<title>零绘制</title><desc>说明</desc>'), false)
    assert.equal(svgInnerDraws('<path d="M0 0L1 1"></path>'), true, '浏览器序列化的成对标签形态')
    assert.equal(svgInnerDraws('<path d="M0 0"></path>'), false, '序列化后的零长度段同样不算绘制')
    assert.equal(svgInnerDraws('<polyline points="1 1"></polyline>'), false, '单点折线不算绘制')
    assert.equal(svgInnerDraws('<circle r="0"></circle>'), false)
    assert.equal(svgInnerDraws('<defs><linearGradient id="g"/></defs><path fill="url(#g)" d="M0 0L1 1"></path>'), true)
    assert.equal(svgInnerDraws('<title>x</title><path d="M0 0L1 1"></path>'), true)
    assert.equal(svgInnerDraws('<svg data-navic="1"><path d="M0 0L1 1"/></svg>'), true, '整段声明形态同样可判')
  })

  test(prefix + '安全门矩阵(属性门):style/href/xlink:href/on*/attributeName/SMIL/引用型属性拒收', () => {
    const { resolveIcon, svgAttributeAllowed } = L
    // 属性白名单直判:报告列名逐项拒绝,合法几何属性放行
    for (const name of ['style', 'href', 'xlink:href', 'onload', 'onclick', 'attributename', 'attributetype', 'from', 'to', 'values', 'begin', 'dur', 'filter', 'clip-path', 'mask', 'marker-end', 'cursor', 'data-x']) {
      assert.equal(svgAttributeAllowed('path', name), false, '属性门应拒 ' + name)
    }
    assert.equal(svgAttributeAllowed('path', 'd'), true)
    assert.equal(svgAttributeAllowed('circle', 'd'), false, '几何属性按标签隔离(circle 无 d)')
    assert.equal(svgAttributeAllowed('path', 'viewbox'), false, 'svg 专有属性不下放')
    // 完整标记:每个属性都随白名单被拒,不只靠标签筛选
    assert.equal(resolveIcon('<svg><path style="background:url(https://evil.example/x)" d="M0 0L1 1"/></svg>'), undefined, 'style 属性')
    assert.equal(resolveIcon('<svg style="position:fixed;inset:0"><path d="M0 0L1 1"/></svg>'), undefined, '根 style 属性')
    assert.equal(resolveIcon('<svg><path fill="url(https://evil.example/p.svg#g)" d="M0 0L1 1"/></svg>'), undefined, 'fill 外链 url')
    assert.equal(resolveIcon('<svg><path stroke="url(//evil.example/p.svg#g)" d="M0 0L1 1"/></svg>'), undefined, '协议相对外链')
    assert.equal(resolveIcon('<svg><path fill="url(#dsw-icon-settings-outline)" d="M0 0L1 1"/></svg>'), undefined, '跨文档/官方 sprite id 不可达')
    assert.equal(resolveIcon('<svg><path fill="url(#g) red" d="M0 0L1 1"/></svg>'), undefined, 'url 带兜底色不入子集')
    assert.equal(resolveIcon('<svg><path fill="url(#g" d="M0 0L1 1"/></svg>'), undefined, '畸形 url')
    assert.equal(resolveIcon('<svg><path xlink:href="https://evil/x.svg#a"/></svg>'), undefined, 'xlink:href')
    assert.equal(resolveIcon('<svg><path href="https://evil/x.svg#a"/></svg>'), undefined, 'href')
    assert.equal(resolveIcon('<svg onload="x"></svg>'), undefined, 'onload')
    assert.equal(resolveIcon('<svg/OnLoAd="x"></svg>'), undefined, '斜杠分隔与大小写混淆')
    assert.equal(resolveIcon('<SVG ONLOAD="x"></SVG>'), undefined, '全大写载荷')
    assert.equal(resolveIcon('<svg><circle onclick="x"/></svg>'), undefined, 'onclick')
    assert.equal(resolveIcon('<svg><path attributeName="fill" to="url(https://evil/x)"/></svg>'), undefined, 'attributeName 缺动画载体也拒')
    assert.equal(resolveIcon('<svg><path fill="expression(alert(1))"/></svg>'), undefined, 'expression')
    assert.equal(resolveIcon('<svg><path fill="var(--x)"/></svg>'), undefined, 'var() 引用页面变量')
    assert.equal(resolveIcon('<svg><stop stop-color="url(https://evil/c)"/></svg>'), undefined, 'stop-color 外链')
    assert.equal(resolveIcon('<svg xmlns="https://evil.example/ns"><path d="M0 0L1 1"/></svg>'), undefined, '非 SVG 命名空间')
    assert.equal(resolveIcon('<svg xmlns:xlink="http://www.w3.org/1999/xlink"><path d="M0 0L1 1"/></svg>'), undefined, '命名空间前缀属性')
    // 合法边界:颜色字面量与本地渐变引用、表现层与几何属性
    assert.equal(resolveIcon('<svg><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="currentColor"/></linearGradient></defs><path fill="url(#g)" d="M0 0L1 1"/></svg>') !== undefined, true, 'fill="url(#g)" 指向本值内渐变合法')
    assert.equal(resolveIcon('<svg><path fill="url(#g)" d="M0 0L1 1"/><radialGradient id="g"/></svg>') !== undefined, true, 'id 先引用后定义同样合法')
    // id 大小写:camelCase/大写 id 必须能引用(曾经的回归点:整值小写归一后引用失配)
    const camelGradient = '<svg><defs><linearGradient id="myGradient"><stop offset="0" stop-color="#0AF"/><stop offset="1" stop-color="currentColor"/></linearGradient></defs><path fill="url(#myGradient)" d="M0 0L1 1"/></svg>'
    assert.equal(resolveIcon(camelGradient), camelGradient, 'camelCase id 的本地引用必须接受')
    assert.equal(resolveIcon('<svg><defs><linearGradient id="G"/></defs><path fill="url(#G)" d="M0 0L1 1"/></svg>') !== undefined, true, '大写单字符 id 引用合法')
    assert.equal(resolveIcon('<svg><defs><linearGradient id="MyGradient"/></defs><path stroke="URL(#MyGradient)" d="M0 0L1 1"/></svg>') !== undefined, true, 'url 函数名大小写不敏感且片段保留原样')
    assert.equal(resolveIcon('<svg><defs><linearGradient id="G"/></defs><path fill="url(#g)" d="M0 0L1 1"/></svg>'), undefined, 'id 大小写不匹配仍拒收')
    assert.equal(resolveIcon('<svg><defs><linearGradient id="myGradient"/></defs><path fill="url(#mygradient)" d="M0 0L1 1"/></svg>'), undefined, '片段被小写改写即失配')
    const plain = '<svg><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M0 0L1 1"/></svg>'
    assert.equal(resolveIcon(plain), plain, '内置风格属性组合接受')
    assert.equal(resolveIcon('<svg><g transform="translate(1 2)"><rect x="1" y="1" width="2" height="2" rx=".5" fill="#0af" stroke="rgb(1, 2, 3)" opacity="0.8"/></g></svg>') !== undefined, true, '几何/十六进制/rgb 接受')
    assert.equal(resolveIcon('<svg><circle cx="8" cy="8" r="5.5" fill="red" stroke="hsl(0 0% 0%)"/></svg>') !== undefined, true, '命名色与 hsl() 接受')
    assert.equal(resolveIcon('<svg class="VOzbGW_navIcon" aria-hidden="true" role="img" data-navic="1"><path d="M0 0L1 1"/></svg>') !== undefined, true, '壳层属性(含本包记账)接受')
  })

  test(prefix + '安全门矩阵(属性值策略单元):颜色门与本地引用门', () => {
    const { svgColorAllowed } = L
    const refs = []
    assert.equal(svgColorAllowed('none', refs), true)
    assert.equal(svgColorAllowed('currentColor', refs), true, '大小写归一后接受')
    assert.equal(svgColorAllowed('CURRENTCOLOR', refs), true, '关键字按小写归一,大小写不敏感')
    assert.equal(svgColorAllowed('transparent', refs), true)
    assert.equal(svgColorAllowed('#0af', refs), true)
    assert.equal(svgColorAllowed('#00aaff', refs), true)
    assert.equal(svgColorAllowed('#0AF', refs), true, '十六进制按小写归一')
    assert.equal(svgColorAllowed('rgb(1,2,3)', refs), true)
    assert.equal(svgColorAllowed('RGB(1,2,3)', refs), true, '函数名按小写归一')
    assert.equal(svgColorAllowed('rgba(1,2,3,0.5)', refs), true)
    assert.equal(svgColorAllowed('hsl(0 0% 0%)', refs), true)
    assert.equal(svgColorAllowed('red', refs), true)
    assert.equal(svgColorAllowed('url(#g)', refs), true)
    assert.deepEqual(refs, ['g'], '本地引用被登记待核验')
    // url() 片段是 DOM id,大小写敏感:登记值必须保留原样,否则与 id 侧比对必失配
    const camelRefs = []
    assert.equal(svgColorAllowed('url(#myGradient)', camelRefs), true, 'camelCase id 不得被小写归一')
    assert.deepEqual(camelRefs, ['myGradient'], '引用登记保留原始大小写')
    assert.equal(svgColorAllowed('URL(#myGradient)', camelRefs), true, 'url 函数名大小写不敏感(CSS 语义)')
    assert.deepEqual(camelRefs.slice(1), ['myGradient'])
    assert.equal(svgColorAllowed('url(#a-b_c)', camelRefs), true, '连字符/下划线片段')
    assert.equal(svgColorAllowed('url(https://evil/p.svg#g)', refs), false, '外部 URL')
    assert.equal(svgColorAllowed('url(//evil.example/p.svg#g)', refs), false, '协议相对')
    assert.equal(svgColorAllowed('url(data:image/svg+xml,<svg/>)', refs), false, 'data URL')
    assert.equal(svgColorAllowed('url(#g) red', refs), false, '兜底色语法')
    assert.equal(svgColorAllowed('expression(alert(1))', refs), false)
    assert.equal(svgColorAllowed('var(--c)', refs), false)
    assert.equal(svgColorAllowed('red;background:url(https://evil)', refs), false, '分号拼接')
    assert.equal(svgColorAllowed('', refs), false)
  })

  test(prefix + '内置图标全表过同一道门且剥壳非空(声明机制可复述内置图形)', () => {
    const { GLYPHS, ICONS, FALLBACK, resolveIcon, svgInner, svgInnerDraws } = L
    for (const name of Object.keys(GLYPHS)) {
      assert.equal(resolveIcon(GLYPHS[name]), GLYPHS[name], 'glyph ' + name + ' 应过四重白名单')
    }
    // 取图链三层的来源都必须含图元:否则 svgInner 会剥出空内容,官方图标被清空;
    // 写入后的内容判据必须一致为「在画」,否则自愈判据会把已改写的格子每帧重写
    for (const svg of [...Object.values(GLYPHS), ...Object.values(ICONS), ...FALLBACK]) {
      assert.equal(resolveIcon(svg), svg, '内置图标必须过图元门')
      assert.notEqual(svgInner(svg), '', '内置图标剥壳后必须非空')
      assert.equal(svgInnerDraws(svgInner(svg)), true, '内置图标写入后内容判据必须仍认')
    }
  })

  test(prefix + '安全门判定缓存:同值重复结果一致,溢出清空后重算仍一致', () => {
    const { resolveIcon, SVG_GATE_CACHE_MAX } = L
    const legal = '<svg><path fill="currentColor" d="M0 0L1 1"/></svg>'
    const illegal = (i) => '<svg><path style="x' + i + '" d="M0 0L1 1"/></svg>'
    assert.equal(resolveIcon(legal), legal)
    assert.equal(resolveIcon(legal), legal, '命中缓存结果不变')
    assert.equal(resolveIcon(illegal('0')), undefined)
    assert.equal(resolveIcon(illegal('0')), undefined, '拒收结果同样可缓存')
    // 灌满并越过上限:清空后早期条目须重新解析出正确结论
    for (let i = 0; i <= SVG_GATE_CACHE_MAX; i += 1) resolveIcon(illegal('flood-' + i))
    assert.equal(resolveIcon(legal), legal, '清空后合法值仍接受')
    assert.equal(resolveIcon(illegal('0')), undefined, '清空后非法值仍拒收')
  })

  test(prefix + '真实生产者声明值(跨包内联 svg)过门', () => {
    const { resolveIcon, svgInner, svgInnerDraws } = L
    // dsh-stock-assistant 的声明值(全仓唯一内联 svg 生产者),属性变更须同步该包
    const stock = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M2 2v12h12M4 10l3-4 3 2 4-5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    assert.equal(resolveIcon(stock), stock, '外部生产者声明必须仍可过门')
    assert.equal(svgInnerDraws(svgInner(stock)), true, '外部生产者声明写入后内容判据一致')
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
    const { themedIcon, FALLBACK, GLYPHS } = L
    assert.equal(themedIcon('important'), FALLBACK[poolIndexOf('important')], 'im 不命中 important')
    assert.equal(themedIcon('dbtool'), FALLBACK[poolIndexOf('dbtool')], 'db 不命中 dbtool')
    assert.equal(themedIcon('my db tool'), themedIcon('db'), '独立词 db 命中')
    // 英文复数为已知盲区(单数规则不命中复数词形),现状:落哈希池
    assert.equal(themedIcon('Notifications'), FALLBACK[poolIndexOf('Notifications')])
    // 顺序即优先级,具体语义在前:双规则同打名取靠前者
    assert.equal(themedIcon('search-bot'), themedIcon('search'), 'search 先于 bot')
    assert.equal(themedIcon('git-notify'), themedIcon('git'), 'git 先于 notify')
    // 大分类兜底:扩展类优先于 Agent 类,IM 类保持机器人;不再落随机网格
    assert.equal(themedIcon('Agent 扩展'), GLYPHS.cube, '扩展大类优先取魔方')
    assert.equal(themedIcon('Agent 管理'), GLYPHS.spark, 'Agent 大类取星芒')
    assert.equal(themedIcon('IM 机器人'), GLYPHS.bot, 'IM 大类取机器人')
    assert.equal(themedIcon('扩展工具'), GLYPHS.cube, '中文扩展关键词命中')
    // 余额语义:wallet 系关键词命中钱包图,plan 系关键词仍命中时钟
    assert.equal(themedIcon('account-balance'), GLYPHS.wallet, 'balance 命中钱包')
    assert.equal(themedIcon('my-wallet-tool'), GLYPHS.wallet, 'wallet 命中钱包')
    assert.equal(themedIcon('cron-board'), GLYPHS.plan, 'cron 仍命中时钟')
    // 仪表盘语义:dash 系关键词命中表盘图
    assert.equal(themedIcon('usage-dash'), GLYPHS.gauge, 'dash 命中表盘')
    assert.equal(themedIcon('my-dashboard'), GLYPHS.gauge, 'dashboard 命中表盘')
  })

  test(prefix + '别名等价:双语分区任一语言键命中,组外键不受影响', () => {
    const { DECLARED_ICONS, lookupWithAlias, aliasKeysOf } = L
    try {
      DECLARED_ICONS['通用设置'] = 'bell'
      assert.equal(lookupWithAlias(DECLARED_ICONS, 'General'), 'bell', '反向等价命中')
      assert.equal(lookupWithAlias(DECLARED_ICONS, '通用设置'), 'bell', '正向直查')
      assert.equal(aliasKeysOf('General').length, 2, '等价组键展开为双语两侧')
      assert.deepEqual(aliasKeysOf('插件市场'), ['插件市场'], '组外键只返回自身')
    } finally {
      delete DECLARED_ICONS['通用设置']
    }
  })

  test(prefix + '声明的别名等价:声明写在任一语言键,双语 label 都命中', () => {
    const { DECLARED_ICONS, resolveForLabel, resolveIcon } = L
    try {
      DECLARED_ICONS['General'] = 'search'
      assert.equal(resolveForLabel('通用设置'), resolveIcon('search'), '反向 label 命中声明')
    } finally {
      delete DECLARED_ICONS['General']
    }
  })

  test(prefix + '头像槽:原子节点隐藏记账,换名清旧注入不误删外来兄弟', () => {
    const { decideAvatar, applyAvatar } = L
    const removed = []
    // 注入桩物化为真实兄弟节点(innerHTML 承接图标内容),decideAvatar 的幂等
    // 判据只看槽的下一元素:注入节点必须紧邻槽体,parentInjections[0] 即它
    const img = {
      tagName: 'IMG',
      dataset: {},
      hidden: false,
      style: { display: '' },
      parentInjections: [],
      get nextElementSibling() { return img.parentInjections.length === 0 ? null : img.parentInjections[0] },
      parentElement: {
        querySelectorAll(sel) {
          return sel === '[data-navic="1"]' ? img.parentInjections.filter((n) => n.dataset.navic === '1') : []
        },
      },
      inserted: null,
      insertAdjacentHTML(pos, html) {
        img.inserted = pos + ':' + html
        const injected = {
          dataset: { navic: '1' },
          innerHTML: html,
          remove() {
            const at = img.parentInjections.indexOf(injected)
            if (at >= 0) img.parentInjections.splice(at, 1)
          },
        }
        img.parentInjections.unshift(injected)
      },
    }
    const d1 = decideAvatar(img, '某插件')
    assert.ok(d1, '首次应产出决策')
    applyAvatar(img, d1)
    assert.equal(img.hidden, true, '原子节点隐藏保留(React 持引用)')
    assert.equal(img.style.display, 'none', '行内 display:none 压过市场卡自有类规则(hidden 属性是 UA 样式可被 .av{display:grid} 覆盖)')
    assert.equal(img.dataset.navic, '某插件')
    assert.ok(img.inserted.startsWith('afterend:'), '注入跟随其后')
    assert.equal(img.parentInjections.length, 1, '注入节点物化在父容器')
    // 换名:行内带标记的旧注入清理,无标记外来兄弟不动
    const stale = { dataset: { navic: '1' }, remove() { removed.push('stale') } }
    const foreign = { dataset: {}, remove() { removed.push('foreign') } }
    img.parentInjections.push(stale, foreign)
    const d2 = decideAvatar(img, '改名插件')
    applyAvatar(img, d2)
    assert.deepEqual(removed, ['stale'], '旧注入清理,外来兄弟保留')
    assert.equal(img.dataset.navic, '改名插件')
    assert.equal(decideAvatar(img, '改名插件'), null, '同名、行内隐藏在场且注入可绘制,幂等')
    // React 重渲染清 style 保记账:放行重贴,replacePass 全量重置实现自愈
    img.style.display = ''
    const d3 = decideAvatar(img, '改名插件')
    assert.ok(d3, '行内隐藏丢失时重出决策')
    applyAvatar(img, d3)
    assert.equal(img.style.display, 'none', '重贴恢复行内隐藏')
    assert.equal(decideAvatar(img, '改名插件'), null, '重贴后回归幂等')
    assert.equal(decideAvatar(img, ''), null, '空名不决策')
  })

  // R2-I3:幂等不能只看记账 + style——注入节点被摘掉或内容为空/零绘制时必须重贴
  test(prefix + '头像槽幂等校验注入节点与内容:节点丢失/空壳/零绘制注入都重出决策', () => {
    const { decideAvatar, applyAvatar, svgInner } = L
    const makeAvatar = (injections) => {
      const av = {
        tagName: 'IMG',
        dataset: { navic: '某插件' },
        hidden: true,
        style: { display: 'none' },
        parentInjections: injections,
        get nextElementSibling() { return av.parentInjections.length === 0 ? null : av.parentInjections[0] },
        parentElement: {
          querySelectorAll(sel) {
            return sel === '[data-navic="1"]' ? av.parentInjections.filter((n) => n.dataset.navic === '1') : []
          },
        },
        insertAdjacentHTML(pos, html) {
          av.inserted = pos + ':' + html
          const injected = {
            dataset: { navic: '1' },
            innerHTML: html,
            remove() {
              const at = av.parentInjections.indexOf(injected)
              if (at >= 0) av.parentInjections.splice(at, 1)
            },
          }
          av.parentInjections.unshift(injected)
        },
      }
      return av
    }
    const drawing = { dataset: { navic: '1' }, innerHTML: '<path d="M8 1.6l1.7 4.7"></path>', remove() {} }
    const cases = [
      ['节点丢失', []],
      ['空壳注入', [{ dataset: { navic: '1' }, innerHTML: '', remove() {} }]],
      ['零绘制注入', [{ dataset: { navic: '1' }, innerHTML: '<defs><path d="M0 0L1 1"/></defs>', remove() {} }]],
      ['零长度注入', [{ dataset: { navic: '1' }, innerHTML: '<path d="M0 0L0 0"></path>', remove() {} }]],
    ]
    for (const [name, injections] of cases) {
      const av = makeAvatar(injections)
      const d = decideAvatar(av, '某插件')
      assert.ok(d, name + ':必须重出决策')
      applyAvatar(av, d)
      assert.notEqual(svgInner(av.inserted.slice('afterend:'.length)), '', name + ':重贴内容非空')
      assert.equal(decideAvatar(av, '某插件'), null, name + ':重贴后回归幂等')
    }
    const ok = makeAvatar([drawing])
    assert.equal(decideAvatar(ok, '某插件'), null, '注入内容可绘制时幂等')
    const emptyName = makeAvatar([drawing])
    assert.equal(decideAvatar(emptyName, ''), null, '空名不决策')
    const noSibling = { dataset: { navic: '某插件' }, style: { display: 'none' }, nextElementSibling: null }
    assert.ok(decideAvatar(noSibling, '某插件'), '槽后无节点时无法确认注入,必须重出决策')
    // R3-I3-3:同父双槽不得串槽——注入只满足它紧邻的那个槽
    const sharedInjection = { dataset: { navic: '1' }, innerHTML: '<path d="M8 1.6l1.7 4.7"></path>', remove() {} }
    const sharedParent = {
      querySelectorAll(sel) {
        return sel === '[data-navic="1"]' ? [sharedInjection].filter((n) => n.dataset.navic === '1') : []
      },
    }
    const slotA = { dataset: { navic: '插件甲' }, style: { display: 'none' }, parentElement: sharedParent, nextElementSibling: sharedInjection }
    const slotB = { dataset: { navic: '插件乙' }, style: { display: 'none' }, parentElement: sharedParent, nextElementSibling: { dataset: {}, innerHTML: '' } }
    assert.equal(decideAvatar(slotA, '插件甲'), null, '紧邻注入的槽幂等')
    assert.ok(decideAvatar(slotB, '插件乙'), '另一个槽不得被相邻槽的注入满足')
  })

  test(prefix + '头像槽:div 与 img 同构(隐藏+跟随),不再清空子树', () => {
    const { decideAvatar, applyAvatar } = L
    const div = {
      tagName: 'DIV',
      dataset: {},
      textContent: 'X',
      hidden: false,
      style: { display: '' },
      parentElement: { querySelectorAll(sel) { return sel === '[data-navic="1"]' ? [] : [] } },
      inserted: null,
      insertAdjacentHTML(pos, html) { div.inserted = pos + ':' + html },
    }
    const d = decideAvatar(div, '另一插件')
    applyAvatar(div, d)
    assert.equal(div.hidden, true, '色块节点隐藏(React 受管子树不触碰)')
    assert.equal(div.style.display, 'none', '行内隐藏与 img 同构')
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
  assert.deepEqual(logic.GEAR_PATHS, client.GEAR_PATHS, '两代齿轮前缀同源')
  assert.deepEqual(logic.ALIAS_GROUPS, client.ALIAS_GROUPS, '别名组同源')
})

// 安全门文法常量与文法正则:长度/深度/缓存上界与六条正则(ID/hex/函数/关键字/
// 本地引用/sprite 名)原文逐项对表
test('两份实现安全门文法常量与正则逐项同源(含 SVG_MAX_DEPTH 与六条文法正则)', () => {
  assertSafetyParity(client)
})

// 负向验证:同源断言必须是"活"的。只改 client 侧 LOGIC 段的一处常量/正则,
// 同源断言必须立刻变红——否则"改大 SVG_MAX_DEPTH 测试仍绿"就是自证循环。
test('负向验证:安全常量/正则单边漂移必被同源断言捕获', () => {
  const mutations = [
    ['SVG_MAX_DEPTH', 'const SVG_MAX_DEPTH = 8', 'const SVG_MAX_DEPTH = 9'],
    ['SVG_KEYWORD_RE', 'const SVG_KEYWORD_RE = /^[a-z]{3,24}$/', 'const SVG_KEYWORD_RE = /^[a-z]{3,25}$/'],
  ]
  for (const [name, from, to] of mutations) {
    const drifted = clientLogic({
      mutateSection: (section) => {
        const mutated = section.replace(from, to)
        assert.notEqual(mutated, section, '突变必须命中源码: ' + name)
        return mutated
      },
    })
    assert.notEqual(String(drifted[name]), String(logic[name]), '突变已生效: ' + name)
    assert.throws(() => assertSafetyParity(drifted), new RegExp(name), '同源断言未捕获漂移: ' + name)
  }
  // 未突变的第二实现仍通过:证明上一轮 throws 来自漂移而非断言恒抛
  assertSafetyParity(client)
})

test('两份实现安全门白名单同源(标签/全局属性/按标签属性/颜色属性/图元表/非渲染子树)', () => {
  assert.deepEqual(logic.SVG_TAG_ALLOW, client.SVG_TAG_ALLOW, '标签白名单同源')
  assert.deepEqual(logic.SVG_ATTR_GLOBAL, client.SVG_ATTR_GLOBAL, '全局属性白名单同源')
  assert.deepEqual(logic.SVG_COLOR_ATTRS, client.SVG_COLOR_ATTRS, '颜色属性集同源')
  assert.deepEqual(logic.SVG_SHAPE_ATTRS, client.SVG_SHAPE_ATTRS, '图元表同源(零绘制判定依据)')
  assert.deepEqual(logic.SVG_NON_RENDERED, client.SVG_NON_RENDERED, '非渲染子树集同源(defs 内图元不算绘制)')
  // 片段判定的两条扫描正则与坐标正则同样必须逐项同源
  assert.deepEqual(logic.SVG_POINTS_MIN_PAIRS, client.SVG_POINTS_MIN_PAIRS, '点集最小对数漂移')
  assert.deepEqual(logic.SVG_PATH_PARAMS, client.SVG_PATH_PARAMS, 'path 命令参数表漂移')
  assert.deepEqual(logic.SVG_PATH_COMMAND_RE, client.SVG_PATH_COMMAND_RE, 'path 命令判定正则漂移(source+flags)')
  assert.deepEqual(logic.SVG_PATH_TOKEN_RE, client.SVG_PATH_TOKEN_RE, 'path 分词正则漂移(source+flags)')
  assert.deepEqual(logic.SVG_FRAGMENT_TAG_RE, client.SVG_FRAGMENT_TAG_RE, 'DOM 内容标签扫描正则漂移(source+flags)')
  assert.deepEqual(logic.SVG_FRAGMENT_ATTR_RE, client.SVG_FRAGMENT_ATTR_RE, 'DOM 内容属性扫描正则漂移(source+flags)')
  assert.deepEqual(Object.keys(logic.SVG_ATTR_BY_TAG).sort(), Object.keys(client.SVG_ATTR_BY_TAG).sort(), '按标签属性表键集同源')
  for (const tag of Object.keys(logic.SVG_ATTR_BY_TAG)) {
    assert.deepEqual(logic.SVG_ATTR_BY_TAG[tag], client.SVG_ATTR_BY_TAG[tag], tag + ' 专有属性表漂移')
  }
  // 每个标签的合法绘制属性都应有归属(防单边漏登记后静默失配)
  for (const tag of logic.SVG_TAG_ALLOW) {
    assert.ok(Object.hasOwn(logic.SVG_ATTR_BY_TAG, tag), '标签 ' + tag + ' 缺少专有属性表')
  }
  // 图元表的标签与几何属性必须落在既有白名单内,否则判定依据与解析器脱钩
  for (const tag of Object.keys(logic.SVG_SHAPE_ATTRS)) {
    assert.ok(logic.SVG_TAG_ALLOW.has(tag), '图元标签必须在标签白名单内: ' + tag)
    for (const name of logic.SVG_SHAPE_ATTRS[tag]) {
      assert.ok(logic.SVG_ATTR_BY_TAG[tag].has(name), '图元几何属性必须在标签专有属性表内: ' + tag + '.' + name)
    }
  }
})

test('两份实现 ICONS/GLYPHS/FALLBACK 全量同源', () => {
  assert.deepEqual(logic.ICONS, client.ICONS)
  assert.deepEqual(logic.GLYPHS, client.GLYPHS)
  assert.deepEqual(logic.FALLBACK, client.FALLBACK)
  assert.equal(logic.poolIndexOf('某新装分区'), client.poolIndexOf('某新装分区'))
})

test('两份实现 NAME_RULES 全量同源(含标志位)', () => {
  assert.equal(logic.NAME_RULES.length, client.NAME_RULES.length)
  for (let i = 0; i < logic.NAME_RULES.length; i += 1) {
    assert.equal(logic.NAME_RULES[i].re.source, client.NAME_RULES[i].re.source, '规则 ' + i + ' 正则漂移')
    assert.equal(logic.NAME_RULES[i].re.flags, client.NAME_RULES[i].re.flags, '规则 ' + i + ' 标志漂移')
    assert.equal(logic.NAME_RULES[i].icon, client.NAME_RULES[i].icon, '规则 ' + i + ' 图标漂移')
  }
})

test('兼容性测试文档的声明载荷可过图元门(否则人工核对项必然假红)', () => {
  const doc = readFileSync(join(PKG_ROOT, '兼容性测试.md'), 'utf8')
  // 文档里的 path 载荷只用于承载「攻击面拒收 / 合法面接受」判定,d 本身必须能画出
  // 内容;只写 moveto 或零长度段的载荷会被图元门拒收,人工核对项随即恒假
  const payloads = [...doc.matchAll(/<path[^>]*?\sd="([^"]*)"/g)].map((match) => match[1])
  assert.ok(payloads.length > 0, '兼容性测试文档缺少 path 载荷')
  for (const d of payloads) {
    assert.equal(logic.pathDraws(d), true, '文档载荷零绘制会令人工核对假红: d="' + d + '"')
  }
})

test('README 契约:glyph 清单 / 关键词规则组数 / 内置映射表与实现逐项一致', () => {
  const readme = readFileSync(join(PKG_ROOT, 'README.md'), 'utf8')
  // 1. 声明机制节的 glyph 名清单是 README 对生产者的取值承诺,按序逐名对表
  const glyphList = /内置 glyph 名\(`([^`]+)`\)/.exec(readme)
  assert.ok(glyphList !== null, 'README 缺少内置 glyph 名清单')
  assert.deepEqual(glyphList[1].split('/'), Object.keys(logic.GLYPHS), 'README glyph 清单与 GLYPHS 漂移')
  // 2. 关键词规则组数
  const ruleCount = /等 (\d+) 组规则/.exec(readme)
  assert.ok(ruleCount !== null, 'README 缺少关键词规则组数')
  assert.equal(Number(ruleCount[1]), logic.NAME_RULES.length, 'README 规则组数与 NAME_RULES 漂移')
  // 3. 内置映射表覆盖 ICONS 全键(一行可写「中文 / English」双键;键名自带 " / " 时整格是一个键)
  const start = readme.indexOf('## 内置映射表')
  const end = readme.indexOf('## 实现要点')
  assert.ok(start >= 0 && end > start, 'README 缺少内置映射表节')
  const keys = Object.keys(logic.ICONS)
  const covered = []
  let rows = 0
  for (const line of readme.slice(start, end).split('\n')) {
    const m = /^\|\s*([^|]+?)\s*\|[^|]+\|$/.exec(line)
    if (m === null) continue
    const cell = m[1].trim()
    if (cell === '分区显示文本' || /^-+$/.test(cell)) continue
    rows += 1
    const parts = cell.split(' / ')
    const labels = parts.length > 1 && parts.every((part) => keys.includes(part)) ? parts : [cell]
    for (const label of labels) {
      assert.ok(keys.includes(label), 'README 内置映射表出现非 ICONS 键: ' + cell)
      covered.push(label)
    }
  }
  assert.ok(rows > 0, 'README 内置映射表为空')
  assert.deepEqual(covered.sort(), keys.slice().sort(), 'README 内置映射表与 ICONS 键集漂移')
})

test('官方 sprite 原样重建:data-icon 形态门拦畸形属性值', () => {
  const cases = [
    ['dsw-icon-settings-outline-medium', '<use href="#dsw-icon-settings-outline-medium"></use>'],
    ['a-b_c', '<use href="#a-b_c"></use>'],
    ['', null],
    ['x" onload="alert(1)', null],
    ['a b', null],
    ['#a', null],
    ['<script>', null],
  ]
  for (const L of [logic, client]) {
    for (const [icon, expected] of cases) {
      const svg = {
        getAttribute(name) { return name === 'data-icon' ? icon : null },
        dataset: {},
      }
      assert.equal(L.officialSpriteRestore(svg), expected, 'data-icon=' + JSON.stringify(icon))
    }
    assert.equal(L.officialSpriteRestore({ getAttribute() { return null }, dataset: {} }), null, '无自描述属性不重建')
  }
})

test('LOGIC 段与 logic.mjs 决策函数逐函数源码一致(归一化注释与空白)', () => {
  const normalize = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, '')
  for (const name of ['resolveIcon', 'svgMarkupAllowed', 'svgAttributeAllowed', 'svgColorAllowed', 'pathDraws', 'svgShapeDraws', 'svgInnerDraws', 'svgInner', 'resolveForLabel', 'themedIcon', 'lookupWithAlias', 'aliasKeysOf', 'isGear', 'officialSpriteRestore', 'clearInjected', 'decide', 'applyDecision', 'decideAvatar', 'avatarApplied', 'applyAvatar', 'poolIndexOf']) {
    assert.equal(
      normalize(client[name].toString()),
      normalize(logic[name].toString()),
      'LOGIC 段与 logic.mjs 漂移: ' + name,
    )
  }
})
