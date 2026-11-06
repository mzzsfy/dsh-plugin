window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-shared-terminal',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const parse = (text) => { try { return JSON.parse(text) } catch { return undefined } }

    const NS = 'dsh-shared-terminal'
    const zh = {
      'title': '终端',
      'preparing': '准备终端操作',
      'running': '执行中',
      'error': '失败',
      'action.open': '打开终端',
      'action.close': '关闭终端',
      'action.read': '读取屏幕',
      'action.write': '写入终端',
      'action.list': '列出终端',
      'action.wait': '等待屏幕文本',
      'unit.lines': '行',
      'unit.terminals': '个终端',
      'badge.truncated': '已截断',
      'badge.submitted': '已提交',
      'badge.attached': '已连接',
      'badge.detached': '未连接',
      'badge.found': '已出现',
      'badge.timeout': '超时',
      'badge.exited': '已退出',
      'badge.skipped': '已跳过',
      'action.skipWait': '跳过等待',
      'label.terminal': '终端 ID',
      'label.screen': '屏幕',
      'label.input': '输入',
      'label.result': '结果',
      'label.size': '尺寸',
      'label.shell': 'Shell',
      'hint.blankScreen': '（屏幕底部为空白行）',
    }
    const en = {
      'title': 'Terminal',
      'preparing': 'Preparing terminal action',
      'running': 'Running',
      'error': 'Failed',
      'action.open': 'Open terminal',
      'action.close': 'Close terminal',
      'action.read': 'Read screen',
      'action.write': 'Write terminal',
      'action.list': 'List terminals',
      'action.wait': 'Wait for screen text',
      'unit.lines': 'lines',
      'unit.terminals': 'terminal(s)',
      'badge.truncated': 'truncated',
      'badge.submitted': 'submitted',
      'badge.attached': 'attached',
      'badge.detached': 'not attached',
      'badge.found': 'found',
      'badge.timeout': 'timeout',
      'badge.exited': 'exited',
      'badge.skipped': 'skipped',
      'action.skipWait': 'Skip wait',
      'label.terminal': 'Terminal ID',
      'label.screen': 'Screen',
      'label.input': 'Input',
      'label.result': 'Result',
      'label.size': 'Size',
      'label.shell': 'Shell',
      'hint.blankScreen': '(blank lines at bottom of screen)',
    }

    // 视觉 token 与官方 ToolRow(css$3)同值,类名用本包前缀
    const CSS = [
      '.stv{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-secondary)}',
      '.stv-row{display:flex;align-items:center;padding:2px 0}',
      '.stv-row[data-expandable]{cursor:pointer;user-select:none}',
      '.stv-leading{display:flex;align-items:center;gap:4px;flex:none;margin-right:8px;color:var(--dsw-alias-label-tertiary)}',
      '.stv-iconIdle{display:inline-flex}',
      '.stv-chevron{opacity:.55}',
      '.stv-row[data-expandable]:hover .stv-chevron{opacity:1}',
      '.stv-visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}',
      '.stv-title{font-weight:400}',
      '.stv-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}',
      '.stv-summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:auto;overflow:hidden}',
      '.stv-summary[data-error]{color:var(--dsw-alias-state-error-primary)}',
      '.stv-badge{font-size:11px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);opacity:.85;flex:none;white-space:nowrap;margin-left:6px}',
      '.stv-openBtn{flex:none;margin-left:6px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:inherit;cursor:pointer;font-size:11px;line-height:16px}',
      '.stv-openBtn:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.stv-bodyWrap{display:flex;flex-direction:column}',
      '.stv-ioCard{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);flex-direction:column;margin:4px 0 4px 4px;display:flex}',
      '.stv-ioSection{display:flex;flex-direction:column;gap:4px;padding:10px 14px;max-height:224px;overflow-y:auto}',
      '.stv-ioLabel{color:var(--dsw-alias-label-caption);align-self:start;font-size:11px}',
      '.stv-ioText{white-space:pre-wrap;word-break:break-word;min-width:0;color:var(--dsw-alias-label-secondary);margin:0}',
      '.stv-ioDivider{background:var(--dsw-alias-border-l2);flex:none;height:.5px}',
      '.stv-termRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.stv-termTitle{font-weight:500}',
    ].join('\n')

    // ── 模型派生:argsRaw + content JSON → 行模型 ────────────────────────
    function shortId(id) {
      const text = String(id ?? '')
      return text.length <= 8 ? text : text.slice(0, 8)
    }

    function firstLine(text) {
      const line = String(text ?? '').split('\n').find((line) => line.trim() !== '')
      return line ?? ''
    }

    function actionKey(action) {
      return ['open', 'close', 'read', 'write', 'list', 'wait'].includes(action) ? `action.${action}` : undefined
    }

    const WAIT_KINDS = ['found', 'timeout', 'exited', 'skipped']

    function cardModel(block, phase, t) {
      const settled = phase === 'result'
      if (!settled) {
        const args = parse(block.argsRaw)
        const waiting = actionKey(args?.action) === 'action.wait' && typeof args?.text === 'string' && args.text !== ''
        return {
          state: 'running',
          title: t(actionKey(args?.action) ?? 'title'),
          summary: waiting ? args.text : undefined,
          waiting: waiting && typeof args?.terminal_id === 'string' && args.terminal_id !== '',
          sections: [],
          badges: [],
        }
      }
      const raw = (block.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('')
      const args = parse(block.call?.argsRaw)
      const result = parse(raw)
      if (block.isError === true || result?.ok === false) {
        const code = result?.error?.code ?? block.error?.code ?? block.error?.name
        const message = result?.error?.message ?? firstLine(raw)
        return {
          state: 'error',
          title: t(actionKey(args?.action) ?? 'title'),
          summary: [code, message].filter(Boolean).join(' '),
          sections: raw === '' ? [] : [{ label: t('label.result'), text: raw }],
          badges: [],
          waiting: false,
        }
      }
      if (args === undefined || result === undefined || typeof actionKey(args.action) !== 'string' || result.ok !== true) {
        return { state: 'done', title: t('title'), summary: firstLine(raw), sections: raw === '' ? [] : [{ label: t('label.result'), text: raw }], badges: [], waiting: false }
      }
      const action = args.action
      const badges = []
      const sections = []
      // 折叠行 = title · summary;summary 只放参数/结果新信息,不重复动作名
      let summary = ''
      if (action === 'read') {
        summary = `${result.lines} ${t('unit.lines')}`
        if (result.truncated === true) badges.push(t('badge.truncated'))
        const screen = result.text ?? ''
        sections.push({ label: t('label.screen'), text: screen.trim() === '' ? t('hint.blankScreen') : screen })
      } else if (action === 'list') {
        const terminals = Array.isArray(result.terminals) ? result.terminals : []
        summary = `${terminals.length} ${t('unit.terminals')}`
        sections.push({
          label: t('action.list'),
          list: terminals.map((item) => ({
            title: item.title ?? '',
            state: item.state ?? '',
            attached: item.attached === true,
            id: shortId(item.id),
          })),
        })
      } else if (action === 'write') {
        if (args.submit === true) badges.push(t('badge.submitted'))
        if (typeof args.text === 'string' && args.text !== '') sections.push({ label: t('label.input'), text: args.text })
      } else if (action === 'wait') {
        if (typeof args.text === 'string' && args.text !== '') summary = args.text
        if (WAIT_KINDS.includes(result.kind)) badges.push(t(`badge.${result.kind}`))
        const screen = result.text ?? ''
        sections.push({ label: t('label.screen'), text: screen.trim() === '' ? t('hint.blankScreen') : screen })
      } else if (action === 'open') {
        summary = shortId(result.terminal_id)
        sections.push({ label: t('label.terminal'), text: shortId(result.terminal_id) })
        if (typeof args.cols === 'number' && typeof args.rows === 'number') sections.push({ label: t('label.size'), text: `${args.cols}×${args.rows}` })
        if (typeof args.shell_path === 'string' && args.shell_path !== '') sections.push({ label: t('label.shell'), text: args.shell_path })
      } else if (action === 'close') {
        summary = shortId(args.terminal_id)
        sections.push({ label: t('label.terminal'), text: shortId(args.terminal_id) })
      }
      return { state: 'done', title: t(`action.${action}`), summary, sections, badges, waiting: false }
    }

    // ── 行组件(官方 BashRow 同构) ───────────────────────────────────────
    // hooks 恒序:所有 hooks 先于分支渲染执行
    function TerminalToolRow(props) {
      const block = props.block
      const settled = props.phase === 'result'
      const model = cardModel(block, props.phase, props.t ?? (() => ''))
      const [open, setOpen] = React.useState(false)
      const [error, setError] = React.useState('')
      const lifetime = React.useRef(null)
      const args = parse(settled ? block.call?.argsRaw : block.argsRaw)
      const raw = settled ? (block.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('') : ''
      const result = parse(raw)
      const terminalId = settled && !block.isError && result?.ok === true && typeof result.terminal_id === 'string' ? result.terminal_id : undefined
      const canOpen = args?.action === 'open' && terminalId !== undefined && typeof props.sessionId === 'string'
      const navigate = (signal = lifetime.current?.signal) => props.openTerminal(sessionIdOf(props), terminalId, () => signal !== undefined && !signal.aborted)
        .catch((cause) => { if (signal && !signal.aborted) setError(String(cause?.message ?? cause)) })
      // wait 手动打断:POST 宿主 skip 路由,abort 同键全部 pending wait(结果以 skipped 落卡)
      const canSkip = model.waiting === true && typeof props.sessionId === 'string' && typeof args?.terminal_id === 'string'
      const skipWait = async () => {
        try {
          const response = await fetch('/api/shared-terminal/wait/skip', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: props.sessionId, terminalId: args.terminal_id }),
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
        } catch (cause) {
          const signal = lifetime.current?.signal
          if (signal && !signal.aborted) setError(String(cause?.message ?? cause))
        }
      }
      React.useEffect(() => {
        const controller = new AbortController()
        lifetime.current = controller
        if (canOpen && !openedCalls.has(props.callId)) {
          void navigate(controller.signal).then((opened) => { if (opened) openedCalls.add(props.callId) })
        }
        return () => controller.abort()
      }, [canOpen, terminalId, props.sessionId, props.callId])

      if (props.phase === 'preparing') {
        return h('div', { className: 'stv', 'data-tool': 'terminal', 'data-state': 'preparing' },
          h('div', { className: 'stv-row' },
            h('span', { className: 'stv-leading' }, h(primitives.IconCodeOutlineRegular, { size: 14 })),
            h(primitives.TextShimmer, { active: true }, h('span', { className: 'stv-title' }, props.t ? props.t('preparing') : '')),
          ),
        )
      }

      const expandable = model.sections.length > 0
      const expanded = open && expandable
      const statusText = model.state === 'running' ? props.t?.('running') : model.state === 'error' ? props.t?.('error') : null
      // 官方 BashRow leading 同构:icon + chevron(展开 Up/折叠 Down),不可展开仅 icon
      const leading = expandable
        ? [
            h('span', { key: 'icon', className: 'stv-iconIdle' }, h(primitives.IconCodeOutlineRegular, { size: 14 })),
            h(expanded ? primitives.IconChevronUpOutlineRegular : primitives.IconChevronDownOutlineRegular, { key: 'chevron', className: 'stv-chevron' }),
          ]
        : h('span', { className: 'stv-iconIdle' }, h(primitives.IconCodeOutlineRegular, { size: 14 }))
      const toggleFromKeyboard = (event) => {
        if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        setOpen((value) => !value)
      }
      return h('div', { className: 'stv', 'data-tool': 'terminal' },
        h('div', {
          className: 'stv-row',
          'data-state': model.state,
          'data-expandable': expandable || undefined,
          role: expandable ? 'button' : undefined,
          tabIndex: expandable ? 0 : undefined,
          'aria-expanded': expandable ? expanded : undefined,
          onClick: expandable ? () => setOpen((value) => !value) : undefined,
          onKeyDown: expandable ? toggleFromKeyboard : undefined,
        },
          h('span', { className: 'stv-leading' }, leading),
          statusText !== null && statusText !== undefined ? h('span', { className: 'stv-visuallyHidden' }, statusText) : null,
          h(primitives.TextShimmer, { active: model.state === 'running' },
            h('span', { className: 'stv-title' }, model.title),
            (model.state === 'running' || model.summary !== '') && h('span', { className: 'stv-sep', 'data-shimmer-decoration': true, 'aria-hidden': true }),
            h('span', { className: 'stv-summary', 'data-error': model.state === 'error' || undefined }, model.waiting ? model.summary : model.state === 'running' ? props.t?.('running') : model.summary),
          ),
          model.badges.map((badge) => h('span', { key: badge, className: 'stv-badge' }, badge)),
          canSkip ? h('button', { type: 'button', className: 'stv-openBtn', onClick: () => { void skipWait() } }, props.t?.('action.skipWait') ?? '') : null,
          canOpen ? h('button', { type: 'button', className: 'stv-openBtn', onClick: () => navigate() }, props.t?.('action.open') ?? '') : null,
          error !== '' ? h('span', { className: 'stv-badge', role: 'alert' }, error) : null,
        ),
        expanded ? h('div', { className: 'stv-bodyWrap' },
          model.sections.map((section, index) => [
            index > 0 ? h('span', { key: `d${index}`, className: 'stv-ioDivider', 'aria-hidden': true }) : null,
            h('section', { key: section.label, className: 'stv-ioSection', 'aria-label': section.label },
              h('span', { className: 'stv-ioLabel' }, section.label),
              section.list !== undefined
                ? section.list.map((item) => h('div', { key: item.id, className: 'stv-termRow' },
                    h('span', { className: 'stv-termTitle' }, item.title),
                    h('span', null, item.state),
                    h('span', { className: 'stv-badge' }, item.attached ? props.t?.('badge.attached') : props.t?.('badge.detached')),
                    h('span', { style: { opacity: .6 } }, item.id),
                  ))
                : h('pre', { className: 'stv-ioText' }, section.text),
            ),
          ]),
        ) : null,
      )
    }

    function sessionIdOf(props) {
      return typeof props.sessionId === 'string' ? props.sessionId : undefined
    }

    const openedCalls = new Set()

    // ── 只读终端自愈 ─────────────────────────────────────────────────────
    // 宿主在附着结束时只清 controller,不把 writable 交还 UI(宿主按 controller===follower 判定);
    // UI 只读时跳过 fitScreen,窗口或侧栏变矮后底部被 overflow:hidden 裁掉且不可滚。
    // 无控制者时点宿主「接管输入」,UI 重新附着后由宿主自己按容器重算几何。
    const HEAL_INTERVAL_MS = 2 * 1000
    const HEAL_COOLDOWN_MS = 5 * 1000
    const HEAL_OVERFLOW_PX = 2
    const HEAL_SESSIONS_MAX = 64
    // 查询不能拖住巡检:挂起的请求会让后续轮次被 running 守卫全部跳过
    const HEAL_QUERY_TIMEOUT_MS = 3 * 1000

    // 只读状态栏会把 .xterm 挤矮,那部分不算内容溢出:否则每次 AI 写完都会白抢一次控制权
    const clipped = (root) => {
      const content = root.querySelector('.xterm-screen')?.getBoundingClientRect()
      const box = root.querySelector('.xterm')?.getBoundingClientRect()
      if (content === undefined || box === undefined) return false
      const status = root.querySelector('[role="status"]')?.getBoundingClientRect().height ?? 0
      return content.height - box.height - status > HEAL_OVERFLOW_PX || content.width - box.width > HEAL_OVERFLOW_PX
    }

    // 状态栏按钮随终端状态变化:退出态是「新建终端」,按位置取会误建终端
    const TAKEOVER_LABELS = ['接管输入', 'take control']

    const takeoverButton = (root) => {
      const button = root.querySelector('[role="status"]')?.querySelector('button')
      const label = (button?.textContent ?? '').trim().toLowerCase()
      return TAKEOVER_LABELS.some((text) => label.includes(text)) ? button : undefined
    }

    // 隐藏 tab 没有几何;屏上 Session 才渲染终端面板,附着力按 mounted 判断即可
    const visibleRoot = (root) => {
      const rect = root.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }

    // 查询失败按"仍在附着"处理:宁可不自愈,也不抢走 AI 的写入
    const pumpAttached = async (sessionId) => {
      const response = await fetch('/api/shared-terminal/pump', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
        signal: AbortSignal.timeout(HEAL_QUERY_TIMEOUT_MS),
      })
      if (!response.ok) return true
      const state = await response.json()
      return state?.attached !== false
    }

    function healReadOnly(ctx) {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function' || typeof setInterval !== 'function') return () => {}
      const healed = new Map()
      let running = false
      // 只保留最近的上限条:重新插入以刷新顺序,超限时淘汰最旧的一条
      const remember = (sessionId, at) => {
        healed.delete(sessionId)
        healed.set(sessionId, at)
        while (healed.size > HEAL_SESSIONS_MAX) healed.delete(healed.keys().next().value)
      }
      // 每轮重扫 DOM:宿主 tab 可随时增删,缓存 root 会拿到已卸载的节点
      const tick = async () => {
        if (running || document.hidden === true) return
        running = true
        try {
          for (const root of document.querySelectorAll('[data-sidebar-terminal]')) {
            const button = takeoverButton(root)
            if (button === undefined || !visibleRoot(root) || !clipped(root)) continue
            const sessionId = ctx.sidebarRight.mounted?.getSnapshot()
            if (typeof sessionId !== 'string' || healed.get(sessionId) > Date.now() - HEAL_COOLDOWN_MS) continue
            // 泵附着中不抢控制权:那会让 AI 的下一次写入落空
            if (await pumpAttached(sessionId)) continue
            // 等待期间 tab 可能被卸载、状态栏按钮可能被替换、几何可能已恢复
            if (root.isConnected === false || !clipped(root)) continue
            const fresh = takeoverButton(root)
            if (fresh === undefined) continue
            remember(sessionId, Date.now())
            fresh.click()
          }
        } catch {
          // 自愈是宿主行为的兜底,失败不得影响渲染
        } finally {
          running = false
        }
      }
      const timer = setInterval(tick, HEAL_INTERVAL_MS)
      return () => clearInterval(timer)
    }

    return {
      inject: ['remote', 'remote.terminal', 'slots', 'sidebarRight', 'locale'],
      apply(ctx) {
        // Session terminal 复用:同一官方 sidebar xterm,用户可输入并查看当前屏幕
        async function openExisting(sessionId, terminalId, alive) {
          const listed = await ctx.remote.terminal.list(sessionId)
          if (!alive() || !listed.ok || !listed.value.some((item) => item.id === terminalId)) return false
          const existing = ctx.sidebarRight.openTabs?.getSnapshot().find((tab) => {
            if (tab.sessionId !== sessionId || tab.kind !== 'terminal') return false
            const params = ctx.sidebarRight.tabDomain.occurrence(sessionId, { id: tab.tabId }).navigation.getSnapshot().params
            return params?.terminalId === terminalId
          })
          if (existing) ctx.sidebarRight.openResourceIn(sessionId, existing.contentId, { kind: 'terminal', params: { terminalId } })
          else ctx.sidebarRight.openTabIn(sessionId, 'terminal', { params: { terminalId } })
          return true
        }
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
          { name: 'tool.call.toolview', key: 'terminal', locale: NS },
          (props) => h(TerminalToolRow, { ...props, openTerminal: (sessionId, terminalId, alive) => openExisting(sessionId, terminalId, alive) }),
        ))
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'shared-terminal dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', '@mzzsfy/dsh-shared-terminal')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'shared-terminal styles')
        ctx.effect(() => healReadOnly(ctx), 'shared-terminal read-only healing')
      },
    }
  },
})
