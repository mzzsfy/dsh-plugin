// dsh-agent-shell Client 半区:检测 dsh-better-sidebar(可延迟出现),存在即注册
// 原生标签页(执行流 + 审批 + 会话接管);不存在时不注册任何 UI,/agent-shell
// 简陋页(host 半区路由)即回退方案。轮询与页面共用同一组 /agent-shell/api/*。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-agent-shell',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef, useCallback } = React

    const POLL_ACTIVE_MS = 1500
    const POLL_IDLE_MS = 6000

    const h = (type, props, ...children) => React.createElement(type, props, ...children)

    // ── 数据层:events 合并(按 id 保最后态)────────────────────────────
    function useAgentShell(visible) {
      const [events, setEvents] = useState([])
      const [sessions, setSessions] = useState([])
      const [ready, setReady] = useState(false)
      const sinceRef = useRef(0)
      const eventMap = useRef(new Map())

      useEffect(() => {
        let alive = true
        let timer = null
        const loop = async () => {
          if (!alive) return
          let delay = POLL_ACTIVE_MS
          try {
            const data = await fetch('/agent-shell/api/events?since=' + sinceRef.current).then((r) => r.json())
            for (const event of data.events || []) {
              sinceRef.current = Math.max(sinceRef.current, event.seq)
              const key = event.kind === 'approval' ? 'ap:' + event.id : 'ev:' + event.id + ':' + event.state + ':' + (event.text || '')
              eventMap.current.set(key, event)
              if (event.kind === 'approval' && event.state !== 'pending') eventMap.current.delete('ap:' + event.id)
            }
            setEvents([...eventMap.current.values()].sort((a, b) => a.seq - b.seq))
            const state = await fetch('/agent-shell/api/state').then((r) => r.json())
            setReady(state.ready === true)
          } catch {
            setReady(false)
            delay = POLL_IDLE_MS
          }
          if (!visible.current) delay = POLL_IDLE_MS
          timer = setTimeout(loop, delay)
        }
        loop()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [])

      useEffect(() => {
        let alive = true
        const loop = async () => {
          if (!alive) return
          try {
            const data = await fetch('/agent-shell/api/sessions').then((r) => r.json())
            setSessions(data.sessions || [])
          } catch {}
          setTimeout(() => { if (alive) loop() }, visible.current ? 3000 : 10000)
        }
        loop()
        return () => { alive = false }
      }, [])

      const decide = useCallback(async (id, approve) => {
        await fetch('/agent-shell/api/approval/' + encodeURIComponent(id), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ approve }),
        })
      }, [])

      const sendInput = useCallback(async (sessionId, text) => {
        await fetch('/agent-shell/api/session/' + encodeURIComponent(sessionId) + '/input', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        })
      }, [])

      const killSession = useCallback(async (sessionId) => {
        await fetch('/agent-shell/api/kill', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: sessionId }),
        })
      }, [])

      return { events, sessions, ready, decide, sendInput, killSession }
    }

    // ── 视图 ──────────────────────────────────────────────────────────
    const MONO = { fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }

    function EventItem({ event, onDecide }) {
      const pending = event.kind === 'approval' && event.state === 'pending'
      const tag = event.kind === 'approval'
        ? '审批:' + event.state
        : event.state === 'running' ? '运行中' : event.state === 'input' ? '输入' : 'exit ' + (event.exitCode === null || event.exitCode === undefined ? '—' : event.exitCode)
      const tone = pending ? '#ffd479' : event.state === 'running' ? '#ffd479' : (event.exitCode === 0 || event.kind === 'approval' && event.state === 'approved') ? '#b8f0c9' : '#ffb3ba'
      const output = [event.stdout, event.stderr, event.text ? '[输入] ' + event.text : ''].filter(Boolean).join('\n────\n').slice(-8000)
      return h('div', { style: { border: '1px solid var(--dsh-border, #2a3342)', borderRadius: 6, padding: '6px 8px', marginBottom: 6, background: 'var(--dsh-bg, rgba(127,127,127,.06))' } },
        h('div', { style: { display: 'flex', gap: 8, fontSize: 11, opacity: 0.75, flexWrap: 'wrap' } },
          h('span', { style: { color: tone } }, tag),
          h('span', {}, event.host ? 'ssh:' + event.host : 'local'),
          h('span', {}, event.source || ''),
          event.durationMs !== undefined ? h('span', {}, Math.round(event.durationMs / 100) / 10 + 's') : null,
          event.timedOut ? h('span', { style: { color: '#ffb3ba' } }, '超时') : null,
        ),
        h('div', { style: { ...MONO, margin: '4px 0' } }, event.command || ''),
        pending ? h('div', { style: { display: 'flex', gap: 6 } },
          h('button', { onClick: () => onDecide(event.id, true) }, '批准执行'),
          h('button', { onClick: () => onDecide(event.id, false) }, '拒绝'),
        ) : null,
        output ? h('div', { style: { ...MONO, opacity: 0.8, maxHeight: 180, overflow: 'auto', background: 'var(--dsh-bg-deep, rgba(0,0,0,.25))', borderRadius: 4, padding: '4px 6px' } }, output) : null,
      )
    }

    function SessionItem({ session, onSend, onKill }) {
      const [text, setText] = useState('')
      const submit = () => {
        if (!text) return
        onSend(session.id, text)
        setText('')
      }
      return h('div', { style: { border: '1px solid var(--dsh-border, #2a3342)', borderRadius: 6, padding: '6px 8px', marginBottom: 6 } },
        h('div', { style: { display: 'flex', gap: 8, fontSize: 11, opacity: 0.75 } },
          h('span', { style: { color: session.running ? '#ffd479' : '#b8f0c9' } }, session.running ? '运行中' : 'exit ' + (session.exitCode ?? '—')),
          h('span', {}, session.id),
          h('span', { style: { marginLeft: 'auto', cursor: 'pointer', color: '#ffb3ba' }, onClick: () => onKill(session.id) }, '终止'),
        ),
        h('div', { style: { ...MONO, margin: '4px 0' } }, session.command),
        h('div', { style: { display: 'flex', gap: 6 } },
          h('input', {
            value: text,
            placeholder: '输入后回车(密码/确认),与 agent 共享 stdin',
            style: { flex: 1, minWidth: 0 },
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submit() },
          }),
          h('button', { onClick: submit }, '发送'),
        ),
      )
    }

    function AgentShellTab({ visible }) {
      const visibleRef = useRef(visible)
      visibleRef.current = visible
      const { events, sessions, ready, decide, sendInput, killSession } = useAgentShell(visibleRef)
      const [command, setCommand] = useState('')
      const approvals = events.filter((event) => event.kind === 'approval' && event.state === 'pending')
      const execs = events.filter((event) => event.kind !== 'approval')

      const run = async () => {
        if (!command.trim()) return
        const value = command
        setCommand('')
        await fetch('/agent-shell/api/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command: value }),
        })
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', padding: 8, gap: 8, boxSizing: 'border-box' } },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('input', {
            value: command,
            placeholder: '手动执行命令(走同一套黑白名单与审批)…',
            style: { flex: 1, minWidth: 0 },
            onChange: (e) => setCommand(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') run() },
          }),
          h('button', { onClick: run }, '执行'),
          h('span', { style: { fontSize: 11, opacity: 0.7 } }, ready ? '服务就绪' : '服务未就绪'),
        ),
        approvals.length > 0 ? h('div', null,
          h('div', { style: { fontSize: 11, textTransform: 'uppercase', opacity: 0.6, margin: '4px 0' } }, '待审批(' + approvals.length + ')'),
          ...approvals.map((event) => h(EventItem, { key: 'ap:' + event.id, event, onDecide: decide })),
        ) : null,
        h('div', { style: { flex: 1, overflow: 'auto', minHeight: 0 } },
          ...execs.slice(-200).reverse().map((event) => h(EventItem, { key: 'ev:' + event.id + ':' + event.state + ':' + (event.text || '') + ':' + event.seq, event, onDecide: decide })),
          execs.length === 0 ? h('div', { style: { opacity: 0.6 } }, '暂无执行记录;agent 通过 mcp__agent-shell__* 工具执行的命令会实时出现在这里') : null,
        ),
        h('div', { style: { maxHeight: '30%', overflow: 'auto', borderTop: '1px solid var(--dsh-border, #2a3342)', paddingTop: 6 } },
          h('div', { style: { fontSize: 11, textTransform: 'uppercase', opacity: 0.6, margin: '2px 0 6px' } }, '交互会话(用户可直接输入密码/确认)'),
          ...sessions.map((session) => h(SessionItem, { key: session.id, session, onSend: sendInput, onKill: killSession })),
          sessions.length === 0 ? h('div', { style: { opacity: 0.6 } }, '暂无会话') : null,
        ),
      )
    }

    function registerSidebarTab(ctx) {
      const sidebar = ctx.get('betterSidebar')
      if (sidebar === undefined) return false
      ctx.effect(() => sidebar.registerTab({
        id: 'agent-shell',
        title: 'Agent Shell',
        icon: (size) => h('svg', {
          width: size, height: size, viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        },
          h('rect', { x: 2.5, y: 3.5, width: 15, height: 13, rx: 1.5 }),
          h('path', { d: 'M6 8l3 2.5L6 13' }),
          h('path', { d: 'M11 13h3.5' }),
        ),
        order: 42,
        single: true,
        component: ({ visible }) => h(AgentShellTab, { visible }),
      }), 'agent-shell: sidebar tab')
      return true
    }

    return {
      apply(ctx) {
        // better-sidebar 可能在本插件之后就绪:立即探测 + internal/service 晚到探测。
        // 都没有就保持沉默,/agent-shell 页面是官方回退入口。
        if (registerSidebarTab(ctx)) return
        const off = ctx.on('internal/service', (serviceName) => {
          if (serviceName === 'betterSidebar' && registerSidebarTab(ctx)) off()
        })
        ctx.effect(() => off, 'agent-shell: betterSidebar probe')
      },
      __test: { useAgentShell, AgentShellTab },
    }
  },
})
