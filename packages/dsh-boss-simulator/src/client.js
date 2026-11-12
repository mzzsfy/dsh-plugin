window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-boss-simulator',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React
    // 公共依赖 @mzzsfy/dsh-common-tools:看板失效通知唯一通道(模块表缺失即本 client
    // factory 抛错,由装载层判定失败,无轮询回退)
    const tools = require('@mzzsfy/dsh-common-tools/client')
    const ID = '@mzzsfy/dsh-boss-simulator'
    const API = '/api/boss-simulator/'
    const READ_TIMEOUT_MS = 10 * 1000
    // 仅作订阅未就绪时的兜底退避阶梯;订阅恢复即停,空闲不产生周期快照
    const RETRY_MS = [1, 2, 4, 8, 16, 30].map((seconds) => seconds * 1000)
    const COLUMNS = [
      ['draft', '草稿'], ['ready', '已授权待调度'], ['implementing', '实施中'], ['awaiting_acceptance', '待验收'],
      ['completed', '已结案'], ['blocked', '受阻'], ['cancelled', '已取消'],
    ]
    const BUSINESS = Object.fromEntries(COLUMNS)
    // 状态分组:高频在看,低频折叠;分组顺序即首屏阅读顺序
    const GROUPS = [
      { key: 'active', label: '进行中', states: ['implementing', 'awaiting_acceptance', 'ready'] },
      { key: 'pending', label: '待处理', states: ['draft', 'blocked'] },
      { key: 'done', label: '已结束', states: ['completed', 'cancelled'], collapsed: true },
    ]
    const FILTERS = [['all', '全部'], ['active', '进行中'], ['pending', '待处理'], ['done', '已结束']]
    const CONTROL = { active: '可执行', stopping: '中断中', paused: '已暂停', reconciling: '恢复核对中' }
    const RUN = { prepared: '尚未开始', submitted: '已提交', running: '运行中', settled: '已结束', interrupted: '已中断', rejected: '已拒绝', unknown: '待核对' }
    const PHASE = { implement: '实施', fix: '修复', accept: '独立验收', integrate: '整合' }
    const WORK = { planned: '待开始', executing: '执行中', awaitingReview: '待验收', accepted: '已通过', blocked: '受阻', withdrawn: '已撤销' }
    const VERDICT = { ready_for_review: '提交验收', needs_help: '需要协助', pass: '验收通过', issues: '发现问题' }
    const PRIORITY = [['normal', '普通'], ['high', '高'], ['low', '低']]
    const NAV_ICON = { '公司管理': 'plan', 'dsh-boss-simulator': 'plan' }
    if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
    else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
    else window.__navicIconQueue = [NAV_ICON]

    const CSS = `
.bs-root{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);padding:24px;container-type:inline-size;contain:layout paint;min-width:0;height:100%;min-height:0;overflow:hidden;font-size:13px;line-height:20px}
.bs-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;border-bottom:.5px solid var(--dsw-alias-border-l2);padding-bottom:16px}
.bs-head__title{font-size:20px;font-weight:500;line-height:28px;margin:0}
.bs-head__caption{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);flex:1;min-width:0}
.bs-head__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bs-btn{display:inline-flex;align-items:center;justify-content:center;min-height:32px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:inherit;font-size:13px;line-height:20px;font-weight:500;border-radius:var(--dsw-radius-sm);padding:0 12px;cursor:pointer;text-decoration:none;white-space:nowrap}
.bs-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bs-btn:disabled{opacity:.5;cursor:not-allowed}
.bs-btn--primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.bs-btn--primary:hover{background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}
.bs-btn--danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.bs-btn--quiet{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.bs-btn--quiet:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.bs-root :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.bs-banner{display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:12px;line-height:20px;padding:6px 10px;border-inline-start:3px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.bs-banner__error{color:var(--dsw-alias-state-error-primary)}
.bs-banner__ok{color:var(--dsw-alias-state-success-primary)}
.bs-banner__live{display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.bs-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);display:inline-block}
.bs-dot--off{background:var(--dsw-alias-state-warn-primary)}
.bs-views{display:flex;gap:24px;align-items:center;flex-wrap:wrap}
.bs-view{min-height:32px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;border-radius:0;padding:0 2px;cursor:pointer}
.bs-view[aria-selected="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.bs-workspace{display:grid;grid-template-columns:minmax(0,1fr) clamp(320px,38%,420px);gap:16px;flex:1;min-height:0;min-width:0}
.bs-content{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0;overflow:auto;padding-bottom:8px}
.bs-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bs-search{flex:1 1 220px;min-width:0;min-height:32px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:6px 10px;font-size:13px;line-height:20px;background:var(--dsw-alias-bg-base);color:inherit}
.bs-select{min-height:32px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:6px 10px;font-size:13px;background:var(--dsw-alias-bg-base);color:inherit;max-width:240px}
.bs-pill{min-height:28px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;padding:2px 10px;cursor:pointer;white-space:nowrap}
.bs-pill[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}
.bs-pill__count{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);margin-inline-start:4px}
.bs-group{display:flex;flex-direction:column;gap:6px}
.bs-group__head{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);padding:2px 0}
.bs-group__count{font-weight:400;font-variant-numeric:tabular-nums}
.bs-group__toggle{margin-inline-start:auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;padding:2px 4px;border-radius:4px}
.bs-group__toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bs-rows{display:flex;flex-direction:column;gap:6px}
.bs-row{display:flex;flex-direction:column;gap:4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);padding:0}
.bs-row__open{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:center;width:100%;border:0;background:transparent;color:inherit;font:inherit;text-align:start;padding:10px 12px;border-radius:var(--dsw-radius-sm);cursor:pointer}
.bs-row__open:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bs-row--on{border-color:var(--dsw-alias-border-l3);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent)}
.bs-row__title{font-size:14px;line-height:21px;font-weight:600;overflow-wrap:anywhere}
.bs-row__meta{grid-column:1/-1;display:flex;gap:10px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.bs-row__id{font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.bs-status{display:inline-flex;align-items:center;border:0;border-radius:999px;padding:1px 8px;font-size:11px;line-height:18px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.bs-status--ok{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);color:var(--dsw-alias-state-success-primary)}
.bs-status--warn{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);color:var(--dsw-alias-state-warn-primary)}
.bs-status--danger{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary)}
.bs-empty{font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);padding:8px 2px;margin:0}
.bs-empty-state{display:flex;flex-direction:column;gap:10px;align-items:flex-start;border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:24px}
.bs-empty-state h3{margin:0;font-size:16px;line-height:24px}
.bs-empty-state p{margin:0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);max-width:56ch}
.bs-detail{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:12px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-base);min-width:0;max-height:100%;overflow:auto}
.bs-detail__head{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}
.bs-detail__title{font-size:16px;line-height:24px;font-weight:600;overflow-wrap:anywhere;flex:1;margin:0}
.bs-detail__actions{display:flex;gap:8px;flex-wrap:wrap;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.bs-detail__body{display:grid;gap:10px;font-size:13px;line-height:20px;min-width:0}
.bs-detail__group{display:grid;gap:4px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px}
.bs-detail__label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.bs-run{border-inline-start:3px solid var(--dsw-alias-border-l3);padding:6px 10px;display:flex;flex-direction:column;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.bs-run__head,.bs-run__seg{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.bs-run__head{justify-content:space-between}
.bs-run__seg{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.bs-chat{display:flex;flex-direction:column;min-height:0;min-width:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden;background:var(--dsw-alias-bg-base);flex:1}
.bs-chat__head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.bs-chat__head h2{margin:0;font-size:14px;line-height:21px}
.bs-chat__head p{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.bs-chat__body{flex:1;min-height:0;display:flex;flex-direction:column}
.bs-chat__body>[data-conversation-content]{flex:1;min-height:0}
.bs-chat__note{padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bs-chat__welcome{display:flex;flex-direction:column;gap:12px;padding:16px 14px}
.bs-chat__welcome h3{font-size:14px;margin:0}
.bs-chat__welcome p{font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);margin:0}
.bs-chat__first{display:flex;flex-direction:column;gap:8px}
.bs-chat__first label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.bs-chat__first textarea{resize:vertical;min-height:88px;width:100%;box-sizing:border-box;padding:8px 10px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);color:inherit;background:var(--dsw-alias-bg-base);font:inherit;font-size:13px;line-height:1.6}
.bs-chat__send{display:flex;align-items:center;justify-content:space-between;gap:10px}
.bs-settings{max-width:720px}
.bs-setting-row{display:grid;grid-template-columns:minmax(180px,1fr) minmax(200px,2fr);gap:12px;align-items:center;border-bottom:1px solid var(--dsw-alias-border-l2);padding:10px 0}
.bs-setting-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.bs-dialog{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:16px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 30%, transparent)}
.bs-dialog__panel{width:min(560px,100%);max-height:calc(100dvh - 32px);overflow:auto;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-shadow-lv3);padding:16px;display:flex;flex-direction:column;gap:12px}
.bs-dialog__head{display:flex;align-items:center;gap:8px}
.bs-dialog__head h2{margin:0;font-size:16px;line-height:24px;flex:1}
.bs-field{display:flex;flex-direction:column;gap:4px}
.bs-field label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.bs-field input,.bs-field textarea,.bs-field select{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:6px 10px;font:inherit;font-size:13px;line-height:20px;background:var(--dsw-alias-bg-base);color:inherit;width:100%;box-sizing:border-box}
.bs-field textarea{min-height:72px;resize:vertical}
.bs-field__error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.bs-field__hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.bs-dialog__foot{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.bs-visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@container (max-width:719px){.bs-workspace{grid-template-columns:minmax(0,1fr)}.bs-detail{position:fixed;z-index:30;inset:0;border-radius:0;max-height:100dvh;padding:12px}}
@container (max-width:767px){.bs-root{padding:12px}.bs-head__caption{flex-basis:100%}.bs-toolbar>*{min-height:40px}.bs-search{flex:1 1 100%;font-size:16px}.bs-head__actions{width:100%}}
@media(prefers-reduced-motion:reduce){.bs-root *{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
`

    function commandId() { return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }
    function newTaskId() { return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` }
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
    function clockText(value) { return value ? new Date(value).toLocaleTimeString() : '无' }
    function relativeText(value) {
      if (!value) return '无'
      const delta = Date.now() - value
      if (delta < 60 * 1000) return '刚刚'
      if (delta < 60 * 60 * 1000) return `${Math.floor(delta / (60 * 1000))} 分钟前`
      if (delta < 24 * 60 * 60 * 1000) return `${Math.floor(delta / (60 * 60 * 1000))} 小时前`
      return new Date(value).toLocaleDateString()
    }
    function statusTone(task) {
      if (task.businessState === 'blocked') return 'bs-status--danger'
      if (task.businessState === 'completed') return 'bs-status--ok'
      if (task.businessState === 'awaiting_acceptance') return 'bs-status--warn'
      return ''
    }

    // 弹层统一行为:焦点移入、Tab 困在层内、Esc 关闭、关闭后焦点还原。
    // close 走 ref:调用方每次渲染都传新函数,进依赖会让输入过程中焦点反复回到首项。
    function useDialogFocus(open, close, panelRef) {
      const closeRef = useRef(close)
      closeRef.current = close
      useEffect(() => {
        if (!open) return undefined
        const previous = document.activeElement
        const panel = panelRef.current
        const focusable = () => [...(panel?.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? [])].filter((node) => node.getClientRects().length)
        const first = focusable()[0]
        first?.focus()
        const onKey = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
          if (event.key !== 'Tab') return
          const nodes = focusable()
          if (!nodes.length) return
          const head = nodes[0]
          const tail = nodes.at(-1)
          if (event.shiftKey && (document.activeElement === head || !nodes.includes(document.activeElement))) { event.preventDefault(); tail.focus() }
          else if (!event.shiftKey && (document.activeElement === tail || !nodes.includes(document.activeElement))) { event.preventDefault(); head.focus() }
        }
        document.addEventListener('keydown', onKey)
        return () => { document.removeEventListener('keydown', onKey); previous?.focus?.() }
      }, [open, panelRef])
    }

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
          // 重试复用已登记的管理员会话;仅首次没有绑定时才创建。
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
          // 身份先保存再发送;离开只释放本地引用,不取消已经受理的后台回合。
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
      return h('section', { className: 'bs-chat__body', role: 'region', 'aria-label': '管理员对话' },
        failure ? h('p', { className: 'bs-banner__error', role: 'alert' }, failure) : null,
        current ? h('div', { className: 'bs-chat__body' }, h(SessionProvider, { session: current }, renderSlot('boss-simulator.chat', {}))) : null,
        !current || draft ? h('div', { className: 'bs-chat__welcome' },
          h('div', null, h('h3', null, '让管理员先澄清方案'), h('p', null, '管理员会确认范围与验收标准，给出可授权的方案；执行与验收由独立会话承担。也可以直接在任务列表新建任务。')),
          h('form', { onSubmit: sendFirst, className: 'bs-chat__first' }, h('label', { htmlFor: 'bs-admin-draft' }, '给管理员安排工作'), h('textarea', { id: 'bs-admin-draft', value: draft, onChange: (event) => onFirstMessage({ draft: event.target.value }), placeholder: '例如：检查结算服务的重试问题，先给我方案', rows: 4, disabled: pending || sending || Boolean(firstMessage.requestId) }), h('div', { className: 'bs-chat__send' }, h('span', { className: 'bs-setting-note' }, '发送才开始讨论；查看页面不会开工'), h('button', { className: 'bs-btn bs-btn--primary', type: 'submit', disabled: pending || sending || !draft.trim() }, sending ? '正在发送' : '发送'), current && draft ? h('button', { className: 'bs-btn', type: 'button', disabled: pending || sending, onClick: () => { onFirstMessage({ draft: '' }); onError('') } }, '放弃保留输入') : null))) : null,
      )
    }

    function NewTaskDialog({ open, onClose, onSubmit, workspaces, busy }) {
      const panelRef = useRef(null)
      const [form, setForm] = useState({ title: '', goal: '', scope: '', criteria: '', workspaceId: '', priority: 'normal' })
      const [touched, setTouched] = useState({})
      const [failure, setFailure] = useState('')
      useDialogFocus(open, onClose, panelRef)
      useEffect(() => {
        if (!open) return
        setForm((current) => (current.workspaceId || !workspaces.length ? current : { ...current, workspaceId: workspaces[0].workspaceId }))
      }, [open, workspaces])
      if (!open) return null
      const criteria = form.criteria.split('\n').map((line) => line.trim()).filter(Boolean)
      const errors = {
        title: form.title.trim() ? '' : '填写任务标题',
        goal: form.goal.trim() ? '' : '填写目标',
        workspaceId: form.workspaceId ? '' : '选择工作区',
        criteria: criteria.length ? '' : '至少一条验收标准',
      }
      const invalid = Object.values(errors).some(Boolean)
      const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))
      async function submit(event) {
        event.preventDefault()
        setTouched({ title: true, goal: true, workspaceId: true, criteria: true })
        if (invalid || busy) return
        setFailure('')
        try {
          await onSubmit({ ...form, criteria })
          setForm({ title: '', goal: '', scope: '', criteria: '', workspaceId: workspaces[0]?.workspaceId ?? '', priority: 'normal' })
          setTouched({})
          onClose()
        } catch (error) {
          setFailure(`创建失败：${error.message ?? error}`)
        }
      }
      return h('div', { className: 'bs-dialog', onClick: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('form', { className: 'bs-dialog__panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bs-new-task-title', ref: panelRef, onSubmit: submit },
          h('div', { className: 'bs-dialog__head' }, h('h2', { id: 'bs-new-task-title', tabIndex: -1 }, '新建任务'), h('button', { className: 'bs-btn bs-btn--quiet', type: 'button', onClick: onClose }, '关闭')),
          failure ? h('p', { className: 'bs-banner__error', role: 'alert' }, failure) : null,
          h('div', { className: 'bs-field' }, h('label', { htmlFor: 'bs-task-title' }, '任务标题'), h('input', { id: 'bs-task-title', value: form.title, onChange: set('title'), onBlur: () => setTouched((current) => ({ ...current, title: true })), 'aria-invalid': Boolean(touched.title && errors.title), 'aria-describedby': touched.title && errors.title ? 'bs-task-title-error' : undefined }), touched.title && errors.title ? h('span', { className: 'bs-field__error', id: 'bs-task-title-error' }, errors.title) : null),
          h('div', { className: 'bs-field' }, h('label', { htmlFor: 'bs-task-goal' }, '目标'), h('textarea', { id: 'bs-task-goal', value: form.goal, onChange: set('goal'), onBlur: () => setTouched((current) => ({ ...current, goal: true })), 'aria-describedby': 'bs-task-goal-hint' }), h('span', { className: 'bs-field__hint', id: 'bs-task-goal-hint' }, '一句话说清要达成什么；执行会话据此开工'), touched.goal && errors.goal ? h('span', { className: 'bs-field__error' }, errors.goal) : null),
          h('div', { className: 'bs-field' }, h('label', { htmlFor: 'bs-task-scope' }, '范围（可选）'), h('input', { id: 'bs-task-scope', value: form.scope, onChange: set('scope') })),
          h('div', { className: 'bs-field' }, h('label', { htmlFor: 'bs-task-criteria' }, '验收标准'), h('textarea', { id: 'bs-task-criteria', value: form.criteria, onChange: set('criteria'), onBlur: () => setTouched((current) => ({ ...current, criteria: true })), placeholder: '每行一条', 'aria-describedby': 'bs-task-criteria-hint' }), h('span', { className: 'bs-field__hint', id: 'bs-task-criteria-hint' }, '每行一条；独立验收按这些标准判定'), touched.criteria && errors.criteria ? h('span', { className: 'bs-field__error' }, errors.criteria) : null),
          h('div', { className: 'bs-field' }, h('label', { htmlFor: 'bs-task-workspace' }, '工作区'), h('select', { id: 'bs-task-workspace', value: form.workspaceId, onChange: set('workspaceId'), onBlur: () => setTouched((current) => ({ ...current, workspaceId: true })) }, workspaces.length ? workspaces.map((item) => h('option', { key: item.workspaceId, value: item.workspaceId }, item.title)) : h('option', { value: '' }, '没有可选工作区')), workspaces.length ? null : h('span', { className: 'bs-field__hint' }, '先在宿主侧边栏添加工作区，再回来新建任务'), touched.workspaceId && errors.workspaceId ? h('span', { className: 'bs-field__error' }, errors.workspaceId) : null),
          h('div', { className: 'bs-field' }, h('label', { htmlFor: 'bs-task-priority' }, '优先级'), h('select', { id: 'bs-task-priority', value: form.priority, onChange: set('priority') }, PRIORITY.map(([value, label]) => h('option', { key: value, value }, label)))),
          h('div', { className: 'bs-dialog__foot' }, h('button', { className: 'bs-btn', type: 'button', onClick: onClose }, '取消'), h('button', { className: 'bs-btn bs-btn--primary', type: 'submit', disabled: busy }, busy ? '正在创建' : '创建任务')),
        ),
      )
    }

    function App({ api, sessions, conversation, uiWorkspace, SessionProvider, renderSlot, bus }) {
      const catalog = React.useSyncExternalStore((notify) => sessions.list.subscribe(notify), () => sessions.list.getSnapshot())
      // 通用会话面只放行主会话:宿主 list 的 ids 含子 agent 行,openSession 会被拒
      const accessibleSessions = new Set(catalog.ids.filter((id) => catalog.byId?.[id]?.origin !== 'subagent'))
      const [sessionMessage, setSessionMessage] = useState('')
      const [data, setData] = useState(null)
      const [workspaces, setWorkspaces] = useState([])
      const [loadError, setLoadError] = useState(false)
      const [observedAt, setObservedAt] = useState(null)
      const [search, setSearch] = useState('')
      const [workspace, setWorkspace] = useState('')
      const [filter, setFilter] = useState('all')
      const [collapsed, setCollapsed] = useState({ done: true })
      const [view, setView] = useState('tasks')
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState(null)
      const [detailError, setDetailError] = useState(null)
      const [settings, setSettings] = useState(null)
      const [settingsDirty, setSettingsDirty] = useState(false)
      const [settingsMessage, setSettingsMessage] = useState('')
      const [settingsConfirmDiscard, setSettingsConfirmDiscard] = useState(false)
      const [writing, setWriting] = useState(false)
      const [notice, setNotice] = useState('')
      const [adminOverride, setAdminOverride] = useState(undefined)
      const [adminRebuildConfirm, setAdminRebuildConfirm] = useState(false)
      const [adminPending, setAdminPending] = useState(false)
      const [firstMessage, setFirstMessage] = useState(readFirstMessage)
      const [newTaskOpen, setNewTaskOpen] = useState(false)
      const [creating, setCreating] = useState(false)
      const [live, setLive] = useState(false)
      const [refreshing, setRefreshing] = useState(false)
      const [backend, setBackend] = useState('unknown')
      const [confirmDispatch, setConfirmDispatch] = useState(false)
      function updateFirstMessage(value) {
        try {
          if (value.draft) sessionStorage.setItem(FIRST_MESSAGE_KEY, JSON.stringify(value))
          else sessionStorage.removeItem(FIRST_MESSAGE_KEY)
        } catch { setSessionMessage('浏览器无法保存首条输入；离开页面前请复制保留。') }
        setFirstMessage(value)
      }
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
      const [visible, setVisible] = useState(!document.hidden)

      useEffect(() => { sessions.refresh().catch(() => setSessionMessage('会话目录读取失败；历史引用保留，未创建替代会话。')) }, [sessions])
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
      // 创建只登记空会话;对话留在本面板,发送首条消息由用户表单显式触发。
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
            setView('assistant')
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
        else setRefreshing(true)
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
        } finally {
          clearTimeout(timeout)
          if (epoch === queryEpoch.current) { readController.current = null; setReadingMore(false); setRefreshing(false) }
        }
      }, [api, search, workspace])

      // 工作区候选:宿主注册表优先,读不到退回任务记录里的标识;
      // 该路由随本版本新增,仅 404 说明宿主仍在跑旧后端,其它错误不得误报"需重启"
      const loadWorkspaces = useCallback(async () => {
        try {
          const result = await api.get('workspaces')
          setWorkspaces(result?.items ?? [])
          setBackend('ready')
        } catch (error) {
          if (error.status === 404) setBackend('legacy')
          setWorkspaces((await api.get('board').catch(() => null))?.workspaceIds?.map((id) => ({ workspaceId: id, title: id, path: null })) ?? [])
        }
      }, [api])

      useEffect(() => {
        const onVisibility = () => setVisible(!document.hidden)
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [])

      useEffect(() => { loadWorkspaces().catch(() => {}) }, [loadWorkspaces])
      useEffect(() => {
        if (data?.workspaceIds?.length && !workspaces.length) setWorkspaces(data.workspaceIds.map((id) => ({ workspaceId: id, title: id, path: null })))
      }, [data, workspaces.length])

      // 失效通知唯一通道:首连/重连 onReset 全量对账,变更到达单飞刷新(末尾补拉);
      // 仅订阅未就绪时按退避阶梯兜底拉取,订阅恢复即停,空闲无周期快照
      // 订阅只建立一次:refresh 随搜索/筛选变化,若进依赖会每次键入重连总线并多打一轮快照
      const refreshRef = useRef(refresh)
      refreshRef.current = refresh

      useEffect(() => {
        if (!visible) return undefined
        const snapshot = tools.createSnapshotRefresh(() => refreshRef.current())
        let disposed = false
        let ready = false
        let attempt = 0
        let timer = null
        let unsubscribe = null
        const fallback = async () => {
          timer = null
          if (disposed || ready) return
          await refreshRef.current()
          if (disposed || ready) return
          attempt += 1
          timer = setTimeout(fallback, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)])
        }
        try {
          unsubscribe = bus.subscribe(() => snapshot.refresh(), {
            onReset: () => { ready = true; setLive(true); clearTimeout(timer); timer = null; snapshot.refresh() },
          })
        } catch (error) {
          console.warn(`[boss-simulator] 推送总线订阅不可用,退回退避兜底: ${String(error?.message ?? error)}`)
        }
        if (!ready) timer = setTimeout(fallback, RETRY_MS[0])
        return () => {
          disposed = true
          setLive(false)
          clearTimeout(timer)
          unsubscribe?.()
          snapshot.dispose()
          ++queryEpoch.current
          readController.current?.abort()
        }
      }, [visible, bus])

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

      // 详情随看板快照失效重取:选中或最近一次快照更新触发,失败不自行重试
      useEffect(() => {
        if (!selected || !visible) { if (!selected) { setDetail(null); setDetailError(null) }; return undefined }
        let disposed = false
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(new Error('读取超时')), READ_TIMEOUT_MS)
        api.get(`board?taskId=${encodeURIComponent(selected)}`, controller.signal)
          .then((value) => { if (!disposed) { setDetail(value); setDetailError(null) } })
          .catch((error) => {
            if (disposed) return
            if (!controller.signal.aborted || controller.signal.reason?.message === '读取超时') setDetailError(error.message ?? '记录不可用')
          })
          .finally(() => clearTimeout(timeout))
        return () => { disposed = true; clearTimeout(timeout); controller.abort() }
      }, [api, selected, visible, data])

      const narrow = containerWidth <= 719
      const selectedModelSummary = data?.modelTasks?.flatMap((group) => group.tasks).find((task) => task.taskId === selected)
      const detailModal = Boolean(selected && containerWidth < 720)
      useEffect(() => { if (selected) detailTitle.current?.focus() }, [selected])
      useEffect(() => {
        const dialog = settingsConfirmDiscard ? discardRef.current : null
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
        return () => { blocked.forEach(([node, previous]) => { node.inert = previous }) }
      }, [settingsConfirmDiscard])
      useEffect(() => {
        if (!selected && !settingsConfirmDiscard) return undefined
        const onKey = (event) => { if (event.key === 'Escape') { if (settingsConfirmDiscard) continueEditing(); else closeDetail() } }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [selected, settingsConfirmDiscard])

      async function stop(body) {
        if (writing) return
        setWriting(true)
        setNotice('正在提交中断请求。')
        try {
          const result = await api.post('interrupt', { ...body, commandId: commandId() })
          setNotice(result.status === 'accepted' || result.accepted ? '已提交中断，等待服务端确认。' : '中断结果待核对；未确认前不视为已暂停。')
        } catch (error) { setNotice(`中断结果未知：${error.message ?? error}。不会自动重试。`) }
        finally { setWriting(false); refresh() }
      }
      async function createTask(form) {
        if (backend === 'legacy') { setNotice('宿主仍在运行旧版后端：重启 dsh 后才能新建任务'); return }
        setCreating(true)
        try {
          const result = await api.post('task', {
            action: 'create',
            taskId: newTaskId(),
            title: form.title.trim(),
            goal: form.goal.trim(),
            scope: form.scope.trim(),
            acceptanceCriteria: form.criteria,
            workspaceId: form.workspaceId,
            priority: form.priority,
          })
          await refresh()
          setSelected(result.taskId)
          setView('tasks')
          setNotice('任务已创建。核对详情后授权，授权后可派发实施。')
        } finally { setCreating(false) }
      }
      async function authorizeTask(taskId) {
        if (writing) return
        if (backend === 'legacy') { setNotice('宿主仍在运行旧版后端：重启 dsh 后才能授权'); return }
        setWriting(true)
        setNotice('正在授权。')
        try {
          await api.post('task', { action: 'authorize', taskId, commandId: commandId() })
          setNotice('已授权。下一步可派发实施。')
          await refresh()
        } catch (error) { setNotice(`授权失败：${error.message ?? error}`) }
        finally { setWriting(false) }
      }
      async function dispatchTask(task, phase) {
        if (writing) return
        if (backend === 'legacy') { setNotice('宿主仍在运行旧版后端：重启 dsh 后才能派发'); return }
        setWriting(true)
        const accepting = phase === 'accept'
        setNotice(accepting ? '正在派发独立验收。' : '正在派发实施。')
        try {
          const workItemId = detail?.taskId === task.taskId ? (detail.workItems?.[0]?.workItemId ?? 'w1') : 'w1'
          const result = await api.post('task', {
            action: 'dispatch',
            taskId: task.taskId,
            workItemId,
            phase,
            content: `${accepting ? '独立验收任务' : '实施任务'}：${task.title}`,
          })
          setConfirmDispatch(false)
          setNotice(accepting
            ? `已派发独立验收，验收会话 ${result.sessionId ?? '已登记'}。通过后任务可结案。`
            : `已派发实施，执行会话 ${result.sessionId ?? '已登记'}。完成后回报会出现在详情。`)
          await refresh()
        } catch (error) { setNotice(`派发失败：${error.message ?? error}`) }
        finally { setWriting(false) }
      }
      function selectTask(task, event) {
        returnFocus.current = event?.currentTarget ?? null
        setDetailError(null)
        setConfirmDispatch(false)
        setSelected(task.taskId)
        setView('tasks')
      }
      function closeDetail() {
        const taskId = selected
        setSelected(null)
        setDetail(null)
        setConfirmDispatch(false)
        requestAnimationFrame(() => {
          const original = returnFocus.current
          const replacement = [...(rootRef.current?.querySelectorAll('.bs-row__open') ?? [])].find((node) => node.getAttribute('aria-label')?.endsWith(`，${taskId}`))
          const target = original?.isConnected && original.getClientRects().length && !original.closest('[inert]') ? original : replacement ?? rootRef.current?.querySelector('.bs-head__title')
          target?.focus()
        })
      }
      async function openSettings() {
        setView('settings')
        settingsRead.current?.abort()
        const controller = new AbortController()
        settingsRead.current = controller
        setSettings(null)
        setSettingsDirty(false)
        setSettingsMessage('正在读取设置。')
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
        setView('tasks')
      }

      const items = data?.items ?? []
      const selectedSummary = items.find((task) => task.taskId === selected) ?? (detail?.taskId === selected ? detail : null) ?? selectedModelSummary ?? (selected ? { taskId: selected, title: selected } : null)
      const filtered = items.filter((task) => (!workspace || task.projectWorkspaceId === workspace) && (!search || `${task.taskId} ${task.title}`.toLowerCase().includes(search.toLowerCase())))
      const workspaceIds = data?.workspaceIds ?? []
      const groupStates = Object.fromEntries(GROUPS.map((group) => [group.key, group.states]))
      const visibleRows = filter === 'all' ? filtered : filtered.filter((task) => groupStates[filter]?.includes(task.businessState))
      const counts = Object.fromEntries(GROUPS.map((group) => [group.key, filtered.filter((task) => group.states.includes(task.businessState)).length]))

      function renderRun(task, run) {
        const started = Boolean(run.startedAt)
        const open = run.state === 'running' && started
        const seconds = started && run.endedAt ? Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000)) : null
        return h('article', { className: 'bs-run', key: `${task.taskId}:${run.runId}`, 'data-run-id': run.runId },
          h('div', { className: 'bs-run__head' }, h('strong', null, `${run.runId} · ${PHASE[run.phase] ?? '阶段待核对'} · 第 ${run.attemptOrdinal ?? 1} 次`), h('span', { className: `bs-status${open ? ' bs-status--warn' : ''}` }, RUN[run.state] ?? '状态待核对')),
          h('div', { className: 'bs-run__seg' }, started ? h('span', null, `开始 ${new Date(run.startedAt).toLocaleString()}`) : h('span', null, '尚未开始'), run.endedAt ? h('span', null, `结束 ${new Date(run.endedAt).toLocaleString()}`) : open ? h('span', null, '运行中') : null, seconds !== null ? h('span', null, `墙钟 ${seconds} 秒`) : null, h('span', null, modelText(run)), h('span', null, tokenText(run.tokenTotal, run.usageCoverage))),
          run.dispatchError ? h('span', { className: 'bs-banner__error' }, `派发失败：${run.dispatchError}`) : null,
          h('div', { className: 'bs-run__head' }, h('span', { className: 'bs-setting-note' }, run.sessionId ? `会话 ${run.sessionId}` : '会话记录不可用'), h('button', { className: 'bs-btn', disabled: !accessibleSessions.has(run.sessionId), title: accessibleSessions.has(run.sessionId) ? '打开已有会话，不创建或发送消息' : '会话不可用；保留历史引用', onClick: () => openSession(run.sessionId) }, accessibleSessions.has(run.sessionId) ? '打开会话' : '会话不可用')),
        )
      }

      function renderDetail() {
        if (!selectedSummary) return null
        const value = detail?.taskId === selected ? detail : selectedSummary
        const activeRunCount = value.activeRunCount ?? 0
        const workspaceInfo = workspaces.find((item) => item.workspaceId === value.projectWorkspaceId)
        const canAuthorize = value.businessState === 'draft'
        // 派发只在详情已就绪时给出:summary 没有 runs,不能据此判断执行槽是否空闲
        const detailReady = detail?.taskId === selected
        const idle = detailReady && activeRunCount === 0
        const canImplement = idle && ['ready', 'implementing'].includes(value.businessState) && value.authorized !== false
        const canAccept = idle && value.businessState === 'awaiting_acceptance' && value.authorized !== false
        const canDispatch = canImplement || canAccept
        const dispatchPhase = canAccept ? 'accept' : 'implement'
        return h('aside', { ref: detailRef, className: 'bs-detail', role: detailModal ? 'dialog' : undefined, 'aria-modal': detailModal ? 'true' : undefined, 'aria-labelledby': 'bs-task-detail-title', 'data-modality': narrow ? 'mobile' : 'panel' },
          h('div', { className: 'bs-detail__head' }, h('h2', { className: 'bs-detail__title', id: 'bs-task-detail-title', tabIndex: -1, ref: detailTitle }, value.title), h('button', { className: 'bs-btn', onClick: closeDetail }, '关闭')),
          h('div', { className: 'bs-detail__actions' },
            canAuthorize ? h('button', { className: 'bs-btn bs-btn--primary', disabled: writing, onClick: () => authorizeTask(value.taskId) }, '授权') : null,
            canDispatch && !confirmDispatch ? h('button', { className: 'bs-btn bs-btn--primary', disabled: writing, onClick: () => setConfirmDispatch(true) }, canAccept ? '派发独立验收' : '派发实施') : null,
            canDispatch && confirmDispatch ? h(React.Fragment, null, h('button', { className: 'bs-btn bs-btn--primary', disabled: writing, onClick: () => dispatchTask(value, dispatchPhase) }, writing ? '正在派发' : canAccept ? '确认派发验收，开始消耗模型' : '确认派发，开始消耗模型'), h('button', { className: 'bs-btn', disabled: writing, onClick: () => setConfirmDispatch(false) }, '先不派发')) : null,
            activeRunCount > 0 ? h('button', { className: 'bs-btn bs-btn--danger', disabled: writing, onClick: () => stop({ taskId: value.taskId }) }, '中断') : null,
          ),
          detailError ? h('p', { className: 'bs-banner__error', role: 'alert' }, `任务记录不可用：${detailError}`) : null,
          detail?.taskId !== selected && !detailError ? h('p', { className: 'bs-empty' }, '正在读取任务详情…') : null,
          h('div', { className: 'bs-detail__body' },
            h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '状态与控制'), h('span', null, `${BUSINESS[value.businessState] ?? value.businessState} · ${controlText(value).join(' · ')}`), value.businessState === 'blocked' && value.block?.reason ? h('span', { className: 'bs-status bs-status--danger' }, `受阻原因：${value.block.reason}`) : null, value.businessState === 'awaiting_acceptance' ? h('span', { className: 'bs-setting-note' }, '实施报告已提交；派发独立验收通过后才可结案。') : null, value.controlState === 'paused' ? h('span', null, '已暂停。需要继续时，向管理员或对应执行会话明确提出。') : null),
            detail?.taskId === selected ? h(React.Fragment, null,
              h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '目标与范围'), h('span', null, value.definition?.goal ?? '目标记录不可用'), h('span', null, value.definition?.scope || '未填写范围')),
              h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '工作区'), h('span', null, workspaceInfo?.title ?? value.projectWorkspaceId), workspaceInfo?.path ? h('span', { className: 'bs-setting-note' }, workspaceInfo.path) : null),
              h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '验收标准'), ...(value.definition?.acceptanceCriteria ?? []).map((criterion) => h('span', { key: criterion.criterionId }, `${criterion.criterionId} · ${criterion.text}`))),
              h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '工作项'), ...((value.workItems ?? []).length ? value.workItems.map((work) => h('div', { key: work.workItemId }, `${work.title} · ${WORK[work.state] ?? work.state}${work.dependencyWorkItemIds?.length ? ` · 依赖 ${work.dependencyWorkItemIds.join(', ')}` : ''}`)) : [h('span', { key: 'none' }, '尚无工作项')])),
              h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '执行记录'), ...((value.runs ?? []).length ? [...value.runs].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)).map((run) => renderRun(value, run)) : [h('span', { key: 'none' }, '尚无 Run 记录')])),
              h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '验收结果'), ...((value.reports ?? []).length ? value.reports.map((report) => h('div', { key: report.reportId }, `${VERDICT[report.verdict] ?? report.verdict}${report.historical ? ' · 历史记录' : ''} · ${report.issues?.length ?? 0} 项问题`)) : [h('span', { key: 'none' }, '尚无验收结果')])),
              h('section', { className: 'bs-detail__group' }, h('strong', { className: 'bs-detail__label' }, '累计用量'), h('span', null, tokenText(value.usage?.tokenTotal, value.usage?.coverage))),
            ) : null,
          ),
        )
      }

      function renderList() {
        if (!data) return h('p', { className: 'bs-empty', 'aria-live': 'polite' }, loadError ? '任务读取失败。检查连接后重试。' : '正在读取任务…')
        const noTasks = visibleRows.length === 0
        if (noTasks) {
          const filteredOut = Boolean(search || workspace || filter !== 'all')
          const reason = filteredOut ? '没有匹配的任务' : '还没有任务'
          return h('div', { className: 'bs-empty-state' },
            h('h3', null, reason),
            h('p', null, filteredOut ? '清除筛选后查看全部任务。' : '新建任务后自行授权并派发，或让管理员先澄清方案再安排。'),
            h('div', { className: 'bs-toolbar' },
              filteredOut ? h('button', { className: 'bs-btn bs-btn--primary', onClick: () => { setSearch(''); setWorkspace(''); setFilter('all') } }, '清除筛选') : h('button', { className: 'bs-btn bs-btn--primary', disabled: backend === 'legacy', onClick: () => setNewTaskOpen(true) }, '新建任务'),
              filteredOut ? null : h('button', { className: 'bs-btn', onClick: () => setView('assistant') }, '让管理员安排'),
            ),
          )
        }
        return h(React.Fragment, null,
          ...GROUPS.filter((group) => filter === 'all' || group.key === filter).map((group) => {
            const rows = filtered.filter((task) => group.states.includes(task.businessState))
            if (!rows.length) return null
            const isCollapsed = collapsed[group.key] === true
            return h('section', { className: 'bs-group', key: group.key, 'aria-labelledby': `bs-group-${group.key}` },
              h('div', { className: 'bs-group__head' }, h('span', { id: `bs-group-${group.key}` }, group.label), h('span', { className: 'bs-group__count' }, String(rows.length)), h('button', { className: 'bs-group__toggle', 'aria-expanded': !isCollapsed, onClick: () => setCollapsed((current) => ({ ...current, [group.key]: !isCollapsed })) }, isCollapsed ? '展开' : '收起')),
              isCollapsed ? null : h('div', { className: 'bs-rows' }, ...rows.map((task) => h('article', { key: task.taskId, className: `bs-row${selected === task.taskId ? ' bs-row--on' : ''}` },
                h('button', { className: 'bs-row__open', 'aria-label': `打开任务 ${task.title}，${task.taskId}`, onClick: (event) => selectTask(task, event) },
                  h('span', { className: 'bs-row__title' }, task.title), h('span', { className: `bs-status ${statusTone(task)}` }, BUSINESS[task.businessState] ?? task.businessState),
                  h('span', { className: 'bs-row__meta' }, h('span', { className: 'bs-row__id' }, task.taskId), h('span', null, workspaces.find((item) => item.workspaceId === task.projectWorkspaceId)?.title ?? task.projectWorkspaceId), h('span', null, `子项 ${task.workItemCount}`), h('span', null, `在途 ${task.activeRunCount}`), h('span', null, tokenText(task.usage?.tokenTotal, task.usage?.coverage)), h('span', null, `更新 ${relativeText(task.updatedAt)}`)),
                ),
              ))),
            )
          }),
          data?.nextCursor ? h('button', { className: 'bs-btn', disabled: readingMore, 'aria-busy': readingMore, onClick: () => refresh(true) }, readingMore ? '正在加载任务' : '加载更多任务') : null,
        )
      }

      function renderSettings() {
        return h('section', { className: 'bs-detail bs-settings', 'aria-labelledby': 'bs-settings-title' },
          h('div', { className: 'bs-detail__head' }, h('h2', { id: 'bs-settings-title', className: 'bs-detail__title' }, '设置'), h('button', { className: 'bs-btn', onClick: () => leaveSettings() }, '返回任务')),
          settingsConfirmDiscard ? h('div', { ref: discardRef, className: 'bs-dialog__panel', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'bs-discard-title', 'aria-describedby': 'bs-discard-description' }, h('h3', { id: 'bs-discard-title', tabIndex: -1 }, '放弃未保存修改？'), h('p', { id: 'bs-discard-description' }, '当前更改尚未保存。'), h('div', { className: 'bs-toolbar' }, h('button', { className: 'bs-btn', onClick: continueEditing }, '继续编辑'), h('button', { className: 'bs-btn bs-btn--danger', onClick: () => leaveSettings(true) }, '放弃修改'))) : null,
          h('div', { className: 'bs-setting-row' }, h('div', null, h('label', { htmlFor: 'bs-concurrency' }, '全局并发参考值'), h('p', { className: 'bs-setting-note' }, '仅作角色决策参考，不构成硬限制；留空表示未设置。')), h('input', { id: 'bs-concurrency', className: 'bs-search', type: 'number', min: 1, max: 16, step: 1, disabled: !settings || writing, value: settings?.concurrencyReference ?? '', onChange: (event) => { setSettingsDirty(true); setSettings((current) => ({ ...current, concurrencyReference: event.target.value === '' ? null : Number(event.target.value) })) } })),
          settingsMessage ? h('p', { className: settingsMessage.includes('失败') || settingsMessage.includes('冲突') ? 'bs-banner__error' : 'bs-setting-note', role: 'status', 'aria-live': 'polite' }, settingsMessage) : null,
          h('div', { className: 'bs-toolbar' }, h('button', { className: 'bs-btn bs-btn--primary', disabled: writing || !settings || !settingsDirty, onClick: saveSettings }, writing ? '正在保存' : '保存'), h('button', { className: 'bs-btn', disabled: writing, onClick: () => leaveSettings() }, '取消'), settingsDirty ? h('button', { className: 'bs-btn bs-btn--danger', disabled: writing, onClick: () => leaveSettings(true) }, '放弃修改') : null),
        )
      }

      function renderAssistant() {
        const rebuild = adminRebuildConfirm
          ? h('button', { className: 'bs-btn bs-btn--danger', disabled: adminPending, onClick: () => startAdmin(true) }, '再次点击确认重建')
          : h('button', { className: 'bs-btn', disabled: adminPending, onClick: () => setAdminRebuildConfirm(true) }, '重建管理员会话')
        return h('section', { className: 'bs-chat' },
          h('div', { className: 'bs-chat__head' }, h('div', null, h('h2', null, '管理员'), h('p', null, '交代目标、确认方案、接收汇报；任务创建与授权也能在任务页直接完成')), h('div', { className: 'bs-toolbar' }, adminPending ? h('span', { className: 'bs-setting-note' }, '正在创建会话') : null, rebuild)),
          h('div', { className: 'bs-chat__note' }, h('span', null, '重建只换管理员会话，任务与历史记录保留。'), adminRebuildConfirm ? h('button', { className: 'bs-btn bs-btn--quiet', onClick: () => setAdminRebuildConfirm(false) }, '取消') : null),
          h(AdminConversation, { sessionId: administrator, sessions, conversation, SessionProvider, renderSlot, pending: adminPending, createSession: createAdminSession, firstMessage, onFirstMessage: updateFirstMessage, onError: setSessionMessage }),
        )
      }

      const administrator = adminOverride !== undefined ? adminOverride : serverAdministrator
      const headerHint = live ? h('span', { className: 'bs-banner__live' }, h('span', { className: 'bs-dot' }), '实时') : h('span', { className: 'bs-banner__live' }, h('span', { className: 'bs-dot bs-dot--off' }), '轮询兜底')
      return h('div', { className: 'bs-root', ref: attachRoot, 'data-container-width': containerWidth },
        h('style', { 'data-plugin': ID, dangerouslySetInnerHTML: { __html: CSS } }),
        h('header', { className: 'bs-head' },
          h('h1', { className: 'bs-head__title', tabIndex: -1 }, '公司管理'),
          h('span', { className: 'bs-head__caption' }, '安排任务、授权派发、跟踪执行与验收'),
          h('div', { className: 'bs-head__actions' },
            h('button', { className: 'bs-btn bs-btn--primary', disabled: backend === 'legacy', title: backend === 'legacy' ? '重启 dsh 后可用' : undefined, onClick: () => setNewTaskOpen(true) }, '新建任务'),
            h('button', { className: 'bs-btn', onClick: () => setView('assistant') }, '管理员对话'),
            h('button', { className: 'bs-btn', onClick: openSettings }, '设置'),
          ),
        ),
        h('div', { className: 'bs-banner', 'aria-live': 'polite' },
          headerHint,
          h('span', null, `最后更新 ${clockText(observedAt?.getTime())}`),
          h('button', { className: 'bs-btn bs-btn--quiet', disabled: refreshing, onClick: () => { refresh().catch(() => {}); loadWorkspaces().catch(() => {}) } }, refreshing ? '正在刷新' : '刷新'),
          backend === 'legacy' ? h('span', { className: 'bs-banner__error', role: 'alert' }, '宿主仍在运行旧版后端：重启 dsh 后才能新建、授权和派发') : null,
          loadError ? h('span', { className: 'bs-banner__error' }, '连接中断，当前执行状态尚不可确认') : null,
          sessionMessage ? h('span', { className: 'bs-banner__error' }, sessionMessage) : null,
          notice ? h('span', { className: notice.includes('失败') ? 'bs-banner__error' : 'bs-banner__ok', role: 'status' }, notice) : null,
        ),
        h('div', { className: 'bs-views', role: 'tablist', 'aria-label': '视图' },
          ...['tasks', 'assistant'].map((key) => h('button', { key, className: 'bs-view', role: 'tab', 'aria-selected': view === key, onClick: () => setView(key) }, key === 'tasks' ? '任务' : '助手')),
        ),
        view === 'assistant' ? renderAssistant() : view === 'settings' ? renderSettings() : h('div', { className: 'bs-workspace' },
          h('div', { className: 'bs-content' },
            h('div', { className: 'bs-toolbar', role: 'group', 'aria-label': '按状态筛选' },
              ...FILTERS.map(([key, label]) => h('button', { key, className: 'bs-pill', 'aria-pressed': filter === key, onClick: () => setFilter(key) }, label, key === 'all' ? h('span', { className: 'bs-pill__count' }, String(filtered.length)) : h('span', { className: 'bs-pill__count' }, String(counts[key] ?? 0)))),
              h('label', { className: 'bs-visually-hidden', htmlFor: 'bs-search' }, '搜索任务标题或标识'),
              h('input', { id: 'bs-search', className: 'bs-search', type: 'search', value: search, placeholder: '搜索任务标题或标识', onChange: (event) => { if (selected) closeDetail(); setSearch(event.target.value) } }),
              h('label', { className: 'bs-visually-hidden', htmlFor: 'bs-workspace' }, '按工作区筛选'),
              h('select', { id: 'bs-workspace', className: 'bs-select', value: workspace, onChange: (event) => { if (selected) closeDetail(); setWorkspace(event.target.value) } }, h('option', { value: '' }, '全部工作区'), ...workspaceIds.map((id) => h('option', { key: id, value: id }, id))),
            ),
            renderList(),
          ),
          renderDetail(),
        ),
        h(NewTaskDialog, { open: newTaskOpen, onClose: () => setNewTaskOpen(false), onSubmit: createTask, workspaces, busy: creating }),
      )
    }

    function Panel({ ctx, bus, SessionProvider, renderSlot }) {
      const api = {
        get: async (path, signal) => { const response = await fetch(API + path, { signal }); const body = await response.json().catch(() => null); if (!response.ok) throw Object.assign(new Error(body?.error ?? `请求失败 (${response.status})`), { code: body?.code, status: response.status }); return body },
        post: async (path, body) => { const response = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }); const result = await response.json().catch(() => null); if (!response.ok) throw Object.assign(new Error(result?.error ?? `请求失败 (${response.status})`), { code: result?.code, status: response.status }); return result },
      }
      return h(App, { api, sessions: ctx.sessions, conversation: ctx.conversation, uiWorkspace: ctx.uiWorkspace, SessionProvider, renderSlot, bus })
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
      const bus = tools.setupCommonTools(ctx)
      ctx.slots.inject('conversation.session', () => ctx.slots.inject('main', () => {
        const unregisterMain = ctx.slots.register({ name: 'main', id: 'boss-simulator', key: 'boss-simulator', label: '公司管理', children: { 'boss-simulator.chat': { kind: 'single', scope: 'session' } } }, (props) => h(Panel, { ...props, ctx, bus }))
        const unregisterChat = ctx.slots.register({ name: 'boss-simulator.chat' }, EmbeddedChat)
        return () => { unregisterChat(); unregisterMain() }
      }))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'boss-simulator', label: '公司管理' }, (iconProps) => h(PanelIcon, iconProps)))
      return { dispose() {} }
    }
    return { inject: ['slots', 'sessions', 'uiWorkspace', 'uiSession', 'uiConversation', 'conversation'], apply }
  },
})
