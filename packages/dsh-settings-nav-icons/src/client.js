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
    const ATTR_MARK = 'data-navic'

    // ---- 设置导航滚动补偿:官方 navList 高度随内容撑开,溢出被 panel hidden
    // 裁剪且无滚动机制,分区一多底部即不可达。样式表形态一次注入,对弹窗重开
    // 等任意 React 重渲染持续生效;类名锚定与上方单元格同策略(哈希前缀字面量)。

    const NAVLIST_SCROLL_CSS = '.VOzbGW_navList{flex:1 1 0;min-height:0;overflow-y:auto;scrollbar-width:thin}'

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

    // 声明值解析与安全门:svg 须完整开标签(大小写不敏感)且单根闭合(首个 </svg>
    // 后不得再有内容,堵尾缀活动 HTML);不带事件属性(\b 前界堵斜杠分隔绕过)、
    // 不带脚本/样式/SMIL 动画载体(内联 svg 的 style 全文档生效,@import 外联可达)、
    // 不带 href/xlink:href 与 SMIL attributeName 注入(16×16 静态图标无合法引用/
    // 动画场景,外联与事件注入一并封死),超长拒绝;glyph 名称查表(原型链成员经
    // typeof 收口不可能混入);非法值返回 undefined。
    const SVG_MAX_CHARS = 4 * 1024
    function resolveIcon(value) {
      if (typeof value !== 'string') return undefined
      const trimmed = value.trim()
      if (
        trimmed.length <= SVG_MAX_CHARS
        && /^<svg[\s>]/i.test(trimmed)
        && /<\/svg>\s*$/i.test(trimmed)
        && !/\bon[a-z]+\s*=/i.test(trimmed)
        && !/<foreignObject/i.test(trimmed)
        && !/<script[\s/>]/i.test(trimmed)
        && !/<style[\s/>]/i.test(trimmed)
        && !/<(animate|animatemotion|animatetransform|set)[\s/>]/i.test(trimmed)
        && !/\b(xlink:)?href\s*=/i.test(trimmed)
        && !/attributeName\s*=\s*["']?\s*(xlink:)?href/i.test(trimmed)
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

    // 分区取图全链:声明 → 内置映射 → 关键词/哈希兜底。decide 与声明变更就地
    // 重写共用;撤销内置分区声明时回退必须含内置映射,否则卡死在哈希图。
    function resolveForLabel(label) {
      const declared = resolveIcon(DECLARED_ICONS[label])
      if (declared !== undefined) return declared
      const mapped = ICONS[label]
      if (mapped !== undefined) return mapped
      return themedIcon(label)
    }

    // 市场卡片头像槽决策:img(作者头像)与 div(字母色块)同构处理——原子节点隐藏,
    // 插件图标注入跟随。记账值 = 插件名,换名重贴由该比较驱动。
    function decideAvatar(av, name) {
      if (name === '' || av.dataset.navic === name) return null
      return { name, html: themedIcon(name), av }
    }

    function applyAvatar(av, decision) {
      // 原子节点不移除(React 持引用,移除/清空子树后 reconcile 报错):隐藏并记账,
      // 注入图标跟随其后;重贴先清行内上次注入的图标(父容器范围扫描,防槽体被
      // 外部替换后旧注入成孤儿双图)
      av.hidden = true
      av.dataset.navic = decision.name
      const parent = av.parentElement
      if (parent !== null) {
        for (const injected of parent.querySelectorAll('[' + ATTR_MARK + '="1"]')) injected.remove()
      }
      av.insertAdjacentHTML('afterend', decision.html)
    }

    // 官方默认齿轮首段路径前缀,用于识别"未装饰"单元格。
    const GEAR_PATH = 'M14.0861'

    function isGear(svg) {
      return svg.querySelector('path[d^="' + GEAR_PATH + '"]') !== null
    }

    // 完整 svg 字符串剥壳取内部内容:resolveIcon 输出与 GLYPHS/声明值均为完整 svg,
    // 内容改写制只写 official.innerHTML,壳由本函数剥除。输入已过安全门(单根闭合)。
    function svgInner(html) {
      return html.replace(/^<svg[^>]*>/i, '').replace(/<\/svg>\s*$/i, '')
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

    // 单元格改写判定(内容改写制):不新建 svg、不动属性,直接把官方齿轮 svg 的
    // 内部内容改写为本插件图标;记账迁到官方 svg 自身(dataset.navic = label),
    // 节点与 class/位置等属性保持官方原样,第三方对官方图标的 CSS/选择器处理
    // 照常作用于改写结果(dream-skin 藏首 svg 的规则命中改写后的节点,无双图标)。
    // React 安全性:官方 nav 图标为静态子树,重渲染时前后 element 引用相等即
    // bailout,改写内容稳定存活;旧版 NotFoundError 仅源于 remove 节点本身。
    // 只对官方齿轮强补:非齿轮(官方原生图形或第三方供给形态)一律不动,
    // 映射/声明命中也不例外。已改写的按 svg 记账与当前 label 同异决定幂等或重写。
    function decide(cell) {
      const labelNode = cell.querySelector(SELECTOR_LABEL)
      if (labelNode === null) return null
      const label = (labelNode.textContent || '').trim()
      if (label === '') return null
      const svgs = cell.querySelectorAll('svg')
      let official = null
      for (const svg of svgs) {
        if (svg.dataset.navic !== '1') {
          official = svg
          break
        }
      }
      if (official === null) return null
      if (official.dataset.navic === label) return null
      const touched = official.dataset.navic !== undefined && official.dataset.navic !== ''
      if (!touched && !isGear(official)) return null
      return { label, inner: svgInner(resolveForLabel(label)), official }
    }

    function applyDecision(cell, decision) {
      // 内容改写 + svg 自记账;先清 0.1.x 注入语义的升级残留(带 '1' 标记的旧节点)
      for (const injected of cell.querySelectorAll('[' + ATTR_MARK + '="1"]')) injected.remove()
      decision.official.innerHTML = decision.inner
      decision.official.dataset.navic = decision.label
    }

    /* LOGIC-END */

    // ---- 市场卡片 DOM 锚点(css-modules 哈希前缀随版本变,按后缀匹配) ----

    const SELECTOR_AV = '[class$="_av"]'
    const SELECTOR_ROW1 = '[class$="_row1"]'
    const SELECTOR_NM = 'a[class*="_nm"]'

    const SELECTOR_ALL = SELECTOR_CELL + ',' + SELECTOR_AV

    let active = false
    let observer = null
    let rafId = 0
    // HMR 代际槽:重评估时新实例先拆上一代观察器与在途帧,防多套扫描器并发
    const SLOT_KEY = Symbol.for('@mzzsfy/dsh-settings-nav-icons')
    let slot = null
    // 确定性失败节点(宿主 DOM 漂移后 decide 必抛)只告警一次,防长时间挂机刷屏
    const warnedNodes = new WeakSet()

    function warnOnce(node, scope, error) {
      if (warnedNodes.has(node)) return
      warnedNodes.add(node)
      console.warn('[nav-icons] ' + scope + '处理失败', error)
    }

    function handleCell(cell) {
      const decision = decide(cell)
      if (decision !== null) applyDecision(cell, decision)
    }

    function handleAvatar(av) {
      const row1 = av.closest(SELECTOR_ROW1)
      if (row1 === null) return
      const nm = row1.querySelector(SELECTOR_NM)
      if (nm === null) return
      const name = (nm.textContent || '').trim()
      const decision = decideAvatar(av, name)
      if (decision !== null) applyAvatar(av, decision)
    }

    function replacePass() {
      rafId = 0
      if (slot !== null) slot.rafId = 0
      for (const node of document.querySelectorAll(SELECTOR_ALL)) {
        try {
          if (node.matches(SELECTOR_AV)) handleAvatar(node)
          else handleCell(node)
        } catch (error) {
          // 单项异常不中断当轮剩余处理(宿主 DOM 形态漂移是常态风险),去重告警
          warnOnce(node, node.matches(SELECTOR_AV) ? '头像槽' : '单元格', error)
        }
      }
      // 自产写入回波消除:pass 中 insertAdjacentHTML 产生的记录此刻已在待派发队列,
      // 同任务内清空后微任务派发即为空,不再多跑一帧幂等空扫
      if (observer !== null) observer.takeRecords()
    }

    // 事件过滤:childList 通道仅元素级变更放行(流式文本节点级变更不相关);
    // characterData 通道按目标域精确放行(语言切换的 label 原地改写、卡片改名),
    // 域外文本变更(流式输出正文)不唤醒
    function onMutations(mutations) {
      for (const record of mutations) {
        if (record.type === 'characterData') {
          const parent = record.target.parentElement
          if (parent === null) continue
          if (parent.closest(SELECTOR_CELL) === null && parent.closest(SELECTOR_ROW1) === null) continue
        } else {
          let relevant = false
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) { relevant = true; break }
          }
          if (!relevant) {
            for (const node of record.removedNodes) {
              if (node.nodeType === 1) { relevant = true; break }
            }
          }
          if (!relevant) continue
        }
        schedule()
        return
      }
    }

    // rAF 合批:rafId 为唯一在途状态源,未 flush 前重复触发直接并入
    function schedule() {
      if (!active || rafId !== 0) return
      rafId = requestAnimationFrame(replacePass)
      if (slot !== null) slot.rafId = rafId
    }

    // 声明持久层:client 半区热重载会重跑 factory 而生产者不重发,声明外置 window
    // 纯数据,新实例启动时恢复;页面刷新随 window 释放。恢复走同一安全门收口,
    // 篡改的全局存储不直通注入。
    const DECLARATIONS_STORE = '__navicIconDeclarations'
    function restoreDeclarations() {
      const saved = window[DECLARATIONS_STORE]
      if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return
      for (const key of Object.keys(saved)) {
        try {
          // 逐键隔离:持久层被写入带抛错 getter 的对象/Proxy 时坏键告警跳过
          const resolved = resolveIcon(saved[key])
          if (resolved !== undefined) DECLARED_ICONS[key] = resolved
        } catch (error) {
          console.warn('[nav-icons] 持久层键 ' + key + ' 恢复失败,已跳过', error)
        }
      }
    }
    function persistDeclarations() {
      window[DECLARATIONS_STORE] = Object.assign({}, DECLARED_ICONS)
    }

    // 声明入口:值经 resolveIcon 归一化(非法值撤销声明走默认管线,与 README 承诺一致),
    // 同值幂等短路;仅值发生变更的键清记账重贴,无关分区不抖动。
    // 时序无关:本插件未就绪时调用方入队等待;已停止实例短路,不驱动 DOM。
    const KEY_MAX_CHARS = 256
    function registerIcons(entries) {
      if (!active) return
      if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
        console.warn('[nav-icons] register 入参须为非数组对象,已忽略')
        return
      }
      const touched = []
      for (const key of Object.keys(entries)) {
        // '1' 是注入图标的纯标记值,禁作声明键,否则记账清理会误删全部注入标记
        if (key === '__proto__' || key === '1' || key.length > KEY_MAX_CHARS) continue
        let resolved
        try {
          // 逐键隔离:生产者传入带抛错 getter 的对象/Proxy 时坏键告警跳过,不中断注册
          resolved = resolveIcon(entries[key])
        } catch (error) {
          console.warn('[nav-icons] 声明键 ' + key + ' 取值失败,已跳过', error)
          continue
        }
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
      // 声明变更就地生效:nav svg(记账为分区/插件名)直接重写内容且记账保留——
      // 改写后的 svg 非齿轮,清账会让 isGear 判定失配卡死;头像槽(非 svg 节点)
      // 清账后走 decideAvatar 重贴。'1' 为注入纯标记,不命中声明键。
      for (const el of document.querySelectorAll('[' + ATTR_MARK + ']')) {
        if (touched.indexOf(el.dataset.navic) < 0) continue
        if (el.tagName === 'svg') {
          el.innerHTML = svgInner(resolveForLabel(el.dataset.navic))
        } else {
          delete el.dataset.navic
        }
      }
      schedule()
    }

    // 滚动样式元素:start 注入 head,stop 移除,引用即状态源,幂等无守卫分支;
    // 同挂代际槽, HMR 重评估 stop 未跑时由新实例代拆
    let scrollStyle = null

    function installScrollStyle() {
      scrollStyle = document.createElement('style')
      scrollStyle.textContent = NAVLIST_SCROLL_CSS
      document.head.appendChild(scrollStyle)
      if (slot !== null) slot.scrollStyle = scrollStyle
    }

    function uninstallScrollStyle() {
      if (scrollStyle === null) return
      scrollStyle.remove()
      scrollStyle = null
      if (slot !== null) slot.scrollStyle = null
    }

    // 队列直通桩属主守卫:stop 仅复位本实例所置桩,乱序清理不覆盖新实例运行态
    let queueStub = null

    function drainQueue() {
      const queue = window.__navicIconQueue
      if (Array.isArray(queue)) {
        for (const entries of queue) {
          try {
            registerIcons(entries)
          } catch (error) {
            console.warn('[nav-icons] 队列条目处理失败', error)
          }
        }
      } else if (queue !== undefined && queue !== null) {
        console.warn('[nav-icons] 遗留队列形态异常(非数组),已丢弃', typeof queue)
      }
      queueStub = { push(items) { registerIcons(items) } }
      window.__navicIconQueue = queueStub
    }

    function start() {
      active = true
      const previous = window[SLOT_KEY]
      if (previous !== undefined) {
        if (previous.observer !== null) previous.observer.disconnect()
        if (previous.rafId !== 0) cancelAnimationFrame(previous.rafId)
        // 宽松判空:槽是跨代码版本通道,旧版槽无 scrollStyle 字段(undefined)
        if (previous.scrollStyle != null) previous.scrollStyle.remove()
      }
      slot = { observer: null, rafId: 0, scrollStyle: null }
      window[SLOT_KEY] = slot
      // 可抛步骤(声明恢复/队列排水/样式注入)先于观察器挂载,失败不产生孤儿扫描器
      installScrollStyle()
      restoreDeclarations()
      drainQueue()
      observer = new MutationObserver(onMutations)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      slot.observer = observer
      replacePass()
    }

    function stop() {
      active = false
      uninstallScrollStyle()
      if (observer !== null) {
        observer.disconnect()
        observer = null
      }
      if (rafId !== 0) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      if (slot !== null) {
        slot.observer = null
        slot.rafId = 0
        slot = null
      }
      // 队列恢复数组形态仅限本实例桩:卸载后生产者按 README 惯用法入队等待下一实例
      if (window.__navicIconQueue === queueStub) window.__navicIconQueue = []
      queueStub = null
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
