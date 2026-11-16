// 设置导航图标 Client 半区:按分区显示文本把回退齿轮换成专属图形。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory})。
// 背景见 README「实现边界」:settings.* 子槽声明权被原版条目占用,
// 接管 Shell 不可行,DOM 观察是唯一不依赖官方契约变更的路径。

// 本插件市场短名自画像:经同一套声明机制注册(先于 load,渲染端同文件就绪)
if (typeof window !== 'undefined') {
  const NAV_ICON = { 'dsh-settings-nav-icons': 'tune' }
  if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
  else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
  else window.__navicIconQueue = [NAV_ICON]
}

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-settings-nav-icons',
  factory(require) {
    // ---- 官方 DOM 字面量标识(设置弹窗导航,CSS Modules 哈希前缀稳定) ----

    // 注册 id 单点定义:样式 data-plugin 标记与装载归属同源,防字面量双写漂移
    const PLUGIN_ID = '@mzzsfy/dsh-settings-nav-icons'
    const SELECTOR_CELL = 'button.VOzbGW_navCell'
    const SELECTOR_LABEL = '.VOzbGW_navLabel'
    const ATTR_MARK = 'data-navic'

    // 恢复路径内容刷新:页面刷新后 DOM 全新无此需求;HMR 热重载复用旧 DOM,
    // 记账与 label 相同会被 replacePass 幂等跳过,恢复的声明必须就地重算。
    function refreshMarkedContent() {
      const keys = []
      for (const el of document.querySelectorAll('[' + ATTR_MARK + ']')) {
        const key = el.dataset.navic
        if (key !== undefined && key !== '' && key !== '1' && keys.indexOf(key) < 0) keys.push(key)
      }
      if (keys.length === 0) return
      rewriteTouched(keys)
    }

    // ---- 设置导航滚动补偿:官方 navList 高度随内容撑开,溢出被 panel hidden
    // 裁剪且无滚动机制,分区一多底部即不可达。样式表形态一次注入,对弹窗重开
    // 等任意 React 重渲染持续生效;类名锚定与上方单元格同策略(哈希前缀字面量)。

    const NAVLIST_SCROLL_CSS = '@media (min-width:768px){.VOzbGW_navList{flex:1 1 0;min-height:0;overflow-y:auto;scrollbar-width:thin}}'

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
    const WALLET = svgOf(
      rectOf('2.5', '3.5', '11', '9.5', '1.5') +
      pathOf('M13.5 7.4h-2.1a1.6 1.6 0 0 0 0 3.2h2.1'))
    const GAUGE = svgOf(
      pathOf('M2.5 12a5.5 5.5 0 1 1 11 0') +
      pathOf('M8 12 10.8 9.2') +
      pathOf('M2.5 12h11'))
    const FALLBACK = [SPARK, LAYERS, TAG, GRID]

    // 内置 glyph 名称表:声明值可用名称引用内置图形,避免跨插件复制 svg。
    const GLYPHS = {
      tune: TUNE, theme: THEME, bot: BOT, market: MARKET, cube: CUBE, mcp: MCP,
      shield: SHIELD, cards: CARDS, plan: PLAN, bell: BELL, wrench: WRENCH,
      archive: ARCHIVE, spark: SPARK, layers: LAYERS, tag: TAG, grid: GRID,
      git: GIT, search: SEARCH, term: TERM, chart: CHART, code: CODE, doc: DOC,
      db: DB, flow: FLOW, globe: GLOBE, lock: LOCK, image: IMAGE, zap: ZAP,
      wallet: WALLET, gauge: GAUGE,
    }

    // 声明值解析与四重白名单安全门(标签门 + 属性门 + 颜色值门 + 文法门):值先经
    // 严格子集解析器建出元素与属性序列,再逐项过白名单;文法外字符(实体引用、
    // 注释、CDATA、处理指令、命名空间前缀、未加引号属性值、单根之外的内容)一律
    // 否决,该子集与浏览器解析结果等价,不靠正则黑名单。载体标签(script/style/
    // use/image/a/foreignObject/animate…)不在标签白名单;style/href/xlink:href/
    // attributeName/SMIL 动画属性/on* 事件属性不在任何属性白名单。颜色属性
    // (fill/stroke/color/stop-color)只认颜色字面量与指向本值内 id 的 url(#id),
    // 外部 URL 无从表达。解析器自持而非 DOMParser:client.js 与 logic.mjs 需在
    // 无 DOM 环境跑同一份判定(parity),DOMParser 只在浏览器存在。
    // 图元门在四重白名单之后追加:声明必须含至少一个非退化图元,空壳/仅
    // defs/title/desc 的声明不是图标——写进官方 innerHTML 等于把齿轮清空。
    // glyph 名称查表(原型链成员经 typeof 收口不可能混入);非法值 undefined。
    const SVG_MAX_CHARS = 4 * 1024
    // 白名单标签集:16×16 静态图标的合法绘制元素(嵌套 svg 仍合法)
    const SVG_TAG_ALLOW = new Set([
      'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse',
      'g', 'defs', 'lineargradient', 'radialgradient', 'stop', 'title', 'desc',
    ])
    // 表现层属性:任一白名单标签可带,其中颜色四属性另做值校验
    const SVG_ATTR_GLOBAL = new Set([
      'id', 'class', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
      'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
      'stroke-dasharray', 'stroke-dashoffset', 'color', 'opacity', 'transform',
      'vector-effect', 'display', 'visibility', 'stop-color', 'stop-opacity',
    ])
    // 标签专有属性:几何/渐变/描述面。属性名一律小写(HTML 解析器对 camelCase
    // SVG 属性名有校正表,小写进 DOM 即还原 viewBox/gradientUnits 等)
    const SVG_ATTR_BY_TAG = {
      svg: new Set(['width', 'height', 'viewbox', 'preserveaspectratio', 'version', 'xmlns', 'role', 'aria-hidden', 'aria-label', 'focusable', 'data-navic']),
      path: new Set(['d', 'pathlength']),
      rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry']),
      circle: new Set(['cx', 'cy', 'r']),
      ellipse: new Set(['cx', 'cy', 'rx', 'ry']),
      line: new Set(['x1', 'y1', 'x2', 'y2']),
      polyline: new Set(['points']),
      polygon: new Set(['points']),
      g: new Set(),
      defs: new Set(),
      lineargradient: new Set(['x1', 'y1', 'x2', 'y2', 'gradientunits', 'gradienttransform', 'spreadmethod']),
      radialgradient: new Set(['cx', 'cy', 'r', 'fx', 'fy', 'fr', 'gradientunits', 'gradienttransform', 'spreadmethod']),
      stop: new Set(['offset']),
      title: new Set(),
      desc: new Set(),
    }
    // 颜色属性名:值经 svgColorAllowed 校验
    const SVG_COLOR_ATTRS = new Set(['fill', 'stroke', 'color', 'stop-color'])
    // 图元表:每类绘制标签的几何属性。不在表内的标签(g/svg 嵌套)本身不画像素,
    // 只承载结构;其中「非渲染子树」连后代都不画。
    const SVG_SHAPE_ATTRS = {
      path: ['d'],
      polyline: ['points'],
      polygon: ['points'],
      circle: ['r'],
      ellipse: ['rx', 'ry'],
      rect: ['width', 'height'],
      line: ['x1', 'y1', 'x2', 'y2'],
    }
    // 非渲染子树根:定义(defs)、描述(title/desc)与渐变容器只提供引用或语义,
    // 其后代永不画像素——defs 里的图元不算图标。
    const SVG_NON_RENDERED = new Set(['defs', 'title', 'desc', 'lineargradient', 'radialgradient', 'stop'])
    // 坐标数:polyline/polygon 至少两对才成线,单点没有长度。
    const SVG_POINTS_MIN_PAIRS = 2
    // path 命令参数个数与分词正则(命令字母 + 坐标;指数记法的 e 归入坐标)
    const SVG_PATH_PARAMS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }
    const SVG_PATH_COMMAND_RE = /^[MmZzLlHhVvCcSsQqTtAa]$/
    const SVG_PATH_TOKEN_RE = /[MmZzLlHhVvCcSsQqTtAa]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g

    // path 是否画出像素:逐段比端点与笔位,任一非零位移即成段(隐式重复的坐标对
    // 按前一条命令续段);只有 moveto、零长度段与退化弧(端点不动)不算。
    function pathDraws(d) {
      if (typeof d !== 'string' || d === '') return false
      const tokens = d.match(SVG_PATH_TOKEN_RE)
      if (tokens === null) return false
      let penX = 0
      let penY = 0
      let startX = 0
      let startY = 0
      let command = ''
      let started = false
      for (let at = 0; at < tokens.length;) {
        const token = tokens[at]
        if (SVG_PATH_COMMAND_RE.test(token)) {
          // 子路径必须以 moveto 起手:缺它的词法外内容不产生任何渲染
          if (!started && token !== 'm' && token !== 'M') return false
          started = true
          at += 1
          if (token === 'z' || token === 'Z') {
            if (penX !== startX || penY !== startY) return true
            penX = startX
            penY = startY
            command = ''
            continue
          }
          command = token
          continue
        }
        if (command === '') return false
        const kind = command.toLowerCase()
        const args = tokens.slice(at, at + SVG_PATH_PARAMS[kind]).map(Number)
        if (args.length < SVG_PATH_PARAMS[kind] || args.some((value) => !Number.isFinite(value))) return false
        at += SVG_PATH_PARAMS[kind]
        const relative = command !== command.toUpperCase()
        // 相对命令的坐标是增量,绝对命令的坐标与笔位直接比较
        const departs = (x, y) => {
          const nextX = relative ? penX + x : x
          const nextY = relative ? penY + y : y
          return nextX !== penX || nextY !== penY
        }
        if (kind === 'm') {
          penX = relative ? penX + args[0] : args[0]
          penY = relative ? penY + args[1] : args[1]
          startX = penX
          startY = penY
          // 首个坐标对是 moveto,后续隐式重复按 lineto 处理
          command = relative ? 'l' : 'L'
          continue
        }
        if (kind === 'c' || kind === 's' || kind === 'q' || kind === 't') {
          for (let pair = 0; pair < args.length; pair += 2) {
            if (departs(args[pair], args[pair + 1])) return true
          }
          penX = relative ? penX + args[args.length - 2] : args[args.length - 2]
          penY = relative ? penY + args[args.length - 1] : args[args.length - 1]
          continue
        }
        const endpoint = (x, y) => (relative ? [penX + x, penY + y] : [x, y])
        let endX
        let endY
        if (kind === 'h') {
          endX = relative ? penX + args[0] : args[0]
          endY = penY
        } else if (kind === 'v') {
          endX = penX
          endY = relative ? penY + args[0] : args[0]
        } else if (kind === 'a') {
          [endX, endY] = endpoint(args[5], args[6])
          // 端点不动是退化弧(半径为零按直线处理,仍在下方比长度)
          if (endX === penX && endY === penY) continue
        } else {
          [endX, endY] = endpoint(args[0], args[1])
        }
        if (endX !== penX || endY !== penY) return true
        penX = endX
        penY = endY
      }
      return false
    }

    // 单元素是否画出像素:长度类须为正,坐标类任一非零即成线,路径须至少一条非零长度段。
    // 零尺寸图元与「无图元」等价:r="0"/width="0" 不产生任何可见内容,同样判非法。
    function svgShapeDraws(tag, attrs) {
      function positive(name) {
        const size = parseFloat(attrs[name])
        return Number.isFinite(size) && size > 0
      }
      function moved(name) {
        const coord = parseFloat(attrs[name])
        return Number.isFinite(coord) && coord !== 0
      }
      function present(name) {
        return attrs[name] !== undefined && attrs[name] !== ''
      }
      function points() {
        const coords = String(attrs.points).match(SVG_PATH_TOKEN_RE)
        const count = coords === null ? 0 : coords.filter((token) => !SVG_PATH_COMMAND_RE.test(token)).length
        return count >= SVG_POINTS_MIN_PAIRS * 2
      }
      if (tag === 'path') return present('d') && pathDraws(attrs.d)
      if (tag === 'polyline' || tag === 'polygon') return present('points') && points()
      if (tag === 'circle') return positive('r')
      if (tag === 'ellipse') return positive('rx') && positive('ry')
      if (tag === 'rect') return positive('width') && positive('height')
      if (tag === 'line') return moved('x1') || moved('y1') || moved('x2') || moved('y2')
      return false
    }

    const SVG_NS = 'http://www.w3.org/2000/svg'
    const SVG_WS = ' \t\n\f\r'
    const SVG_NAME_MAX = 32
    const SVG_MAX_DEPTH = 8
    const SVG_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
    const SVG_HEX_RE = /^#[0-9a-f]{3,8}$/
    const SVG_FUNC_RE = /^(rgb|rgba|hsl|hsla)\([0-9.,%+\- ]{1,40}\)$/
    const SVG_KEYWORD_RE = /^[a-z]{3,24}$/
    const SVG_LOCAL_REF_RE = /^url\(#([A-Za-z_][A-Za-z0-9_-]{0,63})\)$/i
    const SVG_SPRITE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
    const SVG_REJECT = Symbol('svg-reject')
    // 安全门判定缓存:full-document 扫描每帧对同一批声明值反复过门,解析器按调用
    // 分配上下文,纯函数结果按原值缓存(上限后清空,不接受无界增长)
    const SVG_GATE_CACHE = new Map()
    const SVG_GATE_CACHE_MAX = 256

    function resolveIcon(value) {
      if (typeof value !== 'string') return undefined
      const trimmed = value.trim()
      if (trimmed.length <= SVG_MAX_CHARS && svgMarkupAllowed(trimmed)) return trimmed
      return Object.hasOwn(GLYPHS, trimmed) && typeof GLYPHS[trimmed] === 'string' ? GLYPHS[trimmed] : undefined
    }

    // 属性白名单:全局表现层属性,或该标签专有属性;两者皆不在即否决
    function svgAttributeAllowed(tag, name) {
      if (SVG_ATTR_GLOBAL.has(name)) return true
      const own = SVG_ATTR_BY_TAG[tag]
      return own !== undefined && own.has(name)
    }

    // 颜色值:颜色字面量(none/currentColor/命名色/十六进制/rgb()/hsl())或本地
    // url(#id);外部 URL、拼接串、var()、expression() 均不可表达。关键字先行:
    // 常见值(none/currentColor)一次正则即收口。关键字/十六进制/函数名大小写不敏感,
    // 统一按小写归一;url() 片段是 DOM id,大小写敏感,保留原样,与 id 登记侧同口径。
    function svgColorAllowed(value, refs) {
      const raw = value.trim()
      const literal = raw.toLowerCase()
      if (SVG_KEYWORD_RE.test(literal)) return true
      if (SVG_HEX_RE.test(literal) || SVG_FUNC_RE.test(literal)) return true
      const local = SVG_LOCAL_REF_RE.exec(raw)
      if (local === null) return false
      refs.push(local[1])
      return true
    }

    // 严格子集解析:唯一 svg 根、双引号属性、无实体引用与注释/CDATA/处理指令、
    // 开闭标签严格配对、嵌套深度有上界;逐标签逐属性过白名单,收尾核验
    // url(#id) 指向本值内定义的 id(官方 sprite 与页面其他 id 不可达),并要求
    // 至少一个非退化图元(零绘制内容不得当图标)。
    function svgMarkupAllowed(markup) {
      const cached = SVG_GATE_CACHE.get(markup)
      if (cached !== undefined) return cached
      const size = markup.length
      const ids = new Set()
      const refs = []
      let drawn = false
      let at = 0

      function reject() { throw SVG_REJECT }
      function isWs(ch) { return SVG_WS.indexOf(ch) >= 0 }
      function isNameStart(ch) { return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') }
      function isNamePart(ch) { return isNameStart(ch) || (ch >= '0' && ch <= '9') || ch === '-' }
      function skipWs() { while (at < size && isWs(markup[at])) at += 1 }

      function readName() {
        const start = at
        if (at >= size || !isNameStart(markup[at])) reject()
        at += 1
        while (at < size && isNamePart(markup[at])) at += 1
        if (at - start > SVG_NAME_MAX) reject()
        return markup.slice(start, at).toLowerCase()
      }

      function readQuoted() {
        if (markup[at] !== '"') reject()
        at += 1
        const start = at
        for (;;) {
          if (at >= size) reject()
          const ch = markup[at]
          if (ch === '"') {
            at += 1
            return markup.slice(start, at - 1)
          }
          // 标签闭合符与实体引用不得出现在值里:前者破坏剥壳,后者可绕开名字检查
          if (ch === '<' || ch === '>' || ch === '&') reject()
          at += 1
        }
      }

      function readText() {
        for (;;) {
          if (at >= size) return
          if (markup[at] === '<') return
          if (markup[at] === '&') reject()
          at += 1
        }
      }

      function readAttribute(tag, attrs) {
        const name = readName()
        skipWs()
        if (markup[at] !== '=') reject()
        at += 1
        skipWs()
        const value = readQuoted()
        if (!svgAttributeAllowed(tag, name)) reject()
        if (name === 'xmlns' && value !== SVG_NS) reject()
        if (name === 'id') {
          if (!SVG_ID_RE.test(value)) reject()
          ids.add(value)
          return
        }
        if (SVG_COLOR_ATTRS.has(name) && !svgColorAllowed(value, refs)) reject()
        // 只登记图元标签的几何属性,供图元门判定(其余标签不画像素)
        if (attrs !== null) attrs[name] = value
      }

      function readElement(depth, rendered) {
        if (depth > SVG_MAX_DEPTH) reject()
        if (markup[at] !== '<') reject()
        at += 1
        const tag = readName()
        if (!SVG_TAG_ALLOW.has(tag)) reject()
        // 渲染树内计数:非渲染子树(defs/title/desc/渐变)的后代不算绘制
        const paints = rendered && !SVG_NON_RENDERED.has(tag)
        const attrs = Object.hasOwn(SVG_SHAPE_ATTRS, tag) ? {} : null
        let selfClosed = false
        for (;;) {
          const before = at
          skipWs()
          if (at >= size) reject()
          if (markup[at] === '>') {
            at += 1
            break
          }
          if (markup[at] === '/') {
            if (markup[at + 1] !== '>') reject()
            at += 2
            selfClosed = true
            break
          }
          // 属性之间必须有空白:斜杠分隔等宽松形态不入子集
          if (at === before) reject()
          readAttribute(tag, attrs)
        }
        if (paints && attrs !== null && svgShapeDraws(tag, attrs)) drawn = true
        if (selfClosed) return tag
        for (;;) {
          if (at >= size) reject()
          if (markup[at] !== '<') {
            readText()
            continue
          }
          if (markup[at + 1] !== '/') {
            readElement(depth + 1, paints)
            continue
          }
          at += 2
          if (readName() !== tag) reject()
          skipWs()
          if (markup[at] !== '>') reject()
          at += 1
          return tag
        }
      }

      let allowed = true
      try {
        skipWs()
        if (readElement(0, true) !== 'svg') reject()
        skipWs()
        if (at !== size) reject()
        for (const id of refs) if (!ids.has(id)) reject()
        // 图元门:零绘制声明(空 svg / 仅 defs/title/desc / 只有 moveto / 几何退化)不是图标
        if (!drawn) reject()
      } catch (error) {
        if (error !== SVG_REJECT) throw error
        allowed = false
      }
      if (SVG_GATE_CACHE.size >= SVG_GATE_CACHE_MAX) SVG_GATE_CACHE.clear()
      SVG_GATE_CACHE.set(markup, allowed)
      return allowed
    }

    // 已写入 DOM 的内容是否仍含可绘制图元:输入是本插件写进 official/injected 节点的
    // innerHTML,只作内容判据、不承担安全门职责,故按宽松标签扫描——属性顺序、自闭合
    // 与序列化形态差异不影响结论;非渲染子树内的图元同样不算。
    const SVG_FRAGMENT_TAG_RE = /<(\/?)([a-z][a-z0-9]*)([^>]*)>/gi
    const SVG_FRAGMENT_ATTR_RE = /([a-z][a-z0-9-]*)="([^"]*)"/g

    function svgInnerDraws(inner) {
      if (typeof inner !== 'string' || inner === '') return false
      let hidden = 0
      for (const match of inner.matchAll(SVG_FRAGMENT_TAG_RE)) {
        const tag = match[2].toLowerCase()
        if (match[1] === '/') {
          if (hidden > 0 && SVG_NON_RENDERED.has(tag)) hidden -= 1
          continue
        }
        if (hidden === 0 && Object.hasOwn(SVG_SHAPE_ATTRS, tag)) {
          const attrs = {}
          for (const pair of match[3].matchAll(SVG_FRAGMENT_ATTR_RE)) attrs[pair[1]] = pair[2]
          if (svgShapeDraws(tag, attrs)) return true
        }
        if (!match[3].trimEnd().endsWith('/') && SVG_NON_RENDERED.has(tag)) hidden += 1
      }
      return false
    }

    // 名称关键词 → 主题图标;整词边界匹配,短词(im/db/ai)不误伤子串。
    // 顺序即优先级,具体语义在前。涵盖 dsh-market 目录内全部插件:
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
      ['dash|dashboard|gauge', GAUGE],
      ['usage|stat|meter|monitor|radar|metric', CHART],
      ['wallet|balance|money|coin|fund', WALLET],
      ['flow|workflow|pipeline|task|job|queue', FLOW],
      ['auth|login|pass|secret|token|lock|guard|crypt', SHIELD],
      ['mcp', MCP],
      ['market|store|registry|catalog', MARKET],
      // 扩展/插件是比 Agent 更具体的大类:Agent 扩展取魔方,Agent 管理才取星芒。
      ['extension|plugin|扩展|插件', CUBE],
      ['agent|智能体|助手', SPARK],
      ['im|chat|msg|notify|notif|bot|bark|wechat|qq|telegram|wecom|dingtalk|push|机器人', BOT],
      ['plan|time|timer|clock|calendar|cron', PLAN],
      ['code|lint|graph|dev|debug|patch', CODE],
      ['llm|gpt|claude|deepseek|gemini|prompt|think|reason', SPARK],
      ['zap|flash|fast|quick|boost|speed|turbo', ZAP],
    ].map(function (pair) { return { re: new RegExp('(^|[^a-z])(' + pair[0] + ')([^a-z]|$)'), icon: pair[1] } })

    // 官方双语分区等价组:组内任一语言 label 作声明键,组内其他语言取图时
    // 同样命中(消除语言切换下声明键漂移)。仅收官方现有展示形态,不发明未知 id。
    const ALIAS_GROUPS = [
      ['通用设置', 'General'],
    ]

    // 表查询的别名等价扩展:先按原键直查,再沿等价组用同组成员试查。
    // 表为 Object.create(null) 帧装,继承成员不可达。
    function lookupWithAlias(table, label) {
      const direct = table[label]
      if (direct !== undefined) return direct
      for (const group of ALIAS_GROUPS) {
        if (group.indexOf(label) < 0) continue
        for (const member of group) {
          if (member === label) continue
          const hit = table[member]
          if (hit !== undefined) return hit
        }
      }
      return undefined
    }

    // 键的等价组展开:自身 + 所属组内其他成员;不入组的键只返回自身。
    // 声明变更就地重写按该范围触达,保证双语分区两侧状态一致。
    function aliasKeysOf(label) {
      const keys = [label]
      for (const group of ALIAS_GROUPS) {
        if (group.indexOf(label) < 0) continue
        for (const member of group) {
          if (member !== label && keys.indexOf(member) < 0) keys.push(member)
        }
      }
      return keys
    }

    // 插件名/分区 label 两级取图:外部声明 → 关键词主题图 → 稳定哈希备用池。
    // 表值为原始声明(glyph 名或 svg),命中后过 resolveIcon 归一化展开;归一化失败
    // (声明值被撤销/存储被篡改)视为该层未命中,继续下一层。
    function themedIcon(name) {
      const declared = lookupWithAlias(DECLARED_ICONS, name)
      if (declared !== undefined) {
        const resolved = resolveIcon(declared)
        if (resolved !== undefined) return resolved
      }
      const n = name.toLowerCase()
      for (const rule of NAME_RULES) {
        if (rule.re.test(n)) return rule.icon
      }
      return FALLBACK[poolIndexOf(name)]
    }

    // 分区取图全链:声明(含别名) → 内置映射 → 关键词/哈希兜底。decide
    // 与声明变更就地重写共用;撤销时回退必须含内置映射,否则卡死在哈希图。内置
    // 映射是普通字面量对象,查表经 Object.hasOwn 收口:label 恰为 constructor/
    // toString 等原型链成员时不可达其继承值(否则取到函数,.replace 即抛)。
    function resolveForLabel(label) {
      const declared = lookupWithAlias(DECLARED_ICONS, label)
      if (declared !== undefined) {
        const resolved = resolveIcon(declared)
        if (resolved !== undefined) return resolved
      }
      if (Object.hasOwn(ICONS, label)) return ICONS[label]
      return themedIcon(label)
    }

    // 市场卡片头像槽决策:img(作者头像)与 div(字母色块)同构处理——原子节点隐藏,
    // 插件图标注入跟随。记账值 = 插件名,换名重贴由该比较驱动。幂等须三件齐备:
    // 记账相等、行内隐藏在场、紧随槽体之后的那一个注入节点仍可绘制——React 重渲染
    // 可能清 style 或摘掉注入节点,旧版本还可能注入过零绘制空壳;任一缺失即重出
    // 决策由重贴自愈。判据锚定「槽的下一元素」而非父容器任意节点:同一行里两个槽
    // 共用父容器时,缺图的那个不得被另一槽的注入满足。
    function decideAvatar(av, name) {
      if (name === '') return null
      if (avatarApplied(av, name)) return null
      return { name, html: themedIcon(name), av }
    }

    function avatarApplied(av, name) {
      if (av.dataset.navic !== name || av.style.display !== 'none') return false
      const injected = av.nextElementSibling
      if (injected === null || injected === undefined) return false
      return injected.dataset !== undefined && injected.dataset.navic === '1' && svgInnerDraws(injected.innerHTML)
    }

    function applyAvatar(av, decision) {
      // 原子节点不移除(React 持引用,移除/清空子树后 reconcile 报错):隐藏并记账,
      // 注入图标跟随其后;重贴先清行内上次注入的图标(父容器范围扫描,防槽体被
      // 外部替换后旧注入成孤儿双图)。隐藏必须走行内 style:hidden 属性是 UA 样式,
      // 会被市场卡自己的 .av{display:grid} 类规则压过(dsh-market v1.69 实测双图标)
      av.hidden = true
      av.style.display = 'none'
      av.dataset.navic = decision.name
      const parent = av.parentElement
      if (parent !== null) {
        for (const injected of parent.querySelectorAll('[' + ATTR_MARK + '="1"]')) injected.remove()
      }
      av.insertAdjacentHTML('afterend', decision.html)
    }

    // 官方默认齿轮识别(三代):0.1.x 内联齿体 / 0.1.7 起 primitives 内联齿体 /
    // 0.2.2 起 sprite 引用形态(use[href^=…],内联 path 消失,语义由 sprite 名
    // 承载)。官方分区语义图标非齿轮一律不动;插件注册分区走齿轮 fallback,
    // 是本插件强补对象。
    const GEAR_PATHS = ['M14.0861', 'M13.0107 7.79377']
    const GEAR_SPRITE_PREFIX = '#dsw-icon-settings-outline'

    function isGear(svg) {
      if (svg.querySelector('use[href^="' + GEAR_SPRITE_PREFIX + '"]') !== null) return true
      return GEAR_PATHS.some((prefix) => svg.querySelector('path[d^="' + prefix + '"]') !== null)
    }

    // 完整 svg 字符串剥壳取内部内容:resolveIcon 输出与 GLYPHS/声明值均为完整 svg,
    // 内容改写制只写 official.innerHTML,壳由本函数剥除。输入已过安全门(单根闭合且
    // 含图元),剥壳结果恒非空——空内容会清空官方图标,且记账相等后不再重试。
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
    // 内置映射仅收官方与无法改源的第三方分区;自有插件分区由各插件声明。原型链
    // 成员不是合法键,查表侧由 resolveForLabel 的 Object.hasOwn 收口。
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

    // 官方 sprite 原样重建:官方 svg 携带 data-icon 声明(sprite 代自描述形态),
    // 按该属性即可无损重建。属性值拼进 innerHTML 前过 id 形态门,畸形值不重建。
    // 返回 null = 非自描述形态(内联代)。
    function officialSpriteRestore(svg) {
      const icon = svg.getAttribute ? svg.getAttribute('data-icon') : null
      if (icon === null || !SVG_SPRITE_ID_RE.test(icon)) return null
      return '<use href="#' + icon + '"></use>'
    }

    // 外部图标供给声明:cell 携带他包 data-*-nav-icon 标记(dshmarket 等以此
    // 声明「本格图标归我供给」)。读公开 DOM 声明做让位裁决,零写零改他包——
    // 该格即使官方 svg 仍是默认形态,格面呈现权已归外部,强补必双图。
    function hasExternalNavMark(cell) {
      const keys = Object.keys(cell.dataset ?? {})
      for (const key of keys) {
        if (key === 'navic' || key === 'navicOrig' || key === 'navicYield') continue
        if (/^[a-z][a-zA-Z0-9]*NavIcon$/.test(key)) return true
      }
      return false
    }

    // 单元格改写判定(内容改写制):不新建 svg,只把官方齿轮 svg 的内部内容改写为
    // 本插件图标;官方 svg 上的呈现属性(class/width/位置等)保持原样,只就地增删
    // data-* 记账三种:navic(记账=label)、navicOrig(官方原样备份)、navicYield(让位);
    // 改写路径落前两条,回退路径删 navic、留 navicOrig 并落 yield。
    // 裁决(哲学:只替换官方默认齿轮;非默认 icon 一律不管):
    // 1. yield 记账(navicYield)永不重入;
    // 2. 外部供给声明格(data-*-nav-icon,他包公开声明):无残留零动作;有残留
    //    回退——恢复官方原样(navicOrig 优先,data-icon 重建兜底),清账留 yield;
    // 3. 其余格子只认官方默认齿轮形态(sprite data-icon 声明 / 两代内联齿体),
    //    非默认形态一律不管;我方记账在即幂等或随 label 重写(语言切换)。
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
      if (official.dataset.navicYield !== undefined) return null
      const external = hasExternalNavMark(cell)
      const touched = official.dataset.navic !== undefined && official.dataset.navic !== ''
      if (!touched) {
        if (external) return null
        if (!isGear(official)) return null
        return { label, official, inner: svgInner(resolveForLabel(label)), orig: official.innerHTML }
      }
      if (external) return revertDecision(official, official.dataset.navic)
      // 记账相等还须内容真在画:旧版本把零绘制声明(空串、仅 defs、仅 title)写进过
      // innerHTML,这类内容不视为已完成改写,否则该格永久空白且永不自愈
      if (official.dataset.navic === label && svgInnerDraws(official.innerHTML)) return null
      return { label, official, inner: svgInner(resolveForLabel(label)), orig: official.dataset.navicOrig ?? official.innerHTML }
    }

    function revertDecision(official, booked) {
      const inner = official.dataset.navicOrig !== undefined ? official.dataset.navicOrig : officialSpriteRestore(official)
      if (inner === null) return null
      return { label: booked, revert: true, official, inner }
    }

    // 升级残留清理:0.1.x 注入制在官方 svg 之后追加带纯标记 '1' 的兄弟节点,0.2.x
    // 起改为内容改写制,残留只增不减。清理必须在单元格裁决之前无条件执行——外部
    // 供给格/让位格不产生决策,残留若留给 applyDecision 就永不清理(让位格双图)。
    // 首个 svg 是官方节点本身(React 持引用,移除即 reconcile NotFoundError);图标
    // 内容里的嵌套 svg 也可能带纯标记(安全门允许嵌套 svg 与 data-navic),误删即
    // 掏空当前图标:只清 primary 之外的直接兄弟。
    function clearInjected(cell) {
      const primary = cell.querySelectorAll('svg')[0] ?? null
      for (const injected of cell.querySelectorAll('[' + ATTR_MARK + '="1"]')) {
        if (injected === primary) continue
        if (primary !== null && (primary.contains(injected) || injected.parentElement !== primary.parentElement)) continue
        injected.remove()
      }
    }

    function applyDecision(decision) {
      // 内容改写 + svg 自记账(升级残留已由 clearInjected 在裁决入口清理)
      if (decision.revert === true) {
        decision.official.innerHTML = decision.inner
        delete decision.official.dataset.navic
        decision.official.dataset.navicYield = decision.label
        return
      }
      decision.official.dataset.navicOrig = decision.orig
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
      // 升级残留清理先于裁决且无条件:外部供给格/让位格不产生决策,残留不得留到 apply
      clearInjected(cell)
      const decision = decide(cell)
      if (decision !== null) applyDecision(decision)
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
    // 域外文本变更(流式输出正文)不唤醒;attributes 通道仅 style 且命中头像槽
    // 才放行(行内隐藏被外部清除后的自愈重贴入口,域外属性写不唤醒)
    function onMutations(mutations) {
      for (const record of mutations) {
        if (record.type === 'characterData') {
          const parent = record.target.parentElement
          if (parent === null) continue
          if (parent.closest(SELECTOR_CELL) === null && parent.closest(SELECTOR_ROW1) === null) continue
        } else if (record.type === 'attributes') {
          const target = record.target
          if (record.attributeName !== 'style') continue
          if (target == null || typeof target.matches !== 'function' || !target.matches(SELECTOR_AV)) continue
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
      rewriteTouched(touched)
      schedule()
    }

    // 键命中元素就地重写:nav svg(记账为分区/插件名)直接重写内容且记账保留——
    // 改写后的 svg 非齿轮,清账会让 isGear 判定失配卡死;头像槽(非 svg 节点)
    // 清账后走 decideAvatar 重贴。'1' 为注入纯标记,不命中声明键。
    // 触达键先按等价组展开:声明写在哪一侧语言键,双语分区两侧都立即生效。
    function rewriteTouched(touched) {
      const expanded = []
      for (const key of touched) {
        for (const k of aliasKeysOf(key)) {
          if (expanded.indexOf(k) < 0) expanded.push(k)
        }
      }
      for (const el of document.querySelectorAll('[' + ATTR_MARK + ']')) {
        if (expanded.indexOf(el.dataset.navic) < 0) continue
        if (el.tagName === 'svg') {
          el.innerHTML = svgInner(resolveForLabel(el.dataset.navic))
        } else {
          delete el.dataset.navic
        }
      }
    }

    // 滚动样式元素:start 注入 head,stop 移除,引用即状态源,幂等无守卫分支;
    // 同挂代际槽, HMR 重评估 stop 未跑时由新实例代拆
    let scrollStyle = null

    function installScrollStyle() {
      scrollStyle = document.createElement('style')
      // 自带 data-plugin:缺失时宿主 claimStyles 会把它归属给后续材质化插件,其 HMR 重建即误删
      scrollStyle.setAttribute('data-plugin', PLUGIN_ID)
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
        // 宽松判空:槽是跨代码版本通道,旧版槽缺新字段(undefined)
        if (previous.scrollStyle != null) previous.scrollStyle.remove()
      }
      slot = { observer: null, rafId: 0, scrollStyle: null }
      window[SLOT_KEY] = slot
      // 可抛步骤(声明恢复、队列排水、样式注入)先于观察器挂载,失败不产生孤儿扫描器
      installScrollStyle()
      restoreDeclarations()
      drainQueue()
      observer = new MutationObserver(onMutations)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style'] })
      slot.observer = observer
      refreshMarkedContent()
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
