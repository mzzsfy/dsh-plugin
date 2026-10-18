window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-boss-simulator',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React
    const ID = '@mzzsfy/dsh-boss-simulator'
    const API = '/api/boss-simulator/'
    const REFRESH_MS = 3 * 1000
    const READ_TIMEOUT_MS = 10 * 1000
    const STALE_MS = 15 * 1000
    const RETRY_MS = [3, 6, 12, 30].map((seconds) => seconds * 1000)
    const COLUMNS = [
      ['draft', '草稿'], ['ready', '已授权待调度'], ['implementing', '实施中'], ['awaiting_acceptance', '待验收'],
      ['completed', '已结案'], ['blocked', '受阻'], ['cancelled', '已取消'],
    ]
    const BUSINESS = Object.fromEntries(COLUMNS)
    const CONTROL = { active: '可执行', stopping: '中断中', paused: '已暂停', reconciling: '恢复核对中' }
    const RUN = { prepared: '尚未开始', submitted: '已提交', running: '运行中', settled: '已结束', interrupted: '已中断', rejected: '已拒绝', unknown: '待核对' }
    const PHASE = { implement: '实施', fix: '修复', accept: '独立验收', integrate: '整合' }
    const WORK = { planned: '待开始', executing: '执行中', awaitingReview: '待验收', accepted: '已通过', blocked: '受阻', withdrawn: '已撤销' }
    const VERDICT = { ready_for_review: '提交验收', needs_help: '需要协助', pass: '验收通过', issues: '发现问题' }
    const TABS = [['board', '看板'], ['timeline', '实际时间线'], ['models', '模型任务']]
    const NAV_ICON = { '公司管理': 'plan', 'dsh-boss-simulator': 'plan' }
    if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
    else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
    else window.__navicIconQueue = [NAV_ICON]

    const CSS = `
.bs-root{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary,#0f1115);padding:16px;container-type:inline-size;contain:layout paint;min-width:0;height:100%;min-height:0;overflow:hidden}
.bs-workbench{display:grid;grid-template-columns:minmax(320px,.9fr) minmax(0,1.1fr);gap:16px;flex:1;min-height:0}.bs-chat{display:flex;flex-direction:column;min-height:0;min-width:0;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-base,#fff)}.bs-chat__head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.bs-chat__head h2{margin:0;font-size:16px}.bs-chat__head p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#61666b);font-size:12px}.bs-chat__body{flex:1;min-height:0;display:flex;flex-direction:column}.bs-chat__body>[data-conversation-content]{flex:1;min-height:0}.bs-chat__welcome{display:flex;flex-direction:column;justify-content:space-between;gap:24px;flex:1;padding:24px 18px}.bs-chat__welcome--retry{flex:0;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.bs-chat__welcome--retry>div:first-child{display:none}.bs-chat__welcome h3{font-size:20px;margin:0 0 12px}.bs-chat__welcome p{font-size:14px;line-height:1.7;color:var(--dsw-alias-label-secondary,#61666b)}.bs-chat__first{display:flex;flex-direction:column;gap:10px}.bs-chat__first label{font-size:13px}.bs-chat__first textarea{resize:vertical;min-height:100px;width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));color:inherit;background:var(--dsw-alias-bg-base,#fff);font:inherit;line-height:1.6}.bs-chat__send{display:flex;align-items:center;justify-content:space-between;gap:10px}.bs-btn--primary{background:var(--dsw-alias-state-focus-primary,#3978d4);color:#fff}.bs-taskspace{display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0;overflow:auto}.bs-workspace-switch{display:none}
@container(max-width:767px){.bs-workbench{grid-template-columns:minmax(0,1fr)}.bs-workspace-switch{display:flex;gap:8px}.bs-workbench[data-workspace-view="chat"]>.bs-taskspace:not([data-detail-open="true"]){display:none}.bs-workbench:has(>.bs-taskspace[data-detail-open="true"])>.bs-chat{display:none}.bs-workbench[data-workspace-view="tasks"]>.bs-chat{display:none}}
.bs-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));padding-bottom:12px}
.bs-head__title{font:600 18px/27px var(--dsw-font-family,sans-serif)}.bs-head__caption{font:400 13px/20px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-secondary,#61666b);flex:1}
.bs-banner{font:400 13px/20px var(--dsw-font-family,sans-serif);display:flex;gap:12px;flex-wrap:wrap;padding:8px 10px;border-inline-start:3px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-secondary,rgba(0,0,0,.025))}.bs-banner__error{color:var(--dsw-alias-state-error-primary,#b42318)}
.bs-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.bs-search{flex:0 1 280px;min-height:36px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:6px;padding:7px 10px;font:400 14px/20px var(--dsw-font-family,sans-serif);background:var(--dsw-alias-bg-base,#fff);color:inherit}
.bs-btn{display:inline-flex;align-items:center;justify-content:center;min-height:36px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:var(--dsw-alias-bg-base,#fff);color:inherit;font:500 14px/20px var(--dsw-font-family,sans-serif);border-radius:6px;padding:7px 12px;cursor:pointer;text-decoration:none}.bs-btn:hover{background:var(--dsw-alias-bg-secondary,rgba(0,0,0,.04))}.bs-btn--danger{color:var(--dsw-alias-state-error-primary,#b42318)}.bs-btn:disabled{opacity:.55;cursor:not-allowed}.bs-root :focus-visible{outline:2px solid var(--dsw-alias-state-focus-primary,#3978d4);outline-offset:2px}
.bs-board{display:flex;gap:12px;overflow-x:auto;align-items:flex-start;max-width:100%;padding:2px 2px 12px;overscroll-behavior-inline:contain}.bs-col{flex:0 0 256px;display:flex;flex-direction:column;gap:8px;min-width:0}.bs-col__head{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-base,#fff);font:600 14px/22px var(--dsw-font-family,sans-serif);display:flex;gap:8px;align-items:baseline;padding:6px 2px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12))}.bs-col__count{font:400 12px/18px var(--dsw-font-family,sans-serif);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#61666b)}
.bs-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-base,#fff);padding:10px 12px;display:flex;flex-direction:column;gap:5px;color:inherit;min-width:0}.bs-card__open:focus-visible{outline:2px solid var(--dsw-alias-state-focus-primary,#3978d4);outline-offset:2px}.bs-discard-dialog{position:fixed;inset:50% auto auto 50%;transform:translate(-50%,-50%);z-index:40;max-width:min(480px,calc(100% - 24px));padding:20px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));border-radius:8px;box-shadow:0 10px 32px rgba(0,0,0,.24)}.bs-card__open{display:flex;flex-direction:column;gap:6px;align-items:flex-start;text-align:left;border:0;background:transparent;padding:0;width:100%;color:inherit;font:inherit;cursor:pointer}.bs-card__title{font:600 14px/21px var(--dsw-font-family,sans-serif);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.bs-card__id{font:400 11px/16px var(--dsw-font-family-mono,monospace);color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}.bs-card__meta{font:400 12px/18px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}.bs-card__row{display:flex;gap:6px;flex-wrap:wrap}.bs-card--on{outline:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.4))}
.bs-board-layout{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:16px;align-items:start;min-width:0}.bs-board-layout--plain{grid-template-columns:minmax(0,1fr)}.bs-main{min-width:0}
.bs-detail__actions{display:flex;justify-content:flex-end;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.bs-detail__actions .bs-btn{min-height:44px}.bs-detail{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;padding:12px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-base,#fff);min-width:0;max-height:calc(100cqh - 32px);overflow:auto}.bs-detail__head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.bs-detail__title{font:600 16px/24px var(--dsw-font-family,sans-serif);overflow-wrap:anywhere;flex:1}.bs-detail__body{display:grid;gap:8px;font:400 14px/21px var(--dsw-font-family,sans-serif);min-width:0}.bs-detail__group{display:grid;gap:4px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));padding-top:8px}.bs-detail__label{font-size:12px;color:var(--dsw-alias-label-secondary,#61666b)}
.bs-status{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));border-radius:4px;padding:2px 6px;font:500 12px/17px var(--dsw-font-family,sans-serif);white-space:normal}.bs-status--danger{border-color:var(--dsw-alias-state-error-primary,#b42318);color:var(--dsw-alias-state-error-primary,#b42318)}
.bs-run{border-inline-start:3px solid var(--dsw-alias-border-l3,rgba(0,0,0,.34));padding:8px 10px;display:flex;flex-direction:column;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.bs-run__head,.bs-run__seg,.bs-run__meta{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.bs-run__head{justify-content:space-between}.bs-run__seg,.bs-run__meta{font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums}.bs-run__line{height:6px;min-width:12px;background:var(--dsw-alias-bg-tertiary,rgba(0,0,0,.1));border-radius:2px;overflow:hidden}.bs-run__line-fill{display:block;height:100%;background:var(--dsw-alias-label-secondary,#61666b)}.bs-run__line-fill--open{background:var(--dsw-alias-state-info-primary,#3978d4)}
.bs-empty{font:400 14px/21px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-secondary,#61666b);padding:10px}.bs-settings{max-width:720px}.bs-setting-row{display:grid;grid-template-columns:minmax(180px,1fr) minmax(200px,2fr);gap:12px;align-items:center;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));padding:10px 0}.bs-setting-note{font-size:12px;color:var(--dsw-alias-label-secondary,#61666b)}.bs-statuses{display:none}.bs-visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.bs-model-row{display:grid;grid-template-columns:minmax(160px,1fr) 100px minmax(240px,2fr);gap:12px;padding:8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));align-items:center}.bs-model-row--head{font-weight:600}.bs-model-task-list{display:flex;gap:6px;flex-wrap:wrap}
@container (max-width:1279px){.bs-board-layout{grid-template-columns:minmax(0,1fr)}.bs-drawer{position:fixed;z-index:20;inset:0 0 0 auto;width:min(420px,100%);max-height:100dvh;border-radius:0;box-shadow:0 0 0 100vmax rgba(0,0,0,.35)}}
@container (max-width:767px){.bs-root{padding:12px;gap:12px}.bs-head__caption{flex-basis:100%}.bs-toolbar>*{min-height:44px}.bs-toolbar .bs-search{flex:1 1 100%;font-size:16px}.bs-statuses{display:flex;gap:8px;overflow:auto;padding:2px 0}.bs-status-select{white-space:nowrap;min-height:44px}.bs-board{display:block;overflow:visible}.bs-col{display:none;flex-basis:auto}.bs-col--mobile{display:flex}.bs-board-layout{display:block}.bs-detail--mobile{position:fixed;z-index:30;inset:0;background:var(--dsw-alias-bg-base,#fff);max-height:100dvh;border-radius:0;padding:12px;overflow:auto}.bs-setting-row{grid-template-columns:1fr;gap:4px}.bs-model-row{grid-template-columns:1fr;gap:4px}}
@media(prefers-reduced-motion:reduce){.bs-root *{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
`

    function commandId() { return `stop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }
    function tokenText(total, coverage) {
      if (coverage === 'unknown' || total === null || total === undefined) return 'token 未知'
      if (coverage === 'partial') return `已知 ${total} token · 不完整`
      return `${total} token`
    }
    function controlText(task) {
      const result = [CONTROL[task.controlState] ?? '控制状态待核对']
      if (task.stopDetail === 'requesting') result.push('中断中')
      if (task.stopDetail === 'unconfirmed') result.push('停止结果待确认')
      if (task.pendingCancel) result.push('取消处理中')
      return result
    }
    function modelText(run) { return run.actualModel ? run.actualModel : '模型待核对' }

    function FixedChat(props) { return props.renderSlot('conversation.session', { view: 'chat' }) }

    function EmbeddedChat({ useSession, renderFactorySlot }) {
      const session = useSession((value) => value)
      if (session.openState === 'error' || session.removed) return h('p', { className: 'bs-banner__error', role: 'alert' }, session.openError?.message ?? '管理员会话不可用，请重建管理员；任务记录保留。')
      return renderFactorySlot('conversation.content', { variant: 'embedded', phase: session.openState === 'loading' ? 'settling' : 'active', hero: false }, { slots: { views: FixedChat } })
    }

    const FIRST_MESSAGE_KEY = `${ID}:first-message`
    function readFirstMessage() {
      try {
        const saved = JSON.parse(sessionStorage.getItem(FIRST_MESSAGE_KEY) ?? 'null')
        return saved && typeof saved.draft === 'string' ? saved : { draft: '' }
      } catch { return { draft: '' } }
    }

    function AdminConversation({ sessionId, sessions, conversation, SessionProvider, renderSlot, pending, createSession, firstMessage, onFirstMessage, onError }) {
      const draft = firstMessage.draft
      const [bound, setBound] = useState(null)
      const [failure, setFailure] = useState('')
      const [sending, setSending] = useState(false)
      const sendLock = useRef(false)
      const lifetime = useRef(null)
      const sendingReference = useRef(null)
      useEffect(() => {
        const controller = new AbortController()
        lifetime.current = controller
        return () => { controller.abort(); sendingReference.current?.release(); sendingReference.current = null }
      }, [])
      useEffect(() => {
        if (!sessionId || !draft.trim()) return
        const block = { reason: '请先核对并处理保留的首条消息' }
        conversation.blocks.set(sessionId, block)
        return () => {
          if (conversation.blocks.storeFor(sessionId).getSnapshot() === block) conversation.blocks.set(sessionId, undefined)
        }
      }, [sessionId, Boolean(draft.trim()), conversation])
      useEffect(() => {
        if (!sessionId) { setBound(null); return }
        let reference
        try {
          reference = sessions.retain(sessionId, { source: 'bossSimulatorPanel' })
          setFailure('')
          setBound({ sessionId, reference })
        } catch (error) { setFailure(error.message ?? String(error)) }
        return () => reference?.release()
      }, [sessionId, sessions])
      async function sendFirst(event) {
        event.preventDefault()
        if (sendLock.current || !draft.trim()) return
        sendLock.current = true
        setSending(true)
        const controller = lifetime.current
        const text = draft.trim()
        let reference
        try {
          // 重试复用已登记的管理员会话；仅首次没有绑定时才创建。
          const id = firstMessage.sessionId ?? await createSession(false)
          if (controller.signal.aborted) return
          reference = sessions.retain(id, { source: 'bossSimulatorFirstMessage', signal: controller.signal })
          sendingReference.current = reference
          await reference.ready
          if (controller.signal.aborted) return
          const session = reference.binding.session
          const snapshot = session.getSnapshot()
          if (snapshot.openState !== 'open') throw new Error(snapshot.openError?.message ?? '管理员会话未打开，输入已保留')
          const requestId = firstMessage.requestId ?? session.beginSubmission({ mode: 'queue', text, attachments: [] }).requestId
          // 身份先保存再发送；离开只释放本地引用，不取消已经受理的后台回合。
          onFirstMessage({ draft: text, sessionId: id, requestId })
          const result = await session.prompt([{ type: 'text', text }], 'queue', undefined, requestId)
          if (!result.ok) throw new Error(result.error?.message ?? '发送未受理，输入已保留')
          onFirstMessage({ draft: '' })
        } catch (error) {
          if (!controller.signal.aborted) onError(`发送结果未确认：${error.message ?? error}。输入已保留，请核对对话后再试。`)
        } finally {
          reference?.release()
          if (sendingReference.current === reference) sendingReference.current = null
          sendLock.current = false
          if (!controller.signal.aborted) setSending(false)
        }
      }
      const current = bound?.sessionId === sessionId ? bound.reference : null
      return h('section', { className: 'bs-chat', role: 'region', 'aria-label': '管理员对话' },
        h('div', { className: 'bs-chat__head' }, h('div', null, h('h2', null, '管理员'), h('p', null, '交代目标、确认方案、接收汇报')), h('span', { className: 'bs-setting-note' }, '安排与讨论')),
        failure ? h('p', { className: 'bs-banner__error', role: 'alert' }, failure) : null,
        current ? h('div', { className: 'bs-chat__body' }, h(SessionProvider, { session: current }, renderSlot('boss-simulator.chat', {}))) : null,
        !current || draft ? h('div', { className: `bs-chat__welcome${current ? ' bs-chat__welcome--retry' : ''}` },
          h('div', null, h('h3', null, '你定目标，管理员安排团队'), h('p', null, '说清要做什么、在哪个项目做。管理员会先澄清范围和验收标准，明确授权后再执行。')),
          h('form', { onSubmit: sendFirst, className: 'bs-chat__first' }, h('label', { htmlFor: 'bs-admin-draft' }, '给管理员安排工作'), h('textarea', { id: 'bs-admin-draft', value: draft, onChange: (event) => onFirstMessage({ draft: event.target.value }), placeholder: '例如：检查结算服务的重试问题，先给我方案', rows: 4, disabled: pending || sending || Boolean(firstMessage.requestId) }), h('div', { className: 'bs-chat__send' }, h('span', { className: 'bs-setting-note' }, '发送才开始讨论；查看页面不会开工'), h('button', { className: 'bs-btn bs-btn--primary', type: 'submit', disabled: pending || sending || !draft.trim() }, sending ? '正在发送' : '发送'), current && draft ? h('button', { className: 'bs-btn', type: 'button', disabled: pending || sending, onClick: () => { onFirstMessage({ draft: '' }); onError('') } }, '放弃保留输入') : null))) : null,
      )
    }

    function App({ api, sessions, conversation, uiWorkspace, SessionProvider, renderSlot }) {
      const catalog = React.useSyncExternalStore((notify) => sessions.list.subscribe(notify), () => sessions.list.getSnapshot())
      const accessibleSessions = new Set(catalog.ids)
      const [sessionMessage, setSessionMessage] = useState('')
      const [data, setData] = useState(null)
      const [loadError, setLoadError] = useState(false)
      const [observedAt, setObservedAt] = useState(null)
      const [search, setSearch] = useState('')
      const [workspace, setWorkspace] = useState('')
      const [mobileState, setMobileState] = useState('draft')
      const [tab, setTab] = useState('board')
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState(null)
      const [detailError, setDetailError] = useState(null)
      const [settings, setSettings] = useState(null)
      const [settingsDirty, setSettingsDirty] = useState(false)
      const [settingsMessage, setSettingsMessage] = useState('')
      const [settingsConfirmDiscard, setSettingsConfirmDiscard] = useState(false)
      const [writing, setWriting] = useState(false)
      const [stopMessage, setStopMessage] = useState('')
      const [adminOverride, setAdminOverride] = useState(undefined)
      const [adminRebuildConfirm, setAdminRebuildConfirm] = useState(false)
      const [adminPending, setAdminPending] = useState(false)
      const [firstMessage, setFirstMessage] = useState(readFirstMessage)
      function updateFirstMessage(value) {
        try {
          if (value.draft) sessionStorage.setItem(FIRST_MESSAGE_KEY, JSON.stringify(value))
          else sessionStorage.removeItem(FIRST_MESSAGE_KEY)
        } catch { setSessionMessage('浏览器无法保存首条输入；离开页面前请复制保留。') }
        setFirstMessage(value)
      }
      const [workspaceView, setWorkspaceView] = useState('chat')
      const adminCreateLock = useRef(null)
      const [containerWidth, setContainerWidth] = useState(0)
      const loadedPages = useRef(1)
      const activeQuery = useRef('')
      const [readingMore, setReadingMore] = useState(false)
      const rootRef = useRef(null)
      const readController = useRef(null)
      const queryEpoch = useRef(0)
      const detailRef = useRef(null)
      const discardRef = useRef(null)
      const settingsRead = useRef(null)
      const settingsFocus = useRef(null)
      const returnFocus = useRef(null)
      const detailTitle = useRef(null)
      const [clock, setClock] = useState(Date.now())
      const [visible, setVisible] = useState(!document.hidden)

      useEffect(() => { sessions.refresh().catch(() => setSessionMessage('会话目录读取失败；历史引用保留，未创建替代会话。')) }, [sessions])
      // override 只服务"创建后立即导航"窗口;服务端绑定与本页不一致(如另一页重建)时回归服务端事实,两步确认同时失效
      const serverAdministrator = data?.administrator ?? null
      useEffect(() => {
        if (serverAdministrator != null && adminOverride !== undefined && serverAdministrator !== adminOverride) {
          setAdminOverride(undefined)
          setAdminRebuildConfirm(false)
        }
      }, [serverAdministrator, adminOverride])
      function openSession(sessionId) {
        if (!accessibleSessions.has(sessionId)) return
        uiWorkspace.openSession(sessionId)
      }
      // 创建只登记空会话；对话留在本面板，发送首条消息由用户表单显式触发。
      async function createAdminSession(replace = false) {
        if (adminCreateLock.current) return adminCreateLock.current
        setAdminPending(true)
        setSessionMessage('正在创建管理员会话。')
        const creation = (async () => {
          try {
            const result = await api.post('admin', { action: 'create', replace: replace || undefined })
            if (!result?.sessionId) throw new Error('创建结果缺少会话标识')
            await sessions.refresh()
            setAdminOverride(result.sessionId)
            setAdminRebuildConfirm(false)
            setWorkspaceView('chat')
            setSessionMessage('')
            return result.sessionId
          } catch (error) {
            setSessionMessage(`管理员会话结果未确认：${error.message ?? error}。未自动重试，请核对服务端绑定。`)
            throw error
          } finally { setAdminPending(false); adminCreateLock.current = null }
        })()
        adminCreateLock.current = creation
        return creation
      }
      function startAdmin(replace = false) { createAdminSession(replace).catch(() => {}) }
      const refresh = useCallback(async (more = false) => {
        if (document.hidden) return
        const key = JSON.stringify([search, workspace])
        if (activeQuery.current !== key) { activeQuery.current = key; loadedPages.current = 1 }
        if (more !== true && readController.current && !readController.current.signal.aborted) return null
        if (more === true) loadedPages.current += 1
        const requestedPages = loadedPages.current
        if (more === true) setReadingMore(true)
        readController.current?.abort()
        const controller = new AbortController()
        readController.current = controller
        const epoch = ++queryEpoch.current
        const timeout = setTimeout(() => controller.abort(new Error('读取超时')), READ_TIMEOUT_MS)
        const query = new URLSearchParams()
        if (search) query.set('search', search)
        if (workspace) query.set('workspaceId', workspace)
        try {
          let result
          const tasks = []
          let pageCount = 0
          for (; pageCount < requestedPages; pageCount += 1) {
            const page = await api.get(`board${query.size ? `?${query}` : ''}`, controller.signal)
            if (controller.signal.aborted || epoch !== queryEpoch.current) return
            tasks.push(...page.items)
            result = page
            if (!page.nextCursor) { pageCount += 1; break }
            query.set('cursor', page.nextCursor)
          }
          setData({ ...result, items: tasks })
          loadedPages.current = pageCount
          setObservedAt(new Date())
          setLoadError(false)
          return true
        } catch (error) {
          if (epoch === queryEpoch.current && (!controller.signal.aborted || controller.signal.reason?.message === '读取超时')) setLoadError(true)
          return false
        } finally { clearTimeout(timeout); if (epoch === queryEpoch.current) { readController.current = null; setReadingMore(false) } }
      }, [api, search, workspace, tab])

      useEffect(() => {
        const onVisibility = () => setVisible(!document.hidden)
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [])
      useEffect(() => {
        if (!visible) return undefined
        let disposed = false
        let timer
        let failures = 0
        const poll = async () => {
          const success = await refresh()
          if (disposed) return
          if (success !== null) failures = success ? 0 : failures + 1
          timer = setTimeout(poll, success || success === null ? REFRESH_MS : RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)])
        }
        poll()
        const ticker = setInterval(() => setClock(Date.now()), 1000)
        return () => { disposed = true; clearTimeout(timer); clearInterval(ticker); ++queryEpoch.current; readController.current?.abort() }
      }, [refresh, visible])

      const resizeObserver = useRef(null)
      const attachRoot = useCallback((root) => {
        resizeObserver.current?.disconnect()
        rootRef.current = root
        if (!root) return
        setContainerWidth(root.clientWidth - parseFloat(getComputedStyle(root).paddingLeft) - parseFloat(getComputedStyle(root).paddingRight))
        const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width))
        observer.observe(root)
        resizeObserver.current = observer
      }, [])
      useEffect(() => () => resizeObserver.current?.disconnect(), [])

      useEffect(() => {
        if (!selected || !visible) { if (!selected) { setDetail(null); setDetailError(null) }; return undefined }
        let disposed = false
        let controller
        let timer
        const pollDetail = async () => {
          controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), READ_TIMEOUT_MS)
          try {
            const value = await api.get(`board?taskId=${encodeURIComponent(selected)}`, controller.signal)
            if (!disposed) { setDetail(value); setDetailError(null) }
          } catch (error) { if (!disposed) setDetailError(error.message ?? '记录不可用') }
          finally { clearTimeout(timeout); if (!disposed) timer = setTimeout(pollDetail, REFRESH_MS) }
        }
        pollDetail()
        return () => { disposed = true; clearTimeout(timer); controller?.abort() }
      }, [api, selected, visible])

      const narrow = containerWidth <= 767
      const selectedModelSummary = data?.modelTasks?.flatMap((group) => group.tasks).find((task) => task.taskId === selected)
      const detailModal = Boolean(selected && tab === 'board' && containerWidth < 1280)
      useEffect(() => { if (selected) detailTitle.current?.focus() }, [selected, tab])
      useEffect(() => {
        const dialog = settingsConfirmDiscard ? discardRef.current : detailModal ? detailRef.current : null
        const root = rootRef.current
        if (!dialog || !root) return undefined
        const blocked = []
        let branch = dialog
        while (branch && branch !== root) {
          for (const sibling of branch.parentElement.children) {
            if (sibling !== branch && sibling.tagName !== 'STYLE') { blocked.push([sibling, sibling.inert]); sibling.inert = true }
          }
          branch = branch.parentElement
        }
        if (!dialog.contains(document.activeElement)) (dialog.querySelector('h2,h3') ?? dialog).focus()
        const onKey = (event) => {
          if (event.key !== 'Tab') return
          const focusable = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter((node) => node.getClientRects().length)
          if (!focusable.length) { event.preventDefault(); return }
          const first = focusable[0]; const last = focusable.at(-1)
          if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) { event.preventDefault(); first.focus() }
        }
        document.addEventListener('keydown', onKey)
        return () => { blocked.forEach(([node, previous]) => { node.inert = previous }); document.removeEventListener('keydown', onKey) }
      }, [detailModal, settingsConfirmDiscard, tab])
      useEffect(() => {
        if (!selected && !settingsConfirmDiscard) return undefined
        const onKey = (event) => { if (event.key === 'Escape') { if (settingsConfirmDiscard) continueEditing(); else closeDetail() } }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [selected, settingsConfirmDiscard])

      async function stop(body) {
        if (writing) return
        setWriting(true)
        setStopMessage('正在提交中断请求。')
        try {
          const result = await api.post('interrupt', { ...body, commandId: commandId() })
          setStopMessage(result.status === 'accepted' || result.accepted ? '已提交中断，等待服务端确认。' : '中断结果待核对；未确认前不视为已暂停。')
        } catch (error) { setStopMessage(`中断结果未知：${error.message ?? error}。不会自动重试。`) }
        finally { setWriting(false); refresh() }
      }
      function selectTask(task, event) {
        returnFocus.current = event.currentTarget
        setDetailError(null)
        setSelected(task.taskId)
        setTab('board')
      }
      function closeDetail() {
        const taskId = selected
        setSelected(null)
        setDetail(null)
        requestAnimationFrame(() => {
          const original = returnFocus.current
          const replacement = [...(rootRef.current?.querySelectorAll('.bs-card__open') ?? [])].find((node) => node.getAttribute('aria-label')?.endsWith(`，${taskId}`))
          const target = original?.isConnected && original.getClientRects().length && !original.closest('[inert]') ? original : replacement ?? rootRef.current?.querySelector('.bs-head__title')
          target?.focus()
        })
      }
      async function openSettings() {
        setWorkspaceView('tasks')
        if (tab === 'settings') return
        settingsRead.current?.abort()
        const controller = new AbortController()
        settingsRead.current = controller
        setSettings(null)
        setSettingsDirty(false)
        setSettingsMessage('正在读取设置。')
        setTab('settings')
        try {
          const value = await api.get('board?settings=1', controller.signal)
          if (controller.signal.aborted) return
          setSettings({ revision: value.configRevision, concurrencyReference: value.values.concurrencyReference })
          setSettingsMessage('')
        } catch (error) { if (!controller.signal.aborted) setSettingsMessage(`设置读取失败：${error.message ?? error}`) }
      }
      useEffect(() => () => settingsRead.current?.abort(), [])
      async function saveSettings() {
        if (!settings || !settingsDirty || writing) return
        setWriting(true)
        setSettingsMessage('正在保存设置。')
        try {
          const saved = await api.post('settings', { expectedConfigRevision: settings.revision, values: { concurrencyReference: settings.concurrencyReference } })
          setSettingsDirty(false)
          setSettings({ revision: saved.configRevision, concurrencyReference: saved.values.concurrencyReference })
          setSettingsMessage('已保存。仅影响后续角色决策或派发。')
        } catch (error) {
          const message = error.message ?? String(error)
          setSettingsMessage(`保存失败或版本冲突：${message}。本地草稿已保留。`)
          try {
            const latest = await api.get('board?settings=1')
            setSettings((draft) => ({ ...draft, revision: latest.configRevision }))
            setSettingsMessage((current) => `${current} 服务端当前为 ${latest.values.concurrencyReference ?? '未设置'}，版本 ${latest.configRevision}；核对后再显式保存。`)
          } catch {}
        } finally { setWriting(false) }
      }
      function continueEditing() {
        setSettingsConfirmDiscard(false)
        requestAnimationFrame(() => settingsFocus.current?.focus())
      }
      function leaveSettings(discard = false) {
        if (settingsDirty && !discard) { settingsFocus.current = document.activeElement; setSettingsConfirmDiscard(true); return }
        settingsRead.current?.abort()
        setSettingsConfirmDiscard(false)
        setSettingsDirty(false)
        setTab('board')
      }

      const items = data?.items ?? []
      const selectedSummary = items.find((task) => task.taskId === selected) ?? (detail?.taskId === selected ? detail : null) ?? selectedModelSummary ?? (selected ? { taskId: selected, title: selected } : null)
      const filtered = items.filter((task) => (!workspace || task.projectWorkspaceId === workspace) && (!search || `${task.taskId} ${task.title}`.toLowerCase().includes(search.toLowerCase())))
      const workspaces = data?.workspaceIds ?? []

      function renderRun(task, run) {
        const started = Boolean(run.startedAt)
        const open = run.state === 'running' && started
        const seconds = started && run.endedAt ? Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000)) : null
        return h('article', { className: 'bs-run', key: `${task.taskId}:${run.runId}`, 'data-run-id': run.runId },
          h('div', { className: 'bs-run__head' }, h('strong', null, `${run.runId} · ${PHASE[run.phase] ?? '阶段待核对'} · 第 ${run.attemptOrdinal ?? 1} 次`), h('span', { className: 'bs-status' }, RUN[run.state] ?? '状态待核对')),
          started ? h('div', { className: 'bs-run__line', 'aria-label': open ? '实际执行中' : '真实执行区间' }, h('span', { className: `bs-run__line-fill${open ? ' bs-run__line-fill--open' : ''}`, style: { width: '100%' } })) : h('p', { className: 'bs-empty' }, '尚未开始。'),
          h('div', { className: 'bs-run__seg' }, started ? h('span', null, `开始 ${new Date(run.startedAt).toLocaleString()}`) : null, run.endedAt ? h('span', null, `结束 ${new Date(run.endedAt).toLocaleString()}`) : open ? h('span', null, '运行中') : null, seconds !== null ? h('span', null, `墙钟区间 ${seconds} 秒`) : null),
          h('div', { className: 'bs-run__meta' }, h('span', null, modelText(run)), h('span', null, tokenText(run.tokenTotal, run.usageCoverage)), run.stopObserved ? h('span', null, run.stopObserved === 'confirmed' ? '停止已确认' : '停止待确认') : null, h('span', { className: 'bs-setting-note' }, run.sessionId ? `会话 ${run.sessionId}` : '会话记录不可用'), h('button', { className: 'bs-btn', disabled: !accessibleSessions.has(run.sessionId), title: accessibleSessions.has(run.sessionId) ? '打开已有会话，不创建或发送消息' : '会话不可用；保留历史引用', onClick: () => openSession(run.sessionId) }, accessibleSessions.has(run.sessionId) ? '打开会话' : '会话不可用')),
        )
      }

      function renderDetail() {
        if (!selectedSummary) return null
        const value = detail?.taskId === selected ? detail : selectedSummary
        const modality = narrow ? 'mobile' : containerWidth < 1280 ? 'drawer' : 'panel'
        return h('aside', { ref: detailRef, className: `bs-detail bs-drawer${narrow ? ' bs-detail--mobile' : ''}`, role: detailModal ? 'dialog' : undefined, 'aria-modal': detailModal ? 'true' : undefined, 'aria-labelledby': 'bs-task-detail-title', 'data-modality': modality },
          h('div', { className: 'bs-detail__head' }, h('h2', { className: 'bs-detail__title', id: 'bs-task-detail-title', tabIndex: -1, ref: detailTitle }, value.title), h('button', { className: 'bs-btn', onClick: closeDetail }, '关闭'), h('button', { className: 'bs-btn bs-btn--danger', disabled: writing || !(selectedSummary.activeRunCount > 0), title: selectedSummary.activeRunCount ? '中断请求等待服务端确认' : '当前无在途 Run', onClick: () => stop({ taskId: selected }) }, '中断')),
          h('div', { className: 'bs-detail__actions' }, h('button', { className: 'bs-btn bs-btn--danger', disabled: writing, onClick: () => stop({ global: true }) }, '全局紧急停止')),
          detailError ? h('p', { className: 'bs-banner__error', role: 'alert' }, `任务记录不可用：${detailError}`) : null,
          detail?.taskId !== selected && !detailError ? h('p', { className: 'bs-empty' }, '正在读取任务详情…') : null,
          h('div', { className: 'bs-detail__body' },
            h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '业务状态与控制事实'), h('span', null, `${BUSINESS[value.businessState] ?? value.businessState} · ${controlText(value).join(' · ')}`), value.businessState === 'blocked' && value.block?.reason ? h('span', { className: 'bs-status bs-status--danger' }, `受阻原因：${value.block.reason}`) : null, value.controlState === 'paused' ? h('span', null, '已暂停。需要继续时，请向管理员或对应执行/验收会话明确提出。') : null),
            detail?.taskId === selected ? h(React.Fragment, null,
              h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '目标与范围'), h('span', null, value.definition?.goal ?? '目标记录不可用'), h('span', null, value.definition?.scope ?? '未填写范围')),
              h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '工作区与执行目录'), h('span', null, value.projectWorkspaceId), h('span', null, value.projectWorkspaceId), ...(value.definition?.dependencyTaskIds ?? []).map((taskId) => h('span', { key: taskId }, `依赖任务 ${taskId} · 关联任务不可用`))),
              h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '验收标准'), ...(value.definition?.acceptanceCriteria ?? []).map((criterion) => h('span', { key: criterion.criterionId }, `${criterion.criterionId} · ${criterion.text}`))),
              h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '子任务'), ...(value.workItems ?? []).map((work) => h('div', { key: work.workItemId }, `${work.title} · ${WORK[work.state] ?? work.state}${work.dependencyWorkItemIds?.length ? ` · 依赖 ${work.dependencyWorkItemIds.join(', ')}` : ''}`))),
              h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '每次 Run'), ...((value.runs ?? []).length ? value.runs.map((run) => renderRun(value, run)) : ['尚无 Run 记录'])),
              h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '整合与整合验收'), ...['integrate', 'accept'].filter((phase) => (value.runs ?? []).some((run) => run.phase === phase)).map((phase) => h('span', { key: phase }, `${PHASE[phase]} · ${phase === 'accept' ? '验收角色' : '整合角色'}`))),
              h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '验收结果与报告'), ...((value.reports ?? []).length ? value.reports.map((report) => h('div', { key: report.reportId }, `${VERDICT[report.verdict] ?? report.verdict}${report.historical ? ' · 历史记录' : ''} · ${report.issues?.length ?? 0} 项问题`)) : ['尚无结果；待核对'])),
              h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '累计 token'), h('span', null, tokenText(value.usage?.tokenTotal, value.usage?.coverage))),
            ) : null,
          ),
        )
      }

      function renderBoard() {
        const hasNoTasks = data && Object.values(data.counts ?? {}).every((count) => count === 0) && !search && !workspace
        if (!data) return h('p', { className: 'bs-empty', 'aria-live': 'polite' }, loadError ? '任务读取失败。检查连接后重试。' : '正在读取任务…')
        if (hasNoTasks) return h('p', { className: 'bs-empty' }, '暂无任务。请与管理员讨论安排。')
        const columns = COLUMNS.map(([state, label]) => {
          const rows = filtered.filter((task) => task.businessState === state && (!narrow || mobileState === state))
          const count = data.counts?.[state]
          return h('section', { className: `bs-col${narrow && mobileState === state ? ' bs-col--mobile' : ''}`, key: state, 'aria-labelledby': `bs-state-${state}` },
            h('h2', { className: 'bs-col__head', id: `bs-state-${state}` }, label, h('span', { className: 'bs-col__count' }, count === undefined ? `已加载 ${rows.length}` : String(count))),
            ...rows.map((task) => h('article', { key: task.taskId, className: `bs-card${selected === task.taskId ? ' bs-card--on' : ''}` },
              h('button', { className: 'bs-card__open', 'aria-label': `打开任务 ${task.title}，${task.taskId}`, onClick: (event) => selectTask(task, event) },
                h('span', { className: 'bs-card__title' }, task.title), h('span', { className: 'bs-card__id' }, task.taskId),
                h('span', { className: 'bs-card__meta' }, `${task.projectWorkspaceId} · 优先级 ${task.priority ?? '未指定'}`),
                h('span', { className: 'bs-card__row' }, h('span', { className: 'bs-status' }, label), ...controlText(task).map((status) => h('span', { key: status, className: `bs-status${status.includes('待确认') ? ' bs-status--danger' : ''}` }, status))),
                task.block?.reason ? h('span', { className: 'bs-card__meta' }, `受阻原因：${task.block.reason}`) : null,
                h('span', { className: 'bs-card__meta' }, `子项 ${task.workItemCount} · 在途 Run ${task.activeRunCount} · ${tokenText(task.usage?.tokenTotal, task.usage?.coverage)}`),
              ),
              ['implementing', 'awaiting_acceptance'].includes(task.businessState) ? h('button', { className: 'bs-btn bs-btn--danger', disabled: writing, onClick: () => stop({ taskId: task.taskId }) }, '中断') : null,
            )),
            rows.length === 0 ? h('p', { className: 'bs-empty' }, '此状态暂无任务') : null,
          )
        })
        return h(React.Fragment, null,
          narrow ? h('div', { className: 'bs-statuses', 'aria-label': '选择任务状态' }, ...COLUMNS.map(([state, label]) => h('button', { className: `bs-btn bs-status-select${mobileState === state ? ' bs-card--on' : ''}`, key: state, 'aria-pressed': mobileState === state, onClick: () => setMobileState(state) }, `${label} · ${data.counts?.[state] ?? '…'}`))) : null,
          h('div', { className: selectedSummary ? 'bs-board-layout' : 'bs-board-layout bs-board-layout--plain' }, h('div', { className: 'bs-main' },
            filtered.length === 0 ? h('div', { className: 'bs-empty' }, '没有匹配的任务。', h('button', { className: 'bs-btn', onClick: () => { setSearch(''); setWorkspace('') } }, '清除筛选')) : null,
            h('div', { className: 'bs-board', 'aria-label': '七状态任务看板' }, ...columns),
          ), renderDetail()),
        )
      }

      function renderTimeline() {
        if (!data) return h('p', { className: 'bs-empty' }, loadError ? '时间线读取失败；请重试读取。' : '正在读取实际执行记录…')
        const tasks = selected ? [detail?.taskId === selected ? detail : selectedSummary].filter(Boolean) : filtered
        const rows = tasks.flatMap((task) => (task.runs ?? []).map((run) => ({ task, run })))
        if (!rows.length) return h('section', { className: 'bs-detail' }, h('h2', { className: 'bs-detail__title' }, '实际时间线'), h('p', { className: 'bs-empty' }, selectedSummary ? '该任务暂无执行记录。' : '暂无执行记录。'))
        return h('section', { className: 'bs-detail', 'aria-label': '实际时间线' }, h('div', { className: 'bs-detail__head' }, h('h2', { className: 'bs-detail__title' }, '实际时间线'), h('span', { className: 'bs-card__meta' }, '仅显示真实执行区间；排队和暂停不画区间。')),
          ...rows.map(({ task, run }) => h('div', { key: `${task.taskId}:${run.runId}`, className: 'bs-run' },
            h('div', { className: 'bs-run__head' }, h('button', { className: 'bs-btn', onClick: (event) => selectTask(task, event) }, task.title), h('span', null, task.taskId), h('span', { className: 'bs-status' }, `${PHASE[run.phase] ?? run.phase} · ${RUN[run.state] ?? run.state}`)),
            run.startedAt ? h('div', { className: 'bs-run__line', 'aria-label': run.state === 'running' && loadError ? '最后观测仍在运行' : '真实执行区间' }, h('span', { className: `bs-run__line-fill${run.state === 'running' ? ' bs-run__line-fill--open' : ''}`, style: { width: '100%' } })) : h('p', { className: 'bs-empty' }, '尚未开始。'),
            h('div', { className: 'bs-run__seg' }, run.startedAt ? h('span', null, `开始 ${new Date(run.startedAt).toLocaleString()}`) : null, run.endedAt ? h('span', null, `结束 ${new Date(run.endedAt).toLocaleString()}`) : run.state === 'running' ? h('span', null, loadError ? `最后观测仍在运行 · ${observedAt?.toLocaleTimeString() ?? ''}` : '运行中') : null),
            h('div', { className: 'bs-run__meta' }, h('span', null, modelText(run)), h('span', null, tokenText(run.tokenTotal, run.usageCoverage)), run.stopObserved ? h('span', null, run.stopObserved === 'confirmed' ? '停止已确认' : '停止待确认') : null),
          )),
        )
      }

      function renderModels() {
        if (!data) return h('p', { className: 'bs-empty' }, loadError ? '模型任务读取失败' : '正在读取模型归因…')
        const rows = data.modelTasks ?? []
        return h('section', { className: 'bs-detail', 'aria-label': '模型任务' }, h('div', { className: 'bs-detail__head' }, h('h2', { className: 'bs-detail__title' }, '模型任务'), h('span', { className: 'bs-card__meta' }, '按用量归因的实际模型分组；同一任务去重。')),
          rows.length ? h('div', { role: 'table', 'aria-label': '模型参与任务' }, h('div', { role: 'row', className: 'bs-model-row bs-model-row--head' }, h('span', { role: 'columnheader' }, '实际模型'), h('span', { role: 'columnheader' }, '参与任务数'), h('span', { role: 'columnheader' }, '任务清单')),
            ...rows.map((group) => h('div', { role: 'row', className: 'bs-model-row', key: group.model }, h('span', { role: 'cell' }, `${group.model} · ${group.provider ?? '提供方待核对'}`), h('span', { role: 'cell' }, String(group.taskCount)), h('span', { role: 'cell', className: 'bs-model-task-list' }, ...group.tasks.map((task) => h('button', { className: 'bs-btn', key: task.taskId, onClick: (event) => selectTask(task, event) }, task.title))))),
          ) : h('p', { className: 'bs-empty' }, filtered.some((task) => task.runs?.length) ? '模型待核对；不以请求模型冒充实际模型。' : '暂无模型任务记录。'),
        )
      }

      function renderSettings() {
        return h('section', { className: 'bs-detail bs-settings', 'aria-labelledby': 'bs-settings-title' }, h('div', { className: 'bs-detail__head' }, h('h2', { id: 'bs-settings-title', className: 'bs-detail__title' }, '设置')),
          settingsConfirmDiscard ? h('div', { ref: discardRef, className: 'bs-discard-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'bs-discard-title', 'aria-describedby': 'bs-discard-description' }, h('h3', { id: 'bs-discard-title', tabIndex: -1 }, '放弃未保存修改？'), h('p', { id: 'bs-discard-description' }, '当前更改尚未保存。'), h('div', { className: 'bs-toolbar' }, h('button', { className: 'bs-btn', onClick: continueEditing }, '继续编辑'), h('button', { className: 'bs-btn bs-btn--danger', onClick: () => leaveSettings(true) }, '放弃修改'))) : null,
          h('div', { className: 'bs-setting-row' },h('div', null, h('label', { htmlFor: 'bs-concurrency' }, '全局并发参考值'), h('p', { className: 'bs-setting-note' }, '仅作角色决策参考，不构成硬限制；留空表示未设置。')), h('input', { id: 'bs-concurrency', className: 'bs-search', type: 'number', min: 1, max: 16, step: 1, disabled: !settings || writing, value: settings?.concurrencyReference ?? '', onChange: (event) => { setSettingsDirty(true); setSettings((current) => ({ ...current, concurrencyReference: event.target.value === '' ? null : Number(event.target.value) })) } })),
          settingsMessage ? h('p', { className: settingsMessage.includes('失败') || settingsMessage.includes('冲突') ? 'bs-banner__error' : 'bs-setting-note', role: 'status', 'aria-live': 'polite' }, settingsMessage) : null,
          h('div', { className: 'bs-toolbar' }, h('button', { className: 'bs-btn', disabled: writing || !settings || !settingsDirty, onClick: saveSettings }, writing ? '正在保存' : '保存'), h('button', { className: 'bs-btn', disabled: writing, onClick: () => leaveSettings() }, '取消'), settingsDirty ? h('button', { className: 'bs-btn bs-btn--danger', disabled: writing, onClick: () => leaveSettings(true) }, '放弃修改') : null),
        )
      }

      const administrator = adminOverride !== undefined ? adminOverride : serverAdministrator
      const adminEntry = administrator == null
        ? { label: adminPending ? '正在创建管理员会话' : '创建管理员会话', title: '创建空管理员会话，在本面板讨论工作', disabled: adminPending, onClick: () => startAdmin(false) }
        : accessibleSessions.has(administrator)
          ? { label: '管理员对话', title: '在公司管理内查看管理员对话', disabled: adminPending, onClick: () => setWorkspaceView('chat') }
          : adminRebuildConfirm
            ? { label: '再次点击确认重建', title: '原管理员会话不可访问；重建替换绑定，任务与历史保留', disabled: adminPending, onClick: () => startAdmin(true) }
            : { label: '管理员会话不可用', title: '原管理员会话不可访问；点击进入重建确认', disabled: adminPending, onClick: () => setAdminRebuildConfirm(true) }
      return h('div', { className: 'bs-root', ref: attachRoot, 'data-container-width': containerWidth },
        h('style', { 'data-plugin': ID, dangerouslySetInnerHTML: { __html: CSS } }),
        h('header', { className: 'bs-head' }, h('strong', { className: 'bs-head__title', tabIndex: -1 }, '公司管理'), h('span', { className: 'bs-head__caption' }, '与管理员安排工作，在这里查看团队进展'), h('button', { className: 'bs-btn', disabled: adminEntry.disabled, title: adminEntry.title, onClick: adminEntry.onClick }, adminEntry.label), h('button', { className: 'bs-btn', onClick: openSettings }, '设置'), h('button', { className: 'bs-btn bs-btn--danger', disabled: writing, onClick: () => stop({ global: true }) }, '全局紧急停止')),
        h('div', { className: 'bs-banner', 'aria-live': 'polite' }, loadError ? h('span', { className: 'bs-banner__error' }, `连接中断，当前执行状态尚不可确认。最后成功观察：${observedAt?.toLocaleTimeString() ?? '无'}`) : h('span', null, `数据观察时间：${observedAt?.toLocaleTimeString() ?? '正在读取任务'}`), observedAt && clock - observedAt.getTime() > STALE_MS ? h('span', null, '数据可能过期；保留最后成功观察事实。') : null, sessionMessage ? h('span', { className: 'bs-banner__error' }, sessionMessage) : null, stopMessage ? h('span', { className: 'bs-banner__error' }, stopMessage) : null),
        h('div', { className: 'bs-workspace-switch', role: 'group', 'aria-label': '工作区视图' }, h('button', { className: 'bs-btn', 'aria-pressed': workspaceView === 'chat', onClick: () => setWorkspaceView('chat') }, '对话'), h('button', { className: 'bs-btn', 'aria-pressed': workspaceView === 'tasks', onClick: () => setWorkspaceView('tasks') }, '任务')),
        h('div', { className: 'bs-workbench', 'data-workspace-view': workspaceView },
          h(AdminConversation, { sessionId: administrator, sessions, conversation, SessionProvider, renderSlot, pending: adminPending, createSession: createAdminSession, firstMessage, onFirstMessage: updateFirstMessage, onError: setSessionMessage }),
          h('section', { className: 'bs-taskspace', 'aria-label': '团队任务', 'data-detail-open': Boolean(detailModal || settingsConfirmDiscard) },
        tab === 'settings' ? h(React.Fragment, null, h('div', { className: 'bs-toolbar' }, h('button', { className: 'bs-btn', onClick: () => leaveSettings() }, '返回面板')), renderSettings()) : h(React.Fragment, null,
          h('div', { className: 'bs-toolbar' },
            h('label', { className: 'bs-visually-hidden', htmlFor: 'bs-search' }, '搜索任务标题或标识'), h('input', { id: 'bs-search', className: 'bs-search', type: 'search', value: search, placeholder: '任务标题/标识搜索', onChange: (event) => { if (selected) closeDetail(); setSearch(event.target.value) } }),
            h('label', { className: 'bs-visually-hidden', htmlFor: 'bs-workspace' }, '按工作区筛选'), h('select', { id: 'bs-workspace', className: 'bs-search', value: workspace, onChange: (event) => setWorkspace(event.target.value) }, h('option', { value: '' }, '全部工作区'), ...workspaces.map((name) => h('option', { key: name, value: name }, name))),
          ),
          h('div', { className: 'bs-toolbar', role: 'tablist', 'aria-label': '任务视图' },
            ...TABS.map(([key, label]) => h('button', { key, role: 'tab', id: `bs-tab-${key}`, 'aria-selected': tab === key, 'aria-controls': 'bs-tabpanel', tabIndex: tab === key ? 0 : -1, className: `bs-btn${tab === key ? ' bs-card--on' : ''}`, onClick: () => setTab(key), onKeyDown: (event) => { const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0; if (delta) { event.preventDefault(); const next = TABS[(TABS.findIndex(([k]) => k === tab) + delta + TABS.length) % TABS.length][0]; setTab(next); requestAnimationFrame(() => document.getElementById(`bs-tab-${next}`)?.focus()) } } }, label)),
          ),
          h('div', { id: 'bs-tabpanel', role: 'tabpanel', 'aria-labelledby': `bs-tab-${tab}` }, tab === 'board' ? renderBoard() : tab === 'timeline' ? renderTimeline() : renderModels()),
          tab !== 'models' && data?.nextCursor ? h('button', { className: 'bs-btn', disabled: readingMore, 'aria-busy': readingMore, onClick: () => refresh(true) }, readingMore ? '正在加载任务' : '加载更多任务') : null,
        ),
          ),
        ),
      )
    }

    function Panel({ ctx, SessionProvider, renderSlot }) {
      const api = {
        get: async (path, signal) => { const response = await fetch(API + path, { signal }); const body = await response.json().catch(() => null); if (!response.ok) throw Object.assign(new Error(body?.error ?? `请求失败 (${response.status})`), { code: body?.code }); return body },
        post: async (path, body) => { const response = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }); const result = await response.json().catch(() => null); if (!response.ok) throw Object.assign(new Error(result?.error ?? `请求失败 (${response.status})`), { code: result?.code, status: response.status }); return result },
      }
      return h(App, { api, sessions: ctx.sessions, conversation: ctx.conversation, uiWorkspace: ctx.uiWorkspace, SessionProvider, renderSlot })
    }
    function PanelIcon({ size }) {
      // 侧栏入口行图标:办公楼轮廓,同 dsh-tunnel/dsh-cron-board 的 16×16 stroke 形态
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', title: '公司管理',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M3 13.5V4.5A1.5 1.5 0 0 1 4.5 3h4A1.5 1.5 0 0 1 10 4.5v9' }),
        h('path', { d: 'M10 7h2A1.5 1.5 0 0 1 13.5 8.5v5' }),
        h('path', { d: 'M2 13.5h12' }),
        h('path', { d: 'M5.5 6h2M5.5 8.5h2M5.5 11h2M11.2 10.5h.01M11.2 12h.01' }))
    }
    function apply(ctx) {
      ctx.slots.inject('conversation.session', () => ctx.slots.inject('main', () => {
        const unregisterMain = ctx.slots.register({ name: 'main', id: 'boss-simulator', key: 'boss-simulator', label: '公司管理', children: { 'boss-simulator.chat': { kind: 'single', scope: 'session' } } }, (props) => h(Panel, { ...props, ctx }))
        const unregisterChat = ctx.slots.register({ name: 'boss-simulator.chat' }, EmbeddedChat)
        return () => { unregisterChat(); unregisterMain() }
      }))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'boss-simulator', label: '公司管理' }, (iconProps) => h(PanelIcon, iconProps)))
      return { dispose() {} }
    }
    return { inject: ['slots', 'sessions', 'uiWorkspace', 'uiSession', 'uiConversation', 'conversation'], apply }
  },
})
