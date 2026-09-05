// 设置导航图标 Client 半区:按分区显示文本把回退齿轮换成专属图形。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory})。
// 背景见 README「实现边界」:settings.* 子槽声明权被原版条目占用,
// 接管 Shell 不可行,DOM 观察是唯一不依赖官方契约变更的路径。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-settings-nav-icons',
  factory(require) {
    // ---- 官方 DOM 字面量标识(设置弹窗导航,CSS Modules 哈希前缀稳定) ----

    const SELECTOR_CELL = 'button.VOzbGW_navCell'
    const SELECTOR_LABEL = '.VOzbGW_navLabel'
    const SELECTOR_ICON = 'svg'
    const ATTR_MARK = 'data-navic'

    /* LOGIC-BEGIN */
    // 纯逻辑层:图标映射 + 单元格替换决策,与 src/logic.mjs 同源,由 parity 测试保证。

    // SVG 字面量构造:16×16 stroke 轮廓,与官方 IconOutline16 视觉节奏一致。
    const STROKE_ATTRS = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'

    function svgOf(inner) {
      return '<svg ' + ATTR_MARK + '="1" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" class="VOzbGW_navIcon" aria-hidden="true">' + inner + '</svg>'
    }

    function pathOf(d) {
      return '<path d="' + d + '" ' + STROKE_ATTRS + '/>'
    }

    function circleOf(cx, cy, r) {
      return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" ' + STROKE_ATTRS + '/>'
    }

    function dotOf(cx, cy, r) {
      return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="currentColor"/>'
    }

    function rectOf(x, y, w, h, rx) {
      return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + rx + '" ' + STROKE_ATTRS + '/>'
    }

    function ellipseOf(cx, cy, rx, ry) {
      return '<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + rx + '" ry="' + ry + '" ' + STROKE_ATTRS + '/>'
    }

    const TUNE = svgOf(
      pathOf('M2.5 5h4.6') + pathOf('M10.9 5h2.6') + circleOf('9.2', '5', '1.7') +
      pathOf('M2.5 11h2.4') + pathOf('M8.6 11h4.9') + circleOf('6.9', '11', '1.7'))
    const THEME = svgOf(pathOf('M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 1 0-11z'))
    const BOT = svgOf(
      pathOf('M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8.6l-2.9 2.4a.4.4 0 0 1-.66-.31V11.4A2 2 0 0 1 2.5 9.5z') +
      dotOf('6', '7', '0.9') + dotOf('10', '7', '0.9'))
    const MARKET = svgOf(
      pathOf('M2.5 6.5 3.4 3h9.2l.9 3.5') +
      pathOf('M2.5 6.5a1.75 1.75 0 0 0 3.5 0') + pathOf('M6.25 6.5a1.75 1.75 0 0 0 3.5 0') + pathOf('M10 6.5a1.75 1.75 0 0 0 3.5 0') +
      pathOf('M3.2 8.8V13h9.6V8.8') + pathOf('M6.4 13v-3.1h3.2V13'))
    const CUBE = svgOf(
      pathOf('M8 1.8 13.5 4.9v6.2L8 14.2 2.5 11.1V4.9z') +
      pathOf('M8 8 2.5 4.9') + pathOf('M8 8l5.5-3.1') + pathOf('M8 8v6.2'))
    const MCP = svgOf(
      pathOf('M2.5 3.5h11v3.4h-11z') + pathOf('M2.5 9.1h11v3.4h-11z') +
      dotOf('5', '5.2', '0.85') + dotOf('5', '10.8', '0.85'))
    const SHIELD = svgOf(
      pathOf('M8 1.8 13 3.6v4.2c0 3.2-2.1 5.4-5 6.4-2.9-1-5-3.2-5-6.4V3.6z') +
      pathOf('m5.8 7.9 1.6 1.6 2.8-3'))
    const CARDS = svgOf('<rect x="2.5" y="3" width="11" height="10" rx="1.5" ' + STROKE_ATTRS + '/>' + pathOf('M6.6 3v10'))
    const PLAN = svgOf(
      circleOf('8', '8', '5.5') +
      pathOf('M8 5v3.2l2.2 1.6'))
    const BELL = svgOf(
      pathOf('M8 2.2a4 4 0 0 1 4 4v2.4l1.3 2.4a.5.5 0 0 1-.44.74H3.14a.5.5 0 0 1-.44-.74L4 8.6V6.2a4 4 0 0 1 4-4z') +
      pathOf('M6.6 13.2a1.5 1.5 0 0 0 2.8 0'))
    const WRENCH = svgOf(
      pathOf('M13.2 5.6a3.6 3.6 0 0 1-4.9 4.35L4.6 13.6a1.3 1.3 0 0 1-1.84-1.84L6.4 8.05A3.6 3.6 0 0 1 10.75 3.2L8.9 5.05l.4 1.65 1.65.4z'))
    const ARCHIVE = svgOf(
      '<rect x="2.5" y="2.8" width="11" height="3" rx="0.8" ' + STROKE_ATTRS + '/>' +
      pathOf('M3.8 5.8V12.6a.8.8 0 0 0 .8.8h6.8a.8.8 0 0 0 .8-.8V5.8') +
      pathOf('M6.4 8.6h3.2'))

    // 备用池:未收录分区不再露齿轮,按 label 稳定哈希取一个中性图形。
    const SPARK = svgOf(pathOf('M8 1.6l1.7 4.7 4.7 1.7-4.7 1.7L8 14.4 6.3 9.7 1.6 8l4.7-1.7z'))
    const LAYERS = svgOf(
      pathOf('m8 1.9 5.5 2.8L8 7.5 2.5 4.7z') +
      pathOf('M2.5 8.1 8 10.9l5.5-2.8') + pathOf('M2.5 11.3 8 14.1l5.5-2.8'))
    const TAG = svgOf(
      pathOf('M2.5 2.5h4.4l6.6 6.6-4.4 4.4-6.6-6.6z') + dotOf('5.5', '5.5', '0.9'))
    const GRID = svgOf(
      '<rect x="2.4" y="2.4" width="4.7" height="4.7" rx="1" ' + STROKE_ATTRS + '/>' +
      '<rect x="8.9" y="2.4" width="4.7" height="4.7" rx="1" ' + STROKE_ATTRS + '/>' +
      '<rect x="2.4" y="8.9" width="4.7" height="4.7" rx="1" ' + STROKE_ATTRS + '/>' +
      '<rect x="8.9" y="8.9" width="4.7" height="4.7" rx="1" ' + STROKE_ATTRS + '/>')
    const GIT = svgOf(
      circleOf('4.5', '4', '1.6') + circleOf('4.5', '12', '1.6') + circleOf('11.5', '6.5', '1.6') +
      pathOf('M4.5 5.6v4.8') + pathOf('M11.5 8.1c0 2.2-1.8 3-4 3'))
    const SEARCH = svgOf(circleOf('7', '7', '4.2') + pathOf('M10.2 10.2 13.6 13.6'))
    const TERM = svgOf(
      rectOf('2.5', '3', '11', '10', '1.2') +
      pathOf('M5.2 6.2 7.6 8.5 5.2 10.8') + pathOf('M9.2 11h2.6'))
    const CHART = svgOf(
      pathOf('M3 3v10.2h10') +
      pathOf('M6.2 10.5V7.2') + pathOf('M9 10.5V5.4') + pathOf('M11.8 10.5V8.8'))
    const CODE = svgOf(
      pathOf('M5.6 4.4 2 8l3.6 3.6') + pathOf('M10.4 4.4 14 8l-3.6 3.6'))
    const DOC = svgOf(
      pathOf('M4 2.5h4.6L12 5.9V13a.8.8 0 0 1-.8.8H4.8A.8.8 0 0 1 4 13z') +
      pathOf('M8.6 2.5v3.4H12'))
    const DB = svgOf(
      ellipseOf('8', '4.3', '5.2', '1.7') +
      pathOf('M2.8 4.3v7.4c0 .94 2.33 1.7 5.2 1.7s5.2-.76 5.2-1.7V4.3') +
      pathOf('M2.8 8c0 .94 2.33 1.7 5.2 1.7S13.2 8.94 13.2 8'))
    const FLOW = svgOf(
      rectOf('2.4', '2.4', '4.8', '3.6', '1') + rectOf('8.8', '10', '4.8', '3.6', '1') +
      pathOf('M7.2 4.2h3.3a1.5 1.5 0 0 1 1.5 1.5v3.7'))
    const GLOBE = svgOf(
      circleOf('8', '8', '5.5') +
      pathOf('M2.5 8h11') +
      pathOf('M8 2.5c1.7 1.7 2.6 3.5 2.6 5.5S9.7 11.8 8 13.5C6.3 11.8 5.4 10 5.4 8S6.3 4.2 8 2.5z'))
    const LOCK = svgOf(
      rectOf('3.6', '7.2', '8.8', '6', '1.2') +
      pathOf('M5.6 7.2V5.4a2.4 2.4 0 0 1 4.8 0v1.8') + dotOf('8', '10.2', '0.9'))
    const IMAGE = svgOf(
      rectOf('2.5', '3', '11', '10', '1.2') +
      circleOf('5.9', '6.1', '1') + pathOf('m3.6 12 3-3 2.3 2.3 1.7-1.7 1.9 1.9'))
    const ZAP = svgOf(pathOf('M8.9 1.8 3.8 8.9h3.5L7 14.2l5.2-7.1H8.6z'))
    const FALLBACK = [SPARK, LAYERS, TAG, GRID]

    // 内置 glyph 名称表:声明值可用名称引用内置图形,避免跨插件复制 svg。
    const GLYPHS = {
      tune: TUNE, theme: THEME, bot: BOT, market: MARKET, cube: CUBE, mcp: MCP,
      shield: SHIELD, cards: CARDS, plan: PLAN, bell: BELL, wrench: WRENCH,
      archive: ARCHIVE, spark: SPARK, layers: LAYERS, tag: TAG, grid: GRID,
      git: GIT, search: SEARCH, term: TERM, chart: CHART, code: CODE, doc: DOC,
      db: DB, flow: FLOW, globe: GLOBE, lock: LOCK, image: IMAGE, zap: ZAP,
    }

    // 声明值解析与安全门:svg 字符串须完整开标签且不带事件属性/外联/内嵌载体,
    // 超长拒绝;glyph 名称查表(原型链成员经 typeof 收口不可能混入);非法值返回 undefined。
    const SVG_MAX_CHARS = 4 * 1024
    function resolveIcon(value) {
      if (typeof value !== 'string') return undefined
      const trimmed = value.trim()
      if (
        trimmed.length <= SVG_MAX_CHARS
        && /^<svg[\s>]/.test(trimmed)
        && !/\son[a-z]+\s*=/i.test(trimmed)
        && !/<foreignObject/i.test(trimmed)
        && !/javascript:/i.test(trimmed)
      ) return trimmed
      return typeof GLYPHS[trimmed] === 'string' ? GLYPHS[trimmed] : undefined
    }

    // 名称关键词 → 主题图标;整词边界匹配,短词(im/db/ai)不误伤子串。
    // 顺序即优先级,具体语义在前。覆盖 dsh-market 目录内全部插件:
    // 命中者得语义图,未命中者走哈希备用池。
    const NAME_RULES = [
      ['git', GIT],
      ['search|find|seek', SEARCH],
      ['term|tui|shell|console|cli', TERM],
      ['theme|skin|style|css', THEME],
      ['translate|i18n|lang|locale|globe', GLOBE],
      ['image|vision|pic|photo|shot|ocr', IMAGE],
      ['doc|note|file|markdown|wiki', DOC],
      ['database|sqlite|redis|cache|db', DB],
      ['session|archive|history', ARCHIVE],
      ['usage|stat|meter|monitor|radar|metric', CHART],
      ['flow|workflow|pipeline|task|job|queue', FLOW],
      ['auth|login|pass|secret|token|lock|guard|crypt', SHIELD],
      ['mcp', MCP],
      ['market|store|registry|catalog', MARKET],
      ['im|chat|msg|notify|notif|bot|bark|wechat|qq|telegram|wecom|dingtalk|push', BOT],
      ['plan|time|timer|clock|calendar|cron', PLAN],
      ['code|lint|graph|dev|debug|patch', CODE],
      ['llm|gpt|claude|deepseek|gemini|prompt|think|reason', SPARK],
      ['zap|flash|fast|quick|boost|speed|turbo', ZAP],
    ].map(function (pair) { return { re: new RegExp('(^|[^a-z])(' + pair[0] + ')([^a-z]|$)'), icon: pair[1] } })

    // 插件名/分区 label 两级取图:外部声明 → 关键词主题图 → 稳定哈希备用池。
    function themedIcon(name) {
      const declared = resolveIcon(DECLARED_ICONS[name])
      if (declared !== undefined) return declared
      const n = name.toLowerCase()
      for (const rule of NAME_RULES) {
        if (rule.re.test(n)) return rule.icon
      }
      return FALLBACK[poolIndexOf(name)]
    }

    // 市场卡片头像槽决策:img(作者头像)整体换插件图标;div(字母色块)清空后内嵌。
    // 记账值 = 插件名,换名重贴由该比较驱动。
    function decideAvatar(av, name) {
      if (name === '' || av.dataset.navic === name) return null
      return { name, html: themedIcon(name), old: av }
    }

    function applyAvatar(av, decision) {
      if (av.tagName === 'IMG') {
        // IMG 不移除(React 持引用,移除后 reconcile 复活会双图):隐藏并记账,
        // 注入图标跟随其后;换名重贴时先移除上次注入的图标防重复
        av.hidden = true
        av.dataset.navic = decision.name
        const stale = av.nextElementSibling
        if (stale !== null && stale.dataset.navic === '1') stale.remove()
        av.insertAdjacentHTML('afterend', decision.html)
        return
      }
      av.textContent = ''
      av.insertAdjacentHTML('beforeend', decision.html)
      av.dataset.navic = decision.name
    }

    // 官方默认齿轮首段路径前缀,用于识别"未装饰"单元格。
    const GEAR_PATH = 'M14.0861'

    function isGear(svg) {
      return svg.querySelector('path[d^="' + GEAR_PATH + '"]') !== null
    }

    // 稳定哈希:同一 label 永远取同一个池内图标,重渲染不闪动。
    function poolIndexOf(label) {
      let h = 0
      for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0
      return Math.abs(h) % FALLBACK.length
    }

    // 分区显示文本 → 图标;映射键是文本而非分区 id:id 不进 DOM,文本是唯一稳定锚点。
    // 使用统计(usage-statistics-panel)自带柱状图,不收录。
    // 内置映射仅收官方与无法改源的第三方分区;自有插件分区由各插件声明。
    const ICONS = {
      '通用设置': TUNE, 'General': TUNE,
      'Theme / 外观': THEME,
      'IM机器人': BOT,
      '插件市场': MARKET,
      'Agent Plugins 市场': CUBE,
      'MCP 服务': MCP,
      '认证': SHIELD,
      '侧边卡片': CARDS,
    }

    // 外部声明注册表:其他插件经 window.__navicIcons.register({label: icon}) 声明,
    // 键为分区 label 或插件名,值为 16×16 svg 字符串或内置 glyph 名。声明优先于
    // 内置映射与关键词推导。无原型隔离时 label 恰为 constructor/toString 等会查到
    // 继承成员;污染面收敛在 window.__navicIcons 单一命名空间。
    const DECLARED_ICONS = Object.create(null)

    // 单元格替换判定:先看记账与现役图标;label 有声明或内置映射直接换,
    // 未映射时官方原生图形(非齿轮且非本插件所贴)一律不动,齿轮与本插件所贴
    // 按 themedIcon(声明→关键词→哈希)兜底。
    // 幂等判定与注入内容解耦:记账 label 匹配且现役图标非官方齿轮即视为已处理,
    // 外部声明内容是否自带标记不影响短路;label 变化(如语言切换)则按新 label 重贴。
    function decide(cell) {
      const labelNode = cell.querySelector(SELECTOR_LABEL)
      if (labelNode === null) return null
      const label = (labelNode.textContent || '').trim()
      if (label === '') return null
      const old = cell.querySelector(SELECTOR_ICON)
      if (old === null) return null
      if (cell.dataset.navic === label && !isGear(old)) return null
      let html = resolveIcon(DECLARED_ICONS[label])
      if (html === undefined) html = ICONS[label]
      if (html === undefined) {
        if (!isGear(old) && old.dataset.navic !== '1') return null
        html = themedIcon(label)
      }
      return { label, html, old }
    }

    function applyDecision(cell, decision) {
      decision.old.insertAdjacentHTML('afterend', decision.html)
      decision.old.remove()
      cell.dataset.navic = decision.label
    }

    /* LOGIC-END */

    // ---- 市场卡片 DOM 锚点(css-modules 哈希前缀随版本变,按后缀匹配) ----

    const SELECTOR_AV = '[class$="_av"]'
    const SELECTOR_ROW1 = '[class$="_row1"]'
    const SELECTOR_NM = 'a[class*="_nm"]'

    let pending = false
    let rafId = 0
    let observer = null

    function replacePass() {
      pending = false
      const cells = document.querySelectorAll(SELECTOR_CELL)
      for (const cell of cells) {
        try {
          const decision = decide(cell)
          if (decision !== null) applyDecision(cell, decision)
        } catch (error) {
          // 单项异常不中断当轮剩余处理(宿主 DOM 形态漂移是常态风险),告警后继续
          console.warn('[nav-icons] 单元格处理失败', error)
        }
      }
      for (const av of document.querySelectorAll(SELECTOR_AV)) {
        try {
          const row1 = av.closest(SELECTOR_ROW1)
          if (row1 === null) continue
          const nm = row1.querySelector(SELECTOR_NM)
          if (nm === null) continue
          const name = (nm.textContent || '').trim()
          const decision = decideAvatar(av, name)
          if (decision !== null) applyAvatar(av, decision)
        } catch (error) {
          console.warn('[nav-icons] 头像槽处理失败', error)
        }
      }
    }

    function schedule() {
      if (pending) return
      pending = true
      rafId = requestAnimationFrame(replacePass)
    }

    // 声明持久层:client 半区热重载会重跑 factory 而生产者不重发,声明外置 window
    // 纯数据,新实例启动时恢复;页面刷新随 window 释放
    const DECLARATIONS_STORE = '__navicIconDeclarations'
    function restoreDeclarations() {
      const saved = window[DECLARATIONS_STORE]
      if (saved !== null && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const key of Object.keys(saved)) DECLARED_ICONS[key] = saved[key]
      }
    }
    function persistDeclarations() {
      window[DECLARATIONS_STORE] = Object.assign({}, DECLARED_ICONS)
    }

    // 声明入口:值经 resolveIcon 归一化(非法值撤销声明走默认管线,与 README 承诺一致),
    // 同值幂等短路;仅值发生变更的键清记账重贴,无关分区不抖动。
    // 时序无关:本插件未就绪时调用方入队等待。
    function registerIcons(entries) {
      if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return
      const touched = []
      for (const key of Object.keys(entries)) {
        if (key === '__proto__') continue
        const resolved = resolveIcon(entries[key])
        if (resolved === undefined) {
          if (DECLARED_ICONS[key] !== undefined) {
            delete DECLARED_ICONS[key]
            touched.push(key)
          }
          continue
        }
        if (DECLARED_ICONS[key] === resolved) continue
        DECLARED_ICONS[key] = resolved
        touched.push(key)
      }
      if (touched.length === 0) return
      persistDeclarations()
      // 只清受影响 label/插件名的记账: 无关分区不重贴(svg 的纯标记 '1' 不命中声明键)
      for (const el of document.querySelectorAll('[' + ATTR_MARK + ']')) {
        if (touched.indexOf(el.dataset.navic) >= 0) delete el.dataset.navic
      }
      schedule()
    }

    function drainQueue() {
      const queue = window.__navicIconQueue
      if (Array.isArray(queue)) {
        for (const entries of queue) registerIcons(entries)
      }
      window.__navicIconQueue = {
        push(items) { registerIcons(items) },
      }
    }

    function start() {
      restoreDeclarations()
      observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      drainQueue()
      replacePass()
    }

    function stop() {
      if (observer !== null) {
        observer.disconnect()
        observer = null
      }
      if (rafId !== 0) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      pending = false
      // 队列恢复数组形态: 卸载后生产者按 README 惯用法入队等待下一实例,
      // 而不是驱动已停止实例改写 DOM
      window.__navicIconQueue = []
    }

    return {
      inject: [],
      apply(ctx) {
        ctx.effect(() => {
          start()
          const api = { register: registerIcons }
          window.__navicIcons = api
          return () => {
            stop()
            if (window.__navicIcons === api) delete window.__navicIcons
          }
        }, 'settings-nav-icons: gear replacement observer')
      },
    }
  },
})
