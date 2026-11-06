window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-stock-assistant',
  factory(require) {
    const PANEL_ID = 'stock-assistant', BASE = '/api/stock-assistant', BROWSE_PAGE = 50
    // 一键全能力自举: 启用实例的适配器能力声明(capabilities×markets)是唯一事实源, 缺什么补什么
    const CAP_ORDER = ['quotes', 'kline', 'catalog', 'search', 'calendar']
    const bootstrapRoutes = ({ adapters, providers, routes }) => {
      const enabled = providers.filter(p => p.enabled)
      if (!enabled.length) return routes
      const out = [...routes]
      const capabilities = [...new Set(enabled.flatMap(p => adapters.find(a => a.adapterId === p.adapterId)?.capabilities || []))]
      const markets = [...new Set(enabled.flatMap(p => adapters.find(a => a.adapterId === p.adapterId)?.markets || []))]
      for (const market of markets) for (const capability of CAP_ORDER.filter(c => capabilities.includes(c))) {
        if (capability === 'calendar' && !['XSHG', 'XSHE'].includes(market)) continue
        if (out.some(r => r.market === market && r.capability === capability)) continue
        const supporters = enabled.filter(p => { const d = adapters.find(a => a.adapterId === p.adapterId); return d?.capabilities.includes(capability) && d?.markets.includes(market) }).sort((a, b) => (adapters.find(x => x.adapterId === a.adapterId)?.capabilities || []).length - (adapters.find(x => x.adapterId === b.adapterId)?.capabilities || []).length)
        if (!supporters.length) continue
        const marketRoute = out.find(r => r.market === market)
        const minCaps = (adapters.find(x => x.adapterId === supporters[0].adapterId)?.capabilities || []).length
        const preferred = supporters.find(p => p.id === marketRoute?.primaryInstanceId && (adapters.find(x => x.adapterId === p.adapterId)?.capabilities || []).length === minCaps)
        const primary = preferred || supporters[0]
        // 只有报价与K线支持备用源(schema 约束), 其余能力恒单源不切换
        const failover = ['quotes', 'kline'].includes(capability)
        const fallbacks = failover ? supporters.filter(p => p.id !== primary.id).map(p => p.id).slice(0, 1) : []
        out.push({ id: `${market.toLowerCase()}-${capability}`, capability, market, instrument: 'equity', primaryInstanceId: primary.id, fallbackInstanceIds: fallbacks, failoverMode: failover && fallbacks.length ? 'network' : 'off', maxDelaySeconds: null, acceptUnknownDelay: true })
      }
      return out
    }
    // 探针失败按目标粒度剔除: 主源不可用提升首个可用备源, 备源不可用仅移除该备源, 全部目标不可用才删路由。
    // 适配器声明的能力矩阵是粗粒度笛卡尔积(如腾讯声明 kline 含美股但实际不支持), 整条剔除会连带丢掉可用备源。
    const pruneDeniedTargets = (routes, deniedKeys) => routes.map(route => {
      const target = id => `${id}:${route.capability}:${route.market}`
      const alive = [route.primaryInstanceId, ...route.fallbackInstanceIds].filter(id => !deniedKeys.has(target(id)))
      if (!alive.length) return null
      return { ...route, primaryInstanceId: alive[0], fallbackInstanceIds: alive.slice(1, 2), failoverMode: alive.length > 1 ? route.failoverMode : 'off' }
    }).filter(Boolean)
    const BROWSE_MARKETS = { XSHG: '沪 A', XSHE: '深 A', XHKG: '港股', XNAS: '纳斯达克', XNYS: '纽交所', XJPX: '日本', XKRX: '韩国', XLON: '英国' }
    function createPageRuntime({ layout, bus, tools, document: doc = document, fetch: request = fetch }) {
      let disposed = false, generation = 0, demandGeneration = 0, pageId = crypto.randomUUID(), timer, heartbeat, undoTimer, queryGeneration = 0, querying, composing = false
      const subscribers = new Set(), retiredEpochs = new Set(), requests = new Set()
      let state = { view: { view: 'list', query: '', selectedId: null, detailId: null, sort: 'manual', focusId: null, keyboardNavigating: false, frozenOrder: null, settingsDraft: null, scrollTop: 0, menuId: null, alias: '', browseMarket: 'XSHG', browseRows: null, browseTotal: 0, browseOffset: 0, notice: '', browsePeek: {} }, data: null, paused: false, error: '', errorCode: '', busy: {}, candidates: [], composing: false, undo: null }
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
        const timeout = setTimeout(() => controller.abort(), path === '/provider-check' ? 61000 : path === '/catalog-sync' ? 121000 : 11000)
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
      // 离开 detail 视图时统一清详情态, 防止列表视图残留 detail 面板
      function updateView(next) { const leaveDetail = next.view && next.view !== 'detail' && !next.overlay; patch({ view: { ...state.view, ...next, ...(leaveDetail ? { detailId: null, alias: '', browsePeek: {} } : {}) } }); sendDemand() }
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
            // 首次目录后台同步中: 展示等待态, 用户稍后点市场键即拿到已同步数据
            if (result.syncing) { updateView({ browseMarket: market, browseOffset: offset, browseRows: [], browseTotal: 0, browseSyncing: true }); return }
            patch({ browseSyncing: null })
            updateView({ browseMarket: market, browseOffset: offset, browseRows: result.items, browseTotal: result.total })
            patch({ data: { ...state.data, browseOverview: result.overview || null } })
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
        refresh(securityIds) { return action('refresh', async () => { const gen = generation; const data = await api('/refresh', 'POST', { expectedRoutingRevision: state.data?.routingRevision, ...(securityIds ? { securities: securityIds } : {}) }); if (gen === generation) applySnapshot(data, true) }) },
        preferences(patchValue) { return action('write', async () => { const result = await api('/preferences', 'POST', { ...operation(), patch: patchValue }); if (state.data && state.data.control.revision <= result.revision) patch({ data: { ...state.data, control: { ...state.data.control, revision: result.revision, preferences: { ...state.data.control.preferences, ...patchValue } } } }); refresher.refresh() }) },
        configuration: configuration => action('configuration', async () => { await api('/configuration', 'POST', { ...operation(), ...configuration, expectedRevision: state.view.settingsDraft?.expectedRevision ?? state.data?.control.revision }); updateView({ settingsDraft: null }); refresher.refresh() }),
        sync: market => action('sync', async () => { const result = await api('/catalog-sync', 'POST', { market, expectedRoutingRevision: state.data?.routingRevision }); refresher.refresh(); return result }),
        check: configuration => action('check', () => api('/provider-check', 'POST', configuration)),
        switchPrimary: routeId => action('switch', async () => { const data = await api('/route-selection', 'POST', { routeId, target: 'primary', expectedRoutingRevision: state.data.routingRevision, expectedRouteEpoch: state.data.routeSelections[routeId].routeEpoch }); applySnapshot(data) }),
        setKlinePeriod(key) { patch({ klinePeriod: key }) },
        setKlineError(securityId, message, code = '') { patch({ kline: { loading: false, error: message, errorCode: code, candles: null } }) },
        // 一键K线路由: 已启用市场(verified 且 quotes 路由存在即视为启用)逐一生成 (market,'kline') 草稿;
        // 主源=该市场 quotes 主源(支持 kline 的备选优先), 备源=支持 kline 的其他启用实例;已存在 kline 路由的市场跳过。
        // 检查通过即保存: 分批探测(避开单请求预算), denied 目标剔除后整轮重查, 收敛即提交。
        // 一键启用与"应用推荐配置"共用此流程——两者的差别只是初始配置从哪来。
        async commitConfiguration({ providers, routes, notice }) {
          const CAP_LABEL = { quotes: '行情', kline: 'K线', catalog: '目录', search: '搜索', calendar: '日历' }
          await action('configuration', async () => {
            let current = routes
            let progress = ''
            // 推荐配置与一键补全自带体检: 探针不可用的目标先剔除, 保证装上的是立刻能出数的组合。
            // 这只是推荐配置的质量保证, 手动保存路由不走这条路, 也不看探针结果。
            for (let round = 0; round < 3; round++) {
              const denied = []
              for (const caps of [['quotes'], ['kline'], ['catalog', 'search']]) {
                const usedCaps = caps.filter(c => current.some(r => r.capability === c))
                if (!usedCaps.length) continue
                progress = usedCaps.map(c => CAP_LABEL[c]).join('/') + (round ? `（重查第${round + 1}轮）` : '') + '：检查中…'
                patch({ checkProgress: progress })
                const check = await api('/provider-check', 'POST', { providers, routes: current, capabilities: usedCaps })
                denied.push(...check.checks.filter(c => c.status !== 'ready').map(c => c.providerInstanceId + ':' + c.capability + ':' + c.market))
              }
              if (!denied.length) break
              current = pruneDeniedTargets(current, new Set(denied))
              if (!current.length) { patch({ error: '已启用数据源暂无可用探针，请检查网络后重试', checkProgress: null }); return }
            }
            patch({ checkProgress: null })
            await api('/configuration', 'POST', { operationId: crypto.randomUUID(), expectedRevision: state.data.control.revision, providers, routes: current })
            updateView({ view: 'list', settingsDraft: null, notice })
          }).finally(() => patch({ checkProgress: null }))
        },
        // 一键启用: 按当前草稿里已启用的实例补全缺失的市场能力路由
        async oneClickKline() {
          const saved = state.data.control
          const draft = state.view.settingsDraft || { providers: saved.providers, routes: saved.routes, expectedRevision: saved.revision, checkResults: [], probes: {} }
          const routes = bootstrapRoutes({ adapters: state.data.adapters, providers: draft.providers, routes: draft.routes })
          if (routes.length === draft.routes.length) { updateView({ view: 'list', notice: '已启用数据源的能力路由均已配置，打开证券详情即可查看行情与K线。' }); return }
          await this.commitConfiguration({ providers: draft.providers, routes, notice: `已自动启用 ${routes.length - draft.routes.length} 项能力路由（行情/K线/目录/搜索），全部市场可用。` })
        },
        // 推荐配置: 内置免凭据源 + 八市场能力一次到位, 覆盖数据源与路由, 自选与显示偏好不动
        async applyRecommended() {
          const suggested = state.data?.suggested
          if (!suggested?.providers?.length) { patch({ error: '推荐配置不可用' }); return }
          await this.commitConfiguration({ providers: suggested.providers, routes: suggested.routes, notice: '已应用推荐配置：免凭据数据源与八市场能力路由全部就绪。' })
        },
        // kline 数据流: 详情视图触发;force=true 走 ?force=1 让服务端跳缓存读;结果入 state 供 KlineView 汇合灌入。
        // 复用同一份 state 前要看它有多旧: 只比 securityId|period 会让开着的页面拿昨天的分时当实时。
        loadKline(securityId, period, force = false) {
          const key = `${securityId}|${period}`
          const sameKey = state.klineKey === key, held = sameKey ? state.kline : null
          const maxAge = KLINE_MAX_AGE[period] ?? 0
          const fresh = held?.candles && Date.now() - (held.loadedAt || 0) < maxAge
          if (fresh && !force) return Promise.resolve(held)
          patch({ klineKey: key, kline: { loading: !held?.candles, error: '', candles: held?.candles ?? null, loadedAt: held?.loadedAt } })
          const attempt = (delayMs = 0, retried = false) => new Promise(resolve => setTimeout(resolve, delayMs)).then(() => api(`/kline?${new URLSearchParams({ securityId, period, limit: String(250), ...(force ? { force: '1' } : {}) })}`, 'GET')).then(result => {
            patch({ kline: { loading: false, error: '', loadedAt: Date.now(), ...result } })
            return result
          }).catch(e => {
            // 额度窗口瞬时满/网络抖动: 退避自动重试一次; 服务端带 retryAfterMs 时按其等待, 否则 4s
            if (!retried && ['RATE_LIMIT', 'NETWORK', 'TIMEOUT'].includes(e.code)) return attempt(Math.max(4 * 1000, e.retryAfterMs || 0), true)
            patch({ kline: { loading: false, error: e.message || 'K线加载失败', errorCode: e.code, candles: null } })
            throw e
          })
          return attempt()
        },
        getKlineResult() { return state.kline?.candles ? state.kline : null },
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
    // 价格与成交额: 空值显示破折号, 成交额按万/亿缩写避免长列
    const formatPrice = value => value == null || Number.isNaN(Number(value)) ? '—' : String(value)
    const formatAmount = value => {
      // 0 与 null 都按缺失呈现: 日韩分时的成交额来源恒给 0, 显示 0 会被误读成真的没有成交
      if (value == null) return '—'
      const amount = Number(value)
      if (!Number.isFinite(amount) || amount === 0) return '—'
      if (Math.abs(amount) >= 1e8) return `${(amount / 1e8).toFixed(1)}亿`
      if (Math.abs(amount) >= 1e4) return `${(amount / 1e4).toFixed(0)}万`
      return amount.toFixed(0)
    }
    // 秒数转 1d2h3m4s: 值为 0 的段整段省略, 不留 0 占位
    const formatDuration = total => {
      const seconds = Math.max(0, Math.round(Number(total) || 0))
      let rest = seconds
      const parts = [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]
        .map(([unit, size]) => { const value = Math.floor(rest / size); rest -= value * size; return [value, unit] })
        .filter(([value]) => value > 0)
      return parts.length ? parts.map(([value, unit]) => `${value}${unit}`).join('') : '0s'
    }
    // 延迟口径: 交易中报秒差, 非交易时段报价停在收盘那刻, 报时间点而不是把收盘后的时长当延迟
    const TRADING_STATES = ['trading', 'auction']
    const delayText = quote => {
      if (!quote || quote.delayKind === 'unknown') return '未知'
      if (quote.delayKind === 'realtime') return '实时'
      // sessionState 缺失(如市场概览)时不据此推断休市, 只认 deriveDelay 给出的 closed
      const offline = quote.delayKind === 'closed' || (quote.sessionState && !TRADING_STATES.includes(quote.sessionState))
      if (offline) return `最后 ${String(timeText(quote.quoteAt)).split(' ').pop()}`
      return quote.delaySeconds == null ? '未知' : `延迟 ${formatDuration(quote.delaySeconds)}`
    }
    // 数据新鲜度: 取最旧报价的接收时间, 进入面板时用户能判断是否为缓存值
    const freshnessText = quotes => {
      const stamps = Object.values(quotes || {}).map(entry => Number(entry?.quote?.receivedAt)).filter(at => Number.isFinite(at))
      if (!stamps.length) return ''
      const age = Math.max(0, Math.round((Date.now() - Math.min(...stamps)) / 1000))
      return age < 3 ? '刚刚更新' : `${formatDuration(age)}前更新`
    }
    const MARKET_LABEL = { XSHG: '沪', XSHE: '深', XHKG: '港', XNAS: '美', XNYS: '美', XJPX: '日', XKRX: '韩', XLON: '英' }
    // 客户端 K线数据保鲜期, 与服务端 kline-cache 同量级: 分时是实时数据, 日K盘中会动, 周月K一天一换
    const KLINE_MAX_AGE = { trend: 60 * 1000, '1d': 60 * 60 * 1000, '1w': 24 * 60 * 60 * 1000, '1M': 24 * 60 * 60 * 1000 }
    // 副标题市场面: 沪深两所合并一档, 按固定优先级输出, 避免随添加顺序抖动
    const MARKET_SCOPE = { XSHG: '沪深A股', XSHE: '沪深A股', XHKG: '港股', XNAS: '美股', XNYS: '美股', XJPX: '日股', XKRX: '韩股', XLON: '英股' }
    const SCOPE_ORDER = ['沪深A股', '港股', '美股', '日股', '韩股', '英股']
    const scopeText = ids => {
      const present = new Set(ids.map(id => MARKET_SCOPE[id.split(':')[0]]).filter(Boolean))
      const listed = SCOPE_ORDER.filter(scope => present.has(scope))
      return `自选行情 · ${listed.length ? listed.join('、') : SCOPE_ORDER.join('、')}`
    }
    function Button({ children, onClick, primary, danger, className = '', ...props }) { return h('button', { type: 'button', className: `ssb-button${primary ? ' ssb-primary' : ''}${danger ? ' ssb-danger' : ''} ${className}`, onClick, ...props }, children) }
    function Toggle({ label, checked, onChange, disabled = false }) {
      return h('label', { className: 'ssb-switch' }, h('input', { type: 'checkbox', checked, disabled, onChange: e => onChange(e.target.checked) }), h('span', { className: 'ssb-switch__track' }, h('span', { className: 'ssb-switch__thumb' })), h('span', null, label))
    }
    function QuoteStatus({ entry, short = false }) {
      const quote = entry?.quote
      const detail = (quote ? `${quote.providerInstanceId} · ${quote.delayKind === 'unknown' ? '延迟未知' : delayText(quote)}` : '等待报价') + (entry?.lastError?.message ? ` · ${entry.lastError.message}` : '')
      // short: 列表行只给状态点, 语义与原因收进 title, 文字列让位给数据
      if (short) {
        const health = entry?.health || 'ok'
        const tone = health === 'ok' ? '' : health === 'unconfigured' ? ' ssb-dot-idle' : health === 'error' ? ' ssb-dot-danger' : ' ssb-dot-warn'
        const label = ({ limited: '额度受限', error: '请求失败', 'no-data': '暂无报价', unconfigured: '未配置来源' })[health] || health
        return h('span', { className: `ssb-dot ssb-col-status${tone}`, role: 'img', 'aria-label': health === 'ok' ? `${detail}，正常` : `${label}，${detail}`, title: health === 'ok' ? detail : `${label} · ${detail}` })
      }
      // 详情页只给来源名: 延迟与获取时间已在事实表里逐行列出, 这里重复会把抽屉头部撑长
      return h('span', { className: 'ssb-muted ssb-source', title: detail }, entry?.health && entry.health !== 'ok' ? `${({ limited: '额度受限', error: '请求失败', 'no-data': '暂无报价', unconfigured: '未配置来源' })[entry.health] || entry.health} · ` : '', quote ? quote.providerInstanceId : '等待报价')
    }
    // 拖拽落位: 返回新的完整顺序; 折叠隐藏项按原槽位回填, 保证提交的是全量 order
    function dragOrder(sequence, order, from, over, after) {
      const visible = sequence.filter(id => id !== from)
      const at = visible.indexOf(over)
      if (at < 0) return null
      visible.splice(at + (after ? 1 : 0), 0, from)
      const merged = []
      let index = 0
      for (const id of order) merged.push(sequence.includes(id) ? visible[index++] : id)
      return merged
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
      function open(id) { runtime.updateView({ detailId: id, selectedId: id, overlay: 'detail', focusId: id, keyboardNavigating: false, menuId: null, alias: w.items[id].alias || '', costDraft: null, groupDraft: null, costError: null, groupError: null }) }
      // 概览横幅: 仅异常态显示(健康态运维摘要收进「更多」菜单), Leek-Fund 模式=主页纯列表
      const unhealthy = (state.data.providerStatus || []).filter(s => { const log = s.recentRequests || []; return log.length && log[0].status !== 'ok' })
      const providers = state.data.control.providers || []
      const sourcesBanner = unhealthy.length || providers.some(p => !p.enabled) ? h('div', { className: 'ssb-banner' }, `${providers.filter(p => p.enabled).length}/${providers.length} 个数据源启用${unhealthy.length ? `，${unhealthy.map(s => s.id).join('、')} 最近请求失败` : ''}`, h(Button, { onClick: () => runtime.updateView({ view: 'list', overlay: 'settings' }) }, '查看')) : null
      // 组合概览并入节头(不占独立横幅带)。不做涨跌额求和: 各市场币种不同且无仓位数量, 相加没有意义
      const stats = w.order.length ? w.order.reduce((acc, id) => { const pct = Number(data.quotes[id]?.quote?.changePct); if (Number.isNaN(pct)) return acc; acc.up += pct > 0; acc.down += pct < 0; const item = w.items[id], last = Number(data.quotes[id]?.quote?.last); if (item.cost && last) { acc.held += 1; acc.pl += (last - item.cost) / item.cost * 100 } return acc }, { up: 0, down: 0, held: 0, pl: 0 }) : null
      // 持仓合计为等权均值(无仓位数量数据, 百分比求和会随只数放大; 均值是最不坏近似)
      const heldText = stats?.held ? ` · 持仓盈亏 ${signed(Number((stats.pl / stats.held).toFixed(1)))}%（等权）` : ''
      return h('section', { className: 'ssb-list-pane' },
        sourcesBanner,
        h('div', { className: 'ssb-section-head' }, h('h2', null, `自选 · ${w.order.length}`), stats ? h('span', { className: 'ssb-muted' }, `${w.order.length} 只 · ${stats.up} 涨 ${stats.down} 跌${heldText}${freshnessText(data.quotes) ? ` · ${freshnessText(data.quotes)}` : ''}`) : null, h('label', null, h('span', { className: 'ssb-sr' }, '自选排序'), h('select', { value: view.sort, onChange: e => runtime.updateView({ sort: e.target.value }) }, h('option', { value: 'manual' }, '手动顺序'), h('option', { value: 'desc' }, '涨幅优先'), h('option', { value: 'asc' }, '跌幅优先')))),
        !order.length ? h('div', { className: 'ssb-empty' }, h('p', null, '添加第一只自选，集中查看价格和来源。'), h(Button, { primary: true, onClick: () => runtime.updateView({ view: 'search' }) }, '添加自选')) :
          h('div', { className: 'ssb-table-scroll', onScroll: e => runtime.updateView({ scrollTop: e.currentTarget.scrollTop }), ref: node => { if (node && Math.abs(node.scrollTop - (view.scrollTop || 0)) > 1) node.scrollTop = view.scrollTop || 0 } },
            // 表头: 让每列含义自解释; 窄容器整体隐藏(降级为行内键值对)
            h('div', { className: 'ssb-row-head', 'aria-hidden': true },
              h('span', { className: 'ssb-grip' }, ''),
              h('span', { className: 'ssb-col-name' }, '证券'),
              h('span', { className: 'ssb-cell-price' }, '现价'),
              h('span', { className: 'ssb-cell-pct' }, '涨跌幅'),
              h('span', { className: 'ssb-cell-change' }, '涨跌额'),
              h('span', { className: 'ssb-cell-open' }, '今开'),
              h('span', { className: 'ssb-cell-range' }, '最高/最低'),
              h('span', { className: 'ssb-cell-amount' }, '成交额'),
              h('span', { className: 'ssb-cell-amplitude' }, '振幅'),
              h('span', { className: 'ssb-cell-pl' }, '持仓盈亏'),
              h('span', { className: 'ssb-col-status' }, '')),
            h('div', { className: 'ssb-rows', role: 'list', 'aria-label': '自选列表' }, ...(() => {
                // 分组分段: 仅手动序生效(全局排序即比较语义不分区); 置顶区不进组段; 组序=首现序; 折叠组隐藏成员
                // 拖拽排序: 提交完整显示序, 折叠组隐藏项保持原槽位由 order 回填
                const sequence = []
                const laneOf = id => `${w.items[id].pinned ? 'p' : 'n'}|${w.items[id].group || ''}`
                const commitOrder = (from, over, after) => {
                  if (!from || !over || from === over || laneOf(from) !== laneOf(over)) return
                  const merged = dragOrder(sequence, order, from, over, after)
                  if (!merged) return
                  // 失败错误由 action 通道落到顶部横幅, 这里只防未处理拒绝
                  runtime.mutate('reorder', { order: merged }).catch(() => {})
                }
                const rowOf = id => {
                  const item = w.items[id], entry = data.quotes[id], q = entry?.quote
                  sequence.push(id)
                  const direction = q?.changePct == null ? '' : Number(q.changePct) > 0 ? ' ssb-up' : Number(q.changePct) < 0 ? ' ssb-down' : ''
                  const plPct = item.cost && q?.last != null ? Number((Number(q.last) - item.cost) / item.cost * 100).toFixed(1) : null
                  const amplitude = q?.high != null && q?.low != null && Number(q.previousClose) > 0 ? Number(((Number(q.high) - Number(q.low)) / Number(q.previousClose)) * 100).toFixed(1) : null
                  const dragging = view.dragId === id
                  const dropEdge = view.dropAt?.id === id ? view.dropAt.after ? ' ssb-drop-after' : ' ssb-drop-before' : ''
                  const canDrag = view.sort === 'manual' && !busy.write
                  const changeOrder = (from, over, after) => commitOrder(from, over, after)
                  return h(React.Fragment, { key: id },
                    h('div', {
                      className: `ssb-row${view.detailId === id ? ' ssb-selected' : ''}${entry?.health !== 'ok' ? ' ssb-stale' : ''}${dragging ? ' ssb-dragging' : ''}${dropEdge}${item.pinned ? ' ssb-pinned' : ''}`,
                      role: 'listitem', 'data-security-id': id, draggable: canDrag,
                      onClick: () => open(id),
                      onDragStart: e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); runtime.updateView({ dragId: id, dropAt: null }) },
                      onDragEnd: () => runtime.updateView({ dragId: null, dropAt: null }),
                      onDragOver: e => {
                        if (!view.dragId || view.dragId === id || laneOf(view.dragId) !== laneOf(id)) return
                        e.preventDefault()
                        const rect = e.currentTarget.getBoundingClientRect()
                        const after = e.clientY > rect.top + rect.height / 2
                        if (view.dropAt?.id !== id || view.dropAt.after !== after) runtime.updateView({ dropAt: { id, after } })
                      },
                      onDrop: e => { e.preventDefault(); changeOrder(view.dragId, id, view.dropAt?.after === true); runtime.updateView({ dragId: null, dropAt: null }) },
                    },
                    h('div', { className: 'ssb-row-main' },
                      h('span', { className: 'ssb-grip', 'aria-hidden': true, title: canDrag ? '拖动排序' : '切回手动顺序后可拖动' }, '⠿'),
                      h('button', { className: 'ssb-stock-name', 'data-security-id': id, onClick: () => open(id), onFocus: () => { if (view.focusId !== id) runtime.updateView({ focusId: id }) }, onBlur: e => { if (!e.relatedTarget?.closest('.ssb-stock-name')) runtime.updateView({ keyboardNavigating: false, frozenOrder: null }) }, onKeyDown: e => {
                    if (e.key === 'Escape') { runtime.updateView({ menuId: null, frozenOrder: null, keyboardNavigating: false, view: 'list' }); return }
                    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
                      // 导航序列=实际渲染 DOM 序(分段后与 order 错位), focusId 取目标行 data-security-id 保持状态同步
                      e.preventDefault(); const buttons = [...e.currentTarget.closest('.ssb-rows').querySelectorAll('.ssb-stock-name')]; const at = buttons.indexOf(e.currentTarget), next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))
                      const target = buttons[next]; runtime.updateView({ keyboardNavigating: true, frozenOrder: order, focusId: target?.dataset.securityId }); target?.focus()
                    }
                  } }, item.alias || item.officialName, h('span', { className: 'ssb-code' }, `${MARKET_LABEL[item.exchange] || item.exchange} ${item.code}`)),
                      h('span', { className: `ssb-cell-price ssb-price${direction}`, title: q?.last == null ? '等待报价' : `${item.currency} ${q.last}` }, q?.last ?? '—'),
                      q?.changePct == null ? h('span', { className: 'ssb-cell-pct ssb-muted' }, '—') : h('span', { className: `ssb-cell-pct ssb-pill${direction}` }, `${signed(q.changePct)}%`),
                      q?.change == null ? h('span', { className: 'ssb-cell-change ssb-muted' }, '—') : h('span', { className: `ssb-cell-change ssb-change${direction}` }, signed(q.change)),
                      h('span', { className: 'ssb-cell-open' }, formatPrice(q?.open)),
                      h('span', { className: 'ssb-cell-range' }, `${formatPrice(q?.high)}/${formatPrice(q?.low)}`),
                      h('span', { className: 'ssb-cell-amount' }, formatAmount(q?.amount)),
                      h('span', { className: 'ssb-cell-amplitude' }, amplitude == null ? '—' : `${amplitude}%`),
                      h('span', { className: `ssb-cell-pl${plPct == null ? '' : Number(plPct) > 0 ? ' ssb-up' : Number(plPct) < 0 ? ' ssb-down' : ''}` }, plPct == null ? '—' : `${signed(plPct)}%`),
                      h(QuoteStatus, { entry, short: true })),
                    h('div', { className: 'ssb-row-sub' },
                      h('span', { className: 'ssb-kv' }, '开', formatPrice(q?.open)),
                      h('span', { className: 'ssb-kv' }, '高', formatPrice(q?.high)),
                      h('span', { className: 'ssb-kv' }, '低', formatPrice(q?.low)),
                      h('span', { className: 'ssb-kv' }, '额', formatAmount(q?.amount)),
                      amplitude == null ? null : h('span', { className: 'ssb-kv' }, '振', `${amplitude}%`),
                      plPct == null ? null : h('span', { className: `ssb-kv ssb-kv-pl${Number(plPct) > 0 ? ' ssb-up' : Number(plPct) < 0 ? ' ssb-down' : ''}` }, '持仓', `${signed(plPct)}%`))))
                }
                // 手动序: 未分组置顶区行 + 组段(组头行含统计/重命名/解散+折叠); 全局排序: 平铺不分区
                if (view.sort !== 'manual') return order.map(rowOf)
                const grouped = order.filter(id => !w.items[id].pinned && w.items[id].group)
                const ungrouped = order.filter(id => !w.items[id].pinned && !w.items[id].group)
                const groups = [...new Set(grouped.map(id => w.items[id].group))]
                const out = order.filter(id => w.items[id].pinned).map(rowOf)
                for (const name of groups) {
                  const members = grouped.filter(id => w.items[id].group === name)
                  const gs = members.reduce((acc, id) => { const pct = Number(data.quotes[id]?.quote?.changePct); if (!Number.isNaN(pct)) { acc.up += pct > 0; acc.down += pct < 0 } return acc }, { up: 0, down: 0 })
                  const open = !view.groupCollapsed?.[name]
                  out.push(h('div', { key: 'grp-' + name, className: 'ssb-group-head' }, h('span', { className: 'ssb-group-toggle', role: 'button', tabIndex: 0, 'aria-expanded': open, 'aria-label': `${name} 分组折叠`, onClick: () => runtime.updateView({ groupCollapsed: { ...view.groupCollapsed, [name]: open } }), onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); runtime.updateView({ groupCollapsed: { ...view.groupCollapsed, [name]: open } }) } } }, open ? '▾' : '▸', ` ${name} · ${members.length} 只 · ${gs.up} 涨 ${gs.down} 跌`), h('span', { className: 'ssb-toolbar' }, h(Button, { onClick: () => { const to = prompt('重命名分组', name); if (to?.trim()) { quiet(() => runtime.mutate('groupRename', { from: name, to: to.trim() }))(); runtime.updateView({ groupCollapsed: { ...view.groupCollapsed, [to.trim()]: view.groupCollapsed?.[name], [name]: undefined } }) } } }, '重命名'), h(Button, { disabled: busy.write, onClick: () => { quiet(() => runtime.mutate('groupRemove', { group: name }))(); runtime.updateView({ groupCollapsed: { ...view.groupCollapsed, [name]: undefined } }) } }, '解散'))))
                  if (open) for (const id of members) out.push(rowOf(id))
                }
                for (const id of ungrouped) out.push(rowOf(id))
                return out
              })())))
    }    // ---- KlineView: lightweight-charts 图表视图(设计"client 详情重构"节十步数据流) ----
    const PERIODS = [{ key: 'trend', label: '分时' }, { key: '1d', label: '日K' }, { key: '1w', label: '周K' }, { key: '1M', label: '月K' }]
    const GUIDE_KEY = 'ssb-guides'
    const GUIDE_DEFAULT = { preClose: true, cost: true, highLow: false, ma: true, ema: false, boll: false, bbi: false }
    // horizontal 是横贯全图的参考位(priceLine), indicator 是跟随每根K线的序列(LineSeries)
    const GUIDE_GROUPS = [
      { title: '参考位', items: [['preClose', '昨收'], ['cost', '成本价'], ['highLow', '区间最高/最低']] },
      { title: '指标线', items: [['ma', 'MA 均线'], ['ema', 'EMA 指数均线'], ['boll', 'BOLL 布林带'], ['bbi', 'BBI 多空']] },
    ]
    const EMA_WINDOW = 12, BOLL_WINDOW = 20, BOLL_K = 2
    const VENDOR_URL = '/plugins-vendor/dsh-stock-assistant/lightweight-charts.standalone.production.js'
    const MA_WINDOWS = [5, 10, 20, 60]
    // ensureLwc: 模块级 promise 单例;script 已存在等 onload,否则注入 vendor URL;失败统一文案 reject。
    let lwcPromise = null
    function ensureLwc(document) {
      if (lwcPromise) return lwcPromise
      lwcPromise = new Promise((resolve, reject) => {
        if (window.LightweightCharts?.createChart) { resolve(window.LightweightCharts); return }
        const existing = document.querySelector('script[data-lwc]')
        if (existing) {
          existing.addEventListener('load', () => resolve(window.LightweightCharts))
          existing.addEventListener('error', () => { lwcPromise = null; reject(new Error('图表组件不可用')) })
          return
        }
        const script = document.createElement('script')
        script.dataset.lwc = '1'
        script.src = VENDOR_URL
        script.onload = () => resolve(window.LightweightCharts)
        script.onerror = () => { lwcPromise = null; reject(new Error('图表组件不可用')) }
        document.head.appendChild(script)
      })
      return lwcPromise
    }
    function readChartTheme(root, colorMode) {
      const cs = getComputedStyle(root)
      const red = cs.getPropertyValue('--ssb-danger').trim(), green = cs.getPropertyValue('--ssb-ok').trim()
      const [up, down] = colorMode === 'green-up' ? [green, red] : [red, green]
      return { background: 'transparent', textColor: cs.getPropertyValue('--ssb-text-sub').trim(), gridLine: cs.getPropertyValue('--ssb-border').trim(), crosshair: cs.getPropertyValue('--ssb-text-dim').trim(), up, down, volumeUp: up + '73', volumeDown: down + '73', MA: ['#f59e0b', '#8b5cf6', '#06b6d4', '#64748b'], EMA: '#ec4899', BOLL: ['#3b82f6', '#94a3b8'], BBI: '#10b981', cost: '#f97316' }
    }
    // 以下指标都返回等长数组(前导 null), 因为 BOLL/BBI 要按索引把多条均线对齐
    function seriesMA(candles, n) {
      const out = new Array(candles.length).fill(null)
      let sum = 0
      for (let i = 0; i < candles.length; i++) {
        sum += candles[i].close
        if (i >= n) sum -= candles[i - n].close
        if (i >= n - 1) out[i] = sum / n
      }
      return out
    }
    function seriesEMA(candles, n) {
      const out = new Array(candles.length).fill(null), k = 2 / (n + 1)
      let prev = null
      for (let i = 0; i < candles.length; i++) {
        prev = prev == null ? candles[i].close : candles[i].close * k + prev * (1 - k)
        if (i >= n - 1) out[i] = prev
      }
      return out
    }
    function seriesBoll(candles, n = 20, k = 2) {
      const mid = seriesMA(candles, n), up = new Array(candles.length).fill(null), low = new Array(candles.length).fill(null)
      for (let i = n - 1; i < candles.length; i++) {
        const slice = candles.slice(i - n + 1, i + 1).map(c => c.close)
        const variance = slice.reduce((s, x) => s + (x - mid[i]) ** 2, 0) / n
        up[i] = mid[i] + k * Math.sqrt(variance)
        low[i] = mid[i] - k * Math.sqrt(variance)
      }
      return [mid, up, low]
    }
    function seriesBBI(candles) {
      const m3 = seriesMA(candles, 3), m6 = seriesMA(candles, 6), m12 = seriesMA(candles, 12), m24 = seriesMA(candles, 24)
      return candles.map((_, i) => m3[i] == null || m6[i] == null || m12[i] == null || m24[i] == null ? null : (m3[i] + m6[i] + m12[i] + m24[i]) / 4)
    }
    const toPoints = (candles, values) => values.map((value, i) => value == null ? null : ({ time: candles[i].time, value })).filter(Boolean)
    function KlineError({ message, onRetry, guide, busyOneClick }) {
      // guide 由调用方给出动作与文案: 缺路由是一键开启, 来源不支持则是去设置换源
      return h('div', { className: 'ssb-banner ssb-error', role: 'alert' }, message, guide ? h(Button, { onClick: guide.onClick, disabled: busyOneClick }, busyOneClick ? '处理中…' : guide.label) : null, onRetry ? h(Button, { onClick: onRetry }, '重试') : null)
    }
    function KlineView({ runtime, state, item }) {
      const period = state.klinePeriod || '1d'
      const kline = state.kline || {}
      const holder = React.useRef(null), chartRef = React.useRef(null), mainRef = React.useRef(null), indicatorRef = React.useRef({}), volRef = React.useRef(null), avgRef = React.useRef(null)
      // 数据链与建图链谁先到不确定: 图还没建好时先把结果存下来, 建完再补灌, 否则先到的数据会被丢掉
      const pendingRef = React.useRef(null)
      // 参考线随每次灌数据重画, 不先移除会在同一 series 上越叠越多
      const preCloseLineRef = React.useRef(null), costLineRef = React.useRef(null), highLineRef = React.useRef(null), lowLineRef = React.useRef(null)
      function drawLine(ref, options) {
        const series = mainRef.current
        if (!series) return
        if (ref.current) { try { series.removePriceLine(ref.current) } catch { } ref.current = null }
        if (options) ref.current = series.createPriceLine(options)
      }
      const themeOf = () => readChartTheme(holder.current?.closest('.ssb-root') || document.documentElement, state.data.control.preferences.colorMode)
      // 量柱着色与 MA 灌入(日/周/月)
      // 指标线只灌开着的: 关掉时喂空数组, series 留着不重建
      function applyIndicators(candles) {
        if (!candles?.length) return
        const values = {
          ma: MA_WINDOWS.map(n => seriesMA(candles, n)),
          ema: [seriesEMA(candles, EMA_WINDOW)],
          boll: seriesBoll(candles, BOLL_WINDOW, BOLL_K),
          bbi: [seriesBBI(candles)],
        }
        for (const [key, list] of Object.entries(indicatorRef.current)) {
          list.forEach((series, index) => series.setData(guides[key] ? toPoints(candles, values[key][index]) : []))
        }
      }
      function fillCandleData(result) {
        const theme = themeOf(), candles = result.candles
        mainRef.current.setData(candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })))
        volRef.current.setData(candles.map(c => ({ time: c.time, value: c.volume ?? 0, color: c.close >= c.open ? theme.volumeUp : theme.volumeDown })))
        applyIndicators(candles)
      }
      // 分时: Area 收盘线+均价线+昨收虚线
      function fillTrendData(result) {
        // 横轴优先用来源时刻(at):按索引自造会让时间轴整体平移;缺 at 时退回当天 UTC 零点起算
        const base = Math.floor(new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime() / 1000)
        const axisTime = (c, i) => c.at ?? base + i * 60
        const points = result.candles.map((c, i) => ({ time: axisTime(c, i), value: c.close }))
        mainRef.current.setData(points)
        avgRef.current.setData(result.candles.map((c, i) => ({ time: axisTime(c, i), value: c.avg ?? c.close })))
      }
      // 分时用 Area、K线用 Candlestick, 同一 chart 上换形态就是删旧 series 建新 series;
      // 时间轴允许 Unix 秒与业务日期混用, 所以不必重建整个实例。
      function chartOptions(theme) {
        return { layout: { background: { color: theme.background }, textColor: theme.textColor }, crosshair: { mode: window.LightweightCharts.CrosshairMode.Normal }, timeScale: { timeVisible: false, borderColor: theme.gridLine }, rightPriceScale: { borderColor: theme.gridLine }, grid: { vertLines: { color: theme.gridLine }, horzLines: { color: theme.gridLine } }, autoSize: true }
      }
      const wantTrend = period === 'trend'
      const [guides, setGuides] = usePref(GUIDE_KEY, GUIDE_DEFAULT)
      // 图例: 报价要素一行、指标值一行, 数值全部集中在这里, 图面只留曲线本身
      const legend = React.useMemo(() => {
        const candles = kline?.candles || []
        if (!candles.length) return null
        const last = candles[candles.length - 1], scale = item.priceScale ?? 2
        const price = value => value == null || value === '' ? null : Number(value).toFixed(scale)
        // 日K 的 preClose 有时来源不给, 退到前一根收盘; 两者都没有才算涨跌未知
        const base = Number(kline?.preClose) || Number(candles[candles.length - 2]?.close)
        const pct = Number.isFinite(base) && base ? (Number(last.close) - base) / base * 100 : null
        const tone = pct == null ? '' : pct > 0 ? ' ssb-up' : pct < 0 ? ' ssb-down' : ''
        const quote = wantTrend
          ? [['最新', price(last.close)], ['均价', price(last.avg ?? last.close)], ['昨收', price(kline?.preClose)]]
          : [['开', price(last.open)], ['高', price(last.high)], ['低', price(last.low)], ['收', price(last.close)]]
        // 分时的 volume 是每分钟增量(实测末条远小于当日总量), 要累加; 日K 最后一根本身就是当日总量
        const volume = wantTrend ? candles.reduce((sum, candle) => sum + (Number(candle.volume) || 0), 0) : last.volume
        // 指标只列开着的, 否则图例比图还长
        const series = []
        if (!wantTrend && guides.ma) MA_WINDOWS.forEach((window, index) => series.push([`MA${window}`, seriesMA(candles, window).at(-1), ` ssb-ma-${index}`]))
        if (!wantTrend && guides.ema) series.push([`EMA${EMA_WINDOW}`, seriesEMA(candles, EMA_WINDOW).at(-1), ' ssb-ema'])
        if (!wantTrend && guides.boll) seriesBoll(candles, BOLL_WINDOW, BOLL_K).forEach((line, index) => series.push([['BOLL', 'BOLL上', 'BOLL下'][index], line.at(-1), ` ssb-boll-${index}`]))
        if (!wantTrend && guides.bbi) series.push(['BBI', seriesBBI(candles).at(-1), ' ssb-bbi'])
        return {
          quote: [...quote, ['涨跌', pct == null ? null : `${signed(pct.toFixed(2))}%`, tone], ['量', formatAmount(volume)]],
          series: series.filter(([, value]) => value != null && Number.isFinite(Number(value))),
        }
      }, [kline?.candles, kline?.preClose, wantTrend, item.priceScale, guides])
      const costPct = item.cost && kline?.candles?.length ? (() => { const last = Number(kline.candles[kline.candles.length - 1].close); return Number.isFinite(last) ? (last - item.cost) / item.cost * 100 : null })() : null
      function ensureSeries(LWC) {
        const chart = chartRef.current
        if (!chart || !LWC) return
        if (wantTrend === !!avgRef.current && mainRef.current) return
        const stale = [mainRef.current, avgRef.current, volRef.current, ...Object.values(indicatorRef.current).flat()]
        for (const s of stale) if (s) chart.removeSeries(s)
        mainRef.current = avgRef.current = volRef.current = null; indicatorRef.current = {}
        // 旧 series 上的参考线随 series 一起销毁, 引用要清掉
        preCloseLineRef.current = costLineRef.current = highLineRef.current = lowLineRef.current = null
        const theme = themeOf()
        if (wantTrend) {
          mainRef.current = chart.addSeries(LWC.AreaSeries, { topColor: theme.up + '4d', bottomColor: theme.up + '07', lineColor: theme.up, lineWidth: 1 }, 0)
          avgRef.current = chart.addSeries(LWC.LineSeries, { color: theme.MA[0], lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0)
        } else {
          mainRef.current = chart.addSeries(LWC.CandlestickSeries, { upColor: theme.up, downColor: theme.down, wickUpColor: theme.up, wickDownColor: theme.down, borderUpColor: theme.up, borderDownColor: theme.down }, 0)
          const line = color => chart.addSeries(LWC.LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0)
          indicatorRef.current = {
            ma: MA_WINDOWS.map((n, i) => line(theme.MA[i])),
            ema: [line(theme.EMA)],
            boll: [line(theme.BOLL[0]), line(theme.BOLL[1]), line(theme.BOLL[1])],
            bbi: [line(theme.BBI)],
          }
          volRef.current = chart.addSeries(LWC.HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, 1)
        }
      }
      // 数据就绪后灌入; 图表实例由 effect A 创建, series 按形态在此处切换
      function maybeFill(result) {
        if (!result) return
        if (!chartRef.current) { pendingRef.current = result; return }
        ensureSeries(window.LightweightCharts)
        if (!mainRef.current) return
        // 分时喂的是 Unix 秒, 图表默认按 UTC 渲染那一刻——港股 14:45 会被画成 06:45, 所以刻度一律按该证券
        // 所属市场的时区呈现; 日K的 time 是业务日期(字符串或 BusinessDay), 不参与时区换算, 否则会整体偏一天。
        const zone = item.timezone || 'Asia/Shanghai'
        const asDate = time => {
          if (typeof time === 'number') return new Date(time * 1000)
          if (typeof time === 'string') return new Date(`${time}T00:00:00Z`)
          if (time && typeof time === 'object' && time.year) return new Date(Date.UTC(time.year, time.month - 1, time.day))
          return null
        }
        const clock = time => { const d = asDate(time); return d ? new Intl.DateTimeFormat('zh-CN', { timeZone: zone, hour12: false, hour: '2-digit', minute: '2-digit' }).format(d) : '' }
        const dayStamp = (time, withYear) => {
          const d = asDate(time)
          if (!d) return ''
          const pad = n => String(n).padStart(2, '0')
          return `${withYear ? `${d.getUTCFullYear()}-` : ''}${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
        }
        const tickMark = (time, tickMarkType) => {
          if (wantTrend) return clock(time)
          const d = asDate(time)
          if (!d) return ''
          return tickMarkType === 0 ? String(d.getUTCFullYear()) : tickMarkType === 1 ? `${d.getUTCMonth() + 1}月` : dayStamp(time, false).slice(3)
        }
        chartRef.current.applyOptions({
          localization: { timeFormatter: wantTrend ? clock : time => dayStamp(time, true) },
          timeScale: { timeVisible: wantTrend, tickMarkFormatter: tickMark },
        })
        wantTrend ? fillTrendData(result) : fillCandleData(result)
        // 辅助线统一在这里画: 全部走 createPriceLine, 具体数值看上方图例, 图上只留参考位置
        const palette = themeOf()
        drawLine(preCloseLineRef, guides.preClose && result.preClose != null ? { price: result.preClose, color: palette.crosshair, lineStyle: 2, lineWidth: 1 } : null)
        drawLine(costLineRef, guides.cost && item.cost ? { price: item.cost, color: palette.cost, lineStyle: 3, lineWidth: 1 } : null)
        const highs = result.candles.map(c => Number(c.high)).filter(Number.isFinite), lows = result.candles.map(c => Number(c.low)).filter(Number.isFinite)
        drawLine(highLineRef, guides.highLow && highs.length ? { price: Math.max(...highs), color: palette.textColor, lineStyle: 1, lineWidth: 1, title: '区间高' } : null)
        drawLine(lowLineRef, guides.highLow && lows.length ? { price: Math.min(...lows), color: palette.textColor, lineStyle: 1, lineWidth: 1, title: '区间低' } : null)
        // 换周期后时间范围完全不同, 不重置视口会停在上一周期的区间上
        chartRef.current.timeScale().fitContent()
      }
      // effect A: 图表创建一次; 主题变更(MutationObserver)重涂; 卸载销毁。
      React.useEffect(() => {
        let dead = false, mo
        const root = holder.current?.closest('.ssb-root') || document.documentElement
        ensureLwc(document).then(LWC => {
          if (dead || !holder.current) return
          chartRef.current = LWC.createChart(holder.current, chartOptions(themeOf()))
          const early = pendingRef.current
          pendingRef.current = null
          maybeFill(early || runtime.getKlineResult(item.id, period))
        }).catch(e => runtime.setKlineError(item.id, e.message, e.code))
        mo = new MutationObserver(() => { const chart = chartRef.current; if (!chart) return; const t = themeOf(); chart.applyOptions({ layout: { background: { color: t.background }, textColor: t.textColor }, grid: { vertLines: { color: t.gridLine }, horzLines: { color: t.gridLine } } }) })
        mo.observe(root, { attributes: true, attributeFilter: ['class', 'style'] })
        return () => { dead = true; mo.disconnect(); chartRef.current?.remove(); chartRef.current = null }
      }, [])
      // 数据时间面: 首末日期 + 共几根 + 今日有没有交易。判断只用数据本身, 不猜日历——
      // 最后一根的日期就是市场时区的今天, 说明今天开过市, 否则说明今天还没有行情。
      function klineMetaText(result, trend) {
        const candles = result?.candles || []
        if (!candles.length) return ''
        const zone = item.timezone || 'Asia/Shanghai'
        const dayOf = candle => {
          const time = trend ? candle.at : candle.time
          if (typeof time === 'number') return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(time * 1000))
          return typeof time === 'string' ? time.slice(0, 10) : ''
        }
        const first = dayOf(candles[0]), last = dayOf(candles[candles.length - 1])
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date())
        const span = trend || first === last ? `${last} · ${candles.length} 根` : `${first} ~ ${last} · ${candles.length} 根`
        const todayMark = last === today ? '今日有交易' : `今日无交易（最近 ${last.slice(5)}）`
        return `${span} · ${todayMark}`
      }
      // effect B: 证券/周期变化→拉数据→图表在则灌
      React.useEffect(() => {
        let dead = false
        runtime.loadKline(item.id, period).then(result => { if (!dead) maybeFill(result) }).catch(e => { if (!dead) runtime.setKlineError(item.id, e.message, e.code) })
        return () => { dead = true }
      }, [item.id, period])
      // 成本/辅助线变化(设/改/清)不会触发数据重灌, 得自己把参考线更新掉
      React.useEffect(() => {
        if (!mainRef.current) return
        const palette = themeOf()
        drawLine(costLineRef, guides.cost && item.cost ? { price: item.cost, color: palette.cost, lineStyle: 3, lineWidth: 1 } : null)
        const candles = kline?.candles || []
        const highs = candles.map(c => Number(c.high)).filter(Number.isFinite), lows = candles.map(c => Number(c.low)).filter(Number.isFinite)
        drawLine(preCloseLineRef, guides.preClose && kline?.preClose != null ? { price: kline.preClose, color: palette.crosshair, lineStyle: 2, lineWidth: 1 } : null)
        drawLine(highLineRef, guides.highLow && highs.length ? { price: Math.max(...highs), color: palette.textColor, lineStyle: 1, lineWidth: 1, title: '区间高' } : null)
        drawLine(lowLineRef, guides.highLow && lows.length ? { price: Math.min(...lows), color: palette.textColor, lineStyle: 1, lineWidth: 1, title: '区间低' } : null)
        // 开关变化不触发数据重灌, 指标线要自己补画
        if (!wantTrend) applyIndicators(kline?.candles)
      }, [item.cost, kline.candles, guides])
      return h('div', { className: 'ssb-kline' },
        h('div', { className: 'ssb-kline-toolbar' }, h('div', { role: 'tablist', 'aria-label': 'K线周期', style: { display: 'flex', gap: '8px' } }, ...PERIODS.map(p => h(Button, { key: p.key, role: 'tab', 'aria-selected': period === p.key, primary: period === p.key, onClick: () => runtime.setKlinePeriod(p.key) }, p.label))), h(Button, { onClick: quiet(() => runtime.loadKline(item.id, period, true)) }, '↻'),
          h('div', { className: 'ssb-more', style: { position: 'relative' } }, h(Button, { 'aria-expanded': !!state.view.guideOpen, onClick: () => runtime.updateView({ guideOpen: !state.view.guideOpen }) }, '辅助线'),
            state.view.guideOpen ? h('div', { className: 'ssb-menu', style: { position: 'absolute', left: 0, top: 'calc(100% + 4px)', background: 'var(--ssb-bg)', border: '1px solid var(--ssb-border)', borderRadius: 'var(--ssb-radius-md)', padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px', zIndex: 10, minWidth: '170px' }, role: 'menu' },
              ...GUIDE_GROUPS.flatMap(group => [h('div', { key: group.title, className: 'ssb-menu-title' }, group.title), ...group.items.map(([key, label]) => h(Toggle, { key, label, checked: !!guides[key], onChange: () => setGuides({ [key]: !guides[key] }) }))])) : null),
          h('span', { className: 'ssb-kline-meta' }, klineMetaText(kline, wantTrend))),
        legend ? h('div', { className: 'ssb-kline-legend' },
          h('div', { className: 'ssb-legend-row' }, ...legend.quote.map(([label, value, tone]) => h('span', { key: label, className: `ssb-legend-item${tone || ''}` }, h('span', { className: 'ssb-legend-label' }, label), value == null ? '—' : value))),
          h('div', { className: 'ssb-legend-row' },
            ...legend.series.map(([label, value, tone]) => h('span', { key: label, className: `ssb-legend-item${tone || ''}` }, h('span', { className: 'ssb-legend-label' }, label), Number(value).toFixed(item.priceScale ?? 2))),
            item.cost ? h('span', { className: 'ssb-legend-item ssb-legend-cost' }, h('span', { className: 'ssb-legend-label' }, '成本'), formatPrice(item.cost), costPct == null ? null : h('span', { className: `ssb-legend-pct${costPct > 0 ? ' ssb-up' : costPct < 0 ? ' ssb-down' : ''}` }, `${signed(costPct.toFixed(2))}%`)) : null)) : null,
        kline.loading ? h('div', { className: 'ssb-kline-skeleton', role: 'status' }, '加载K线…') : null,
        kline.error ? h(KlineError, { message: kline.error, busyOneClick: !!state.busy.configuration, onRetry: () => quiet(() => runtime.loadKline(item.id, period, true))(), guide: kline.errorCode === 'NO_ROUTE' ? { label: '一键开启', onClick: () => quiet(async () => { await runtime.oneClickKline(); await runtime.loadKline(item.id, period, true) })() } : kline.errorCode === 'UNSUPPORTED_CAPABILITY' ? { label: '去设置换源', onClick: () => runtime.updateView({ view: 'list', overlay: 'settings' }) } : null }) : null,
        !kline.loading && !kline.error && kline.candles && !kline.candles.length ? h('div', { className: 'ssb-empty' }, h('p', null, '暂无K线数据（停牌或已退市）')) : null,
        state.data.vendorAvailable === false ? h('div', { className: 'ssb-banner' }, '图表组件不可用，已降级为数字详情。') : null,
        // 出错时隐藏画布: 图表实例挂在同一个 DOM 节点上, 卸载会丢实例, 只做可见性切换
        h('div', { ref: holder, className: 'ssb-kline-holder', style: kline.error ? { display: 'none' } : undefined }))
    }
    // 浮层原语: 遮罩+Esc/遮罩关闭, 抽屉(detail)与模态(settings)共用关闭语义
    // 浮层原语: 遮罩+Esc/遮罩关闭+焦点移入/困住/还原+背景滚动锁定, 抽屉(detail)与模态(settings)共用
    function Overlay({ runtime, state, layout }) {
      const { view } = state
      const cardRef = React.useRef(null)
      const restoreRef = React.useRef(null)
      const kind = view.overlay === 'settings' ? 'modal' : 'drawer'
      React.useEffect(() => {
        restoreRef.current = document.activeElement
        document.body.style.overflow = 'hidden'
        cardRef.current?.focus({ preventScroll: true })
        const onKey = e => {
          if (e.key === 'Escape') { runtime.updateView({ overlay: null }); return }
          if (e.key !== 'Tab' || !cardRef.current) return
          // 焦点困住: Tab 循环限制在浮层内
          const focusables = [...cardRef.current.querySelectorAll('button, input, select, a[href], [tabindex]:not([tabindex="-1"])')].filter(n => !n.disabled && n.offsetParent !== null)
          if (!focusables.length) return
          const first = focusables[0], last = focusables[focusables.length - 1]
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
        }
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.body.style.overflow = ''
          restoreRef.current?.focus?.({ preventScroll: true })
        }
      }, [])
      const close = () => runtime.updateView({ overlay: null })
      // 遮罩点击: 仅抽屉(detail)穿透——命中下层自选行则切换详情保持开启; 模态一律关闭(设置态穿透改详情是隐性突变)
      const onMaskClick = e => {
        if (e.target !== e.currentTarget) return
        const hit = kind === 'drawer' ? document.elementsFromPoint(e.clientX, e.clientY).find(n => n.classList?.contains('ssb-stock-name')) : null
        if (hit?.dataset.securityId) runtime.updateView({ detailId: hit.dataset.securityId, selectedId: hit.dataset.securityId, alias: state.data.control.watchlist.items[hit.dataset.securityId]?.alias || '', costDraft: null, groupDraft: null, costError: null, groupError: null })
        else close()
      }
      return h('div', { className: `ssb-overlay ssb-overlay-${kind}`, onClick: onMaskClick, role: 'presentation' },
        kind === 'drawer' ? h('aside', { ref: cardRef, tabIndex: -1, className: 'ssb-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '证券详情' },
          h('div', { className: 'ssb-drawer-head' }, h(Button, { onClick: close, 'aria-label': '关闭' }, '×')), h(Detail, { runtime, state }))
        : h('div', { ref: cardRef, tabIndex: -1, className: 'ssb-modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': '设置' },
          h('div', { className: 'ssb-drawer-head' }, h(Button, { onClick: close, 'aria-label': '关闭' }, '×')), h(SettingsView, { runtime, state, layout })))
    }
    function Detail({ runtime, state }) {
      const { data, view } = state
      // 详情解析链: 自选优先, browsePeek 兜底(市场浏览点进来的临时详情, 无需先加自选)
      const item = data.control.watchlist.items[view.detailId] || view.browsePeek?.[view.detailId]
      // 邻移: 自选详情在抽屉内直接切上下只(对比场景免关-点-开三步); order 为当前排序视图
      const order = data.control.watchlist.order
      const at = order.indexOf(item.id)
      const neighbor = dir => order[(at + dir + order.length) % order.length]
      const openNeighbor = id => { runtime.updateView({ detailId: id, selectedId: id, overlay: 'detail', alias: data.control.watchlist.items[id]?.alias || '', costDraft: null, groupDraft: null, costError: null, groupError: null }); runtime.loadKline(id, state.klinePeriod || '1d', true).catch(() => {}); runtime.refresh([{ id, exchange: data.control.watchlist.items[id].exchange, code: data.control.watchlist.items[id].code, officialName: data.control.watchlist.items[id].officialName }]).catch(() => {}) }
      const inWatchlist = !!data.control.watchlist.items[view.detailId]
      if (!item) return h('aside', { className: 'ssb-detail ssb-empty' }, h('p', null, '选择一只证券查看基础行情。'))
      const entry = data.quotes[item.id], q = entry?.quote
      const direction = q?.changePct == null ? '' : Number(q.changePct) > 0 ? ' ssb-up' : Number(q.changePct) < 0 ? ' ssb-down' : ''
      const marketLabel = MARKET_LABEL[item.exchange] || item.exchange
      // 币种唯一来源是自选条目 currency(watchlist 写入时由 MARKET_META 保证), client 不设回退表
      const currency = item.currency || ''
      const fields = [['今开', formatPrice(q?.open)], ['最高', formatPrice(q?.high)], ['最低', formatPrice(q?.low)], ['昨收', formatPrice(q?.previousClose)], ['涨跌额', q?.change == null ? null : signed(q.change)], ['成交量', q?.volume == null ? null : `${formatAmount(q.volume)}股`], ['成交额', formatAmount(q?.amount)], ['交易时段', ({ trading: '交易中', closed: '休市', break: '午间休市', auction: '集合竞价', preopen: '开市前', unknown: '未知' })[q?.sessionState] || '未知'], ['报价时间', timeText(q?.quoteAt)], ['获取时间', timeText(q?.receivedAt)], ['来源', q?.providerInstanceId], ['延迟', delayText(q)]]
      // 非自选详情: 加自选为主操作, 不显示别名/删除等自选管理
      const peekActions = inWatchlist ? null : h('div', { className: 'ssb-toolbar' }, h(Button, { primary: true, disabled: state.busy.write, onClick: quiet(() => runtime.mutate('add', { securityId: item.id })) }, '加自选'))
      // 成本块: 有成本显盈亏三元组, 表单可设/清成本; 非法输入就地报错不静默(B2), 草稿绑定 detailId 切换即清(B3 由三处 open 清理保证)
      const lastN = Number(q?.last)
      const costPl = item.cost && lastN ? { amount: Number((lastN - item.cost).toFixed(item.priceScale ?? 2)), pct: Number(((lastN - item.cost) / item.cost * 100).toFixed(1)) } : null
      // 没动过草稿就不写: 否则"打开详情直接点保存"会把已有成本清掉
      const costForm = inWatchlist ? h('form', { className: 'ssb-alias-form', onSubmit: e => {
        e.preventDefault()
        if (view.costDraft === null || view.costDraft === undefined) return
        const raw = String(view.costDraft).trim()
        if (!raw) { quiet(() => runtime.mutate('cost', { securityId: item.id, cost: null }))(); return }
        const num = Number(raw)
        if (!Number.isFinite(num) || num <= 0) { runtime.updateView({ costError: '成本价需为正数' }); return }
        quiet(() => runtime.mutate('cost', { securityId: item.id, cost: num }))()
      } }, h('label', null, '成本价', h('input', { value: view.costDraft ?? (item.cost ?? ''), inputMode: 'decimal', onChange: e => runtime.updateView({ costDraft: e.target.value, costError: '' }), placeholder: '留空清除' })), h('div', { style: { display: 'flex', gap: '8px' } }, h('button', { type: 'submit', className: 'ssb-button', disabled: state.busy.write }, '保存成本'), item.cost ? h(Button, { danger: true, disabled: state.busy.write, onClick: quiet(() => { runtime.updateView({ costDraft: null }); return runtime.mutate('cost', { securityId: item.id, cost: null }) }) }, '清除成本') : null), view.costError ? h('small', { className: 'ssb-muted', role: 'alert' }, view.costError) : null) : null
      // 分组表单(B1): 单标签, 空=移出分组; 草稿 view.groupDraft
      const groupForm = inWatchlist ? h('form', { className: 'ssb-alias-form', onSubmit: e => { e.preventDefault(); const raw = view.groupDraft?.trim() ?? item.group; if ([...raw].length > 12) { runtime.updateView({ groupError: '分组名最多12字' }); return } quiet(() => runtime.mutate('group', { securityIds: [item.id], group: raw }))() } }, h('label', null, '设分组', h('input', { value: view.groupDraft ?? (item.group || ''), maxLength: 12, onChange: e => runtime.updateView({ groupDraft: e.target.value, groupError: '' }), placeholder: '留空移出分组' })), h('button', { type: 'submit', className: 'ssb-button', disabled: state.busy.write }, '保存分组'), view.groupError ? h('small', { className: 'ssb-muted', role: 'alert' }, view.groupError) : null) : null
      const costBlock = costPl ? h('div', { className: `ssb-number${costPl.amount > 0 ? ' ssb-up' : costPl.amount < 0 ? ' ssb-down' : ''}` }, h('span', null, `持仓盈亏 ${signed(costPl.amount)} · ${signed(costPl.pct)}%`), h('span', { className: 'ssb-muted ssb-small' }, `成本 ${item.cost}`)) : null
      const watchActions = inWatchlist ? h(React.Fragment, null, costForm, groupForm, h('form', { className: 'ssb-alias-form', onSubmit: e => { e.preventDefault(); quiet(() => runtime.mutate('alias', { securityId: item.id, alias: view.alias }))() } }, h('label', null, '自选别名', h('input', { value: view.alias || '', maxLength: 30, onChange: e => runtime.updateView({ alias: e.target.value }), 'aria-describedby': 'ssb-alias-hint' })), h('small', { id: 'ssb-alias-hint', className: 'ssb-muted' }, '最多30个字符，留空显示正式名称'), h('button', { type: 'submit', className: 'ssb-button', disabled: state.busy.write }, '保存别名')),
        // 行内不再挂操作菜单, 排序走拖拽, 剩下的置顶与移出收敛到这里: 低频、且删除需要确认, 不适合出现在每一行
        h('div', { className: 'ssb-alias-form' }, h('span', { className: 'ssb-muted ssb-small' }, '自选管理'), h('div', { className: 'ssb-toolbar' },
          h(Button, { disabled: state.busy.write, onClick: quiet(() => runtime.mutate('pin', { securityId: item.id, pinned: !item.pinned })) }, item.pinned ? '取消置顶' : '置顶'),
          h(Button, { danger: true, disabled: state.busy.write, onClick: () => { if (!confirm(`从自选移除「${item.alias || item.officialName}」?`)) return; quiet(() => runtime.mutate('remove', { securityId: item.id }))(); runtime.updateView({ detailId: null, selectedId: null, overlay: null, focusId: null }) } }, '移出自选')))) : null
      return h('aside', { className: 'ssb-detail' }, h('div', { className: 'ssb-section-head' }, h('h2', null, item.alias || item.officialName), inWatchlist && order.length > 1 ? h('div', { className: 'ssb-toolbar' }, h(Button, { onClick: () => openNeighbor(neighbor(-1)) }, '上一只'), h(Button, { onClick: () => openNeighbor(neighbor(1)) }, '下一只')) : null),
        h('p', { className: 'ssb-muted' }, `${item.officialName} · ${marketLabel} ${item.code}${currency ? ` · ${currency}` : ''}`),
        h('div', { className: `ssb-detail-price ssb-number${direction}` }, q?.last ?? '—', h('span', { className: 'ssb-small' }, q?.changePct == null ? '—' : `${signed(q.changePct)}%`)),
        h('div', { className: 'ssb-detail-grid' },
          h('div', { className: 'ssb-detail-main' }, h(KlineView, { runtime, state, item })),
          h('div', { className: 'ssb-detail-side' }, peekActions, h(QuoteStatus, { entry }), costBlock, h('dl', { className: 'ssb-facts' }, ...fields.map(([label, value]) => h(React.Fragment, { key: label }, h('dt', null, label), h('dd', null, value ?? '—')))))),
        watchActions ? h('div', { className: 'ssb-detail-forms' }, watchActions) : null)
    }
    // 显示偏好(悬浮窗位置/辅助线开关)属于纯客户端状态: 存本地, 不进宿主 schema,
    // 否则每加一个开关都要重启宿主。同页用自定义事件广播, storage 事件只在跨标签页触发。
    const readPref = (key, fallback) => { try { return { ...fallback, ...(JSON.parse(localStorage.getItem(key) || 'null') || {}) } } catch { return { ...fallback } } }
    const writePref = (key, next) => { try { localStorage.setItem(key, JSON.stringify(next)) } catch { } window.dispatchEvent(new Event(`ssb:${key}`)) }
    function usePref(key, fallback) {
      const [value, setValue] = React.useState(() => readPref(key, fallback))
      React.useEffect(() => {
        const sync = () => setValue(readPref(key, fallback))
        window.addEventListener(`ssb:${key}`, sync)
        return () => window.removeEventListener(`ssb:${key}`, sync)
      }, [key])
      return [value, next => writePref(key, { ...readPref(key, fallback), ...next })]
    }
    // ---- FloatingTicker: 悬浮盯盘, portal 到 body 常驻, 不随面板切换卸载 ----
    const FLOAT_KEY = 'ssb-floating', FLOAT_POLL_MS = 15 * 1000
    // ids 为空时退回自选前几只, 否则第一次打开会是一张空窗
    const FLOAT_DEFAULT = { open: false, live: true, mode: 'list', ids: [], securityId: null, x: null, y: null }
    // 分时曲线自绘: 只要一条折线加填充, 不值得为它再挂一个图表实例
    function Sparkline({ candles, preClose }) {
      const values = (candles || []).map(c => Number(c.close)).filter(Number.isFinite)
      if (!values.length) return null
      const width = 264, height = 88
      const base = Number(preClose)
      const all = Number.isFinite(base) ? [...values, base] : values
      const low = Math.min(...all), high = Math.max(...all), span = high - low || 1
      const y = value => height - ((value - low) / span) * height
      const x = index => (index / Math.max(1, values.length - 1)) * width
      const line = values.map((value, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join('')
      return h('svg', { className: 'ssb-float-spark', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': '分时走势' },
        Number.isFinite(base) ? h('line', { className: 'ssb-float-base', x1: 0, x2: width, y1: y(base), y2: y(base) }) : null,
        h('path', { className: 'ssb-float-area', d: `${line}L${width},${height}L0,${height}Z` }),
        h('path', { className: 'ssb-float-line', d: line }))
    }
    function FloatingTicker({ runtime }) {
      const state = React.useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
      const [floating, setFloating] = usePref(FLOAT_KEY, FLOAT_DEFAULT)
      const [fetched, setFetched] = React.useState({})
      const [trend, setTrend] = React.useState(null)
      const [error, setError] = React.useState('')
      const [picker, setPicker] = React.useState(false)
      // hooks 必须全部在提前返回之前: 开关一旦变化, 排在后头的 useRef 会让 hooks 数量对不上
      const dragRef = React.useRef(null)
      const items = state.data?.control.watchlist.items || {}
      const order = state.data?.control.watchlist.order || []
      // 勾选的观测目标: 空则退回自选前几只, 但绝不隐式等于全部自选
      const picked = (Array.isArray(floating.ids) && floating.ids.length ? floating.ids : order.slice(0, 5)).filter(id => items[id])
      const mode = floating.mode === 'kline' ? 'kline' : 'list'
      const open = !!floating.open
      const securityId = (floating.securityId && picked.includes(floating.securityId) ? floating.securityId : picked[0]) || null
      // 列表模式一次 refresh 批量拉勾选的标的; K线模式只拉当前这只的分时
      React.useEffect(() => {
        if (!open || !picked.length || floating.live === false) return
        let dead = false
        // 页面不可见时不拉: 后台标签页继续轮询只会白耗来源额度
        const pull = () => {
          if (document.visibilityState !== 'visible') return
          if (mode === 'list') {
            const securities = picked.map(id => ({ id, exchange: items[id].exchange, code: items[id].code }))
            fetch(`${BASE}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: crypto.randomUUID(), expectedRevision: state.data?.control.revision ?? 0, securities }) })
              .then(response => response.json())
              .then(payload => { if (dead) return; if (payload.ok) { setFetched(payload.data.quotes || {}); setError('') } else setError(payload.error?.message || '行情不可用') })
              .catch(() => { if (!dead) setError('行情不可用') })
          } else if (securityId) {
            fetch(`${BASE}/kline?${new URLSearchParams({ securityId, period: 'trend', limit: '250' })}`)
              .then(response => response.json())
              .then(payload => { if (dead) return; if (payload.ok) { setTrend(payload.data); setError('') } else setError(payload.error?.message || '行情不可用') })
              .catch(() => { if (!dead) setError('行情不可用') })
          }
        }
        pull()
        const timer = setInterval(pull, FLOAT_POLL_MS)
        return () => { dead = true; clearInterval(timer) }
      }, [open, mode, securityId, picked.join(','), floating.live])
      if (!open) return null
      const update = next => setFloating(next)
      const clamp = (x, y, el) => {
        const width = el?.offsetWidth || 288, height = el?.offsetHeight || 210, margin = 8
        return { x: Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - width - margin)), y: Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - height - margin)) }
      }
      const onPointerDown = e => {
        if (e.target.closest('button, input, label')) return
        const box = e.currentTarget.getBoundingClientRect()
        dragRef.current = { dx: e.clientX - box.left, dy: e.clientY - box.top }
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }
      const onPointerMove = e => {
        if (!dragRef.current) return
        const { x, y } = clamp(e.clientX - dragRef.current.dx, e.clientY - dragRef.current.dy, e.currentTarget)
        e.currentTarget.style.left = `${x}px`
        e.currentTarget.style.top = `${y}px`
        e.currentTarget.style.right = 'auto'
        e.currentTarget.style.bottom = 'auto'
      }
      const onPointerUp = e => {
        if (!dragRef.current) return
        dragRef.current = null
        e.currentTarget.releasePointerCapture?.(e.pointerId)
        const box = e.currentTarget.getBoundingClientRect()
        update({ x: Math.round(box.left), y: Math.round(box.top) })
      }
      const position = floating.x == null || floating.y == null ? {} : { left: floating.x, top: floating.y, right: 'auto', bottom: 'auto' }
      const step = delta => {
        const at = picked.indexOf(securityId)
        const next = picked[(at + delta + picked.length) % picked.length]
        if (next) { setTrend(null); update({ securityId: next }) }
      }
      const toneOf = pct => pct == null ? '' : Number(pct) > 0 ? ' ssb-up' : Number(pct) < 0 ? ' ssb-down' : ''
      // 面板已经刷过的报价先拿来渲染, 悬浮窗自己的 refresh 结果回来后再按 receivedAt 择优:
      // 否则首次打开要干等一轮上游请求, 列表是空的
      const entryOf = id => {
        const panel = state.data?.quotes?.[id], own = fetched[id]
        if (!panel) return own
        if (!own) return panel
        return (Number(own.quote?.receivedAt) || 0) > (Number(panel.quote?.receivedAt) || 0) ? own : panel
      }
      const current = items[securityId]
      const candles = trend?.candles
      const last = candles?.length ? Number(candles[candles.length - 1].close) : null
      const base = Number(trend?.preClose)
      const pct = last != null && Number.isFinite(base) && base ? (last - base) / base * 100 : null
      const tone = toneOf(pct)
      const rowOf = id => {
        const item = items[id], quote = entryOf(id)?.quote, change = quote?.changePct
        return h('button', { key: id, type: 'button', className: `ssb-float-row${id === securityId ? ' ssb-float-row-on' : ''}`, onClick: () => update({ mode: 'kline', securityId: id }) },
          h('span', { className: 'ssb-float-row-name' }, item.alias || item.officialName),
          h('span', { className: `ssb-float-row-price ssb-number${toneOf(change)}` }, quote?.last == null ? '—' : formatPrice(quote.last)),
          h('span', { className: `ssb-float-row-pct ssb-number${toneOf(change)}` }, change == null ? '—' : `${signed(Number(change).toFixed(2))}%`))
      }
      return h('div', { className: `ssb-float${dragRef.current ? ' ssb-float-dragging' : ''}`, role: 'complementary', 'aria-label': '悬浮盯盘', style: position, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
        React.createElement('style', { 'data-plugin': '@mzzsfy/dsh-stock-assistant', dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'ssb-float-head' },
          mode === 'kline' && !picker ? h('button', { className: 'ssb-float-icon', 'aria-label': '上一只', onClick: () => step(-1) }, '‹') : null,
          h('span', { className: 'ssb-float-name', title: current ? `${current.officialName} ${current.code}` : '' }, picker ? '选择观测目标' : mode === 'kline' && current ? (current.alias || current.officialName) : `盯盘 ${picked.length}`),
          mode === 'kline' && !picker ? h('button', { className: 'ssb-float-icon', 'aria-label': '下一只', onClick: () => step(1) }, '›') : null,
          h('div', { className: 'ssb-float-modes' },
            h('button', { type: 'button', className: `ssb-float-mode${mode === 'list' ? ' on' : ''}`, 'aria-pressed': mode === 'list', onClick: () => update({ mode: 'list' }) }, '列表'),
            h('button', { type: 'button', className: `ssb-float-mode${mode === 'kline' ? ' on' : ''}`, 'aria-pressed': mode === 'kline', onClick: () => update({ mode: 'kline' }) }, '图')),
          h('button', { type: 'button', className: 'ssb-float-icon', 'aria-label': picker ? '完成选择' : '选择观测目标', 'aria-expanded': picker, onClick: () => setPicker(!picker) }, picker ? '✓' : '☰'),
          h('button', { type: 'button', className: 'ssb-float-icon', 'aria-label': '关闭悬浮盯盘', onClick: () => update({ open: false }) }, '✕')),
        picker
          ? h('div', { className: 'ssb-float-picker' }, ...(order.length ? order.map(id => h(Toggle, { key: id, label: items[id].alias || items[id].officialName, checked: picked.includes(id), onChange: () => { const next = picked.includes(id) ? picked.filter(x => x !== id) : [...picked, id]; update({ ids: next }) } })) : [h('p', { className: 'ssb-muted' }, '自选为空')]))
          : mode === 'list'
            ? h('div', { className: 'ssb-float-list' }, ...(picked.length ? picked.map(rowOf) : [h('p', { className: 'ssb-muted' }, '未选择标的，点 ☰ 勾选')]))
            : !current ? h('p', { className: 'ssb-muted' }, '未选择标的') : h(React.Fragment, null,
              h('div', { className: `ssb-float-quote ssb-number${tone}` },
                h('span', { className: 'ssb-float-price' }, last == null ? '—' : last),
                h('span', { className: 'ssb-float-pct' }, pct == null ? '—' : `${signed(pct.toFixed(2))}%`)),
              error ? h('p', { className: 'ssb-float-error' }, error) : h('div', { className: `ssb-float-chart${tone}` }, h(Sparkline, { candles, preClose: base }))),
        h('div', { className: 'ssb-float-foot' },
          h('span', { className: 'ssb-muted' }, mode === 'kline' && securityId ? `${picked.indexOf(securityId) + 1}/${picked.length}` : `${picked.length} 只`),
          h('button', { type: 'button', className: 'ssb-float-live', 'aria-pressed': floating.live !== false, onClick: () => update({ live: floating.live === false }) }, floating.live === false ? '开始监听' : '监听中'),
          h('button', { type: 'button', className: 'ssb-float-icon', 'aria-label': '打开详情', disabled: !securityId, onClick: () => { if (!securityId) return; runtime.updateView({ view: 'list', overlay: 'detail', detailId: securityId, selectedId: securityId, alias: items[securityId]?.alias || '' }); runtime.loadKline(securityId, 'trend').catch(() => {}) } }, '⤢')))
    }
    function BrowseView({ runtime, state }) {
      const { view, busy, data } = state
      const rows = view.browseRows
      return h('section', { className: 'ssb-search-view' },
        h('div', { className: 'ssb-panel-head' }, h('h2', null, '浏览市场'), h('div', { className: 'ssb-toolbar' }, h(Button, { onClick: () => runtime.updateView({ view: 'list' }) }, '返回自选'))),
        h('div', { className: 'ssb-toolbar', style: { padding: '12px 16px 0' } }, ...Object.keys(BROWSE_MARKETS).filter(market => (data?.control.routes || []).some(r => r.capability === 'catalog' && r.market === market)).map(market => h(Button, { key: market, primary: (view.browseMarket || 'XSHG') === market, disabled: busy.browse, onClick: quiet(() => runtime.loadBrowse(market, 0)) }, BROWSE_MARKETS[market]))),
        data?.browseOverview ? h('div', { className: 'ssb-banner ssb-banner-ok', style: { margin: '12px 16px 0' } }, `${data.browseOverview.name} ${data.browseOverview.last}`, h('span', { className: `ssb-number ${Number(data.browseOverview.change) >= 0 ? 'ssb-up' : 'ssb-down'}` }, `${Number(data.browseOverview.change) >= 0 ? '+' : ''}${data.browseOverview.change}（${Number(data.browseOverview.changePct) >= 0 ? '+' : ''}${data.browseOverview.changePct}%）`), h('span', { className: 'ssb-muted' }, `${data.browseOverview.source} · ${data.browseOverview.delayKind === 'unknown' ? '延迟未知' : delayText(data.browseOverview)}`)) : null,
        !rows ? h('div', { className: 'ssb-empty' }, view.browseSyncing ? h('p', null, '目录首次同步中（约一两分钟），完成后重新点击该市场即可浏览。') : h(React.Fragment, null, h('p', null, '该市场目录未同步。可直接搜索添加自选，或同步目录后浏览。'), h(Button, { primary: true, onClick: () => runtime.updateView({ view: 'list', overlay: 'settings' }) }, '前往设置'), h(Button, { disabled: busy.sync, onClick: quiet(() => runtime.sync(view.browseMarket || 'XSHG')) }, '同步当前市场目录'))) :
          h('div', { className: 'ssb-results', role: 'list', 'aria-label': '市场证券列表' }, ...rows.map(item => {
            const added = !!data?.control.watchlist.items[item.id]
            return h('div', { className: 'ssb-candidate', role: 'listitem', key: item.id }, h('button', { type: 'button', className: 'ssb-stock-name', onClick: () => { runtime.updateView({ detailId: item.id, view: view.view, overlay: 'detail', browsePeek: { ...(view.browsePeek || {}), [item.id]: item } }); runtime.loadKline(item.id, state.klinePeriod || '1d', true).catch(() => {}); runtime.refresh([{ id: item.id, exchange: item.exchange, code: item.code, officialName: item.officialName }]).catch(() => {}) } }, h('strong', null, item.officialName), h('span', { className: 'ssb-muted' }, `${MARKET_LABEL[item.exchange] || item.exchange} ${item.code}`)), h(Button, { disabled: added || busy.write, onClick: quiet(() => runtime.mutate('add', { securityId: item.id })) }, added ? '已在自选' : '加自选'))
          })),
        rows?.length ? h('div', { className: 'ssb-toolbar', style: { padding: '0 16px 12px' } }, h('span', { className: 'ssb-muted' }, `共 ${view.browseTotal} 只`), h(Button, { disabled: !view.browseOffset || busy.browse, onClick: quiet(() => runtime.loadBrowse(view.browseMarket, Math.max(0, view.browseOffset - BROWSE_PAGE))) }, '上一页'), h(Button, { disabled: view.browseOffset + BROWSE_PAGE >= view.browseTotal || busy.browse, onClick: quiet(() => runtime.loadBrowse(view.browseMarket, view.browseOffset + BROWSE_PAGE)) }, '下一页')) : null)
    }
    function SearchView({ runtime, state }) {
      const { view, candidates, data } = state
      function choose(item) { runtime.updateView({ selectedId: item.id }) }
      const visible = view.searchMarket && view.searchMarket !== 'all' ? candidates.filter(c => c.exchange === view.searchMarket) : candidates
      return h('section', { className: 'ssb-search-view' },
        h('div', { className: 'ssb-panel-head' }, h('h2', null, '添加自选'), h('div', { className: 'ssb-toolbar' }, h(Button, { onClick: () => runtime.updateView({ view: 'list' }) }, '返回自选'))),
        h('div', { className: 'ssb-panel-body' },
          h('div', { className: 'ssb-form-row' },
            h('label', { className: 'ssb-field' }, h('span', null, '市场'), h('select', { value: view.searchMarket || 'all', onChange: e => runtime.updateView({ searchMarket: e.target.value }) }, ...[['all', '全部'], ['XSHG', '沪A股'], ['XSHE', '深A股'], ['XHKG', '港股'], ['XNAS', '美股(NASDAQ)'], ['XNYS', '美股(NYSE)'], ['XJPX', '日经'], ['XKRX', '韩证'], ['XLON', '伦敦']].map(([value, label]) => h('option', { value, key: value }, label)))),
            h('label', { className: 'ssb-search-label' }, '搜索名称、代码或拼音首字母', h('input', { type: 'search', autoFocus: true, value: view.query, placeholder: '例如 600519、茅台、腾讯、AAPL', onChange: e => runtime.search(e.target.value), onCompositionStart: () => runtime.composition(true), onCompositionEnd: () => runtime.composition(false), onKeyDown: e => {
          if (e.nativeEvent?.isComposing || state.composing) return
          const at = visible.findIndex(c => c.id === view.selectedId)
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const index = e.key === 'ArrowDown' ? Math.min(visible.length - 1, at + 1) : Math.max(0, at - 1); if (visible[index]) choose(visible[index]) }
          if (e.key === 'Escape') runtime.updateView({ view: 'list' })
        } }))),
        h('div', { role: 'listbox', 'aria-label': '证券搜索结果', className: 'ssb-results' }, ...visible.map(item => h('div', { role: 'option', 'aria-selected': view.selectedId === item.id, key: item.id, className: `ssb-candidate${view.selectedId === item.id ? ' ssb-selected' : ''}`, onClick: () => choose(item) }, h('span', { className: 'ssb-peek', role: 'button', tabIndex: 0, onClick: e => { e.stopPropagation(); runtime.updateView({ detailId: item.id, view: view.view, overlay: 'detail', browsePeek: { ...(view.browsePeek || {}), [item.id]: item } }); runtime.loadKline(item.id, state.klinePeriod || '1d', true).catch(() => {}); runtime.refresh([{ id: item.id, exchange: item.exchange, code: item.code, officialName: item.officialName }]).catch(() => {}) } }, h('strong', null, item.officialName), h('span', { className: 'ssb-muted' }, `${MARKET_LABEL[item.exchange] || item.exchange} ${item.code}${item.currency ? ` · ${item.currency}` : ''}`)), h(Button, { disabled: !!data?.control.watchlist.items[item.id] || state.busy.write, onClick: quiet(() => runtime.mutate('add', { securityId: item.id })) }, data?.control.watchlist.items[item.id] ? '已在自选' : '加自选')))),
        !visible.length ? h('p', { className: 'ssb-muted', style: { margin: 0 } }, view.query ? '暂无匹配。目录未同步时，请先到设置配置并同步目录。' : '输入关键词开始搜索，例如代码、名称或拼音首字母。') : null,
        state.errorCode === 'CATALOG_NOT_READY' ? h('div', { className: 'ssb-banner', style: { margin: 0 } }, '目录未就绪。可以直接浏览市场添加自选。', h(Button, { onClick: () => runtime.updateView({ view: 'browse' }) }, '前往浏览市场')) : null,
        h('div', { className: 'ssb-toolbar', style: { margin: 0 } }, h(Button, { primary: true, disabled: !view.selectedId || !!data?.control.watchlist.items[view.selectedId] || state.busy.write, onClick: quiet(async () => { await runtime.mutate('add', { securityId: view.selectedId }); runtime.updateView({ view: 'list', selectedId: null }) }) }, data?.control.watchlist.items[view.selectedId] ? '已在自选' : '确认添加'))))
    }
    const defaultProvider = (id, adapterId = 'tushare') => ({ id, adapterId, enabled: true, credentialEnv: adapterId === 'tushare' ? 'DSH_STOCK_TUSHARE_TOKEN' : null, quotaGroup: adapterId + '-account', budget: { requestsPerMinute: adapterId === 'tushare' ? null : 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } })
    const routeFor = (market, capability, instance) => ({ id: `${market.toLowerCase()}-${capability}`, capability, market, instrument: 'equity', primaryInstanceId: instance, fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true })
    function SettingsView({ runtime, state }) {
      const saved = state.data.control
      const draft = state.view.settingsDraft || { providers: saved.providers, routes: saved.routes, expectedRevision: saved.revision, checkResults: [], probes: {} }
      const configuration = { providers: draft.providers, routes: draft.routes }
      function change(next, invalidate = true) { runtime.updateView({ settingsDraft: { ...draft, ...next, ...(invalidate ? { checkResults: [], probes: {} } : {}) } }) }
      const providerChange = (id, patch) => change({ providers: draft.providers.map(p => p.id === id ? { ...p, ...patch } : p) })
      const field = (label, value, onChange, props = {}) => h('label', { className: 'ssb-field' }, h('span', null, label), h('input', { value: value ?? '', onChange: e => onChange(e.target.value), ...props }))
      const CAP_LABEL = { quotes: '报价', catalog: '证券目录', search: '远程搜索', calendar: '交易日历', kline: 'K线' }
      const tab = draft.tab || 'sources'
      const TABS = [['sources', '数据源'], ['routes', '市场与能力'], ['display', '显示偏好']]
      const providersOnly = { providers: draft.providers, routes: saved.routes }
      const routesOnly = { providers: saved.providers, routes: draft.routes }
      const providerCards = draft.providers.map(p => {
        const adapter = state.data.adapters.find(a => a.adapterId === p.adapterId)
        const status = state.data.providerStatus?.find(s => s.id === p.id)
        const openSource = adapter?.credential === 'none'
        const expanded = (draft.expandedProvider || '') === p.id
        // 该实例实际承担的能力与市场(摘要用, 让「这个源在干什么」一眼可见)
        const owned = draft.routes.filter(r => r.primaryInstanceId === p.id || r.fallbackInstanceIds.includes(p.id))
        const asPrimary = draft.routes.filter(r => r.primaryInstanceId === p.id)
        const asBackup = draft.routes.filter(r => r.fallbackInstanceIds.includes(p.id))
        const capsText = [...new Set(owned.map(r => CAP_LABEL[r.capability]))].join('/') || '未分配'
        const marketsText = new Set(owned.map(r => r.market)).size
        // 主源与备源分开计数: 只当备源的实例不该显示成「0 条路由」, 那读起来像没在用
        const scopeText = [asPrimary.length ? `${asPrimary.length} 主源` : '', asBackup.length ? `${asBackup.length} 备源` : ''].filter(Boolean).join(' · ') || '未分配'
        const toggle = () => change({ expandedProvider: expanded ? '' : p.id }, false)
        return h('div', { className: 'ssb-provider', key: p.id },
          h('button', { className: 'ssb-provider-toggle', 'aria-expanded': expanded, disabled: state.busy.configuration, onClick: toggle, title: adapter?.description || '' },
            h('span', { className: `ssb-dot${p.enabled ? '' : ' ssb-dot-idle'}` }),
            h('span', { className: 'ssb-provider-id' }, p.id),
            h('span', { className: 'ssb-provider-adapter-name ssb-muted' }, p.adapterId),
            h('span', { className: 'ssb-provider-scope' }, `${scopeText} · ${marketsText} 市场 · ${capsText}`),
            h('span', { className: 'ssb-muted ssb-provider-kind' }, openSource ? '公开来源' : status?.credentialPresent ? '凭据已就绪' : '待配置凭据'),
            h('span', { className: 'ssb-provider-edit' }, expanded ? '收起' : '配置')),
          adapter?.description ? h('p', { className: 'ssb-provider-desc ssb-muted' }, adapter.description) : null,
          expanded ? h('div', { className: 'ssb-provider-body', disabled: state.busy.configuration },
            h('div', { className: 'ssb-provider-head' },
              h('label', { className: 'ssb-field ssb-provider-adapter' }, h('span', null, '适配器'), h('select', { value: p.adapterId, onChange: e => { const adapterId = e.target.value, descriptor = state.data.adapters.find(a => a.adapterId === adapterId); providerChange(p.id, { adapterId, credentialEnv: descriptor?.credential === 'none' ? null : p.credentialEnv || 'DSH_STOCK_TUSHARE_TOKEN', quotaGroup: adapterId + '-account', budget: descriptor?.credential === 'none' && p.budget.requestsPerMinute === null ? { ...p.budget, requestsPerMinute: 60 } : p.budget }) } }, ...state.data.adapters.map(a => h('option', { value: a.adapterId, key: a.adapterId }, a.adapterId + (a.credential === 'none' ? '（免凭据）' : ''))))),
              h('div', { className: 'ssb-provider-switches' },
                h(Toggle, { label: '启用', checked: p.enabled, onChange: value => providerChange(p.id, { enabled: value }) }),
                h(Button, { danger: true, onClick: () => change({ providers: draft.providers.filter(other => other.id !== p.id), routes: draft.routes.filter(r => r.primaryInstanceId !== p.id).map(r => ({ ...r, fallbackInstanceIds: r.fallbackInstanceIds.filter(id => id !== p.id), failoverMode: r.fallbackInstanceIds.includes(p.id) ? 'off' : r.failoverMode })) }) }, '移除'))),
            h('div', { className: 'ssb-provider-advanced-open' },
              h('div', { className: 'ssb-form-grid' },
                openSource ? h('span', { className: 'ssb-muted', style: { gridColumn: '1 / -1' } }, '公开来源，无需凭据') : field('Host环境变量名', p.credentialEnv, value => providerChange(p.id, { credentialEnv: value }), { autoComplete: 'off', spellCheck: false }),
                field('共享额度组（同账号保持一致）', p.quotaGroup, value => providerChange(p.id, { quotaGroup: value })),
                field('每分钟请求上限（留空仅允许探针）', p.budget.requestsPerMinute, value => providerChange(p.id, { budget: { ...p.budget, requestsPerMinute: value ? Number(value) : null } }), { type: 'number', min: 1 }),
                field('每日请求上限（留空无限制）', p.budget.dailyRequestLimit, value => providerChange(p.id, { budget: { ...p.budget, dailyRequestLimit: value ? Number(value) : null } }), { type: 'number', min: 1 }),
                h('label', { className: 'ssb-field' }, h('span', null, '计费单位'), h('select', { value: p.budget.billingUnit, onChange: e => providerChange(p.id, { budget: { ...p.budget, billingUnit: e.target.value } }) }, h('option', { value: 'request' }, '请求'), h('option', { value: 'symbol' }, '证券'))),
                p.budget.billingUnit === 'symbol' ? field('每分钟证券额度', p.budget.symbolCreditsPerMinute, value => providerChange(p.id, { budget: { ...p.budget, symbolCreditsPerMinute: value ? Number(value) : null } }), { type: 'number', min: 1 }) : null,
                ...['quotes', 'catalog', 'search', 'calendar'].map(cap => field(`${({ quotes: '报价', catalog: '目录', search: '搜索', calendar: '日历' })[cap]}每分钟上限`, p.budget.capabilityLimits[cap] ?? '', value => providerChange(p.id, { budget: { ...p.budget, capabilityLimits: Object.fromEntries(Object.entries({ ...p.budget.capabilityLimits, [cap]: value ? Number(value) : null }).filter(([, limit]) => limit !== null)) } }), { type: 'number', min: 1, key: cap })),
                adapter?.endpointKeys?.length ? h('details', { key: 'ep-' + p.id, style: { gridColumn: '1 / -1' } },
                  h('summary', { className: 'ssb-muted' }, `接口反代${status?.endpointsCovered ? `（已覆盖 ${status.endpointsCovered} 项）` : ''}`),
                  h('p', { className: 'ssb-muted', style: { gridColumn: '1 / -1' } }, '自建反向代理或镜像站时替换对应地址，留空使用官方默认。路径与参数由本插件拼接，反代只需原样转发。'),
                  h('div', { className: 'ssb-form-grid' }, ...adapter.endpointKeys.map(({ key, label }) => field(label, (p.endpoints || {})[key] || '', value => { const endpoints = { ...p.endpoints }; if (value) endpoints[key] = value; else delete endpoints[key]; providerChange(p.id, { endpoints: Object.keys(endpoints).length ? endpoints : undefined }) }, { placeholder: '官方默认', spellCheck: false })))) : null,
                h('details', { key: 'obs-' + p.id, style: { gridColumn: '1 / -1' } }, h('summary', { className: 'ssb-muted' }, '运行状态'), status?.recentRequests?.length ? h('ul', { className: 'ssb-reqlog' }, ...status.recentRequests.slice(0, 5).map((r, i) => h('li', { key: i }, `${timeText(r.at)} · ${r.url} · ${r.status} · ${r.ms}ms`))) : h('p', { className: 'ssb-muted' }, '暂无请求记录；启用并保存后，行情/K线请求会在此留最近 20 条轨迹。'))))) : null)
      })
      const routeRows = Object.keys(MARKET_LABEL).map(market => {
        const caps = ['catalog', 'search', 'quotes', 'kline', ...(['XSHG', 'XSHE'].includes(market) ? ['calendar'] : [])]
        const marketRoutes = draft.routes.filter(r => r.market === market)
        const expanded = (draft.expandedMarket || '') === market
        // 摘要优先: 八市场默认收成八行, 只暴露「用什么源、备源是谁」, 改的时候才展开下拉
        const primaries = [...new Set(marketRoutes.map(r => r.primaryInstanceId))]
        const backs = marketRoutes.filter(r => r.fallbackInstanceIds.length)
        // 能力按固定顺序呈现, 不跟随 routes 数组顺序(来源提高的顺序会变)
        const capOrder = caps.filter(cap => marketRoutes.some(r => r.capability === cap))
        const allocation = marketRoutes.map(r => `${CAP_LABEL[r.capability]}: ${r.primaryInstanceId}${r.fallbackInstanceIds.length ? `（备 ${r.fallbackInstanceIds[0]}）` : ''}`).join('\n')
        const cells = caps.map(cap => {
          const route = draft.routes.find(r => r.market === market && r.capability === cap)
          const options = [h('option', { value: '', key: '' }, '未配置'), ...draft.providers.filter(p => p.enabled && state.data.adapters.find(a => a.adapterId === p.adapterId)?.capabilities.includes(cap)).map(p => h('option', { value: p.id, key: p.id }, p.id))]
          // 每个能力可单独探一次: 结果只做诊断展示, 不影响能否保存
          const probeKey = route ? `${route.primaryInstanceId}:${cap}:${market}` : null
          const probe = probeKey ? (draft.probes || {})[probeKey] : null
          const probing = probeKey ? (draft.probing || {})[probeKey] : false
          return h('div', { className: 'ssb-route-cell ssb-route-cell-probe', key: cap },
            h('label', { className: 'ssb-route-cell-main' }, h('span', { className: 'ssb-route-cell-label' }, CAP_LABEL[cap]), h('select', { value: route?.primaryInstanceId || '', onChange: e => change({ routes: [...draft.routes.filter(r => r !== route), ...(e.target.value ? [routeFor(market, cap, e.target.value)] : [])] }) }, ...options)),
            route ? h('button', {
              className: 'ssb-probe', disabled: probing, title: '单独测这一条能力：拉一次真实数据，报告成败与耗时',
              onClick: quiet(async () => {
                runtime.updateView({ settingsDraft: { ...runtime.getSnapshot().view.settingsDraft, probing: { ...(draft.probing || {}), [probeKey]: true } } })
                try {
                  const result = await runtime.check({ providers: draft.providers, routes: [route], capabilities: [cap] })
                  const hit = result.checks.find(c => c.providerInstanceId === route.primaryInstanceId) || result.checks[0]
                  const current = runtime.getSnapshot().view.settingsDraft || draft
                  runtime.updateView({ settingsDraft: { ...current, probing: { ...(current.probing || {}), [probeKey]: false }, probes: { ...(current.probes || {}), [probeKey]: hit ? { status: hit.status, ms: hit.ms, error: hit.error } : { status: 'denied', error: { message: '未返回结果' } } } } })
                } catch (e) {
                  const current = runtime.getSnapshot().view.settingsDraft || draft
                  runtime.updateView({ settingsDraft: { ...current, probing: { ...(current.probing || {}), [probeKey]: false }, probes: { ...(current.probes || {}), [probeKey]: { status: 'denied', error: { message: e.message } } } } })
                }
              }),
            },
            probing ? '测试中' : '测试') : null,
            probe ? h('span', {
              className: `ssb-probe-result ${probe.status === 'ready' ? 'ssb-probe-ok' : 'ssb-probe-bad'}`,
              title: probe.error ? `${probe.error.code || ''} ${probe.error.message || ''}`.trim() : `耗时 ${probe.ms}ms`,
            }, probe.status === 'ready' ? `✓ ${probe.ms ?? '—'}ms` : '✗') : null)
        })
        // 备源与延迟只对报价/ K线有意义,收进行内折叠,避免八市场铺成三屏
        const tuned = draft.routes.filter(r => r.market === market && (r.capability === 'quotes' || r.capability === 'kline'))
        const advanced = tuned.map(route => {
          const cap = route.capability
          const updateRoute = patch => change({ routes: draft.routes.map(r => r === route ? { ...r, ...patch } : r) })
          const options = [h('option', { value: '', key: '' }, '无'), ...draft.providers.filter(p => p.enabled && state.data.adapters.find(a => a.adapterId === p.adapterId)?.capabilities.includes(cap) && p.id !== route.primaryInstanceId).map(p => h('option', { value: p.id, key: p.id }, p.id))]
          return h('div', { className: 'ssb-route-tune', key: cap },
            h('span', { className: 'ssb-route-tune-label' }, CAP_LABEL[cap]),
            h('label', { className: 'ssb-field' }, h('span', null, '备用源'), h('select', { value: route.fallbackInstanceIds[0] || '', onChange: e => updateRoute({ fallbackInstanceIds: e.target.value ? [e.target.value] : [], failoverMode: 'off' }) }, ...options)),
            h(Toggle, { label: '自动切换', disabled: !route.fallbackInstanceIds.length, checked: route.failoverMode === 'network', onChange: on => updateRoute({ failoverMode: on ? 'network' : 'off' }) }),
            cap === 'quotes' ? h(Toggle, { label: '接受延迟未知', checked: route.acceptUnknownDelay, onChange: on => updateRoute({ acceptUnknownDelay: on }) }) : null,
            cap === 'quotes' ? h('label', { className: 'ssb-field ssb-route-delay' }, h('span', null, '最大延迟秒'), h('input', { type: 'number', min: 0, value: route.maxDelaySeconds ?? '', placeholder: '不限', onChange: e => updateRoute({ maxDelaySeconds: e.target.value ? Number(e.target.value) : null }) })) : null)
        })
        return h('div', { className: 'ssb-market-row', key: market },
          h('button', {
            className: 'ssb-market-toggle', 'aria-expanded': expanded, disabled: state.busy.configuration, title: allocation,
            onClick: () => change({ expandedMarket: expanded ? '' : market }, false),
          },
          h('span', { className: 'ssb-market-name' }, MARKET_LABEL[market]),
          h('span', { className: 'ssb-market-code' }, market),
          h('span', { className: 'ssb-market-caps' }, primaries.length === 1 ? primaries[0] : primaries.length ? `${primaries.length} 个主源` : '未配置',
            h('span', { className: 'ssb-muted' }, ` · ${capOrder.length ? capOrder.map(c => CAP_LABEL[c]).join('/') : '无能力'}`)),
          h('span', { className: 'ssb-market-back' }, backs.length ? `备 ${[...new Set(backs.map(r => r.fallbackInstanceIds[0]))].join('/')}` : '无备源'),
          h('span', { className: 'ssb-market-edit' }, expanded ? '收起' : '改')),
          expanded ? h('div', { className: 'ssb-market-body' },
            h('div', { className: 'ssb-route-grid' }, ...cells),
            advanced.length ? h('div', { className: 'ssb-route-advanced' }, ...advanced) : null) : null)
      })
      const configuredMarkets = new Set(draft.routes.map(r => r.market)).size
      const pane = tab === 'sources' ? h(React.Fragment, null,
        !draft.providers.length ? h('div', { className: 'ssb-banner' }, '尚未配置任何数据源。点上方「应用推荐配置」一次装好内置的免凭据源（延迟未知、无SLA）。') : null,
        h('div', { className: 'ssb-section-head' }, h('h3', null, '数据源'), h(Button, { disabled: state.busy.configuration || draft.providers.length >= 8, onClick: () => { let n = 1; while (draft.providers.some(p => p.id === `ts-${n}`)) n++; change({ providers: [...draft.providers, defaultProvider(`ts-${n}`)] }) } }, '添加实例')),
        providerCards,
        h('div', { className: 'ssb-toolbar' }, h(Button, { primary: true, disabled: state.busy.configuration || !draft.providers.length, onClick: quiet(() => runtime.configuration(providersOnly, [])) }, '保存数据源'), h('span', { className: 'ssb-muted' }, '仅保存实例；能力分配在「市场与能力」页检查并保存'))) :
        tab === 'routes' ? h(React.Fragment, null,
        h('div', { className: 'ssb-section-head' }, h('h3', null, '市场与能力'), h('span', { className: 'ssb-muted', 'aria-live': 'polite' }, state.checkProgress || `${configuredMarkets} 个市场已配置，点行尾「改」调整，其余保持默认即可`)),
        h('div', { className: 'ssb-market-list' },
          h('div', { className: 'ssb-market-head', 'aria-hidden': 'true' },
            h('span', null, '市场'), h('span', null, '代码'), h('span', null, '行情来源'), h('span', null, '备用源'), h('span', null, '')),
          ...routeRows),
        h('div', { className: 'ssb-section-foot' },
          h('p', { className: 'ssb-muted' }, '目录、搜索、报价、日历与K线可独立指定来源；未配置的能力不会隐式借用其他来源。展开任一市场可对单项能力做一次探测，结果只作参考，不阻塞保存。')),
        h('div', { className: 'ssb-toolbar' },
          h(Button, { primary: true, disabled: state.busy.configuration || !draft.routes.length, onClick: quiet(() => runtime.configuration(routesOnly)) }, '保存路由'),
          h(Button, { disabled: state.busy.configuration || state.busy.check || !draft.routes.length, onClick: quiet(async () => {
            const capsUsed = [...new Set(draft.routes.map(r => r.capability))]
            const result = await runtime.check({ providers: draft.providers, routes: draft.routes, capabilities: capsUsed })
            const current = runtime.getSnapshot().view.settingsDraft
            if (current && JSON.stringify({ providers: current.providers, routes: current.routes }) !== JSON.stringify({ providers: draft.providers, routes: draft.routes })) return
            const probes = { ...(current?.probes || draft.probes || {}) }
            for (const c of result.checks) probes[`${c.providerInstanceId}:${c.capability}:${c.market}`] = { status: c.status, ms: c.ms, error: c.error }
            change({ checkResults: result.checks, probes }, false)
          }) }, state.busy.check ? '正在全部测试…' : '全部测一次'),
          h(Button, { disabled: state.busy.check || state.busy.configuration, onClick: () => runtime.updateView({ settingsDraft: null }) }, '放弃草稿')),
        h('h3', null, '目录缓存'), h('div', { className: 'ssb-toolbar' }, ...Object.keys(BROWSE_MARKETS).filter(market => (state.data.control.routes || []).some(r => r.capability === 'catalog' && r.market === market)).map(market => h(Button, { key: market, disabled: state.busy.sync, onClick: quiet(async () => { const results = await runtime.sync(market); const errors = results.filter(r => !r.ok); if (errors.length) tools.toast?.show(errors.map(r => r.error.message).join('；'), { kind: 'error' }) }) }, `同步${BROWSE_MARKETS[market]}`))),
        ...state.data.catalogs.map(c => h('p', { key: c.source, className: 'ssb-muted' }, `${c.source} · ${timeText(c.fetchedAt)}${c.stale ? ' · 已过期' : ''}${c.complete ? '' : ' · 目录可能不完整'}`)),
        ...Object.entries(state.data.routeSelections).filter(([id, selected]) => selected.providerInstanceId !== saved.routes.find(r => r.id === id)?.primaryInstanceId).map(([id, selected]) => h('div', { className: 'ssb-banner', key: id }, `${id}当前使用备用源 ${selected.providerInstanceId}。`, h(Button, { disabled: state.busy.switch, onClick: quiet(() => runtime.switchPrimary(id)) }, '检查并切回主源')))) :
        h(React.Fragment, null, h('h3', null, '显示偏好（即改即存）'), h('div', { className: 'ssb-toolbar' }, h('label', { className: 'ssb-field' }, h('span', null, '刷新间隔'), h('select', { value: saved.preferences.refreshSeconds, disabled: state.busy.write || state.busy.configuration, onChange: quiet(e => runtime.preferences({ refreshSeconds: Number(e.target.value) })) }, ...[15, 30, 60].map(n => h('option', { key: n, value: n }, `${n}秒`)))), h('label', { className: 'ssb-field' }, h('span', null, '涨跌颜色'), h('select', { value: saved.preferences.colorMode, disabled: state.busy.write || state.busy.configuration, onChange: quiet(e => runtime.preferences({ colorMode: e.target.value })) }, h('option', { value: 'red-up' }, '红涨绿跌'), h('option', { value: 'green-up' }, '绿涨红跌')))))
      const controlRoutes = saved.routes || []
      const enabled = (saved.providers || []).filter(p => p.enabled).length
      const markets = new Set(controlRoutes.map(r => r.market)).size
      const busyConfig = state.busy.configuration || state.busy.check
      return h('section', { className: 'ssb-settings' },
        h('div', { className: 'ssb-settings-head' },
          h('div', { className: 'ssb-settings-intro' }, h('h2', null, '设置'), h('p', { className: 'ssb-muted' }, `${enabled} 个数据源 · ${controlRoutes.length} 条能力路由 · ${markets} 个市场；凭据保留在Host环境变量中，这里仅保存变量名与数据路由`)),
          h('div', { className: 'ssb-toolbar' }, h(Button, { primary: true, disabled: busyConfig, title: '写入内置免凭据数据源与八市场能力路由，探针不可用的目标自动剔除；自选与显示偏好不受影响', onClick: quiet(() => runtime.applyRecommended()) }, state.checkProgress || (busyConfig ? '正在应用…' : '应用推荐配置')))),
        h('div', { className: 'ssb-tablist', role: 'tablist', 'aria-label': '设置分区' }, ...TABS.map(([key, label]) => h('button', { key, role: 'tab', 'aria-selected': tab === key, className: `ssb-tab${tab === key ? ' ssb-tab-on' : ''}`, onClick: () => change({ tab: key }, false) }, label))),
        pane)
    }
    const CSS = `
.ssb-root,.ssb-float-root { --ssb-accent:var(--dsw-alias-brand-primary); --ssb-accent-deep:var(--dsw-alias-button-primary-hover); --ssb-on-accent:var(--dsw-alias-label-primary-inverted); --ssb-accent-wash:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent); --ssb-ok:var(--dsw-alias-state-success-primary); --ssb-warn:var(--dsw-alias-state-warn-primary); --ssb-danger:var(--dsw-alias-state-error-primary); --ssb-bg:var(--dsw-alias-bg-layer-1); --ssb-bg-sub:var(--dsw-alias-bg-layer-2); --ssb-bg-muted:var(--dsw-alias-bg-module-platform); --ssb-border:var(--dsw-alias-border-l2); --ssb-text:var(--dsw-alias-label-primary); --ssb-text-sub:var(--dsw-alias-label-secondary); --ssb-text-dim:var(--dsw-alias-label-tertiary); --ssb-radius-sm:6px; --ssb-radius-md:8px; --ssb-radius-lg:12px; }
/* 悬浮盯盘挂在 body 上, 与面板同源取色但不需要面板的整屏布局 */
.ssb-root { height:100%; min-width:0; overflow:auto; color:var(--ssb-text); background:var(--ssb-bg); font:inherit; font-size:12px; line-height:1.5; }
.ssb-float-root { color:var(--ssb-text); font:inherit; font-size:12px; line-height:1.5; }
.ssb-root *,.ssb-float-root * { box-sizing:border-box; }
.ssb-page { max-width:1200px; margin:0 auto; padding:20px; }
.ssb-root h1 { margin:0; font-size:20px; line-height:1.3; }.ssb-root h2 { margin:0; font-size:16px; line-height:1.3; }.ssb-root h3 { margin:24px 0 12px; font-size:14px; }
.ssb-tablist { display:flex; gap:4px; border-bottom:1px solid var(--ssb-border); margin:12px 0 16px; }.ssb-tab { font:inherit; color:var(--ssb-text-sub); background:transparent; border:0; border-bottom:2px solid transparent; padding:8px 14px; cursor:pointer; }.ssb-tab-on { color:var(--ssb-text); border-bottom-color:var(--ssb-accent); }.ssb-header,.ssb-toolbar,.ssb-section-head,.ssb-row-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }.ssb-header { justify-content:space-between; margin-bottom:24px; }.ssb-header p { margin:6px 0 0; }.ssb-section-head { justify-content:space-between; padding:12px 16px; }.ssb-toolbar { margin:12px 0; }
.ssb-button { color:var(--ssb-text); background:transparent; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); min-height:28px; padding:4px 12px; font:inherit; cursor:pointer; transition:background .15s; }.ssb-button:hover { background:var(--dsw-alias-interactive-bg-hover); }.ssb-button.ssb-primary { background:var(--ssb-accent); color:var(--ssb-on-accent); border-color:var(--ssb-accent); }.ssb-button.ssb-primary:hover { background:var(--ssb-accent-deep); }.ssb-button.ssb-danger { color:var(--ssb-danger); }.ssb-root button:disabled { opacity:.5; cursor:not-allowed; }.ssb-root :focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }
.ssb-root input:not([type=checkbox]),.ssb-root select { background:var(--ssb-bg); color:var(--ssb-text); border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); min-height:32px; padding:6px 8px; font:inherit; max-width:100%; }.ssb-field { display:flex; flex-direction:column; gap:6px; min-width:0; }.ssb-muted { color:var(--ssb-text-sub); }.ssb-code,.ssb-source { display:block; font-size:11px; }.ssb-code,.ssb-number { font-family:var(--ds-font-family-code); font-variant-numeric:tabular-nums; }.ssb-code { color:var(--ssb-text-sub); margin-top:4px; }.ssb-small { font-size:13px; margin-left:12px; }
.ssb-content { display:grid; grid-template-columns:minmax(0,1fr); gap:16px; }.ssb-overlay { position:fixed; inset:0; background:color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent); display:flex; z-index:10; animation:ssb-fade .15s ease-out; }.ssb-drawer { animation:ssb-slide .2s ease-out; }.ssb-modal-card { animation:ssb-pop .18s ease-out; }@keyframes ssb-fade { from { opacity:0; } }@keyframes ssb-slide { from { transform:translateX(40px); opacity:0; } }@keyframes ssb-pop { from { transform:scale(.96); opacity:0; } }.ssb-overlay-drawer { justify-content:flex-end; }.ssb-overlay-modal { align-items:center; justify-content:center; padding:24px; }.ssb-drawer { width:min(80vw,94vw); height:100%; overflow:auto; background:var(--ssb-bg); border-left:1px solid var(--ssb-border); box-shadow:var(--dsw-shadow-lv3); padding:16px; }.ssb-modal-card { width:min(880px,94vw); max-height:88vh; overflow:auto; background:var(--ssb-bg); border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-lg); box-shadow:var(--dsw-shadow-lv3); padding:16px; }.ssb-drawer-head { display:flex; justify-content:flex-end; }.ssb-drawer .ssb-detail, .ssb-drawer .ssb-settings { border:0; padding:0; background:transparent; }.ssb-list-pane,.ssb-detail { border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-md); min-width:0; }.ssb-detail { padding:16px; background:var(--ssb-bg-sub); }.ssb-detail .ssb-section-head { padding:0; }.ssb-detail-price { font-size:28px; margin:20px 0 4px; }.ssb-table-scroll { max-height:65vh; overflow:auto; border-radius:0 0 var(--ssb-radius-md) var(--ssb-radius-md); }.ssb-foot { margin:12px 0 4px; }.ssb-table { width:100%; border-collapse:collapse; table-layout:auto; }.ssb-table th { color:var(--ssb-text-sub); font-weight:400; font-size:11px; background:var(--ssb-bg-sub); position:sticky; top:0; z-index:1; }.ssb-table td,.ssb-table th { padding:10px 12px; text-align:left; border-top:1px solid var(--ssb-border); }.ssb-table td.ssb-number { text-align:right; white-space:nowrap; }.ssb-table tr:hover { background:var(--dsw-alias-interactive-bg-hover); }.ssb-selected { background:var(--ssb-accent-wash); }.ssb-stock-name { font:inherit; color:inherit; background:transparent; border:0; padding:0; text-align:left; cursor:pointer; }.ssb-stale td.ssb-number { opacity:.65; }.ssb-up { color:var(--ssb-danger); }.ssb-down { color:var(--ssb-ok); }.ssb-green-up .ssb-up { color:var(--ssb-ok); }.ssb-green-up .ssb-down { color:var(--ssb-danger); }
.ssb-table th.ssb-number { text-align:right; }.ssb-table th.ssb-col-status { text-align:right; }
.ssb-table td { vertical-align:middle; padding-top:8px; padding-bottom:8px; }.ssb-table td:first-child { max-width:240px; }
.ssb-stock-name { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
/* 行情列表: 单行紧凑, 列宽定宽右对齐, 行高按 32px 量级标尺(见 design 规范) */
.ssb-list-pane { container-type:inline-size; }
.ssb-list-pane > .ssb-table-scroll { flex:1; min-height:0; }
.ssb-list-pane > .ssb-foot, .ssb-list-pane > .ssb-banner { flex:0 0 auto; }
.ssb-rows { display:flex; flex-direction:column; }
/* 表头与数据行共用同一套列模板, 保证逐列对齐; 数值列右对齐且等宽数字, 长内容不再挤占相邻列 */
.ssb-row-head,.ssb-row-main { display:grid; grid-template-columns:12px minmax(140px,1fr) 64px 58px 56px 62px 104px 82px 52px 60px 16px; gap:8px; align-items:center; font-variant-numeric:tabular-nums; }
.ssb-row-head { height:32px; padding:0 12px; font-size:12px; color:var(--ssb-text-sub); border-bottom:1px solid var(--ssb-border); }
.ssb-row-head .ssb-cell-price,.ssb-row-head .ssb-cell-pct,.ssb-row-head .ssb-cell-change,.ssb-row-head .ssb-cell-range,.ssb-row-head .ssb-cell-amount,.ssb-row-head .ssb-cell-amplitude,.ssb-row-head .ssb-cell-pl { font-family:inherit; color:inherit; }
.ssb-row-main > .ssb-cell-price,.ssb-row-main > .ssb-cell-pct,.ssb-row-main > .ssb-cell-change,.ssb-row-main > .ssb-cell-open,.ssb-row-main > .ssb-cell-range,.ssb-row-main > .ssb-cell-amount,.ssb-row-main > .ssb-cell-amplitude,.ssb-row-main > .ssb-cell-pl,.ssb-row-head > span:nth-child(n+3) { justify-self:end; }
.ssb-row-main > .ssb-cell-price,.ssb-row-main > .ssb-cell-range,.ssb-row-main > .ssb-cell-amount { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ssb-row { padding:0 12px; cursor:pointer; }
.ssb-row-main { height:40px; font-size:12px; }
.ssb-row:hover { background:var(--dsw-alias-interactive-bg-hover); }
.ssb-row.ssb-selected { background:var(--ssb-accent-wash); }
.ssb-row.ssb-stale { opacity:.72; }
.ssb-row.ssb-pinned { box-shadow:inset 2px 0 0 var(--ssb-accent); }
.ssb-row.ssb-dragging { opacity:.4; }
.ssb-row.ssb-drop-before { box-shadow:inset 0 2px 0 var(--ssb-accent); }
.ssb-row.ssb-drop-after { box-shadow:inset 0 -2px 0 var(--ssb-accent); }
.ssb-grip { flex:0 0 12px; color:var(--ssb-text-dim); cursor:grab; opacity:0; user-select:none; line-height:1; font-size:12px; }
.ssb-row:hover .ssb-grip { opacity:1; }
.ssb-row.ssb-dragging .ssb-grip { cursor:grabbing; }
.ssb-row .ssb-stock-name { min-width:0; font-size:13px; font-weight:500; display:flex; align-items:baseline; gap:6px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.ssb-row-head .ssb-col-name { min-width:0; }
.ssb-row .ssb-code { margin-top:0; flex:0 0 auto; font-size:11px; color:var(--ssb-text-dim); }
.ssb-cell-price,.ssb-cell-pct,.ssb-cell-change,.ssb-cell-open,.ssb-cell-amount,.ssb-cell-amplitude,.ssb-cell-pl { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; font-family:var(--ds-font-family-code); }
.ssb-cell-range { white-space:nowrap; color:var(--ssb-text-dim); font-variant-numeric:tabular-nums; font-family:var(--ds-font-family-code); }
.ssb-cell-price { font-size:15px; font-weight:600; }
.ssb-cell-amount,.ssb-cell-amplitude,.ssb-cell-open { color:var(--ssb-text-dim); }
.ssb-col-status { justify-self:end; }
.ssb-pill { display:inline-block; padding:0 5px; border-radius:var(--ssb-radius-sm); background:color-mix(in srgb, currentColor 12%, transparent); }



/* 窄容器降级: 单行拆两段, 隐藏列头与宽屏列 */
.ssb-row-sub { display:none; }
@container (max-width:700px) {
  .ssb-row-head { display:none; }
  .ssb-row { padding:6px 10px; }
  .ssb-row-main { grid-template-columns:12px minmax(80px,1fr) 68px 64px 56px 16px; height:auto; }
  .ssb-cell-open,.ssb-cell-range,.ssb-cell-amount,.ssb-cell-amplitude,.ssb-cell-pl { display:none; }
  .ssb-row-sub { display:flex; gap:10px; margin-top:2px; padding-left:20px; font-size:12px; color:var(--ssb-text-dim); font-variant-numeric:tabular-nums; font-family:var(--ds-font-family-code); }
}
.ssb-kv { display:inline-flex; gap:3px; white-space:nowrap; }
/* 悬浮盯盘: 固定右下角, 尺寸以 4px 刻度, 只做轻边框分层不挂阴影 */
.ssb-float { position:fixed; right:24px; bottom:24px; z-index:60; width:288px; max-height:calc(100vh - 48px); display:flex; flex-direction:column; gap:8px; padding:12px; background:var(--ssb-bg); border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-lg); box-shadow:var(--dsw-shadow-lv3); font-size:12px; cursor:grab; touch-action:none; }
.ssb-float-dragging { cursor:grabbing; }
.ssb-float-head { display:flex; align-items:center; gap:4px; }
.ssb-float-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
.ssb-float-icon { width:20px; height:20px; display:inline-flex; align-items:center; justify-content:center; font:inherit; font-size:12px; line-height:1; color:var(--ssb-text-sub); background:transparent; border:0; border-radius:var(--ssb-radius-sm); cursor:pointer; }
.ssb-float-icon:hover { color:var(--ssb-text); background:var(--ssb-accent-wash); }
.ssb-float-quote { display:flex; align-items:baseline; gap:8px; }
.ssb-float-price { font-size:20px; line-height:1.3; font-family:var(--ds-font-family-code); font-variant-numeric:tabular-nums; }
.ssb-float-pct { font-size:12px; }
.ssb-float-spark { width:100%; height:88px; display:block; }
/* 曲线用 currentColor 取色: 有涨跌时由 .ssb-up/.ssb-down 决定, 只在两者都没有时退回次要文字色 */
.ssb-float-chart:not(.ssb-up):not(.ssb-down) { color:var(--ssb-text-sub); }
.ssb-float-line { fill:none; stroke:currentColor; stroke-width:1.5; vector-effect:non-scaling-stroke; }
.ssb-float-area { fill:currentColor; opacity:.12; stroke:none; }
.ssb-float-base { stroke:var(--ssb-text-dim); stroke-width:1; stroke-dasharray:3 3; vector-effect:non-scaling-stroke; opacity:.6; }
.ssb-float-error { margin:0; height:88px; display:flex; align-items:center; color:var(--ssb-text-sub); }
.ssb-float-foot { display:flex; align-items:center; gap:8px; }
.ssb-float-live { margin-left:auto; padding:4px 8px; font:inherit; font-size:11px; color:var(--ssb-text-sub); background:transparent; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); cursor:pointer; }
.ssb-float-live[aria-pressed="true"] { color:var(--ssb-ok); border-color:color-mix(in srgb,var(--ssb-ok) 40%,transparent); background:color-mix(in srgb,var(--ssb-ok) 10%,transparent); }
.ssb-float-live:hover { border-color:var(--ssb-accent); }
/* 列表模式: 每行一只标的, 点击切到该只的图形 */
.ssb-float-list, .ssb-float-picker { flex:0 1 auto; min-height:0; display:flex; flex-direction:column; gap:2px; max-height:min(300px, 45vh); overflow:auto; }
.ssb-float-row { display:flex; align-items:baseline; gap:8px; padding:4px 6px; font:inherit; text-align:left; color:inherit; background:transparent; border:0; border-radius:var(--ssb-radius-sm); cursor:pointer; }
.ssb-float-row:hover { background:var(--dsw-alias-interactive-bg-hover); }
.ssb-float-row-on { background:var(--ssb-accent-wash); }
.ssb-float-row-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ssb-float-row-price { font-size:12px; }
.ssb-float-row-pct { width:58px; text-align:right; font-size:11px; }
.ssb-float-modes { display:flex; gap:2px; }
.ssb-float-mode { padding:2px 6px; font:inherit; font-size:11px; color:var(--ssb-text-sub); background:transparent; border:1px solid transparent; border-radius:var(--ssb-radius-sm); cursor:pointer; }
.ssb-float-mode.on { color:var(--ssb-text); border-color:var(--ssb-border); background:var(--ssb-bg-sub); }
.ssb-float-picker .ssb-switch { font-size:11px; }
.ssb-group-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; height:32px; padding:0 12px; border-top:1px solid var(--ssb-border); background:var(--ssb-bg-sub); font-size:12px; color:var(--ssb-text-sub); }
.ssb-dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--ssb-ok); flex:0 0 auto; }.ssb-dot.ssb-dot-warn { background:var(--ssb-warn); }.ssb-dot.ssb-dot-danger { background:var(--ssb-danger); }.ssb-dot.ssb-dot-idle { background:var(--ssb-text-dim); }
.ssb-facts { display:grid; grid-template-columns:1fr 1fr; gap:8px; border-top:1px solid var(--ssb-border); padding-top:16px; margin-top:16px; }.ssb-facts dt { color:var(--ssb-text-sub); }.ssb-facts dd { margin:0; text-align:right; overflow-wrap:anywhere; font-family:var(--ds-font-family-code); }.ssb-alias-form { display:grid; gap:6px; margin-top:0; }.ssb-alias-form label { display:grid; gap:6px; }.ssb-alias-form button { justify-self:start; min-width:96px; }.ssb-detail-forms { display:grid; grid-template-columns:repeat(auto-fit,minmax(176px,1fr)); gap:16px; border-top:1px solid var(--ssb-border); padding-top:16px; margin-top:16px; }
.ssb-settings-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; }.ssb-settings-intro { min-width:0; display:grid; gap:6px; }.ssb-settings-intro p { margin:0; }
.ssb-provider-head { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; flex-wrap:wrap; }.ssb-provider-adapter { flex:0 0 240px; }.ssb-provider-switches { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }.ssb-provider-desc { margin:8px 0 0; }.ssb-provider-advanced { margin-top:8px; }.ssb-provider-advanced > summary { cursor:pointer; }
/* 摘要行: 数据源与市场默认收成一行, 点开才展开编辑区 */
.ssb-provider, .ssb-market-row { border-bottom:1px solid var(--ssb-border); }
.ssb-provider-toggle, .ssb-market-toggle { display:grid; align-items:center; gap:12px; width:100%; padding:12px 4px; background:none; border:0; color:inherit; font:inherit; text-align:left; cursor:pointer; }
.ssb-provider-toggle { grid-template-columns:10px minmax(96px,auto) minmax(88px,auto) minmax(0,1fr) minmax(88px,auto) 42px; }
.ssb-market-toggle { grid-template-columns:minmax(88px,auto) 52px minmax(0,1fr) minmax(72px,auto) 42px; }
.ssb-provider-toggle:hover, .ssb-market-toggle:hover { background:var(--ssb-hover); }
.ssb-provider-toggle:focus-visible, .ssb-market-toggle:focus-visible { outline:2px solid var(--ssb-accent); outline-offset:-2px; }
.ssb-provider-toggle[aria-expanded="true"], .ssb-market-toggle[aria-expanded="true"] { border-bottom:1px solid var(--ssb-border); }
.ssb-provider-id { font-weight:600; }.ssb-provider-adapter-name { font-size:12px; }.ssb-provider-scope { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.ssb-provider-kind { font-size:12px; text-align:right; }.ssb-provider-edit, .ssb-market-edit { font-size:12px; color:var(--ssb-accent); text-align:right; }
.ssb-provider-body, .ssb-market-body { padding:4px 4px 16px; display:grid; gap:12px; }
.ssb-market-name { font-weight:600; }.ssb-market-code { font-size:11px; color:var(--ssb-text-sub); }.ssb-market-caps { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.ssb-market-back { font-size:12px; color:var(--ssb-text-sub); text-align:right; }
.ssb-market-list { display:grid; }
/* 单元格式: 能力选择 + 单项探针按钮 + 结果徽标 */
.ssb-route-cell-probe { display:grid; grid-template-columns:minmax(0,1fr); gap:4px; align-content:start; }
.ssb-route-cell-main { display:grid; gap:2px; }
.ssb-probe { font:inherit; font-size:11px; padding:2px 6px; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); background:var(--ssb-bg); color:var(--ssb-text-sub); cursor:pointer; }
.ssb-probe:hover:not(:disabled) { color:var(--ssb-text); border-color:var(--ssb-accent); }
.ssb-probe:disabled { opacity:.6; cursor:progress; }
.ssb-probe-result { font-size:11px; font-variant-numeric:tabular-nums; }
.ssb-probe-ok { color:var(--ssb-ok); }
.ssb-probe-bad { color:var(--ssb-danger); }
.ssb-market-head { display:grid; grid-template-columns:minmax(88px,auto) 52px minmax(0,1fr) minmax(72px,auto) 42px; gap:12px; padding:0 4px 6px; font-size:11px; color:var(--ssb-text-dim); border-bottom:1px solid var(--ssb-border); }
.ssb-section-foot { display:grid; gap:6px; padding:12px 0; }.ssb-section-foot p { margin:0; }
.ssb-route-advanced { display:grid; gap:8px; padding-top:8px; border-top:1px solid var(--ssb-border); }
.ssb-kline { margin:16px 0; }.ssb-kline-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px; }.ssb-kline-meta { margin-left:auto; color:var(--ssb-text-sub); font-size:12px; white-space:nowrap; }
/* 图例: 均线/成本的数值只在这里出现, 图面不铺文字标签 */
.ssb-kline-legend { display:flex; flex-direction:column; gap:4px; margin:0 0 8px; font-size:11px; color:var(--ssb-text-sub); font-family:var(--ds-font-family-code); font-variant-numeric:tabular-nums; }
.ssb-legend-row { display:flex; flex-wrap:wrap; align-items:baseline; gap:12px; }
.ssb-legend-label { color:var(--ssb-text-dim); margin-right:4px; }
.ssb-legend-cost { color:var(--ssb-text); }
.ssb-legend-pct { margin-left:4px; }
/* 图例指标色与图表 series 色板一一对应(图表侧只能吃具体色值, 无法引用主题变量) */
.ssb-ma-0 { color:#f59e0b; }.ssb-ma-1 { color:#8b5cf6; }.ssb-ma-2 { color:#06b6d4; }.ssb-ma-3 { color:#64748b; }
.ssb-ema { color:#ec4899; }
.ssb-boll-0 { color:#3b82f6; }.ssb-boll-1 { color:#94a3b8; }.ssb-boll-2 { color:#94a3b8; }
.ssb-bbi { color:#10b981; }
.ssb-menu-title { padding:8px 8px 2px; font-size:11px; color:var(--ssb-text-dim); }.ssb-kline-holder { height:340px; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); }.ssb-kline-skeleton { height:340px; border:1px dashed var(--ssb-border); border-radius:var(--ssb-radius-sm); display:flex; align-items:center; justify-content:center; color:var(--ssb-text-sub); margin-bottom:8px; }
.ssb-detail-grid { display:grid; grid-template-columns:minmax(0,1fr) 240px; gap:16px; align-items:start; }.ssb-detail-side { min-width:0; }.ssb-detail-side .ssb-facts { grid-template-columns:auto minmax(0,1fr); gap:6px 12px; }.ssb-detail-side .ssb-facts dt { white-space:nowrap; }
.ssb-empty { padding:32px 16px; color:var(--ssb-text-sub); text-align:center; }.ssb-banner { border:1px solid var(--ssb-border); border-left:3px solid var(--ssb-warn); border-radius:var(--ssb-radius-sm); padding:12px; margin:12px 0; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }.ssb-banner-ok { border-left-color:var(--ssb-ok); }.ssb-error { border-left-color:var(--ssb-danger); }.ssb-banner p { margin:0; }.ssb-search-view { max-width:760px; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-md); background:var(--ssb-bg); padding-bottom:4px; }.ssb-panel-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px; border-bottom:1px solid var(--ssb-border); flex-wrap:wrap; }.ssb-panel-head h2 { font-size:16px; margin:0; }.ssb-panel-body { padding:16px; display:flex; flex-direction:column; gap:12px; }.ssb-form-row { display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; }.ssb-form-row > .ssb-field { flex:0 0 176px; }.ssb-search-label { display:grid; gap:8px; margin-top:20px; }.ssb-form-row > .ssb-search-label { flex:1 1 300px; margin-top:0; }.ssb-results { display:grid; gap:8px; margin:16px; }.ssb-candidate { padding:10px 12px; display:flex; justify-content:space-between; align-items:center; gap:12px; background:transparent; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); color:var(--ssb-text); font:inherit; cursor:pointer; }.ssb-candidate:hover { border-color:var(--ssb-accent); }.ssb-candidate.ssb-selected { background:var(--ssb-accent-wash); border-color:var(--ssb-accent); }.ssb-peek { display:flex; flex:1; flex-direction:column; gap:2px; text-align:left; cursor:pointer; min-width:0; }.ssb-peek:hover strong { text-decoration:underline; }.ssb-provider { border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-md); padding:16px; margin:12px 0; min-width:0; }.ssb-provider legend { padding:0 6px; color:var(--ssb-text-sub); }.ssb-provider details { grid-column:1 / -1; }.ssb-provider summary { cursor:pointer; }.ssb-reqlog { margin:8px 0 0; padding:0 0 0 18px; color:var(--ssb-text-sub); }.ssb-form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }.ssb-route-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(132px,1fr)); gap:12px; }.ssb-route-cell { display:grid; gap:6px; min-width:0; }.ssb-route-cell-label { color:var(--ssb-text-sub); font-size:11px; }.ssb-route-cell select { width:100%; min-width:0; }.ssb-route-advanced { margin-top:12px; }.ssb-route-advanced > summary { cursor:pointer; }.ssb-route-tune { display:flex; align-items:flex-end; gap:12px; flex-wrap:wrap; padding:8px 0; border-top:1px solid var(--ssb-border); }.ssb-route-tune-label { min-width:32px; color:var(--ssb-text-sub); }.ssb-route-delay { flex:0 0 120px; }
.ssb-switch { display:inline-flex; align-items:center; gap:8px; cursor:pointer; position:relative; }.ssb-switch input[type="checkbox"] { position:absolute; opacity:0; width:1px; height:1px; }.ssb-switch__track { display:inline-flex; flex-shrink:0; align-items:center; width:34px; height:19px; padding:3px; border-radius:999px; background:var(--ssb-bg-muted); border:1px solid var(--ssb-border); transition:background .15s ease; }.ssb-switch__thumb { width:13px; height:13px; border-radius:50%; background:var(--ssb-text-sub); transition:transform .15s ease; }.ssb-switch input[type="checkbox"]:checked + .ssb-switch__track { background:var(--ssb-accent); }.ssb-switch input[type="checkbox"]:checked + .ssb-switch__track .ssb-switch__thumb { transform:translateX(13px); background:var(--ssb-bg); }.ssb-switch input[type="checkbox"]:focus-visible + .ssb-switch__track { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }.ssb-switch input[type="checkbox"]:disabled + .ssb-switch__track { opacity:.5; cursor:not-allowed; }.ssb-switch:hover .ssb-switch__track { border-color:var(--ssb-accent); }.ssb-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
@media(max-width:720px) { .ssb-detail-grid { grid-template-columns:minmax(0,1fr); } }
@media(max-width:959px) { .ssb-content { grid-template-columns:minmax(0,1fr); }.ssb-page { padding:16px; } }
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
        React.createElement('style', { 'data-plugin': '@mzzsfy/dsh-stock-assistant', dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'ssb-page' }, h('header', { className: 'ssb-header' }, h('div', null, h('h1', null, '股票'), h('p', { className: 'ssb-muted' }, scopeText(data?.control.watchlist.order || []))), h('nav', { className: 'ssb-toolbar', 'aria-label': '股票工具操作' },
          h(Button, { primary: view.view === 'list', onClick: () => runtime.updateView({ view: 'list' }) }, '自选'), h(Button, { primary: view.view === 'browse', onClick: () => { runtime.updateView({ view: 'browse' }); if (!runtime.getSnapshot().view.browseRows) quiet(() => runtime.loadBrowse('XSHG', 0))() } }, '市场'), h(Button, { primary: view.view === 'search', onClick: () => runtime.updateView({ view: 'search' }) }, '搜索'), h(Button, { disabled: !data || state.busy.refresh, onClick: quiet(runtime.refresh) }, state.busy.refresh ? '刷新中…' : '刷新'),
          h('div', { className: 'ssb-more', style: { position: 'relative' } }, h(Button, { 'aria-label': '更多操作', 'aria-expanded': !!view.menuOpen, onClick: () => runtime.updateView({ menuOpen: !view.menuOpen }) }, '更多'), view.menuOpen ? h('div', { className: 'ssb-menu', style: { position: 'absolute', right: 0, top: 'calc(100% + 4px)', background: 'var(--ssb-bg)', border: '1px solid var(--ssb-border)', borderRadius: 'var(--ssb-radius-md)', padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px', zIndex: 10, minWidth: '140px' }, role: 'menu' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px' } }, h(Toggle, { label: '暂停采集', checked: state.paused, onChange: runtime.setPaused })),
            h('div', { className: 'ssb-muted', style: { padding: '0 8px', fontSize: '11px' } }, `${(data?.control.providers || []).filter(p => p.enabled).length}/${(data?.control.providers || []).length} 源启用${state.data?.klineReady ? ` · K线 ${Object.keys(state.data.klineReady).length} 市场` : ''}`),
            h(Button, { onClick: () => { writePref(FLOAT_KEY, { ...readPref(FLOAT_KEY, FLOAT_DEFAULT), open: !readPref(FLOAT_KEY, FLOAT_DEFAULT).open }); runtime.updateView({ menuOpen: false }) } }, readPref(FLOAT_KEY, FLOAT_DEFAULT).open ? '关闭悬浮盯盘' : '悬浮盯盘'),
            h(Button, { onClick: () => { runtime.updateView({ view: 'list', overlay: 'settings', menuOpen: false }) } }, '设置'),
            h(Button, { onClick: () => { runtime.updateView({ menuOpen: false }); layout.selectPanel(null) } }, '返回对话')) : null))),
          state.error ? h('div', { className: 'ssb-banner ssb-error', role: 'alert' }, state.error, h(Button, { onClick: () => runtime.updateView({ view: 'list', overlay: 'settings' }) }, '检查设置')) : null,
          state.view.notice ? h('div', { className: 'ssb-banner', role: 'status' }, state.view.notice, h(Button, { onClick: () => runtime.updateView({ notice: '' }) }, '知道了')) : null,
          data?.ensureError ? h('div', { className: 'ssb-banner', role: 'status' }, `后台目录同步失败：${data.ensureError.message}。可在设置中手动同步。`, h(Button, { onClick: () => runtime.updateView({ view: 'list', overlay: 'settings' }) }, '前往设置')) : null,
          state.paused ? h('div', { className: 'ssb-banner', role: 'status' }, '自动采集已暂停，保留当前行情。', h(Button, { onClick: () => runtime.setPaused(false) }, '恢复采集')) : null,
          state.undo && state.undo.until > Date.now() ? h('div', { className: 'ssb-banner', role: 'status' }, '已移除自选。', h(Button, { disabled: state.busy.write, onClick: quiet(() => runtime.mutate('restore', { removeOperationId: state.undo.removeOperationId })) }, '撤销')) : null,
          !data ? h('div', { className: 'ssb-empty', role: 'status' }, '正在加载股票工具…') : view.view === 'search' ? h(SearchView, { runtime, state }) : view.view === 'browse' ? h(BrowseView, { runtime, state }) : h('div', { className: 'ssb-content' }, h(Watchlist, { runtime, state })),
          data && view.overlay ? h(Overlay, { runtime, state, layout }) : null,
          h('p', { className: 'ssb-foot ssb-muted' }, '价格与涨跌来自同一数据源。延迟未知表示来源未明确承诺时效。')))
    }
    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        if (!ctx.slots?.inject || !ctx.layout?.panelInfo?.subscribe) return
        const bus = tools.setupCommonTools(ctx)
        const runtime = createPageRuntime({ layout: ctx.layout, bus, tools })
        ctx.effect(() => () => runtime.dispose(), 'stock-assistant page runtime')
        // 悬浮盯盘单独挂到 body: 它要在切走面板后继续存在, 不能跟着面板插槽一起卸载
        ctx.effect(() => {
          // 无 DOM 的宿主环境(测试/SSR)直接跳过, 不能让挂载失败连累面板注册
          const body = globalThis.document?.body
          if (!body) return () => {}
          const host = globalThis.document.createElement('div')
          host.className = 'ssb-float-root'
          body.appendChild(host)
          let root = null
          try { root = require('react-dom/client').createRoot(host) } catch { host.remove(); return () => {} }
          root.render(h(FloatingTicker, { runtime }))
          return () => { try { root.unmount() } catch {} host.remove() }
        }, 'stock-assistant floating ticker')
        ctx.effect(() => {
          const disposers = [
            ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(StockPage, { runtime, layout: ctx.layout }))),
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, label: '股票' }, props => h(PanelIcon, props))),
          ]
          return () => { for (const stop of disposers.reverse()) stop() }
        }, 'stock-assistant main panel')
      },
      __testing: { createPageRuntime, StockPage, dragOrder },
    }
  },
})
