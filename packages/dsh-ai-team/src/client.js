// dsh-ai-team client v2:全局主面板「AI 团队」七列只读看板。
// 数据权威在服务端查询投影(/api/ai-team/board);前端仅管理筛选/选中;
// 中断与全局紧急停止直接提交(commandId 幂等,无确认框);继续执行请与角色对话。
window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-ai-team',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const PLUGIN_ID = '@mzzsfy/dsh-ai-team'
    const SLOT_ID = 'ai-team'
    const API = '/api/ai-team/'
    const REFRESH_MS = 5 * 1000
    const COLUMNS = [
      ['draft', '草稿'], ['ready', '已授权待调度'], ['implementing', '实施中'], ['awaiting_acceptance', '待验收'],
      ['completed', '已结案'], ['blocked', '受阻'], ['cancelled', '已取消'],
    ]
    const CONTROL_LABEL = { active: '', stopping: '中断中', paused: '已暂停', reconciling: '核对中' }
    const STOP_DETAIL_LABEL = { requesting: '中断中', unconfirmed: '停止待确认' }

    const NAV_ICON = { 'AI 团队': 'team', 'dsh-ai-team': 'team' }
    if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
    else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
    else window.__navicIconQueue = [NAV_ICON]

    const CSS = `
.at-root{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary,#0f1115);padding:12px 4px}
.at-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.at-head__title{font:600 16px/24px var(--dsw-font-family,sans-serif)}
.at-head__caption{font:400 13px/20px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-tertiary,#81858c)}
.at-banner{font:400 12px/18px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-tertiary,#81858c);display:flex;gap:12px;flex-wrap:wrap}
.at-banner__error{color:var(--dsw-alias-state-error-primary,#ec1313)}
.at-toolbar{display:flex;gap:8px;align-items:center}
.at-search{flex:0 1 280px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:8px;padding:5px 10px;font:400 13px/20px var(--dsw-font-family,sans-serif);background:var(--dsw-alias-bg-base,#fff);color:inherit}
.at-btn{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#61666b);font:500 13px/20px var(--dsw-font-family,sans-serif);border-radius:8px;padding:5px 12px;cursor:pointer}
.at-btn:hover{color:var(--dsw-alias-label-primary,#0f1115)}
.at-btn--danger{color:var(--dsw-alias-state-error-primary,#ec1313)}
.at-btn:disabled{opacity:.45;cursor:default}
.at-board{display:flex;gap:12px;overflow-x:auto;align-items:flex-start}
.at-col{flex:0 0 auto;min-width:256px;display:flex;flex-direction:column;gap:6px}
.at-col__head{font:600 13px/20px var(--dsw-font-family,sans-serif);display:flex;gap:6px;align-items:baseline}
.at-col__count{font:400 12px/18px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-caption,#adb2b8);font-variant-numeric:tabular-nums}
.at-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:var(--dsw-alias-bg-base,#fff);padding:10px 12px;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:4px;color:inherit;font:inherit}
.at-run{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:6px;padding:8px 10px;margin-bottom:8px;display:flex;flex-direction:column;gap:4px}
.at-run__head{display:flex;gap:8px;align-items:center}
.at-pill{border-radius:999px;padding:1px 8px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15))}
.at-pill--settled,.at-pill--interrupted{background:rgba(0,0,0,.04)}
.at-pill--submitted,.at-pill--running{background:rgba(48,119,235,.12)}
.at-pill--rejected{background:rgba(214,69,69,.12)}
.at-run__seg{display:flex;gap:12px;font-size:12px;color:var(--dsw-alias-text-secondary,rgba(0,0,0,.55))}
.at-run__meta{display:flex;gap:12px;font-size:12px;color:var(--dsw-alias-text-secondary,rgba(0,0,0,.55))}
.at-card:hover,.at-card--on{outline:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.25))}
.at-card__title{font:500 13px/20px var(--dsw-font-family,sans-serif);word-break:break-word}
.at-card__meta{font:400 12px/18px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-tertiary,#81858c);word-break:break-word}
.at-detail{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;padding:12px;display:flex;flex-direction:column;gap:8px}
.at-detail__head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.at-detail__body{display:grid;gap:4px;font:400 13px/20px var(--dsw-font-family,sans-serif)}
.at-empty{font:400 13px/20px var(--dsw-font-family,sans-serif);color:var(--dsw-alias-label-tertiary,#81858c)}
`

    function newCommandId(prefix) {
      return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }

    function App({ api }) {
      const [data, setData] = useState(null)
      const [loadError, setLoadError] = useState(false)
      const [observedAt, setObservedAt] = useState(null)
      const [search, setSearch] = useState('')
      const [tab, setTab] = useState('board')
      const [view, setView] = useState('panel')
      const [settingsDraft, setSettingsDraft] = useState(null)
      const [settingsNote, setSettingsNote] = useState(null)
      const [selected, setSelected] = useState(null)
      const [writing, setWriting] = useState(false)
      const inflight = useRef(null)

      const refresh = useCallback(async (keyword) => {
        if (document.hidden || inflight.current) return
        const query = keyword ? `?search=${encodeURIComponent(keyword)}` : ''
        const request = api.get(`board${query}`)
        inflight.current = request
        try {
          const payload = await request
          setData(payload)
          setObservedAt(new Date())
          setLoadError(false)
        } catch {
          setLoadError(true)
        } finally {
          inflight.current = null
        }
      }, [api])

      useEffect(() => {
        refresh(search)
        const timer = setInterval(() => refresh(search), REFRESH_MS)
        const onVisible = () => { if (!document.hidden) refresh(search) }
        document.addEventListener('visibilitychange', onVisible)
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
      }, [refresh, search])

      async function interrupt(body) {
        if (writing) return
        setWriting(true)
        try {
          await api.post('interrupt', { ...body, payloadHash: JSON.stringify(body) })
        } catch {
          // 结果未知:不自动重试副作用,由用户查询原 commandId
        } finally {
          setWriting(false)
          refresh(search)
        }
      }

      async function openSettings() {
        try {
          const s = await api.get('board?settings=1')
          setSettingsDraft({ expectedConfigRevision: s.configRevision, concurrencyReference: s.values.concurrencyReference })
          setSettingsNote(null)
          setView('settings')
        } catch (e) {
          setSettingsNote('读取失败: ' + (e.message ?? e))
        }
      }

      async function saveSettingsView() {
        try {
          await api.post('settings', {
            expectedConfigRevision: settingsDraft.expectedConfigRevision,
            values: { concurrencyReference: settingsDraft.concurrencyReference },
          })
          setSettingsNote('已保存,对下一次角色决策或派发生效;不影响运行中的 Run')
          await openSettings()
        } catch (e) {
          setSettingsNote('保存失败,草稿已保留: ' + (e.message ?? e))
        }
      }

      const items = data?.items ?? []
      const selectedTask = selected ? items.find((t) => t.taskId === selected) : undefined
      const knownIds = data ? new Set(items.map((t) => t.taskId)) : null
      const selectionLost = selected && knownIds && !knownIds.has(selected)
      if (selectionLost) setSelected(null)

      return h('div', { className: 'at-root' },
        h('style', { 'data-plugin': PLUGIN_ID, dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'at-head' },
          h('span', { className: 'at-head__title' }, 'AI 团队'),
          h('span', { className: 'at-head__caption' }, '只读看板 · 中断入口 · 继续执行请与角色对话'),
          view === 'panel'
            ? h('button', { className: 'at-btn', onClick: openSettings }, '设置')
            : h('button', { className: 'at-btn', onClick: () => setView('panel') }, '返回面板'),
        ),
        view === 'settings' ? h('div', { className: 'at-detail' },
          h('div', { className: 'at-detail__head' }, h('strong', null, '设置')),
          h('div', { className: 'at-detail__body' },
            h('label', null, '并发参考(留空=未设置,仅提示不硬限): ',
              h('input', {
                className: 'at-search', value: settingsDraft?.concurrencyReference ?? '',
                onChange: (e) => setSettingsDraft((d) => ({ ...d, concurrencyReference: e.target.value === '' ? null : Number(e.target.value) })),
              })),
            h('div', { className: 'at-toolbar' },
              h('button', { className: 'at-btn', disabled: writing || !settingsDraft, onClick: saveSettingsView }, '保存'),
              h('button', { className: 'at-btn', onClick: () => setView('panel') }, '取消'),
            ),
            settingsNote ? h('span', { className: 'at-card__meta' }, settingsNote) : null,
          ),
        ) : null,
        view === 'panel' && h(React.Fragment, null,
        h('div', { className: 'at-banner' },
          loadError
            ? h('span', { className: 'at-banner__error' }, `查询失败,显示旧数据(观察于 ${observedAt ? observedAt.toLocaleTimeString() : '—'})`)
            : h('span', null, `数据观察时间 ${observedAt ? observedAt.toLocaleTimeString() : '—'}`),
        ),
        h('div', { className: 'at-toolbar' },
          h('button', { className: `at-btn${tab === 'board' ? ' at-card--on' : ''}`, onClick: () => setTab('board') }, '看板'),
          h('button', { className: `at-btn${tab === 'timeline' ? ' at-card--on' : ''}`, onClick: () => setTab('timeline') }, '实际时间线'),
          h('button', { className: `at-btn${tab === 'models' ? ' at-card--on' : ''}`, onClick: () => setTab('models') }, '模型任务'),
          h('input', {
            className: 'at-search', placeholder: '任务标题/标识搜索', value: search,
            onChange: (e) => setSearch(e.target.value),
          }),
          h('button', {
            className: 'at-btn at-btn--danger', disabled: writing,
            onClick: () => interrupt({ global: true, commandId: newCommandId('stop') }),
          }, '全局紧急停止'),
        ),
        tab === 'board' ? h('div', { className: 'at-board' },
          COLUMNS.map(([key, label]) => {
            const list = items.filter((t) => t.businessState === key)
            const count = data?.counts?.[key]
            return h('div', { className: 'at-col', key },
              h('div', { className: 'at-col__head' }, label, ' ',
                h('span', { className: 'at-col__count' }, count === undefined ? `已加载 ${list.length}` : String(count))),
              list.map((t) => h('button', {
                key: t.taskId,
                className: `at-card${selected === t.taskId ? ' at-card--on' : ''}`,
                onClick: () => setSelected(t.taskId),
              },
              h('span', { className: 'at-card__title' }, t.title),
              h('span', { className: 'at-card__meta' },
                [t.businessState, CONTROL_LABEL[t.controlState], t.stopDetail && STOP_DETAIL_LABEL[t.stopDetail], t.pendingCancel ? '取消中' : ''].filter(Boolean).join(' · ')),
              h('span', { className: 'at-card__meta' }, `${t.projectWorkspaceId} · 子项 ${t.workItemCount}${t.authorized ? ' · 已授权' : ''}`),
              ))
            )
          }),
          items.length === 0 ? h('div', { className: 'at-empty' }, data ? '没有匹配的任务' : '读取中…') : null,
        ) : null,
        tab === 'timeline' ? h('div', { className: 'at-detail' },
          h('div', { className: 'at-detail__head' }, h('strong', null, '实际时间线(仅真实执行区间,无预计与百分比)')),
          selectedTask
            ? h('div', { className: 'at-detail__body' },
              (selectedTask.runs ?? []).length === 0 ? h('span', { className: 'at-empty' }, '该任务暂无执行记录') :
                (selectedTask.runs ?? []).map((r) => h('div', { key: r.runId, className: 'at-run' },
                  h('div', { className: 'at-run__head' },
                    h('strong', null, `${r.runId} · ${r.phase}`),
                    h('span', { className: `at-pill at-pill--${r.state}` }, r.state)),
                  h('div', { className: 'at-run__seg' },
                    r.startedAt ? h('span', { className: 'at-run__seg-start' }, `起 ${new Date(r.startedAt).toLocaleTimeString()}`) : h('span', { className: 'at-empty' }, '未实际开始'),
                    r.endedAt ? h('span', { className: 'at-run__seg-end' }, `止 ${new Date(r.endedAt).toLocaleTimeString()}`) : null,
                    r.startedAt && r.endedAt ? h('span', { className: 'at-run__seg-dur' }, `历时 ${Math.max(0, Math.round((r.endedAt - r.startedAt) / 1000))}s`) : null),
                  h('div', { className: 'at-run__meta' },
                    r.tokenTotal !== null && r.tokenTotal !== undefined ? h('span', null, `tokens ${r.tokenTotal}`) : null,
                    h('span', null, `usage ${r.usageCoverage ?? 'unknown'}`),
                    r.stopObserved ? h('span', null, `stop ${r.stopObserved}`) : null))))
            : h('span', { className: 'at-empty' }, '在看板中选中任务后显示其执行时间线'),
        ) : null,
        tab === 'models' ? h('div', { className: 'at-detail' },
          h('div', { className: 'at-detail__head' }, h('strong', null, '模型任务(参与任务去重计数,无绩效分析)')),
          h('div', { className: 'at-detail__body' },
            items.filter((t) => (t.runs ?? []).length > 0).length === 0
              ? h('span', { className: 'at-empty' }, '暂无模型参与记录')
              : items.filter((t) => (t.runs ?? []).length > 0).map((t) => h('span', { key: t.taskId },
                `${t.title} · 参与模型 ${t.modelTaskCount} · Run ${t.runs.length}`))),
        ) : null,
        selectedTask ? h('div', { className: 'at-detail', role: 'dialog', 'aria-label': '任务详情' },
          h('div', { className: 'at-detail__head' },
            h('strong', null, selectedTask.title),
            h('button', { className: 'at-btn', onClick: () => setSelected(null) }, '关闭'),
            h('button', {
              className: 'at-btn at-btn--danger', disabled: writing,
              onClick: () => interrupt({ taskId: selectedTask.taskId, commandId: newCommandId('stop') }),
            }, '中断'),
          ),
          h('div', { className: 'at-detail__body' },
            h('span', null, ['状态:' + selectedTask.businessState, CONTROL_LABEL[selectedTask.controlState], selectedTask.stopDetail && STOP_DETAIL_LABEL[selectedTask.stopDetail], selectedTask.pendingCancel ? '取消中' : ''].filter(Boolean).join(' · ')),
            h('span', null, `工作区:${selectedTask.projectWorkspaceId}`),
            h('span', null, `定义版本:${selectedTask.definitionRevision} · ${selectedTask.authorized ? '已授权' : '未授权'}`),
            h('span', null, `子项:${selectedTask.workItemCount} · 在途 Run:${selectedTask.activeRunCount}`),
            h('span', { style: { opacity: 0.7, fontSize: 12 } }, `更新于 ${new Date(selectedTask.updatedAt).toLocaleString()}`),
          ),
        ) : null,
        ))
    }

    function Panel() {
      const api = {
        get: async (path) => {
          const res = await fetch(API + path)
          const json = await res.json().catch(() => null)
          if (!res.ok) throw new Error(json?.error ?? `请求失败(${res.status})`)
          return json
        },
        post: async (path, body) => {
          const res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
          const json = await res.json().catch(() => null)
          if (!res.ok) throw new Error(json?.error ?? `请求失败(${res.status})`)
          return json
        },
      }
      return h(App, { api })
    }

    function apply(ctx) {
      const disposers = []
      // 'main' 主面板 + 侧栏图标位(cron-board/tunnel 同构)
      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', id: SLOT_ID, key: SLOT_ID, label: 'AI 团队' }, Panel))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: SLOT_ID, label: 'AI 团队' }, SidebarIcon))
      return { dispose: () => disposers.forEach((d) => d()) }
    }

    function SidebarIcon(props) {
      return h('span', { title: 'AI 团队' }, props?.label ?? '团队')
    }

    return { inject: ['slots'], apply }
  },
})
