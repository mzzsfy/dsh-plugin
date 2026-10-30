window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-stock-sidebar',
  factory(require) {
    const PANEL_ID = 'stock-sidebar', BASE = '/api/stock-sidebar', BROWSE_PAGE = 50
    function createPageRuntime({ layout, bus, tools, document: doc = document, fetch: request = fetch }) {
      let disposed = false, generation = 0, demandGeneration = 0, pageId = crypto.randomUUID(), timer, heartbeat, undoTimer, queryGeneration = 0, querying, composing = false
      const subscribers = new Set(), retiredEpochs = new Set(), requests = new Set()
      let state = { view: { view: 'list', query: '', selectedId: null, detailId: null, sort: 'manual', focusId: null, keyboardNavigating: false, frozenOrder: null, settingsDraft: null, scrollTop: 0, menuId: null, alias: '', browseMarket: 'XSHG', browseRows: null, browseTotal: 0, browseOffset: 0 }, data: null, paused: false, error: '', errorCode: '', busy: {}, candidates: [], composing: false, undo: null }
      function emit() { for (const fn of subscribers) fn() }
      function patch(next) { if (!disposed) { state = { ...state, ...next }; emit() } }
      function applySnapshot(data, explicit = false) {
        if (disposed || !data || retiredEpochs.has(data.serverEpoch)) return
        const old = state.data
        if (old?.serverEpoch === data.serverEpoch && old.snapshotSeq > data.snapshotSeq) return
        if (old && old.serverEpoch !== data.serverEpoch) retiredEpochs.add(old.serverEpoch)
        if (!explicit && state.paused && old && old.serverEpoch === data.serverEpoch && old.routingRevision === data.routingRevision && JSON.stringify(old.routeSelections) === JSON.stringify(data.routeSelections)) data = { ...data, quotes: old.quotes }
        patch({ data, error: '' })
      }
      async function api(path, method = 'GET', body, signal) {
        const controller = new AbortController(); requests.add(controller)
        const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true })
        const timeout = setTimeout(() => controller.abort(), path === '/provider-check' ? 61000 : path === '/catalog-sync' ? 31000 : 11000)
        try {
          const response = await request(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal })
          const result = await response.json()
          if (!response.ok || !result.ok) { const e = new Error(result.error?.message || '请求失败'); Object.assign(e, result.error, { snapshot: result.snapshot }); throw e }
          return result.data
        } finally { clearTimeout(timeout); requests.delete(controller); signal?.removeEventListener('abort', abort) }
      }
      const refresher = tools.createSnapshotRefresh(async () => {
        const gen = generation
        try { const data = await api('/snapshot'); if (gen === generation) applySnapshot(data) }
        catch (e) { if (!disposed && gen === generation) patch({ error: e.message }) }
      })
      function wanted() { return !disposed && layout.panelInfo.getSnapshot().activePanelId === PANEL_ID && doc.visibilityState !== 'hidden' && !state.paused && ['list', 'detail'].includes(state.view.view) }
      let lastWanted = null
      function sendDemand(force = false) {
        const active = wanted()
        if (active === lastWanted && !force) return
        lastWanted = active
        try { bus.publish({ type: 'watch-demand', pageId, generation: ++demandGeneration, active }) } catch {}
        clearInterval(heartbeat)
        if (active) { heartbeat = setInterval(() => sendDemand(true), 30 * 1000); heartbeat?.unref?.() }
      }
      function visible() { sendDemand(); if (layout.panelInfo.getSnapshot().activePanelId === PANEL_ID && doc.visibilityState !== 'hidden') refresher.refresh() }
      const stopLayout = layout.panelInfo.subscribe(visible)
      const stopBus = bus.subscribe(message => { if (message?.type === 'invalidate') refresher.refresh() }, { onReset: () => {
        generation++; queryGeneration++; querying?.abort(); for (const c of requests) c.abort()
        try { bus.publish({ type: 'watch-demand', pageId, generation: ++demandGeneration, active: false }) } catch {}
        pageId = crypto.randomUUID(); lastWanted = null; refresher.refresh(); sendDemand(true)
      } })
      doc.addEventListener('visibilitychange', visible)
      visible()
      async function action(key, work) {
        if (disposed || state.busy[key]) return
        patch({ busy: { ...state.busy, [key]: true }, error: '' })
        try { return await work() } catch (e) { if (e.snapshot) applySnapshot(e.snapshot); patch({ error: e.message, errorCode: e.code }); throw e }
        finally { patch({ busy: { ...state.busy, [key]: false } }) }
      }
      function updateView(next) { patch({ view: { ...state.view, ...next } }); sendDemand() }
      function scheduleSearch(query) {
        updateView({ query, selectedId: null }); clearTimeout(timer); querying?.abort(); querying = new AbortController()
        if (composing || !query.trim()) { patch({ candidates: [] }); return }
        const gen = ++queryGeneration, routingRevision = state.data?.routingRevision, signal = querying.signal
        timer = setTimeout(async () => {
          try {
            for (const phase of ['local', 'remote']) {
              const result = await api(`/search?${new URLSearchParams({ q: query, phase })}`, 'GET', undefined, signal)
              if (disposed || signal.aborted || gen !== queryGeneration || state.data?.routingRevision !== routingRevision || result.routingRevision !== routingRevision) return
              const map = new Map((phase === 'remote' ? state.candidates : []).map(s => [s.id, s]))
              for (const item of result.items) map.set(item.id, item)
              patch({ candidates: [...map.values()], error: '' })
            }
          } catch (e) { if (!signal.aborted && gen === queryGeneration) patch({ error: e.message, errorCode: e.code }) }
        }, 300)
      }
      const operation = () => ({ operationId: crypto.randomUUID(), expectedRevision: state.data?.control.revision ?? 0 })
      return {
        getSnapshot: () => state,
        subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn) },
        updateView, api, action, applySnapshot,
        setPaused(value) { patch({ paused: value }); sendDemand(); if (!value) refresher.refresh() },
        search: scheduleSearch,
        composition(value) { composing = value; patch({ composing: value }); if (!value) scheduleSearch(state.view.query) },
        loadBrowse(market, offset) {
          return action('browse', async () => {
            const result = await api(`/browse?${new URLSearchParams({ market, offset: String(offset), limit: String(BROWSE_PAGE) })}`, 'GET')
            updateView({ browseMarket: market, browseOffset: offset, browseRows: result.items, browseTotal: result.total })
          })
        },
        async mutate(actionName, payload) {
          return action('write', async () => {
            const op = operation(), result = await api('/watchlist', 'POST', { ...op, action: actionName, payload })
            if (actionName === 'remove' && !result.unchanged) { patch({ undo: { removeOperationId: op.operationId, until: Date.now() + 8000 } }); clearTimeout(undoTimer); undoTimer = setTimeout(() => patch({ undo: null }), 8000) }
            if (state.data) patch({ data: { ...state.data, control: { ...state.data.control, revision: Math.max(state.data.control.revision, result.revision) } } })
            if (actionName === 'restore') patch({ undo: null })
            refresher.refresh(); return result
          })
        },
        refresh() { return action('refresh', async () => { const gen = generation; const data = await api('/refresh', 'POST', { expectedRoutingRevision: state.data?.routingRevision }); if (gen === generation) applySnapshot(data, true) }) },
        preferences(patchValue) { return action('write', async () => { const result = await api('/preferences', 'POST', { ...operation(), patch: patchValue }); if (state.data && state.data.control.revision <= result.revision) patch({ data: { ...state.data, control: { ...state.data.control, revision: result.revision, preferences: { ...state.data.control.preferences, ...patchValue } } } }); refresher.refresh() }) },
        configuration: (configuration, checkIds) => action('configuration', async () => { await api('/configuration', 'POST', { ...operation(), ...configuration, expectedRevision: state.view.settingsDraft?.expectedRevision ?? state.data?.control.revision, checkIds }); updateView({ settingsDraft: null }); refresher.refresh() }),
        sync: market => action('sync', async () => { const result = await api('/catalog-sync', 'POST', { market, expectedRoutingRevision: state.data?.routingRevision }); refresher.refresh(); return result }),
        check: configuration => action('check', () => api('/provider-check', 'POST', configuration)),
        switchPrimary: routeId => action('switch', async () => { const data = await api('/route-selection', 'POST', { routeId, target: 'primary', expectedRoutingRevision: state.data.routingRevision, expectedRouteEpoch: state.data.routeSelections[routeId].routeEpoch }); applySnapshot(data) }),
        dispose() {
          if (disposed) return
          try { bus.publish({ type: 'watch-demand', pageId, generation: ++demandGeneration, active: false }) } catch {}
          disposed = true; generation++; queryGeneration++; clearTimeout(timer); clearTimeout(undoTimer); clearInterval(heartbeat); querying?.abort(); for (const c of requests) c.abort(); requests.clear()
          stopLayout(); stopBus(); doc.removeEventListener('visibilitychange', visible); refresher.dispose(); subscribers.clear()
        },
      }
    }
    const React = require('react'), h = React.createElement, tools = require('@mzzsfy/dsh-common-tools/client')
    const NAV_ICON = { '股票': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M2 2v12h12M4 10l3-4 3 2 4-5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' }
    if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
    else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
    else window.__navicIconQueue = [NAV_ICON]
    function PanelIcon({ size = 16, active }) {
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: active ? 1.8 : 1.4, 'aria-hidden': true }, h('path', { d: 'M2 2v12h12M4 10l3-4 3 2 4-5', strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }
    const quiet = fn => (...args) => { Promise.resolve().then(() => fn(...args)).catch(() => {}) }
    const signed = value => value == null ? '—' : `${Number(value) > 0 ? '+' : ''}${value}`
    const timeText = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未知'
    function Button({ children, onClick, primary, danger, className = '', ...props }) { return h('button', { type: 'button', className: `ssb-button${primary ? ' ssb-primary' : ''}${danger ? ' ssb-danger' : ''} ${className}`, onClick, ...props }, children) }
    function Toggle({ label, checked, onChange, disabled = false }) {
      return h('label', { className: 'ssb-switch' }, h('input', { type: 'checkbox', checked, disabled, onChange: e => onChange(e.target.checked) }), h('span', { className: 'ssb-switch__track' }, h('span', { className: 'ssb-switch__thumb' })), h('span', null, label))
    }
    function QuoteStatus({ entry }) {
      const quote = entry?.quote
      return h('span', { className: 'ssb-muted ssb-source', title: entry?.lastError?.message || '' }, entry?.health && entry.health !== 'ok' ? `${({ limited: '额度受限', error: '请求失败', 'no-data': '暂无报价', unconfigured: '未配置来源' })[entry.health] || entry.health} · ` : '', quote ? `${quote.providerInstanceId} · ${quote.delayKind === 'unknown' ? '延迟未知' : quote.delayKind === 'realtime' ? '实时' : `延迟${quote.delaySeconds}秒`}` : '等待报价')
    }
    function Watchlist({ runtime, state }) {
      const { data, view, busy } = state, control = data.control, w = control.watchlist
      const sortedOrder = [...w.order].sort((a, b) => {
        const pinned = Number(w.items[b].pinned) - Number(w.items[a].pinned)
        if (pinned || view.sort === 'manual') return pinned
        const qa = data.quotes[a]?.quote, qb = data.quotes[b]?.quote
        const aa = qa?.changePct == null ? null : Number(qa.changePct), bb = qb?.changePct == null ? null : Number(qb.changePct)
        if (aa === null || bb === null) return aa === bb ? 0 : aa === null ? 1 : -1
        return view.sort === 'asc' ? aa - bb : bb - aa
      })
      const order = (view.menuId || view.keyboardNavigating) && view.frozenOrder ? [...view.frozenOrder.filter(id => w.items[id]), ...sortedOrder.filter(id => !view.frozenOrder.includes(id))] : sortedOrder
      function open(id) { runtime.updateView({ detailId: id, selectedId: id, view: 'detail', focusId: id, keyboardNavigating: false, menuId: null, alias: w.items[id].alias || '' }) }
      return h('section', { className: 'ssb-list-pane' },
        h('div', { className: 'ssb-section-head' }, h('h2', null, `自选 · ${w.order.length}`), h('label', null, h('span', { className: 'ssb-sr' }, '自选排序'), h('select', { value: view.sort, onChange: e => runtime.updateView({ sort: e.target.value }) }, h('option', { value: 'manual' }, '手动顺序'), h('option', { value: 'desc' }, '涨幅优先'), h('option', { value: 'asc' }, '跌幅优先')))),
        !order.length ? h('div', { className: 'ssb-empty' }, h('p', null, '添加第一只自选，集中查看价格和来源。'), h(Button, { primary: true, onClick: () => runtime.updateView({ view: 'search' }) }, '添加自选')) :
          h('div', { className: 'ssb-table-scroll', onScroll: e => runtime.updateView({ scrollTop: e.currentTarget.scrollTop }), ref: node => { if (node && Math.abs(node.scrollTop - (view.scrollTop || 0)) > 1) node.scrollTop = view.scrollTop || 0 } },
            h('table', { className: 'ssb-table' }, h('thead', null, h('tr', null, h('th', null, '证券'), h('th', null, '最新价'), h('th', null, '涨跌幅'), h('th', { className: 'ssb-aux' }, '来源 / 状态'), h('th', null, h('span', { className: 'ssb-sr' }, '操作')))),
              h('tbody', null, ...order.map(id => {
                const item = w.items[id], entry = data.quotes[id], q = entry?.quote
                const direction = q?.changePct == null ? '' : Number(q.changePct) > 0 ? ' ssb-up' : Number(q.changePct) < 0 ? ' ssb-down' : ''
                return h(React.Fragment, { key: id }, h('tr', { className: `${view.detailId === id ? 'ssb-selected' : ''}${entry?.health !== 'ok' ? ' ssb-stale' : ''}` },
                  h('td', null, h('button', { className: 'ssb-stock-name', 'data-security-id': id, onClick: () => open(id), onFocus: () => { if (view.focusId !== id) runtime.updateView({ focusId: id }) }, onBlur: e => { if (!e.relatedTarget?.closest('.ssb-stock-name')) runtime.updateView({ keyboardNavigating: false, frozenOrder: null }) }, onKeyDown: e => {
                    if (e.key === 'Escape') { runtime.updateView({ menuId: null, frozenOrder: null, keyboardNavigating: false, view: 'list' }); return }
                    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
                      e.preventDefault(); const at = order.indexOf(id), next = e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : Math.max(0, Math.min(order.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))
                      runtime.updateView({ keyboardNavigating: true, frozenOrder: order, focusId: order[next] }); const buttons = [...e.currentTarget.closest('tbody').querySelectorAll('.ssb-stock-name')]; buttons[next]?.focus()
                    }
                  } }, item.pinned ? '置顶 · ' : '', item.alias || item.officialName, h('span', { className: 'ssb-code' }, `${item.exchange === 'XSHG' ? '沪' : '深'} ${item.code}`))),
                  h('td', { className: `ssb-number${direction}` }, q?.last ?? '—'),
                  h('td', { className: `ssb-number${direction}` }, q?.changePct == null ? '—' : `${signed(q.changePct)}%`),
                  h('td', { className: 'ssb-aux' }, h(QuoteStatus, { entry })),
                  h('td', null, h(Button, { 'aria-label': `${item.officialName}更多操作`, 'aria-expanded': view.menuId === id, onClick: () => runtime.updateView({ menuId: view.menuId === id ? null : id, frozenOrder: view.menuId === id ? null : order }) }, '更多'))),
                  view.menuId === id ? h('tr', null, h('td', { colSpan: 5 }, h('div', { className: 'ssb-row-actions' },
                    h(Button, { disabled: busy.write, onClick: quiet(() => runtime.mutate('pin', { securityId: id, pinned: !item.pinned })) }, item.pinned ? '取消置顶' : '置顶'),
                    h(Button, { disabled: view.sort !== 'manual' || busy.write || order.indexOf(id) === 0 || w.items[order[order.indexOf(id) - 1]]?.pinned !== item.pinned, onClick: quiet(() => runtime.mutate('move', { securityId: id, beforeId: order[order.indexOf(id) - 1] })) }, '上移'),
                    h(Button, { disabled: view.sort !== 'manual' || busy.write || order.indexOf(id) === order.length - 1 || w.items[order[order.indexOf(id) + 1]]?.pinned !== item.pinned, onClick: quiet(() => runtime.mutate('move', { securityId: id, beforeId: order[order.indexOf(id) + 2] && w.items[order[order.indexOf(id) + 2]]?.pinned === item.pinned ? order[order.indexOf(id) + 2] : null })) }, '下移'),
                    h(Button, { onClick: () => open(id) }, '详情 / 别名'), h(Button, { danger: true, disabled: busy.write, onClick: quiet(() => runtime.mutate('remove', { securityId: id })) }, '删除'),
                    view.sort !== 'manual' ? h('span', { className: 'ssb-muted' }, '切回手动顺序后可移动') : null))) : null)
              })))))
    }
    function Detail({ runtime, state }) {
      const { data, view } = state, item = data.control.watchlist.items[view.detailId]
      if (!item) return h('aside', { className: 'ssb-detail ssb-empty' }, h('p', null, '选择一只证券查看基础行情。'))
      const entry = data.quotes[item.id], q = entry?.quote
      const direction = q?.changePct == null ? '' : Number(q.changePct) > 0 ? ' ssb-up' : Number(q.changePct) < 0 ? ' ssb-down' : ''
      const fields = [['今开', q?.open], ['最高', q?.high], ['最低', q?.low], ['昨收', q?.previousClose], ['涨跌额', q?.change == null ? null : signed(q.change)], ['成交量（股）', q?.volume], ['成交额（元）', q?.amount], ['交易时段', ({ trading: '交易中', closed: '休市', break: '午间休市', auction: '集合竞价', preopen: '开市前', unknown: '未知' })[q?.sessionState] || '未知'], ['个股状态', '未知'], ['报价时间', timeText(q?.quoteAt)], ['获取时间', timeText(q?.receivedAt)], ['来源', q?.providerInstanceId], ['延迟', q?.delayKind === 'unknown' || !q ? '未知' : q.delayKind === 'realtime' ? '实时' : `${q.delaySeconds}秒`]]
      return h('aside', { className: 'ssb-detail' }, h('div', { className: 'ssb-section-head' }, h('h2', null, item.alias || item.officialName), h(Button, { className: 'ssb-mobile-back', onClick: () => runtime.updateView({ view: 'list' }) }, '返回自选')),
        h('p', { className: 'ssb-muted' }, `${item.officialName} · ${item.exchange === 'XSHG' ? '上海' : '深圳'} ${item.code}`),
        h('div', { className: `ssb-detail-price ssb-number${direction}` }, q?.last ?? '—', h('span', { className: 'ssb-small' }, q?.changePct == null ? '—' : `${signed(q.changePct)}%`)),
        h(QuoteStatus, { entry }), h('dl', { className: 'ssb-facts' }, ...fields.map(([label, value]) => h(React.Fragment, { key: label }, h('dt', null, label), h('dd', null, value ?? '—')))),
        h('form', { className: 'ssb-alias-form', onSubmit: e => { e.preventDefault(); quiet(() => runtime.mutate('alias', { securityId: item.id, alias: view.alias }))() } }, h('label', null, '自选别名', h('input', { value: view.alias || '', maxLength: 60, onChange: e => runtime.updateView({ alias: e.target.value }), 'aria-describedby': 'ssb-alias-hint' })), h('small', { id: 'ssb-alias-hint', className: 'ssb-muted' }, '最多30个字符，留空显示正式名称'), h('button', { type: 'submit', className: 'ssb-button', disabled: state.busy.write || [...(view.alias || '')].length > 30 }, '保存别名')))
    }
    function BrowseView({ runtime, state }) {
      const { view, busy, data } = state
      const rows = view.browseRows
      return h('section', { className: 'ssb-search-view' }, h('h2', null, '浏览市场'),
        h('div', { className: 'ssb-toolbar' }, ...['XSHG', 'XSHE'].map(market => h(Button, { key: market, primary: (view.browseMarket || 'XSHG') === market, disabled: busy.browse, onClick: quiet(() => runtime.loadBrowse(market, 0)) }, market === 'XSHG' ? '上海A股' : '深圳A股'))),
        !rows ? h('div', { className: 'ssb-empty' }, h('p', null, '目录尚未同步。先在设置中保存数据源配置，再同步目录。'), h(Button, { primary: true, onClick: () => runtime.updateView({ view: 'settings' }) }, '前往设置'), h(Button, { disabled: busy.sync, onClick: quiet(() => runtime.sync(view.browseMarket || 'XSHG')) }, '同步当前市场目录')) :
          h('div', { className: 'ssb-results', role: 'list', 'aria-label': '市场证券列表' }, ...rows.map(item => {
            const added = !!data?.control.watchlist.items[item.id]
            return h('div', { className: 'ssb-candidate', role: 'listitem', key: item.id }, h('strong', null, item.officialName), h('span', { className: 'ssb-muted' }, `${item.exchange === 'XSHG' ? '沪' : '深'} ${item.code}`), h(Button, { disabled: added || busy.write, onClick: quiet(() => runtime.mutate('add', { securityId: item.id })) }, added ? '已在自选' : '加自选'))
          })),
        rows?.length ? h('div', { className: 'ssb-toolbar' }, h('span', { className: 'ssb-muted' }, `共 ${view.browseTotal} 只`), h(Button, { disabled: !view.browseOffset || busy.browse, onClick: quiet(() => runtime.loadBrowse(view.browseMarket, Math.max(0, view.browseOffset - BROWSE_PAGE))) }, '上一页'), h(Button, { disabled: view.browseOffset + BROWSE_PAGE >= view.browseTotal || busy.browse, onClick: quiet(() => runtime.loadBrowse(view.browseMarket, view.browseOffset + BROWSE_PAGE)) }, '下一页')) : null,
        h('div', { className: 'ssb-toolbar' }, h(Button, { onClick: () => runtime.updateView({ view: 'list' }) }, '返回自选')))
    }
    function SearchView({ runtime, state }) {
      const { view, candidates, data } = state
      function choose(item) { runtime.updateView({ selectedId: item.id }) }
      return h('section', { className: 'ssb-search-view' }, h('h2', null, '添加自选'),
        h('label', { className: 'ssb-search-label' }, '搜索名称、代码或拼音首字母', h('input', { type: 'search', autoFocus: true, value: view.query, placeholder: '例如 600519、茅台、gzmt', onChange: e => runtime.search(e.target.value), onCompositionStart: () => runtime.composition(true), onCompositionEnd: () => runtime.composition(false), onKeyDown: e => {
          if (e.nativeEvent?.isComposing || state.composing) return
          const at = candidates.findIndex(c => c.id === view.selectedId)
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const index = e.key === 'ArrowDown' ? Math.min(candidates.length - 1, at + 1) : Math.max(0, at - 1); if (candidates[index]) choose(candidates[index]) }
          if (e.key === 'Escape') runtime.updateView({ view: 'list' })
        } })),
        h('div', { role: 'listbox', 'aria-label': '证券搜索结果', className: 'ssb-results' }, ...candidates.map(item => h('button', { type: 'button', role: 'option', 'aria-selected': view.selectedId === item.id, key: item.id, className: `ssb-candidate${view.selectedId === item.id ? ' ssb-selected' : ''}`, onClick: () => choose(item) }, h('strong', null, item.officialName), h('span', { className: 'ssb-muted' }, `${item.exchange === 'XSHG' ? '沪' : '深'} ${item.code}`)))),
        !candidates.length ? h('p', { className: 'ssb-muted' }, view.query ? '暂无匹配。目录未同步时，请先到设置配置并同步目录。' : '先选择证券，再确认添加。') : null,
        state.errorCode === 'CATALOG_NOT_READY' ? h('div', { className: 'ssb-banner' }, '目录未就绪。可以直接浏览市场添加自选。', h(Button, { onClick: () => runtime.updateView({ view: 'browse' }) }, '前往浏览市场')) : null,
        h('div', { className: 'ssb-toolbar' }, h(Button, { primary: true, disabled: !view.selectedId || !!data?.control.watchlist.items[view.selectedId] || state.busy.write, onClick: quiet(async () => { await runtime.mutate('add', { securityId: view.selectedId }); runtime.updateView({ view: 'list', selectedId: null }) }) }, data?.control.watchlist.items[view.selectedId] ? '已在自选' : '确认添加'), h(Button, { onClick: () => runtime.updateView({ view: 'list' }) }, '返回自选')))
    }
    const defaultProvider = (id, adapterId = 'tushare') => ({ id, adapterId, enabled: true, credentialEnv: adapterId === 'tushare' ? 'DSH_STOCK_TUSHARE_TOKEN' : null, quotaGroup: adapterId + '-account', budget: { requestsPerMinute: adapterId === 'tushare' ? null : 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } })
    const routeFor = (market, capability, instance) => ({ id: `${market.toLowerCase()}-${capability}`, capability, market, instrument: 'equity', primaryInstanceId: instance, fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true })
    function SettingsView({ runtime, state }) {
      const saved = state.data.control
      const draft = state.view.settingsDraft || { providers: saved.providers, routes: saved.routes, expectedRevision: saved.revision, checkIds: [], checkResults: [] }
      const configuration = { providers: draft.providers, routes: draft.routes }
      function change(next, invalidate = true) { runtime.updateView({ settingsDraft: { ...draft, ...next, ...(invalidate ? { checkIds: [], checkResults: [] } : {}) } }) }
      const providerChange = (id, patch) => change({ providers: draft.providers.map(p => p.id === id ? { ...p, ...patch } : p) })
      const field = (label, value, onChange, props = {}) => h('label', { className: 'ssb-field' }, h('span', null, label), h('input', { value: value ?? '', onChange: e => onChange(e.target.value), ...props }))
      return h('section', { className: 'ssb-settings' }, h('h2', null, '数据源与显示'), h('p', { className: 'ssb-muted' }, '凭据保留在Host环境变量中。这里仅保存变量名与数据路由。'),
        !draft.providers.length ? h('div', { className: 'ssb-banner' }, '尚未配置任何数据源。可一键启用内置免凭据公开源（延迟未知、无SLA），然后逐项检查并保存。', h(Button, { disabled: state.busy.configuration, onClick: () => change({ providers: state.data?.suggested?.providers || [], routes: state.data?.suggested?.routes || [] }) }, '启用默认数据源')) : null,
        h('div', { className: 'ssb-section-head' }, h('h3', null, '数据源实例'), h(Button, { disabled: state.busy.configuration || draft.providers.length >= 8, onClick: () => { let n = 1; while (draft.providers.some(p => p.id === `ts-${n}`)) n++; change({ providers: [...draft.providers, defaultProvider(`ts-${n}`)] }) } }, '添加实例')),
        ...draft.providers.map(p => h('fieldset', { className: 'ssb-provider', key: p.id, disabled: state.busy.configuration }, h('legend', null, p.id),
          h('div', { className: 'ssb-form-grid' },
            h('label', { className: 'ssb-field' }, h('span', null, '适配器'), h('select', { value: p.adapterId, onChange: e => { const adapterId = e.target.value, descriptor = state.data.adapters.find(a => a.adapterId === adapterId); providerChange(p.id, { adapterId, credentialEnv: descriptor?.credential === 'none' ? null : p.credentialEnv || 'DSH_STOCK_TUSHARE_TOKEN', quotaGroup: adapterId + '-account', budget: descriptor?.credential === 'none' && p.budget.requestsPerMinute === null ? { ...p.budget, requestsPerMinute: 60 } : p.budget }) } }, ...state.data.adapters.map(a => h('option', { value: a.adapterId, key: a.adapterId }, a.adapterId + (a.credential === 'none' ? '（免凭据）' : '')))),
            state.data.adapters.find(a => a.adapterId === p.adapterId)?.credential === 'none' ? h('span', { className: 'ssb-muted' }, '公开来源，无需凭据') : field('Host环境变量名', p.credentialEnv, value => providerChange(p.id, { credentialEnv: value }), { autoComplete: 'off', spellCheck: false }),
            field('共享额度组（同账号保持一致）', p.quotaGroup, value => providerChange(p.id, { quotaGroup: value })),
            field('每分钟请求上限（留空仅允许探针）', p.budget.requestsPerMinute, value => providerChange(p.id, { budget: { ...p.budget, requestsPerMinute: value ? Number(value) : null } }), { type: 'number', min: 1 }),
            field('每日请求上限（留空无限制）', p.budget.dailyRequestLimit, value => providerChange(p.id, { budget: { ...p.budget, dailyRequestLimit: value ? Number(value) : null } }), { type: 'number', min: 1 }),
            h('label', { className: 'ssb-field' }, h('span', null, '计费单位'), h('select', { value: p.budget.billingUnit, onChange: e => providerChange(p.id, { budget: { ...p.budget, billingUnit: e.target.value } }) }, h('option', { value: 'request' }, '请求'), h('option', { value: 'symbol' }, '证券'))),
            p.budget.billingUnit === 'symbol' ? field('每分钟证券额度', p.budget.symbolCreditsPerMinute, value => providerChange(p.id, { budget: { ...p.budget, symbolCreditsPerMinute: value ? Number(value) : null } }), { type: 'number', min: 1 }) : null,
            ...['quotes', 'catalog', 'search', 'calendar'].map(cap => field(`${({ quotes: '报价', catalog: '目录', search: '搜索', calendar: '日历' })[cap]}每分钟上限`, p.budget.capabilityLimits[cap] ?? '', value => providerChange(p.id, { budget: { ...p.budget, capabilityLimits: Object.fromEntries(Object.entries({ ...p.budget.capabilityLimits, [cap]: value ? Number(value) : null }).filter(([, limit]) => limit !== null)) } }), { type: 'number', min: 1, key: cap }))),
          h('div', { className: 'ssb-toolbar' }, h(Toggle, { label: '启用实例', checked: p.enabled, onChange: value => providerChange(p.id, { enabled: value }) }), h('span', { className: 'ssb-muted' }, state.data.adapters.find(a => a.adapterId === p.adapterId)?.credential === 'none' ? '公开来源 · 延迟未知 · 无SLA' : state.data.providerStatus?.find(s => s.id === p.id)?.credentialPresent ? 'Host已配置变量' : '保存前检查Host凭据'), h(Button, { danger: true, onClick: () => change({ providers: draft.providers.filter(other => other.id !== p.id), routes: draft.routes.filter(r => r.primaryInstanceId !== p.id).map(r => ({ ...r, fallbackInstanceIds: r.fallbackInstanceIds.filter(id => id !== p.id), failoverMode: r.fallbackInstanceIds.includes(p.id) ? 'off' : r.failoverMode })) }) }, '移除实例')))),
        h('h3', null, '按市场与能力选择来源'), h('p', { className: 'ssb-muted' }, '目录、报价与日历可独立选择。未配置的能力不会隐式使用其他来源。'),
        ...['XSHG', 'XSHE'].map(market => h('fieldset', { className: 'ssb-provider', key: market, disabled: state.busy.configuration }, h('legend', null, market === 'XSHG' ? '上海A股' : '深圳A股'),
          ...['catalog', 'search', 'quotes', 'calendar'].map(cap => {
            const route = draft.routes.find(r => r.market === market && r.capability === cap)
            const updateRoute = patch => change({ routes: draft.routes.map(r => r === route ? { ...r, ...patch } : r) })
            const options = [h('option', { value: '', key: '' }, '未配置'), ...draft.providers.filter(p => p.enabled && state.data.adapters.find(a => a.adapterId === p.adapterId)?.capabilities.includes(cap)).map(p => h('option', { value: p.id, key: p.id }, p.id))]
            return h('div', { className: 'ssb-route', key: cap }, h('label', { className: 'ssb-field' }, h('span', null, ({ quotes: '报价', catalog: '证券目录', search: '远程搜索（可选）', calendar: '交易日历' })[cap]), h('select', { value: route?.primaryInstanceId || '', onChange: e => change({ routes: [...draft.routes.filter(r => r !== route), ...(e.target.value ? [routeFor(market, cap, e.target.value)] : [])] }) }, ...options)),
              cap === 'quotes' && route ? h('div', { className: 'ssb-route-options' }, h('label', { className: 'ssb-field' }, h('span', null, '备用报价源'), h('select', { value: route.fallbackInstanceIds[0] || '', onChange: e => updateRoute({ fallbackInstanceIds: e.target.value ? [e.target.value] : [], failoverMode: 'off' }) }, ...options.filter(o => o.props.value !== route.primaryInstanceId))), h(Toggle, { label: route.fallbackInstanceIds.length ? '网络连续失败自动切换' : '配置兼容备用源后可启用自动切换', disabled: !route.fallbackInstanceIds.length, checked: route.failoverMode === 'network', onChange: on => updateRoute({ failoverMode: on ? 'network' : 'off' }) }), h(Toggle, { label: '接受延迟未知', checked: route.acceptUnknownDelay, onChange: on => updateRoute({ acceptUnknownDelay: on }) }), field('最大延迟秒数（留空无限制）', route.maxDelaySeconds, value => updateRoute({ maxDelaySeconds: value ? Number(value) : null }), { type: 'number', min: 0 })) : null)
          }))),
        h('div', { className: 'ssb-toolbar' },
          h(Button, { disabled: state.busy.configuration || state.busy.check || !draft.routes.length, onClick: quiet(async () => { const result = await runtime.check({ ...configuration, capabilities: [...new Set(draft.routes.map(r => r.capability))] }); const current = runtime.getSnapshot().view.settingsDraft; if (current && JSON.stringify({ providers: current.providers, routes: current.routes }) !== JSON.stringify(configuration)) return; change({ expectedRevision: runtime.getSnapshot().data.control.revision, checkIds: [...draft.checkIds, result.checkId], checkResults: result.checks }, false) }) }, state.busy.check ? '正在逐项检查…' : '检查所有来源能力'),
          h(Button, { primary: true, disabled: state.busy.configuration || state.busy.check || !draft.checkIds.length && draft.providers.some(p => p.enabled), onClick: quiet(() => runtime.configuration(configuration, draft.checkIds)) }, '保存配置'),
          h(Button, { disabled: state.busy.check || state.busy.configuration, onClick: () => runtime.updateView({ settingsDraft: null }) }, '放弃草稿')),
        h('div', { 'aria-live': 'polite' }, ...draft.checkResults.map((r, index) => h('p', { key: `${r.key}-${index}`, className: 'ssb-muted' }, `${r.providerInstanceId} / ${r.market} / ${r.capability}：${r.status === 'ready' ? '就绪' : r.error?.message || '不可用'}`))),
        h('h3', null, '目录与日历'), h('div', { className: 'ssb-toolbar' }, ...['XSHG', 'XSHE'].map(market => h(Button, { key: market, disabled: state.busy.sync, onClick: quiet(async () => { const results = await runtime.sync(market); const errors = results.filter(r => !r.ok); if (errors.length) tools.toast?.show(errors.map(r => r.error.message).join('；'), { kind: 'error' }) }) }, `同步${market === 'XSHG' ? '上海' : '深圳'}目录 / 日历`))),
        ...state.data.catalogs.map(c => h('p', { key: c.source, className: 'ssb-muted' }, `${c.source} · ${timeText(c.fetchedAt)}${c.stale ? ' · 已过期' : ''}${c.complete ? '' : ' · 目录可能不完整'}`)),
        ...Object.entries(state.data.routeSelections).filter(([id, selected]) => selected.providerInstanceId !== saved.routes.find(r => r.id === id)?.primaryInstanceId).map(([id, selected]) => h('div', { className: 'ssb-banner', key: id }, `${id}当前使用备用源 ${selected.providerInstanceId}。`, h(Button, { disabled: state.busy.switch, onClick: quiet(() => runtime.switchPrimary(id)) }, '检查并切回主源'))),
        h('h3', null, '显示偏好'), h('div', { className: 'ssb-toolbar' }, h('label', { className: 'ssb-field' }, h('span', null, '刷新间隔'), h('select', { value: saved.preferences.refreshSeconds, disabled: state.busy.write || state.busy.configuration, onChange: quiet(e => runtime.preferences({ refreshSeconds: Number(e.target.value) })) }, ...[15, 30, 60].map(n => h('option', { key: n, value: n }, `${n}秒`)))), h('label', { className: 'ssb-field' }, h('span', null, '涨跌颜色'), h('select', { value: saved.preferences.colorMode, disabled: state.busy.write || state.busy.configuration, onChange: quiet(e => runtime.preferences({ colorMode: e.target.value })) }, h('option', { value: 'red-up' }, '红涨绿跌'), h('option', { value: 'green-up' }, '绿涨红跌')))),
        h(Button, { onClick: () => runtime.updateView({ view: 'list' }) }, '返回自选')))
    }
    const CSS = `
.ssb-root { --ssb-accent:var(--dsw-alias-brand-primary); --ssb-accent-deep:var(--dsw-alias-button-primary-hover); --ssb-on-accent:var(--dsw-alias-label-primary-inverted); --ssb-accent-wash:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent); --ssb-ok:var(--dsw-alias-state-success-primary); --ssb-warn:var(--dsw-alias-state-warn-primary); --ssb-danger:var(--dsw-alias-state-error-primary); --ssb-bg:var(--dsw-alias-bg-layer-1); --ssb-bg-sub:var(--dsw-alias-bg-layer-2); --ssb-bg-muted:var(--dsw-alias-bg-module-platform); --ssb-border:var(--dsw-alias-border-l2); --ssb-text:var(--dsw-alias-label-primary); --ssb-text-sub:var(--dsw-alias-label-secondary); --ssb-text-dim:var(--dsw-alias-label-tertiary); --ssb-radius-sm:6px; --ssb-radius-md:8px; --ssb-radius-lg:12px; height:100%; min-width:0; overflow:auto; color:var(--ssb-text); background:var(--ssb-bg); font:inherit; font-size:12px; line-height:1.5; }
.ssb-root * { box-sizing:border-box; }
.ssb-page { max-width:1200px; margin:0 auto; padding:24px; }
.ssb-root h1 { margin:0; font-size:20px; line-height:1.3; }.ssb-root h2 { margin:0; font-size:16px; line-height:1.3; }.ssb-root h3 { margin:24px 0 12px; font-size:14px; }
.ssb-header,.ssb-toolbar,.ssb-section-head,.ssb-row-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }.ssb-header { justify-content:space-between; margin-bottom:24px; }.ssb-header p { margin:6px 0 0; }.ssb-section-head { justify-content:space-between; padding:16px; }.ssb-toolbar { margin:12px 0; }
.ssb-button { color:var(--ssb-text); background:transparent; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); min-height:28px; padding:4px 12px; font:inherit; cursor:pointer; transition:background .15s; }.ssb-button:hover { background:var(--dsw-alias-interactive-bg-hover); }.ssb-button.ssb-primary { background:var(--ssb-accent); color:var(--ssb-on-accent); border-color:var(--ssb-accent); }.ssb-button.ssb-primary:hover { background:var(--ssb-accent-deep); }.ssb-button.ssb-danger { color:var(--ssb-danger); }.ssb-root button:disabled { opacity:.5; cursor:not-allowed; }.ssb-root :focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }
.ssb-root input:not([type=checkbox]),.ssb-root select { background:var(--ssb-bg); color:var(--ssb-text); border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); min-height:32px; padding:6px 8px; font:inherit; max-width:100%; }.ssb-field { display:flex; flex-direction:column; gap:6px; min-width:0; }.ssb-muted { color:var(--ssb-text-sub); }.ssb-code,.ssb-source { display:block; font-size:11px; }.ssb-code,.ssb-number { font-family:var(--ds-font-family-code); font-variant-numeric:tabular-nums; }.ssb-code { color:var(--ssb-text-sub); margin-top:4px; }.ssb-small { font-size:13px; margin-left:12px; }
.ssb-content { display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:16px; }.ssb-list-pane,.ssb-detail { border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-md); min-width:0; }.ssb-detail { padding:16px; background:var(--ssb-bg-sub); }.ssb-detail .ssb-section-head { padding:0; }.ssb-detail-price { font-size:28px; margin:20px 0 4px; }.ssb-table-scroll { max-height:65vh; overflow:auto; border-radius:0 0 var(--ssb-radius-md) var(--ssb-radius-md); }.ssb-table { width:100%; border-collapse:collapse; table-layout:auto; }.ssb-table th { color:var(--ssb-text-sub); font-weight:400; font-size:11px; background:var(--ssb-bg-sub); position:sticky; top:0; z-index:1; }.ssb-table td,.ssb-table th { padding:10px 12px; text-align:left; border-top:1px solid var(--ssb-border); }.ssb-table td.ssb-number { text-align:right; white-space:nowrap; }.ssb-table tr:hover { background:var(--dsw-alias-interactive-bg-hover); }.ssb-selected { background:var(--ssb-accent-wash); }.ssb-stock-name { font:inherit; color:inherit; background:transparent; border:0; padding:0; text-align:left; cursor:pointer; }.ssb-stale td.ssb-number { opacity:.65; }.ssb-up { color:var(--ssb-danger); }.ssb-down { color:var(--ssb-ok); }.ssb-green-up .ssb-up { color:var(--ssb-ok); }.ssb-green-up .ssb-down { color:var(--ssb-danger); }
.ssb-facts { display:grid; grid-template-columns:1fr 1fr; gap:8px; border-top:1px solid var(--ssb-border); padding-top:16px; margin-top:16px; }.ssb-facts dt { color:var(--ssb-text-sub); }.ssb-facts dd { margin:0; text-align:right; overflow-wrap:anywhere; font-family:var(--ds-font-family-code); }.ssb-alias-form { display:grid; gap:8px; margin-top:20px; }.ssb-alias-form label { display:grid; gap:8px; }
.ssb-empty { padding:32px 16px; color:var(--ssb-text-sub); text-align:center; }.ssb-banner { border:1px solid var(--ssb-border); border-left:3px solid var(--ssb-warn); border-radius:var(--ssb-radius-sm); padding:12px; margin:12px 0; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }.ssb-error { border-left-color:var(--ssb-danger); }.ssb-banner p { margin:0; }.ssb-search-view { max-width:720px; }.ssb-search-label { display:grid; gap:8px; margin-top:20px; }.ssb-results { display:grid; gap:8px; margin:16px 0; }.ssb-candidate { padding:12px; display:flex; justify-content:space-between; gap:12px; background:transparent; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); color:var(--ssb-text); font:inherit; cursor:pointer; }.ssb-candidate.ssb-selected { background:var(--ssb-accent-wash); border-color:var(--ssb-accent); }.ssb-provider { border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-md); padding:16px; margin:12px 0; min-width:0; }.ssb-provider legend { padding:0 6px; color:var(--ssb-text-sub); }.ssb-form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }.ssb-route { padding:12px 0; border-bottom:1px solid var(--ssb-border); }.ssb-route:last-child { border:0; }.ssb-route-options { display:flex; flex-wrap:wrap; gap:16px; align-items:center; margin-top:12px; }
.ssb-switch { display:inline-flex; align-items:center; gap:8px; cursor:pointer; position:relative; }.ssb-switch input[type="checkbox"] { position:absolute; opacity:0; width:1px; height:1px; }.ssb-switch__track { display:inline-flex; flex-shrink:0; align-items:center; width:34px; height:19px; padding:3px; border-radius:999px; background:var(--ssb-bg-muted); border:1px solid var(--ssb-border); transition:background .15s ease; }.ssb-switch__thumb { width:13px; height:13px; border-radius:50%; background:var(--ssb-text-sub); transition:transform .15s ease; }.ssb-switch input[type="checkbox"]:checked + .ssb-switch__track { background:var(--ssb-accent); }.ssb-switch input[type="checkbox"]:checked + .ssb-switch__track .ssb-switch__thumb { transform:translateX(13px); background:var(--ssb-bg); }.ssb-switch input[type="checkbox"]:focus-visible + .ssb-switch__track { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }.ssb-switch input[type="checkbox"]:disabled + .ssb-switch__track { opacity:.5; cursor:not-allowed; }.ssb-switch:hover .ssb-switch__track { border-color:var(--ssb-accent); }.ssb-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }.ssb-mobile-back { display:none; }
@media(max-width:959px) { .ssb-content { grid-template-columns:minmax(0,1fr); }.ssb-content:not(.ssb-view-detail) .ssb-detail { display:none; }.ssb-view-detail .ssb-list-pane { display:none; }.ssb-mobile-back { display:inline-block; }.ssb-page { padding:16px; } }
@media(max-width:479px) { .ssb-page { padding:12px; }.ssb-header { align-items:flex-start; gap:12px; }.ssb-aux { display:none; }.ssb-table td,.ssb-table th { padding:8px; }.ssb-form-grid { grid-template-columns:minmax(0,1fr); }.ssb-detail-price { font-size:24px; }.ssb-button { min-height:36px; }.ssb-section-head { padding:12px; } }
@media(prefers-reduced-motion:reduce) { .ssb-root * { transition:none; } }
`
    function StockPage({ runtime, layout }) {
      const state = React.useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot), { data, view } = state
      const root = React.useRef(null)
      React.useEffect(() => {
        const node = view.view === 'search' ? root.current?.querySelector('input[type="search"]') : view.view === 'list' && view.focusId ? [...(root.current?.querySelectorAll('.ssb-stock-name') || [])].find(n => n.dataset.securityId === view.focusId) : root.current?.querySelector('h2')
        if (node?.tagName === 'H2') node.setAttribute('tabindex', '-1'); node?.focus({ preventScroll: true })
      }, [view.view])
      return h('div', { className: `ssb-root${data?.control.preferences.colorMode === 'green-up' ? ' ssb-green-up' : ''}`, ref: root },
        React.createElement('style', { 'data-plugin': '@mzzsfy/dsh-stock-sidebar', dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'ssb-page' }, h('header', { className: 'ssb-header' }, h('div', null, h('h1', null, '股票'), h('p', { className: 'ssb-muted' }, '自选行情 · 沪深A股')), h('nav', { className: 'ssb-toolbar', 'aria-label': '股票工具操作' },
          h(Button, { onClick: () => runtime.updateView({ view: 'search' }) }, '添加自选'), h(Button, { onClick: () => { runtime.updateView({ view: 'browse' }); if (!runtime.getSnapshot().view.browseRows) quiet(() => runtime.loadBrowse('XSHG', 0))() } }, '浏览市场'), h(Button, { disabled: !data || state.busy.refresh, onClick: quiet(runtime.refresh) }, state.busy.refresh ? '刷新中…' : '刷新'), h(Toggle, { label: '暂停采集', checked: state.paused, onChange: runtime.setPaused }), h(Button, { onClick: () => runtime.updateView({ view: 'settings' }) }, '设置'), h(Button, { onClick: () => layout.selectPanel(null) }, '返回对话'))),
          state.error ? h('div', { className: 'ssb-banner ssb-error', role: 'alert' }, state.error, h(Button, { onClick: () => runtime.updateView({ view: 'settings' }) }, '检查设置')) : null,
          data?.ensureError ? h('div', { className: 'ssb-banner', role: 'status' }, `后台目录同步失败：${data.ensureError.message}。可在设置中手动同步。`, h(Button, { onClick: () => runtime.updateView({ view: 'settings' }) }, '前往设置')) : null,
          state.paused ? h('div', { className: 'ssb-banner', role: 'status' }, '自动采集已暂停，保留当前行情。', h(Button, { onClick: () => runtime.setPaused(false) }, '恢复采集')) : null,
          state.undo && state.undo.until > Date.now() ? h('div', { className: 'ssb-banner', role: 'status' }, '已移除自选。', h(Button, { disabled: state.busy.write, onClick: quiet(() => runtime.mutate('restore', { removeOperationId: state.undo.removeOperationId })) }, '撤销')) : null,
          !data ? h('div', { className: 'ssb-empty', role: 'status' }, '正在加载股票工具…') : view.view === 'search' ? h(SearchView, { runtime, state }) : view.view === 'browse' ? h(BrowseView, { runtime, state }) : view.view === 'settings' ? h(SettingsView, { runtime, state }) : h('div', { className: `ssb-content ssb-view-${view.view}` }, h(Watchlist, { runtime, state }), h(Detail, { runtime, state })),
          h('p', { className: 'ssb-muted' }, '价格与涨跌来自同一数据源。延迟未知表示来源未明确承诺时效。')))
    }
    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        if (!ctx.slots?.inject || !ctx.layout?.panelInfo?.subscribe) return
        const bus = tools.setupCommonTools(ctx)
        const runtime = createPageRuntime({ layout: ctx.layout, bus, tools })
        ctx.effect(() => () => runtime.dispose(), 'stock-sidebar page runtime')
        ctx.effect(() => {
          const disposers = [
            ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(StockPage, { runtime, layout: ctx.layout }))),
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, label: '股票' }, props => h(PanelIcon, props))),
          ]
          return () => { for (const stop of disposers.reverse()) stop() }
        }, 'stock-sidebar main panel')
      },
      __testing: { createPageRuntime, StockPage },
    }
  },
})
