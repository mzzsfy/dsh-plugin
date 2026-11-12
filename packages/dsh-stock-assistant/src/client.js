window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-stock-assistant',
  factory(require) {
    const PANEL_ID = 'stock-assistant', BASE = '/api/stock-assistant', BROWSE_PAGE = 50
    // 单票标签上限与服务端 schemas.MAX_TAGS 一致, 由 tags-schema 测试守卫; 客户端只做前置提示, 服务端仍校验
    const MAX_TAGS = 8
    // K线结果的归属键: 拉取、校验、灌图三处必须用同一个拼法, 否则校验形同虚设
    function klineKeyOf(securityId, period) { return `${securityId}|${period}` }
    // 灌图计划: 空壳只清屏且不记 key(空数据上 fitContent 是 no-op, 记了就再也不会铺满);
    // 首次看到某个 key 才重置视口, 同一 key 下刷新保留用户缩放
    function klineShipPlan(shippedKey, key, hasData) {
      if (!hasData) return { fit: false, next: shippedKey }
      return { fit: shippedKey !== key, next: key }
    }
    // 分组 tab 的保留键: 标签名来自用户输入且只校验长度, 用不可见前缀保证不会与真实标签撞键
    const ALL_TAB_KEY = '\u0000all', REST_TAB_KEY = '\u0000rest', TAG_PREFIX = 'tag:', WATCHLIST_PANEL_ID = 'ssb-watchlist-panel'
    // 自选的分组切面: 全部 → 各标签(按首次出现顺序) → 未分组(仅当有无标签票)。
    // 一只票可有多个标签, 因此会同时出现在多个 tab 里; 列表与详情编辑共用这一份归属答案
    function tagTabs(order, items) {
      // 只认确实存在的标的: 自选与明细表短暂不一致时, 不存在的 id 既不该进 tab 也不该进未分组
      const known = order.filter(id => items[id])
      const tagsOf = id => items[id].tags || []
      const names = [...new Set(known.flatMap(tagsOf))]
      const tabs = [
        { key: ALL_TAB_KEY, label: '全部', ids: known },
        ...names.map(name => ({ key: `${TAG_PREFIX}${name}`, label: name, ids: known.filter(id => tagsOf(id).includes(name)) })),
      ]
      const rest = known.filter(id => !tagsOf(id).length)
      if (rest.length) tabs.push({ key: REST_TAB_KEY, label: '未分组', ids: rest })
      return tabs
    }
    // 激活键可能已失效(标签被解散或改名): 回退首个 tab, 而不是渲染空白列表
    const resolveTab = (tabs, key) => tabs.find(tab => tab.key === key) || tabs[0]
    // 来源偶发给 null 字段: LWC 只跳过 undefined, null 会按 0 参与价格轴范围把整图压扁;
    // 而非有限的 OHLC 又不能留成 NaN —— 它会顺着均线的滑动窗口把后面所有指标值一起毒掉。
    // 所以四个价格有任一缺失就丢掉整根, 其余字段(avg/amount 等)原样带过去: 分时均价线靠 avg
    // 两份报价里取较新的一份: 自己拉的和面板的都可能旧, 平局取前者
    const pickNewest = (mine, theirs) => {
      if (!mine) return theirs
      if (!theirs) return mine
      return (Number(mine.receivedAt) || 0) >= (Number(theirs.receivedAt) || 0) ? mine : theirs
    }
    // 分时蜡烛的时间是 HH:MM 标签, 日期解析器认不出来
    const CLOCK = /^\d{1,2}:\d{2}(:\d{2})?$/
    function sanitizeCandles(list) {
      return (list || []).flatMap(candle => {
        const prices = { open: finiteOr(candle.open), high: finiteOr(candle.high), low: finiteOr(candle.low), close: finiteOr(candle.close) }
        if (!Object.values(prices).every(Number.isFinite)) return []
        // 时间戳坏掉整根丢弃: 图表库遇到非法日期字符串会抛, 而异常发生在 effect 里,
        // 会把整块图表连同面板一起卸掉, 代价远大于少一根蜡烛.
        // 注意不能用 Number() 来判断——Number('') / Number(true) / Number([]) 全是有限值
        const at = candle.at, time = candle.time
        if (at != null && !(typeof at === 'number' ? Number.isFinite(at) : typeof at === 'string' && !Number.isNaN(Date.parse(at)))) return []
        if (time != null && !(typeof time === 'number' ? Number.isFinite(time) : typeof time === 'string' && (CLOCK.test(time) || !Number.isNaN(Date.parse(time))))) return []
        const volume = finiteOr(candle.volume), avg = finiteOr(candle.avg)
        // 缺失一律给 undefined 而不是 NaN, 让下游的 ?? / 默认值能正常接住
        return [{ ...candle, ...prices, volume: Number.isFinite(volume) ? volume : undefined, avg: Number.isFinite(avg) ? avg : undefined }]
      })
    }
    // 缺失值不是 0: 直接 Number() 会把 null 变成真实的 0, 画到图上就是一条压在地板上的线
    const finiteOr = value => value == null || value === '' ? NaN : Number(value)
    // 多笔成本取最低价作为成本基准: 汇总盈亏按它算, 其余成本只作参考线(各自仍显示与现价的百分比)
    const costBaseOf = marks => { const prices = (marks || []).filter(mark => mark.kind === 'cost').map(mark => mark.price); return prices.length ? Math.min(...prices) : null }
    // 价格标记按该证券的价位精度显示: 港股四位小数, 用 toString 会丢位数
    const priceTextOf = (value, scale) => value == null || value === '' || Number.isNaN(Number(value)) ? '—' : Number(value).toFixed(scale ?? 2)
    // 涨跌方向只在这里判一次: 面板与悬浮窗共用, 避免 0 被显示成涨或被当成跌
    const toneClass = pct => {
      const num = finiteOr(pct)
      return Number.isFinite(num) ? num > 0 ? ' ssb-up' : num < 0 ? ' ssb-down' : '' : ''
    }
    // 每个标记各自的盈亏口径: 成本看「现价相对它」的浮盈, 卖价看「它相对成本」的潜在收益,
    // 还没有成本时卖价退回相对现价——三个口径都是同一个式子, 只是基准不同
    const markPct = (mark, last, costBase) => {
      const base = mark.kind === 'cost' ? mark.price : costBase ?? last
      return base == null || last == null ? null : (mark.kind === 'cost' ? last - base : mark.price - base) / base * 100
    }
    // 成交额按万/亿缩写避免长列; zeroIsMissing 关掉时 0 按真值显示(成交量用)
    function formatAmount(value, { zeroIsMissing = true } = {}) {
      if (value == null) return '—'
      const amount = Number(value)
      if (!Number.isFinite(amount) || (zeroIsMissing && amount === 0)) return '—'
      if (Math.abs(amount) >= 1e8) return `${(amount / 1e8).toFixed(1)}亿`
      if (Math.abs(amount) >= 1e4) return `${(amount / 1e4).toFixed(0)}万`
      return amount.toFixed(0)
    }
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
          let result
          try { result = await response.json() } catch (error) {
            // 读响应体被中止(超时/页面重置)属于外部取消, 不能伪装成服务故障
            if (error?.name === 'AbortError') throw error
            // 插件 host 半区未激活时宿主对未注册路由回纯文本 "not found", 解析器报错对用户无信息量
            const unavailable = new Error(`股票工具服务不可用（HTTP ${response.status}）`)
            unavailable.code = 'SERVICE_UNAVAILABLE'
            throw unavailable
          }
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
      // 换详情即清草稿: 收口在唯一的视图写入口, 浏览/搜索/悬浮窗/邻移都不必各自记得清,
      // 否则上一只输了一半的成本会被"保存成本"写到另一只身上。
      // 别名同理在这里回填: 新增一条打开路径时不必记得带 alias, 漏带的后果是把已存别名保存成空串。
      function updateView(next) {
        const leaveDetail = next.view && next.view !== 'detail' && !next.overlay
        const detailChanged = next.detailId !== undefined && next.detailId !== state.view.detailId
        const saved = next.detailId === undefined ? undefined : (state.data?.control.watchlist.items[next.detailId] || state.view.browsePeek?.[next.detailId])
        const alias = next.alias !== undefined ? { alias: next.alias } : detailChanged ? { alias: saved?.alias || '' } : {}
        patch({ view: { ...state.view, ...next, ...alias, ...(leaveDetail ? { detailId: null, alias: '', browsePeek: {} } : {}), ...(detailChanged ? { markDraft: null, tagDraft: null, markError: null, tagError: null } : {}) } })
        sendDemand()
      }
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
      // K线请求代际: 同 key 并发时只认最后一次发出的请求
      let klineSeq = 0
      return {
        getSnapshot: () => state,
        subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn) },
        updateView, api, action, applySnapshot,
        // 详情只有一个入口: 面板/邻移/悬浮窗都走这里。
        // 面板不在前台时"打开详情"点了没反应, 所以先 selectPanel; 草稿由 updateView 在 detailId 变更处统一清。
        // 不预载 K 线: KlineView 的加载 effect 会在 detailId 变化时自己发起, 预载只会让同一 key 请求两遍。
        openDetail(securityId) {
          const config = state.data?.control, item = config?.watchlist.items[securityId] || state.view.browsePeek?.[securityId]
          if (!item) return
          layout.selectPanel?.(PANEL_ID)
          updateView({ view: 'list', detailId: securityId, selectedId: securityId, overlay: 'detail' })
          // 这里必须经 this 调用同对象的成员, 所以 openDetail 只能以 runtime.openDetail(...) 形式使用
          this.refresh([{ id: item.id, exchange: item.exchange, code: item.code, officialName: item.officialName }]).catch(() => {})
        },
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
        // 错误同样带 key: 结果只在它属于当前标的与周期时才落进 state, 否则卸载/切换后的迟到错误会清掉别的标的
        setKlineError(securityId, period, message, code = '') { if (state.klineKey !== klineKeyOf(securityId, period)) return; patch({ kline: { loading: false, error: message, errorCode: code, candles: null } }) },
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
          const key = klineKeyOf(securityId, period)
          const sameKey = state.klineKey === key, held = sameKey ? state.kline : null
          const maxAge = KLINE_MAX_AGE[period] ?? 0
          const fresh = held?.candles && Date.now() - (held.loadedAt || 0) < maxAge
          if (fresh && !force) return Promise.resolve(held)
          // 同一 key 也可能并发(例如 ↻ 连点): 只让最后一次发出的请求落地, 否则先发后到会盖掉新的
          const seq = ++klineSeq
          patch({ klineKey: key, kline: { loading: !held?.candles, error: '', candles: held?.candles ?? null, loadedAt: held?.loadedAt } })
          const attempt = (delayMs = 0, retried = false) => new Promise(resolve => setTimeout(resolve, delayMs)).then(() => {
            // 退避期间可能已经来了同 key 的新请求, 等到点了就别再打这一枪
            if (seq !== klineSeq) return undefined
            return api(`/kline?${new URLSearchParams({ securityId, period, limit: String(250), ...(force ? { force: '1' } : {}) })}`, 'GET')
          }).then(result => {
            // 等待期间换了标的/周期, 或已有更新的同 key 请求: 丢弃这轮结果, 否则旧数据会盖掉新数据
            if (state.klineKey !== key || seq !== klineSeq) return result
            const candles = sanitizeCandles(result?.candles)
            patch({ kline: { loading: false, error: '', loadedAt: Date.now(), ...result, candles } })
            return { ...result, candles }
          }).catch(e => {
            // 已被更新的同 key 请求取代: 既不该落错误(会盖掉新数据), 也不该继续退避
            if (seq !== klineSeq) return undefined
            // 切走之后就别再为废弃的 key 退避重试了, 白打一次请求还占额度
            if (state.klineKey !== key) throw e
            // 额度窗口瞬时满/网络抖动: 退避自动重试一次; 服务端带 retryAfterMs 时按其等待, 否则 4s
            if (!retried && ['RATE_LIMIT', 'NETWORK', 'TIMEOUT'].includes(e.code)) return attempt(Math.max(4 * 1000, e.retryAfterMs || 0), true)
            patch({ kline: { loading: false, error: e.message || 'K线加载失败', errorCode: e.code, candles: null } })
            throw e
          })
          return attempt()
        },
        // key 不匹配说明是上标的一轮结果, 交给当前轮的 effect 灌
        getKlineResult(securityId, period) { return state.klineKey === klineKeyOf(securityId, period) && state.kline?.candles ? state.kline : null },
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
    // 包住点击处理: 事件对象不会被当成业务参数透传, 而且要把 promise 交回去,
    // 调用方才能等写入成功再改本地 UI 状态
    const quiet = fn => (...args) => Promise.resolve().then(() => fn(...args)).catch(() => { })
    const signed = value => value == null ? '—' : `${Number(value) > 0 ? '+' : ''}${value}`
    const timeText = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未知'
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
    // 时刻解析: 行情时间可能是 ISO 串、毫秒或秒(unix), 缺失与坏值都返回 null(不能落成 0)
    const timestampOf = value => {
      if (value == null || value === '') return null
      const ms = typeof value === 'number' ? (value > 0 && value < 1e12 ? value * 1000 : value) : Date.parse(value)
      return Number.isFinite(ms) ? ms : null
    }
    // 悬浮窗的展示时刻与陈旧判定必须同源: 展示取自成一体的分时却用报价的接收时间判黄,
    // 会出现"图是新的、卡却标黄"的假告警, 几次之后用户就不再信这个颜色
    function floatFreshness({ mode, quoteTimes, liveQuoteTimes, trendAt, quiet, now, refreshSeconds }) {
      const stale = stamp => stamp != null && !quiet && now - stamp > staleAfter(refreshSeconds)
      if (mode === 'kline' && trendAt != null) return { stamp: trendAt, stale: stale(trendAt) }
      const stamp = quoteTimes.length ? Math.min(...quoteTimes) : null
      // 列表里收市/午休的报价本来就不动, 不参与判黄; 全休市时无活口, 只给时刻
      return { stamp, stale: liveQuoteTimes.length ? stale(Math.min(...liveQuoteTimes)) : false }
    }
    // 展示用时刻: 当天只给时分秒, 跨天补日期——常驻窗挂过夜后, 只看得见时刻会读成今天的收盘。
    // now 只供测试钉住"今天", 生产按真实时钟
    const clockText = (value, now = Date.now()) => {
      // Number(null) 是 0, 会把缺失值渲染成 1970; 空值必须在进 Date 之前拦掉
      if (value == null || value === '') return ''
      const stamp = new Date(Number(value))
      if (Number.isNaN(stamp.getTime())) return ''
      const day = date => new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
      const time = stamp.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hourCycle: 'h23' })
      return day(stamp) === day(now) ? time : `${day(stamp).slice(5)} ${time}`
    }
    // 多久没更新算可疑: 三倍刷新间隔, 下限两分钟; 低于它只是正常的轮询抖动
    const staleAfter = refreshSeconds => Math.max(2 * 60 * 1000, 3 * (Number(refreshSeconds) || 15) * 1000)
    // 价格时刻: 有成交时间就用成交时间(用户问的是"这个价是几点的"), 来源没给才退回取数时刻
    const priceTimeOf = quote => timestampOf(quote?.quoteAt) ?? timestampOf(quote?.receivedAt)
    // 分时悬停: 按水平比例取最近一根, 越界夹到两端
    const sparkIndexAt = (ratio, count) => {
      if (!count) return -1
      const value = Number.isFinite(ratio) ? ratio : 0
      return Math.min(count - 1, Math.max(0, Math.round(value * (count - 1))))
    }
    // 分时时间标签: 分时来源多半直接给 HH:MM, 缺了才退回时间戳
    const candleTimeText = candle => {
      if (typeof candle?.time === 'string' && CLOCK.test(candle.time)) return candle.time
      const at = timestampOf(candle?.at)
      return at == null ? '' : new Date(at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hourCycle: 'h23' })
    }
    // 分时纵轴: 1 倍时容纳数据与昨收, 放大后以数据区间为中心——用含昨收的中点会在
    // 一字板/涨停横盘这类贴边行情把整条曲线挤出窗, 拆开后数据始终绕中心
    function sparkRangeOf({ values, preClose, zoom = 1 }) {
      if (!values.length) return { low: 0, high: 1, zoom: 1 }
      const base = finiteOr(preClose)
      const low = Math.min(...values), high = Math.max(...values)
      const factor = Math.max(1, Math.min(12, Number(zoom) || 1))
      const all = factor <= 1 && Number.isFinite(base) ? [Math.min(low, base), Math.max(high, base)] : [low, high]
      // 十字线/一字板: 数据跨度为 0 时给一个极小窗口, 否则缩放后范围退化成一条线
      const span = Math.max(all[1] - all[0], Math.max(Math.abs(all[1]), 1) * 0.002)
      const center = (all[0] + all[1]) / 2, half = span / 2 / factor
      return { low: center - half, high: center + half, zoom: factor }
    }
    // 右侧刻度: 间隔取 0.02/0.05/0.1/0.2/0.5/1/2/5/10/50/100/200/500 的整档, 落点按可视最高最低算
    const SPARK_TICK_STEPS = [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 50, 100, 200, 500]
    function sparkTicksOf({ low, high, max = 4 }) {
      if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return []
      const collect = step => {
        const out = []
        // 减一点再取整, 免得 30.1/0.1 的浮点误差把 30.1 自己漏掉
        for (let value = Math.ceil(low / step - 1e-9) * step; value <= high + step * 1e-9 && out.length < max + 2; value += step) out.push(Number(value.toFixed(4)))
        return out
      }
      // 挑第一个放得下且至少两个点的档位
      for (const step of SPARK_TICK_STEPS) {
        const ticks = collect(step)
        if (ticks.length >= 2 && ticks.length <= max) return ticks
      }
      // 档位都不合适(区间过宽或过窄): 等分覆盖整个区间, 数量仍守 2~max
      const step = (high - low) / (max - 1)
      return Array.from({ length: max }, (_, index) => Number((low + step * index).toFixed(4)))
    }
    // 列表悬停: 当日区间与全部标记; 缺字段给破折号, 不能把 null 当 0 显示
    function quoteTipLines({ quote, marks, scale }) {
      const price = value => priceTextOf(value, scale)
      return [
        `今高 ${price(quote?.high)}　今低 ${price(quote?.low)}`,
        `今开 ${price(quote?.open)}　昨收 ${price(quote?.previousClose)}`,
        ...(marks || []).map(mark => `${mark.kind === 'cost' ? '成本' : '卖价'} ${price(mark.price)}`),
      ]
    }
    // K线十字线读数: 图例只报最后一根, 悬停时要能读到光标下那根的开高低收与量
    function crosshairTipLines({ candle, scale, trend, preClose, volume, series }) {
      const price = value => priceTextOf(value, scale)
      const last = finiteOr(candle?.close ?? candle?.value)
      const base = finiteOr(preClose)
      const pct = Number.isFinite(last) && Number.isFinite(base) && base ? (last - base) / base * 100 : null
      const pctText = pct == null ? '—' : `${signed(pct.toFixed(2))}%`
      const vol = volume ?? candle?.volume
      const amount = `量 ${vol == null ? '—' : formatAmount(vol, { zeroIsMissing: false })}`
      const rows = trend
        ? [`价 ${price(last)}`, pctText].concat(volume == null ? [] : [amount])
        : [`开 ${price(candle?.open)}　高 ${price(candle?.high)}`, `低 ${price(candle?.low)}　收 ${price(candle?.close)}`, `${pctText}　${amount}`]
      // 指标线与浮层同源: 只列开着的, 成对排一行, 免得十几条把浮层撑出画布
      for (let at = 0; at < (series || []).length; at += 2) rows.push(series.slice(at, at + 2).map(([label, value]) => `${label} ${price(value)}`).join('　'))
      return rows
    }
    // 时间键归一: 日K的 time 可能是字符串或 BusinessDay, 分时是 Unix 秒, 跨形态比较前先拍平
    function timeKeyOf(time) {
      if (typeof time === 'number' || typeof time === 'string') return time
      return time?.year ? `${time.year}-${time.month}-${time.day}` : ''
    }
    function crosshairTimeText(time, trend, zone) {
      if (time == null) return ''
      if (trend) return Number.isFinite(time) ? new Intl.DateTimeFormat('zh-CN', { timeZone: zone || 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date(time * 1000)) : ''
      if (typeof time === 'string') return time
      if (time?.year) { const pad = n => String(n).padStart(2, '0'); return `${time.year}-${pad(time.month)}-${pad(time.day)}` }
      return ''
    }
    // 读数浮层贴光标右上, 靠边时翻到内侧: 固定在画布上, 不跟着价格轴漂
    function crosshairTipStyle({ point, width, height }) {
      return { left: Math.max(4, Math.min(point.x + 14, Math.max(4, width - 204))), top: Math.max(4, Math.min(point.y + 14, Math.max(4, height - 160))) }
    }
    // 列表悬停浮层: 高度按行数估算, 下方放不下就翻到行上方, 多标记时也不能撞出视口
    const ROWTIP_LINE = 17.4, ROWTIP_PAD = 12
    function rowTipPositionOf({ top, bottom, lines, viewportHeight }) {
      const height = lines * ROWTIP_LINE + ROWTIP_PAD
      const limit = viewportHeight - height - 8
      return { height, top: top + height > viewportHeight - 8 ? Math.max(8, Math.min(bottom - height, limit)) : Math.max(8, Math.min(top, limit)) }
    }
    // 标记价提醒: 现价从安全侧越到标记侧才触发一次, 回到安全侧还要再离开一个滞回幅度
    // 才算重新武装, 两次触发之间另有冷却——阈值附近的抖动与来回穿越都不该连续叫人
    const MARK_ALERT_HYSTERESIS = 0.005
    const MARK_ALERT_COOLDOWN_MS = 5 * 60 * 1000
    function markAlertOf({ mark, price, prev, lastFiredAt, now, cooldown = MARK_ALERT_COOLDOWN_MS, hysteresis = MARK_ALERT_HYSTERESIS }) {
      if (!mark || !Number.isFinite(price)) return { side: prev === 'hit' ? 'hit' : 'safe', fire: false }
      const up = mark.kind === 'target'
      const hit = up ? price >= mark.price : price <= mark.price
      const safe = up ? price <= mark.price * (1 - hysteresis) : price >= mark.price * (1 + hysteresis)
      // 滞回带维持上一侧: 没有它, 一个 tick 的抖动就能把标记重新武装
      const side = hit ? 'hit' : safe ? 'safe' : prev === 'hit' ? 'hit' : 'safe'
      const fire = side === 'hit' && prev !== 'hit' && (lastFiredAt == null || now - lastFiredAt >= cooldown)
      return { side, fire }
    }
    // 文案: 名称 + 现价 + 越过的是哪个标记 + 相对标记的幅度
    function markAlertText({ name, price, mark, scale }) {
      const digits = Number.isInteger(scale) ? scale : 2
      const pct = mark.price ? (price - mark.price) / mark.price * 100 : null
      const action = mark.kind === 'target' ? '达到卖价' : '跌破成本'
      return {
        title: `行情提醒 · ${name}`,
        body: `${name} 现价 ${price.toFixed(digits)}，${action} ${mark.price.toFixed(digits)}${pct == null ? '' : `（${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%）`}`,
      }
    }
    // 分发: 装了通知插件就交给它的通道——它有自己的开关与专注静默, 绕过等于无视用户设置;
    // 没装才降级为本卡闪烁 + 标题闪烁, 有通知权限再收一条系统通知
    function deliverMarkAlert({ alert, key, hub, blink, flash, notify }) {
      // 桥接只在契约版本对得上时才用: 版本不符或调用抛错都退回本地降级, 不能让提醒静默丢失。
      // 正常返回后即使一条都没发也不再走本地——那是用户自己关掉了通道, 不能绕过
      if (hub && hub.version === 1 && typeof hub.notify === 'function') {
        try {
          const result = hub.notify({ key, title: alert.title, body: alert.body })
          return { via: 'bridge', delivered: Array.isArray(result?.delivered) ? result.delivered : [] }
        } catch { /* 落到下面的本地通道 */ }
      }
      if (typeof blink === 'function') blink()
      if (typeof flash === 'function') flash()
      if (typeof notify === 'function' && notify(alert.title, alert.body, key)) return { via: 'local', delivered: ['notification'] }
      return { via: 'local', delivered: [] }
    }
    // 浏览器系统通知: 权限只在开关打开时申请(浏览器要求在用户手势里), 这里只负责发
    function sendBrowserNotification(title, body, tag) {
      try {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false
        new Notification(title, { body, tag })
        return true
      } catch { return false }
    }
    function requestAlertPermission() {
      // 浏览器通知权限是前置条件, 与有没有通知插件无关: 授权后桥接那边才发得出系统通知
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().then(() => {}, () => {})
      } catch { }
    }
    // 降级标题闪烁: 1s 交替前缀, 最长 30s, 窗口聚焦即停; 同一页面只跑一条
    const ALERT_BLINK_MS = 1000, ALERT_BLINK_MAX_MS = 30 * 1000
    let alertBlink = null
    function stopAlertBlink() {
      if (!alertBlink) return
      clearInterval(alertBlink.timer)
      clearTimeout(alertBlink.limit)
      if (alertBlink.onFocus) window.removeEventListener('focus', alertBlink.onFocus)
      document.title = document.title.replace(/^🔔 /, '')
      alertBlink = null
    }
    function startAlertBlink() {
      // 人就在页面前时闪标题没有意义, 与"窗口聚焦即停"的承诺一致
      if (alertBlink || typeof document === 'undefined' || typeof window === 'undefined' || document.hasFocus?.() === true) return
      const base = () => document.title.replace(/^🔔 /, '')
      const state = { timer: null, limit: null, onFocus: null }
      state.timer = setInterval(() => { document.title = document.title.startsWith('🔔 ') ? base() : `🔔 ${base()}` }, ALERT_BLINK_MS)
      state.limit = setTimeout(stopAlertBlink, ALERT_BLINK_MAX_MS)
      state.onFocus = () => stopAlertBlink()
      window.addEventListener('focus', state.onFocus)
      alertBlink = state
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
    // 自绘下拉: 原生 select 的菜单不进 DOM, 自动化点不到也断言不了; 换成 listbox 后「打开→选择」全链路可测
    const DROPDOWN = { itemHeight: 28, padding: 8, gap: 4, maxHeight: 240, edge: 8 }
    // 菜单定位: 下方空间不够且上方更宽裕时向上弹, 左右夹在视口内; 高度取可用方向的空间
    function dropdownPlacement(rect, viewport, count) {
      const height = Math.min(count * DROPDOWN.itemHeight + DROPDOWN.padding, DROPDOWN.maxHeight)
      const below = viewport.height - rect.bottom - DROPDOWN.gap - DROPDOWN.edge
      const above = rect.top - DROPDOWN.gap - DROPDOWN.edge
      const up = below < height && above > below
      const maxHeight = Math.max(DROPDOWN.itemHeight, Math.min(height, Math.floor(up ? above : below)))
      const left = Math.max(DROPDOWN.edge, Math.min(rect.left, viewport.width - rect.width - DROPDOWN.edge))
      return { left, top: up ? Math.max(DROPDOWN.edge, rect.top - DROPDOWN.gap - maxHeight) : rect.bottom + DROPDOWN.gap, minWidth: rect.width, maxHeight }
    }
    function Select({ value, options, onChange, disabled = false, label }) {
      const [open, setOpen] = React.useState(false), [active, setActive] = React.useState(0), [place, setPlace] = React.useState(null)
      const rootRef = React.useRef(null), triggerRef = React.useRef(null), menuRef = React.useRef(null), menuId = React.useId()
      const selectedAt = Math.max(0, options.findIndex(option => option.value === value))
      const current = options[selectedAt]
      const close = React.useCallback(() => setOpen(false), [])
      // 打开时才量坐标: 设置页有折叠区, 渲染期算出的位置会过期
      const openMenu = React.useCallback(() => {
        if (disabled || !triggerRef.current) return
        setPlace(dropdownPlacement(triggerRef.current.getBoundingClientRect(), { width: innerWidth, height: innerHeight }, options.length))
        setActive(selectedAt); setOpen(true)
      }, [disabled, options.length, selectedAt])
      React.useEffect(() => {
        if (!open) return
        const onPointer = event => { if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) close() }
        // 收菜单只针对页面级滚动: 菜单自身 maxHeight 裁剪后的内部滚动(option
        // scrollIntoView/滚轮)会以 capture 冒到这里, 关掉自己会让点击落空
        const onMove = event => { if (!menuRef.current || event.target !== menuRef.current) close() }
        document.addEventListener('pointerdown', onPointer, true)
        window.addEventListener('scroll', onMove, true)
        window.addEventListener('resize', onMove)
        return () => { document.removeEventListener('pointerdown', onPointer, true); window.removeEventListener('scroll', onMove, true); window.removeEventListener('resize', onMove) }
      }, [open, close])
      React.useEffect(() => { if (disabled) close() }, [disabled, close])
      const choose = index => {
        const option = options[index]
        if (!option) return
        setOpen(false); triggerRef.current?.focus()
        if (option.value !== value) onChange(option.value)
      }
      const onKeyDown = event => {
        if (disabled) return
        if (!open) {
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openMenu() }
          return
        }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
        if (event.key === 'Tab') { close(); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(at => Math.max(0, Math.min(options.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))); return }
        if (event.key === 'Home') { event.preventDefault(); setActive(0); return }
        if (event.key === 'End') { event.preventDefault(); setActive(options.length - 1); return }
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active) }
      }
      const optionId = index => `${menuId}-opt-${index}`
      // 菜单常驻 DOM, 打开时 fixed 定位浮出。不 portal: react-dom 本体不在宿主
      // client 种子表(只有 react-dom/client); 弹窗卡 scale 动画会把动画期 fixed
      // 菜单的包含块劫持为卡片——已把 pop 动画从卡片移除, 从根上消除该窗口期
      const menu = h('div', {
        role: 'listbox', id: menuId, hidden: !open, className: 'ssb-select-menu', 'aria-label': label,
        ref: menuRef,
        style: place ? { left: place.left, top: place.top, minWidth: place.minWidth, maxHeight: place.maxHeight } : undefined,
      }, ...options.map((option, index) => h('div', {
        key: option.value, id: optionId(index), role: 'option', 'aria-selected': option.value === value,
        className: `ssb-select-option${index === active ? ' ssb-select-option-active' : ''}`,
        onPointerDown: event => event.preventDefault(),
        onClick: () => choose(index),
        onPointerEnter: () => setActive(index),
      }, option.label)))
      return h('div', { className: 'ssb-select', ref: rootRef },
        h('button', {
          type: 'button', ref: triggerRef, className: 'ssb-select-trigger', role: 'combobox', disabled, 'aria-label': label,
          'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-controls': menuId, 'aria-activedescendant': open ? optionId(active) : undefined,
          onClick: () => (open ? close() : openMenu()), onKeyDown,
        }, h('span', { className: 'ssb-select-value' }, current?.label ?? ''), h('span', { className: 'ssb-select-caret', 'aria-hidden': 'true' })),
        menu)
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
    // 拖拽落位: 返回新的完整顺序; 非本 tab 成员按原槽位回填, 保证提交的是全量 order
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
        // 显式转布尔: 旧记录可能没有 pinned 字段, Number(undefined) 是 NaN, 比较器会退化成随机序
        const pinned = Number(!!w.items[b].pinned) - Number(!!w.items[a].pinned)
        if (pinned || view.sort === 'manual') return pinned
        const qa = data.quotes[a]?.quote, qb = data.quotes[b]?.quote
        const aa = qa?.changePct == null ? null : Number(qa.changePct), bb = qb?.changePct == null ? null : Number(qb.changePct)
        if (aa === null || bb === null) return aa === bb ? 0 : aa === null ? 1 : -1
        return view.sort === 'asc' ? aa - bb : bb - aa
      })
      const order = (view.menuId || view.keyboardNavigating) && view.frozenOrder ? [...view.frozenOrder.filter(id => w.items[id]), ...sortedOrder.filter(id => !view.frozenOrder.includes(id))] : sortedOrder
      // 草稿清理由 updateView 在 detailId 变更处统一处理, 这里再清一遍会把键盘导航到同一只时输了一半的内容抹掉
      function open(id) { runtime.updateView({ detailId: id, selectedId: id, overlay: 'detail', focusId: id, keyboardNavigating: false, menuId: null }) }
      // 概览横幅: 仅异常态显示(健康态运维摘要收进「更多」菜单), Leek-Fund 模式=主页纯列表
      const unhealthy = (state.data.providerStatus || []).filter(s => { const log = s.recentRequests || []; return log.length && log[0].status !== 'ok' })
      const providers = state.data.control.providers || []
      const sourcesBanner = unhealthy.length || providers.some(p => !p.enabled) ? h('div', { className: 'ssb-banner' }, `${providers.filter(p => p.enabled).length}/${providers.length} 个数据源启用${unhealthy.length ? `，${unhealthy.map(s => s.id).join('、')} 最近请求失败` : ''}`, h(Button, { onClick: () => runtime.updateView({ view: 'list', overlay: 'settings' }) }, '查看')) : null
      // 分组 tab: 全部 → 各标签(首现序) → 未分组; 一只票可同时属于多个标签, 于是在多个 tab 可见
      const tabs = tagTabs(w.order, w.items)
      const active = resolveTab(tabs, view.activeTab)
      const inTab = new Set(active.ids)
      // tab 顺序取排序后的全量序, 置顶票因此在每个 tab 里都排最前
      const tabOrder = order.filter(id => inTab.has(id))
      // 组合概览按当前 tab 成员算(不占独立横幅带)。不做涨跌额求和: 各市场币种不同且无仓位数量, 相加没有意义
      const stats = active.ids.reduce((acc, id) => { const pct = Number(data.quotes[id]?.quote?.changePct); if (Number.isNaN(pct)) return acc; acc.up += pct > 0; acc.down += pct < 0; const item = w.items[id], last = Number(data.quotes[id]?.quote?.last), costBase = costBaseOf(item.marks); if (costBase != null && last) { acc.held += 1; acc.pl += (last - costBase) / costBase * 100 } return acc }, { up: 0, down: 0, held: 0, pl: 0 })
      // 持仓合计为等权均值(无仓位数量数据, 百分比求和会随只数放大; 均值是最不坏近似)
      const heldText = stats.held ? ` · 持仓盈亏 ${signed(Number((stats.pl / stats.held).toFixed(1)))}%（等权）` : ''
      const statsText = `${active.ids.length} 只 · ${stats.up} 涨 ${stats.down} 跌${heldText}${freshnessText(data.quotes) ? ` · ${freshnessText(data.quotes)}` : ''}`
      const isTagTab = active.key.startsWith(TAG_PREFIX)
      // 重命名草稿绑定的是标签名: 切换 tab 后残留的草稿不再渲染
      const renameDraft = isTagTab && view.tagRename?.from === active.label ? view.tagRename : null
      const tabBar = w.order.length ? h('div', { className: 'ssb-tabs', role: 'tablist', 'aria-label': '自选分组' },
        ...tabs.map(tab => h('button', { key: tab.key, type: 'button', role: 'tab', 'aria-controls': WATCHLIST_PANEL_ID, className: `ssb-tab${tab.key === active.key ? ' ssb-tab-on' : ''}`, 'aria-selected': tab.key === active.key, onClick: () => runtime.updateView({ activeTab: tab.key, tagRename: null }) }, `${tab.label} · ${tab.ids.length}`))) : null
      const tagTools = isTagTab ? h('div', { className: 'ssb-toolbar' },
        h(Button, { disabled: busy.write, onClick: () => runtime.updateView({ tagRename: { from: active.label, to: active.label, error: '' } }) }, '重命名'),
        // 解散成功后激活键失效, 显式回到全部而不是让 resolveTab 静默兜底; 失败时保留原地由顶部横幅报错
        h(Button, { disabled: busy.write, onClick: () => runtime.mutate('tagRemove', { tag: active.label }).then(() => runtime.updateView({ activeTab: ALL_TAB_KEY, tagRename: null })).catch(() => { }) }, '解散')) : null
      const renameForm = renameDraft ? h('form', { className: 'ssb-inline-form ssb-tag-rename', onSubmit: e => {
        e.preventDefault()
        const to = String(renameDraft.to || '').trim()
        if (!to) { runtime.updateView({ tagRename: { ...renameDraft, error: '标签名不能为空' } }); return }
        if ([...to].length > 12) { runtime.updateView({ tagRename: { ...renameDraft, error: '标签名最多12字' } }); return }
        // 激活键跟随新标签名, 否则重命名成功后 tab 条上找不到旧键会掉回全部; 失败保留草稿供改名重试
        runtime.mutate('tagRename', { from: renameDraft.from, to }).then(() => runtime.updateView({ tagRename: null, activeTab: `${TAG_PREFIX}${to}` })).catch(() => { })
      } },
        h('label', { className: 'ssb-inline-field' }, h('span', { className: 'ssb-field-label' }, '标签名'), h('input', { className: 'ssb-input ssb-input-group', value: renameDraft.to, maxLength: 12, onChange: e => runtime.updateView({ tagRename: { ...renameDraft, to: e.target.value, error: '' } }) })),
        h('button', { type: 'submit', className: 'ssb-button', disabled: busy.write }, '保存'),
        h(Button, { onClick: () => runtime.updateView({ tagRename: null }) }, '取消'),
        renameDraft.error ? h('small', { className: 'ssb-form-error', role: 'alert' }, renameDraft.error) : null) : null
      return h('section', { className: 'ssb-list-pane' },
        sourcesBanner,
        h('div', { className: 'ssb-section-head' }, h('h2', null, `自选 · ${w.order.length}`), w.order.length ? h('span', { className: 'ssb-muted' }, statsText) : null, tagTools, h(Select, { value: view.sort, label: '自选排序', options: [{ value: 'manual', label: '手动顺序' }, { value: 'desc', label: '涨幅优先' }, { value: 'asc', label: '跌幅优先' }], onChange: value => runtime.updateView({ sort: value }) })),
        renameForm,
        tabBar,
        !w.order.length ? h('div', { className: 'ssb-empty' }, h('p', null, '添加第一只自选，集中查看价格和来源。'), h(Button, { primary: true, onClick: () => runtime.updateView({ view: 'search' }) }, '添加自选')) :
          h('div', { className: 'ssb-table-scroll', role: 'tabpanel', id: WATCHLIST_PANEL_ID, 'aria-label': active.label, onScroll: e => runtime.updateView({ scrollTop: e.currentTarget.scrollTop }), ref: node => { if (node && Math.abs(node.scrollTop - (view.scrollTop || 0)) > 1) node.scrollTop = view.scrollTop || 0 } },
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
            h('div', { className: 'ssb-rows', role: 'list' }, ...(() => {
                // 列表只渲染激活 tab 的成员: 行序取排序后的全量序, 拖拽落的仍是完整自选序。
                // 置顶是排序权重而不是独立分段, 所以 lane 只按置顶区分, 防止把置顶票拖出置顶段
                const sequence = []
                const laneOf = id => String(!!w.items[id].pinned)
                const commitOrder = (from, over, after) => {
                  // 拖拽期间别处可能移除标的或解散标签: 源不在本 tab 的渲染序里就放弃, 否则会提交重复 id
                  if (!from || !over || from === over || !w.items[from] || !w.items[over] || !sequence.includes(from)) return
                  if (laneOf(from) !== laneOf(over)) return
                  const merged = dragOrder(sequence, order, from, over, after)
                  if (!merged) return
                  // 失败错误由 action 通道落到顶部横幅, 这里只防未处理拒绝
                  runtime.mutate('reorder', { order: merged }).catch(() => {})
                }
                const rowOf = id => {
                  const item = w.items[id], entry = data.quotes[id], q = entry?.quote
                  sequence.push(id)
                  const direction = toneClass(q?.changePct)
                  // 列表只显示一个数: 多个成本取最低价作为「持仓成本」
                  const costBase = costBaseOf(item.marks)
                  const plPct = costBase != null && q?.last != null ? Number((Number(q.last) - costBase) / costBase * 100).toFixed(1) : null
                  const amplitude = q?.high != null && q?.low != null && Number(q.previousClose) > 0 ? Number(((Number(q.high) - Number(q.low)) / Number(q.previousClose)) * 100).toFixed(1) : null
                  const dragging = view.dragId === id
                  const dropEdge = view.dropAt?.id === id ? view.dropAt.after ? ' ssb-drop-after' : ' ssb-drop-before' : ''
                  const canDrag = view.sort === 'manual' && !busy.write
                  return h(React.Fragment, { key: id },
                    h('div', {
                      className: `ssb-row${view.detailId === id ? ' ssb-selected' : ''}${entry?.health !== 'ok' ? ' ssb-stale' : ''}${dragging ? ' ssb-dragging' : ''}${dropEdge}${item.pinned ? ' ssb-pinned' : ''}`,
                      role: 'listitem', 'data-security-id': id, draggable: canDrag,
                      onClick: () => open(id),
                      onDragStart: e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); runtime.updateView({ dragId: id, dropAt: null }) },
                      onDragEnd: () => runtime.updateView({ dragId: null, dropAt: null }),
                      onDragOver: e => {
                        // 拖拽期间别处可能移除标的: 先确认两端都还在, 否则 laneOf 会读 undefined
                        if (!view.dragId || view.dragId === id || !w.items[view.dragId] || !w.items[id] || laneOf(view.dragId) !== laneOf(id)) return
                        e.preventDefault()
                        const rect = e.currentTarget.getBoundingClientRect()
                        const after = e.clientY > rect.top + rect.height / 2
                        if (view.dropAt?.id !== id || view.dropAt.after !== after) runtime.updateView({ dropAt: { id, after } })
                      },
                      onDrop: e => { e.preventDefault(); commitOrder(view.dragId, id, view.dropAt?.after === true); runtime.updateView({ dragId: null, dropAt: null }) },
                    },
                    h('div', { className: 'ssb-row-main' },
                      h('span', { className: 'ssb-grip', 'aria-hidden': true, title: canDrag ? '拖动排序' : '切回手动顺序后可拖动' }, '⠿'),
                      h('button', { className: 'ssb-stock-name', 'data-security-id': id, onClick: () => open(id), onFocus: () => { if (view.focusId !== id) runtime.updateView({ focusId: id }) }, onBlur: e => { if (!e.relatedTarget?.closest('.ssb-stock-name')) runtime.updateView({ keyboardNavigating: false, frozenOrder: null }) }, onKeyDown: e => {
                    if (e.key === 'Escape') { runtime.updateView({ menuId: null, frozenOrder: null, keyboardNavigating: false, view: 'list' }); return }
                    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
                      // 导航序列=实际渲染 DOM 序(tab 过滤后与全量 order 错位), focusId 取目标行 data-security-id 保持状态同步
                      e.preventDefault(); const buttons = [...e.currentTarget.closest('.ssb-rows').querySelectorAll('.ssb-stock-name')]; const at = buttons.indexOf(e.currentTarget), next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))
                      const target = buttons[next]; runtime.updateView({ keyboardNavigating: true, frozenOrder: order, focusId: target?.dataset.securityId }); target?.focus()
                    }
                  } }, item.alias || item.officialName, h('span', { className: 'ssb-code' }, `${MARKET_LABEL[item.exchange] || item.exchange} ${item.code}`)),
                      h('span', { className: `ssb-cell-price ssb-price${direction}`, title: q?.last == null ? '等待报价' : `${item.currency} ${q.last}` }, priceTextOf(q?.last, item.priceScale)),
                      q?.changePct == null ? h('span', { className: 'ssb-cell-pct ssb-muted' }, '—') : h('span', { className: `ssb-cell-pct ssb-pill${direction}` }, `${signed(q.changePct)}%`),
                      q?.change == null ? h('span', { className: 'ssb-cell-change ssb-muted' }, '—') : h('span', { className: `ssb-cell-change ssb-change${direction}` }, signed(q.change)),
                      h('span', { className: 'ssb-cell-open' }, priceTextOf(q?.open, item.priceScale)),
                      h('span', { className: 'ssb-cell-range' }, `${priceTextOf(q?.high, item.priceScale)}/${priceTextOf(q?.low, item.priceScale)}`),
                      h('span', { className: 'ssb-cell-amount' }, formatAmount(q?.amount)),
                      h('span', { className: 'ssb-cell-amplitude' }, amplitude == null ? '—' : `${amplitude}%`),
                      h('span', { className: `ssb-cell-pl${toneClass(plPct)}` }, plPct == null ? '—' : `${signed(plPct)}%`),
                      h(QuoteStatus, { entry, short: true })),
                    h('div', { className: 'ssb-row-sub' },
                      h('span', { className: 'ssb-kv' }, '开', priceTextOf(q?.open, item.priceScale)),
                      h('span', { className: 'ssb-kv' }, '高', priceTextOf(q?.high, item.priceScale)),
                      h('span', { className: 'ssb-kv' }, '低', priceTextOf(q?.low, item.priceScale)),
                      h('span', { className: 'ssb-kv' }, '额', formatAmount(q?.amount)),
                      amplitude == null ? null : h('span', { className: 'ssb-kv' }, '振', `${amplitude}%`),
                      plPct == null ? null : h('span', { className: `ssb-kv ssb-kv-pl${toneClass(plPct)}` }, '持仓', `${signed(plPct)}%`))))
                }
                return tabOrder.map(rowOf)
              })())))
    }
    // ---- KlineView: lightweight-charts 图表视图(设计"client 详情重构"节十步数据流) ----
    const PERIODS = [{ key: 'trend', label: '分时' }, { key: '1d', label: '日K' }, { key: '1w', label: '周K' }, { key: '1M', label: '月K' }]
    const GUIDE_KEY = 'ssb-guides'
    const GUIDE_DEFAULT = { preClose: true, marks: true, highLow: false, ma: true, ema: false, boll: false, bbi: false }
    // horizontal 是横贯全图的参考位(priceLine), indicator 是跟随每根K线的序列(LineSeries)
    const GUIDE_GROUPS = [
      { title: '参考位', items: [['preClose', '昨收'], ['marks', '价格标记'], ['highLow', '区间最高/最低']] },
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
      const varOf = name => cs.getPropertyValue(name).trim()
      const red = varOf('--ssb-danger'), green = varOf('--ssb-ok')
      const [up, down] = colorMode === 'green-up' ? [green, red] : [red, green]
      // 背景取面板底色而不是 transparent: 容器自身没有背景, 交给 canvas 留白的话暗色主题下会露出一块白
      return { background: varOf('--ssb-bg') || 'transparent', textColor: varOf('--ssb-text-sub'), gridLine: varOf('--ssb-border'), crosshair: varOf('--ssb-text-dim'), up, down, volumeUp: up + '73', volumeDown: down + '73', MA: [varOf('--ssb-chart-ma-fast'), varOf('--ssb-chart-ma-mid'), varOf('--ssb-chart-ma-slow'), varOf('--ssb-chart-ma-long')], EMA: varOf('--ssb-chart-ema'), BOLL: [varOf('--ssb-chart-boll-mid'), varOf('--ssb-chart-boll-rail')], BBI: varOf('--ssb-chart-bbi'), cost: varOf('--ssb-chart-cost'), target: varOf('--ssb-chart-target') }
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
    // 指标与蜡烛必须同代: 建图补灌时 candles 来自挂起结果而 values 来自最近渲染,
    // 中间若夹过一次更长的数据, 越界取 time 会直接抛 TypeError
    const toPoints = (candles, values) => values.map((value, i) => value == null || !candles[i] ? null : ({ time: candles[i].time, value })).filter(Boolean)
    function KlineError({ message, onRetry, guide, busyOneClick }) {
      // guide 由调用方给出动作与文案: 缺路由是一键开启, 来源不支持则是去设置换源
      return h('div', { className: 'ssb-banner ssb-error', role: 'alert' }, message, guide ? h(Button, { onClick: guide.onClick, disabled: busyOneClick }, busyOneClick ? '处理中…' : guide.label) : null, onRetry ? h(Button, { onClick: onRetry }, '重试') : null)
    }
    function KlineView({ runtime, state, item }) {
      const period = state.klinePeriod || '1d'
      // 切标的/周期的当帧 state.kline 还是上一轮的, 只有 key 对上才算这一轮的数据;
      // 否则图例会拼出上一只的涨跌并带上残缺的"最近 ()"
      const kline = state.klineKey === klineKeyOf(item.id, period) ? state.kline || {} : {}
      const holder = React.useRef(null), chartRef = React.useRef(null), mainRef = React.useRef(null), indicatorRef = React.useRef({}), volRef = React.useRef(null), avgRef = React.useRef(null), shippedKeyRef = React.useRef(null)
      // 数据链与建图链谁先到不确定: 图还没建好时先把结果存下来, 建完再补灌, 否则先到的数据会被丢掉
      const pendingRef = React.useRef(null)
      // 建图 effect 是空依赖的, 回调里要用当前主题与当前数据, 只能从这里现取
      const liveRef = React.useRef({})
      // 建图后补灌动作也走它, 保证用的是最新渲染的 maybeFill 而不是首帧那份
      const fillRef = React.useRef(null)
      // 上一次铺色用的主题签名, 用来跳过无关的 body style 抖动
      const paintKeyRef = React.useRef('')
      // 参考线随每次灌数据重画, 不先移除会在同一 series 上越叠越多
      const preCloseLineRef = React.useRef(null), highLineRef = React.useRef(null), lowLineRef = React.useRef(null)
      // 价格标记是可变数量的, 数量变了就得把旧的整批撤掉重建
      const markLinesRef = React.useRef([])
      // 十字线读数: 悬停那根的读数是瞬时状态, 离开图面即清空
      const [crosshair, setCrosshair] = React.useState(null)
      function drawMarks(series, palette, list) {
        if (!series) return
        for (const line of markLinesRef.current) { try { series.removePriceLine(line) } catch { } }
        markLinesRef.current = (list || []).map(mark => series.createPriceLine({
          price: mark.price,
          color: mark.kind === 'cost' ? palette.cost : palette.target,
          lineStyle: 3, lineWidth: 1, axisLabelVisible: true,
          title: mark.kind === 'cost' ? '成本' : '卖价',
        }))
      }
      function drawLine(ref, options) {
        const series = mainRef.current
        if (!series) return
        if (ref.current) { try { series.removePriceLine(ref.current) } catch { } ref.current = null }
        if (options) ref.current = series.createPriceLine(options)
      }
      // 配色取 liveRef 里的当前值: 建图与补灌都在空依赖回调里, 直接用 state 会读到首帧的旧配色
      const themeOf = () => readChartTheme(holder.current?.closest('.ssb-root') || document.documentElement, liveRef.current.colorMode)
      // 量柱着色与 MA 灌入(日/周/月)
      // 指标线只灌开着的: 关掉时喂空数组, series 留着不重建
      function applyIndicators(candles) {
        // 现取而不是用闭包: 建图与补灌都在空依赖回调里, 闭包里的 indicatorValues 永远停在首帧 null
        const values = liveRef.current.indicators
        // 数据被清空时指标线也要跟着清, 否则时间轴仍是旧数据驱动的, 会留下一截没有蜡烛的孤立折线
        if (!candles?.length || !values) { for (const list of Object.values(indicatorRef.current)) list.forEach(series => series.setData([])); return }
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
        // 行情自带时间戳优先: 没有它才按「区间起点 + 分钟偏移」推。
        // 注意 base 是当天 UTC 零点, 推到非 UTC 市场会整体偏时区(美股约 11 小时),
        // 所以这只是最后一道兜底——东财分时恒给 at, 该路径当前不可达
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
      // 指标序列只算一次: 图例取末值、图上灌全序列, 两边共用同一份结果
      const indicatorValues = React.useMemo(() => {
        const candles = kline?.candles
        if (!candles?.length || wantTrend) return null
        return { ma: MA_WINDOWS.map(n => seriesMA(candles, n)), ema: [seriesEMA(candles, EMA_WINDOW)], boll: seriesBoll(candles, BOLL_WINDOW, BOLL_K), bbi: [seriesBBI(candles)] }
      }, [kline?.candles, wantTrend])
      // 建图与重涂都在空依赖的回调里跑, 用这份最新值替代首帧闭包
      liveRef.current = { candles: kline?.candles, colorMode: state.data?.control.preferences?.colorMode, indicators: indicatorValues, period, priceScale: item.priceScale, timezone: item.timezone, preClose: kline?.preClose, guides }
      const legend = React.useMemo(() => {
        const candles = kline?.candles || []
        if (!candles.length) return null
        const last = candles[candles.length - 1], scale = item.priceScale ?? 2
        const price = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value).toFixed(scale)
        // 日K 的 preClose 有时来源不给, 退到前一根收盘; 分时不能这么退——前一根分钟收盘会算出个假的 0.0x% 涨跌
        const base = finiteOr(kline?.preClose) || (wantTrend ? NaN : finiteOr(candles[candles.length - 2]?.close))
        const pct = Number.isFinite(base) && base && Number.isFinite(finiteOr(last.close)) ? (finiteOr(last.close) - base) / base * 100 : null
        const tone = toneClass(pct)
        const quote = wantTrend
          ? [['最新', price(last.close)], ['均价', price(last.avg ?? last.close)], ['昨收', price(kline?.preClose)]]
          : [['开', price(last.open)], ['高', price(last.high)], ['低', price(last.low)], ['收', price(last.close)]]
        // 分时的 volume 是每分钟增量(实测末条远小于当日总量), 要累加; 日K 最后一根本身就是当日总量。
        // 一根有效量都没有时留 null 而不是 0, 否则图例会写出一个并不存在的"0"
        const volume = wantTrend
          ? (candles.some(candle => Number.isFinite(finiteOr(candle.volume))) ? candles.reduce((sum, candle) => sum + (finiteOr(candle.volume) || 0), 0) : null)
          : last.volume
        // 指标只列开着的, 否则图例比图还长
        const series = []
        if (indicatorValues && guides.ma) MA_WINDOWS.forEach((window, index) => series.push([`MA${window}`, indicatorValues.ma[index].at(-1), ` ssb-ma-${index}`]))
        if (indicatorValues && guides.ema) series.push([`EMA${EMA_WINDOW}`, indicatorValues.ema[0].at(-1), ' ssb-ema'])
        if (indicatorValues && guides.boll) ['BOLL', 'BOLL上', 'BOLL下'].forEach((name, index) => series.push([name, indicatorValues.boll[index].at(-1), ` ssb-boll-${index}`]))
        if (indicatorValues && guides.bbi) series.push(['BBI', indicatorValues.bbi[0].at(-1), ' ssb-bbi'])
        return {
          quote: [...quote, ['涨跌', pct == null ? null : `${signed(pct.toFixed(2))}%`, tone], ['量', formatAmount(volume, { zeroIsMissing: false })]],
          series: series.filter(([, value]) => value != null && Number.isFinite(Number(value))),
        }
      }, [kline?.candles, kline?.preClose, wantTrend, item.priceScale, guides])
      const marks = item.marks || []
      const costBase = costBaseOf(marks)
      // 盈亏一律以最后一根收盘为准, 跟图例里的成分保持一致
      const lastClose = kline?.candles?.length ? finiteOr(kline.candles[kline.candles.length - 1].close) : null
      const costPct = costBase != null && Number.isFinite(lastClose) ? (lastClose - costBase) / costBase * 100 : null
      // 把一套主题色铺满整张图: 背景/网格/两轴边框/主序列/成交量/指标线/参考线。
      // 首灌与换主题共用同一份, 免得两处漏项(分时面积序列的键名与蜡烛不同)
      function repaintChart(t) {
        const chart = chartRef.current
        if (!chart) return
        // body 的 style 会因为字体、滚动条之类无关变动抖动, 签名没变就不必整图重涂
        const signature = themeSignature(t)
        if (paintKeyRef.current === signature) return
        paintKeyRef.current = signature
        chart.applyOptions({
          layout: { background: { color: t.background }, textColor: t.textColor },
          grid: { vertLines: { color: t.gridLine }, horzLines: { color: t.gridLine } },
          timeScale: { borderColor: t.gridLine },
          rightPriceScale: { borderColor: t.gridLine },
        })
        // 面积序列用 lineColor/topColor/bottomColor, 蜡烛用 up/down 那一组, 键名互不相通
        mainRef.current?.applyOptions(seriesPaintPlan(t, !!avgRef.current))
        // 成交量序列不认系列级配色, 只认每根柱子自带的 color, 所以必须按当前蜡烛重灌一次
        const candles = liveRef.current.candles
        if (candles?.length) volRef.current?.setData(candles.map(c => ({ time: c.time, value: c.volume ?? 0, color: c.close >= c.open ? t.volumeUp : t.volumeDown })))
        avgRef.current?.applyOptions({ color: t.MA[0] })
        const palette = { ma: t.MA, ema: t.EMA, boll: t.BOLL, bbi: t.BBI }
        for (const [key, list] of Object.entries(indicatorRef.current)) list.forEach((series, index) => series.applyOptions({ color: Array.isArray(palette[key]) ? palette[key][index] : palette[key] }))
        // 参考线建好后就固定了, 只换颜色; 没有对应的线时 applyOptions 是 no-op
        preCloseLineRef.current?.applyOptions({ color: t.crosshair })
        // 标记线按种类各一个颜色, 逐条换
        for (const [index, line] of markLinesRef.current.entries()) {
          const mark = (liveRef.current.marks || [])[index]
          line.applyOptions({ color: mark?.kind === 'target' ? t.target : t.cost })
        }
        highLineRef.current?.applyOptions({ color: t.textColor })
        lowLineRef.current?.applyOptions({ color: t.textColor })
      }
      function ensureSeries(LWC) {
        const chart = chartRef.current
        if (!chart || !LWC) return
        if (wantTrend === !!avgRef.current && mainRef.current) return
        const stale = [mainRef.current, avgRef.current, volRef.current, ...Object.values(indicatorRef.current).flat()]
        for (const s of stale) if (s) chart.removeSeries(s)
        mainRef.current = avgRef.current = volRef.current = null; indicatorRef.current = {}
        // 旧 series 上的参考线随 series 一起销毁, 引用要清掉
        preCloseLineRef.current = highLineRef.current = lowLineRef.current = null
        markLinesRef.current = []
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
      function maybeFill(result, fit = true) {
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
        drawLine(preCloseLineRef, guides.preClose && result.preClose != null ? { price: result.preClose, color: palette.crosshair, lineStyle: 2, lineWidth: 1, title: '昨收' } : null)
        drawMarks(mainRef.current, palette, guides.marks ? marks : [])
        const highs = result.candles.map(c => finiteOr(c.high)).filter(Number.isFinite), lows = result.candles.map(c => finiteOr(c.low)).filter(Number.isFinite)
        drawLine(highLineRef, guides.highLow && highs.length ? { price: Math.max(...highs), color: palette.textColor, lineStyle: 1, lineWidth: 1, title: '区间高' } : null)
        drawLine(lowLineRef, guides.highLow && lows.length ? { price: Math.min(...lows), color: palette.textColor, lineStyle: 1, lineWidth: 1, title: '区间低' } : null)
        // 换周期后时间范围完全不同, 不重置视口会停在上一周期的区间上; 手动刷新保留缩放
        if (fit) chartRef.current.timeScale().fitContent()
      }
      // 建图 effect 是空依赖的, 它拿到的是首帧那份 maybeFill; 转发一次, 让它永远调用最新渲染的版本,
      // 否则建图那几百毫秒里切的周期/开关的辅助线/改的成本都会用旧值
      fillRef.current = maybeFill
      // effect A: 图表创建一次; 主题变更(MutationObserver)重涂; 卸载销毁。
      React.useEffect(() => {
        let dead = false, mo, onCross = null
        const root = holder.current?.closest('.ssb-root') || document.documentElement
        ensureLwc(document).then(LWC => {
          if (dead || !holder.current) return
          chartRef.current = LWC.createChart(holder.current, chartOptions(themeOf()))
          // 十字线读数: 图例只报最后一根, 悬停某根时要能读到它的开高低收
          onCross = param => {
            const main = mainRef.current, mainData = main && param?.seriesData?.get(main)
            if (!param?.time || !mainData) { setCrosshair(null); return }
            const info = liveRef.current, trend = info.period === 'trend'
            // 日K某一根的涨跌相对它的前一根收盘; 分时相对当日昨收。第一根没有前收才退回 preClose
            const candles = info.candles || []
            const at = candles.findIndex(candle => timeKeyOf(candle.time) === timeKeyOf(param.time))
            const base = trend || at <= 0 ? info.preClose : candles[at - 1]?.close
            // 分时没有独立的成交量序列, 量从匹配到的那根上取; 日K取柱状序列
            const volume = volRef.current ? param.seriesData.get(volRef.current)?.value : (at >= 0 ? candles[at]?.volume : null)
            // 辅助线读数与图上线条同源: 直接用 series 在该时间点的值, 关掉的线没有数据自然不列
            const readings = []
            if (!trend) {
              const refs = indicatorRef.current, data = param.seriesData
              const pick = (label, handle) => { const value = handle && data.get(handle)?.value; if (value != null) readings.push([label, value]) }
              if (info.guides?.ma) MA_WINDOWS.forEach((window, index) => pick(`MA${window}`, refs.ma?.[index]))
              if (info.guides?.ema) pick(`EMA${EMA_WINDOW}`, refs.ema?.[0])
              if (info.guides?.boll) ['BOLL', 'BOLL上', 'BOLL下'].forEach((label, index) => pick(label, refs.boll?.[index]))
              if (info.guides?.bbi) pick('BBI', refs.bbi?.[0])
            }
            setCrosshair({
              time: crosshairTimeText(param.time, trend, info.timezone),
              lines: crosshairTipLines({ candle: mainData, scale: info.priceScale, trend, preClose: base, volume, series: readings }),
              point: param.point,
            })
          }
          chartRef.current.subscribeCrosshairMove(onCross)
          const early = pendingRef.current
          pendingRef.current = null
          fillRef.current?.(early || runtime.getKlineResult(item.id, period))
        }).catch(e => runtime.setKlineError(item.id, liveRef.current.period, e.message, e.code))        // 宿主换主题/切涨跌配色都是给 root 加类或在 body 上打标记, 观察这里重涂。
        // 这个 effect 空依赖, 所以主题与数据都从 liveRef 现取; 主序列是蜡烛还是面积由已建序列判断,
        // 用 wantTrend 会读到首帧的值。分时面积序列的键名与蜡烛完全不同, 只按蜡烛键重涂等于没涂
        mo = new MutationObserver(() => repaintChart(readChartTheme(holder.current?.closest('.ssb-root') || document.documentElement, liveRef.current.colorMode)))
        mo.observe(root, { attributes: true, attributeFilter: ['class', 'style'] })
        // 明暗主题标记落在 body 上, 不在 root 的观察范围里, 单开一路才收得到切换。
        // 同色系两套主题(或第三方主题覆盖 token)切换时这个标记不变, 必须连 style 一起听
        mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] })
        return () => {
          dead = true; mo.disconnect()
          const chart = chartRef.current
          if (chart) { if (onCross) chart.unsubscribeCrosshairMove(onCross); chart.remove() }
          chartRef.current = null
        }
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
      // effect B: 只在标的/周期变化时发起加载; 灌图由下面的数据 effect 统一负责,
      // 否则手动刷新(↻)只改 state 不进图表, 出现图例已更新而蜡烛还是旧的
      React.useEffect(() => {
        let dead = false
        runtime.loadKline(item.id, period).catch(e => { if (!dead) runtime.setKlineError(item.id, period, e.message, e.code) })
        return () => { dead = true }
      }, [item.id, period])
      // 数据唯一入口: state.kline 变就重灌, 换 key 才重置视口。
      // 必须校验 key: 切周期当帧 state.kline 已被清成上一轮的空壳, 直接灌会把分时的 "09:30" 交给
      // Candlestick, vendor 对非法日期字符串是抛错而不是忽略; 空数组同样要灌, 否则换只后旧图残留。
      React.useEffect(() => {
        const key = klineKeyOf(item.id, period)
        if (state.klineKey !== key) return
        const plan = klineShipPlan(shippedKeyRef.current, key, !!kline?.candles?.length)
        shippedKeyRef.current = plan.next
        maybeFill({ candles: kline?.candles || [], preClose: kline?.preClose }, plan.fit)
      }, [state.klineKey, kline?.candles, kline?.preClose, item.id, period])
      // 成本/辅助线变化(设/改/清)不会触发数据重灌, 得自己把参考线更新掉
      React.useEffect(() => {
        if (!mainRef.current) return
        const palette = themeOf()
        drawMarks(mainRef.current, palette, guides.marks ? marks : [])
        const candles = kline?.candles || []
        const highs = candles.map(c => finiteOr(c.high)).filter(Number.isFinite), lows = candles.map(c => finiteOr(c.low)).filter(Number.isFinite)
        drawLine(preCloseLineRef, guides.preClose && kline?.preClose != null ? { price: kline.preClose, color: palette.crosshair, lineStyle: 2, lineWidth: 1, title: '昨收' } : null)
        drawLine(highLineRef, guides.highLow && highs.length ? { price: Math.max(...highs), color: palette.textColor, lineStyle: 1, lineWidth: 1, title: '区间高' } : null)
        drawLine(lowLineRef, guides.highLow && lows.length ? { price: Math.min(...lows), color: palette.textColor, lineStyle: 1, lineWidth: 1, title: '区间低' } : null)
        // 开关变化不触发数据重灌, 指标线要自己补画
        if (!wantTrend) applyIndicators(kline?.candles)
      }, [item.marks, kline.candles, guides])
      return h('div', { className: 'ssb-kline' },
        h('div', { className: 'ssb-kline-toolbar' }, h('div', { role: 'tablist', 'aria-label': 'K线周期', style: { display: 'flex', gap: '8px' } }, ...PERIODS.map(p => h(Button, { key: p.key, role: 'tab', 'aria-selected': period === p.key, primary: period === p.key, onClick: () => runtime.setKlinePeriod(p.key) }, p.label))), h(Button, { onClick: quiet(() => runtime.loadKline(item.id, period, true)) }, '↻'),
          h('div', { className: 'ssb-more', style: { position: 'relative' } }, h(Button, { 'aria-expanded': !!state.view.guideOpen, onClick: () => runtime.updateView({ guideOpen: !state.view.guideOpen }) }, '辅助线'),
            state.view.guideOpen ? h('div', { className: 'ssb-menu', style: { position: 'absolute', left: 0, top: 'calc(100% + 4px)', background: 'var(--ssb-bg)', border: '1px solid var(--ssb-border)', borderRadius: 'var(--ssb-radius-md)', padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px', zIndex: 10, minWidth: '170px' }, role: 'menu' },
              ...GUIDE_GROUPS.flatMap(group => [h('div', { key: group.title, className: 'ssb-menu-title' }, group.title), ...group.items.map(([key, label]) => h(Toggle, { key, label, checked: !!guides[key], onChange: () => setGuides({ [key]: !guides[key] }) }))])) : null),
          h('span', { className: 'ssb-kline-meta' }, klineMetaText(kline, wantTrend))),
        legend ? h('div', { className: 'ssb-kline-legend' },
          // 成本与卖价都是报价要素, 跟开高低收放同一行; 放在指标行会被挤到第三行去
          h('div', { className: 'ssb-legend-row' }, ...legend.quote.map(([label, value, tone]) => h('span', { key: label, className: `ssb-legend-item${tone || ''}` }, h('span', { className: 'ssb-legend-label' }, label), value == null ? '—' : value)),
            costBase == null ? null : h('span', { className: 'ssb-legend-item ssb-legend-cost' }, h('span', { className: 'ssb-legend-label' }, marks.filter(m => m.kind === 'cost').length > 1 ? '成本(最低)' : '成本'), priceTextOf(costBase, item.priceScale), costPct == null ? null : h('span', { className: `ssb-legend-pct${toneClass(costPct)}` }, `${signed(costPct.toFixed(2))}%`)),
            // 目标位只在图例里出现一次: 线在价格轴上, 具体数值看这里
            ...marks.filter(mark => mark.kind === 'target').map(mark => {
              const pct = markPct(mark, lastClose, costBase)
              return h('span', { key: mark.id, className: 'ssb-legend-item ssb-legend-target' }, h('span', { className: 'ssb-legend-label' }, '卖价'), priceTextOf(mark.price, item.priceScale), pct == null ? null : h('span', { className: `ssb-legend-pct${toneClass(pct)}` }, `${signed(pct.toFixed(2))}%`))
            })),
          legend.series.length ? h('div', { className: 'ssb-legend-row' },
            ...legend.series.map(([label, value, tone]) => h('span', { key: label, className: `ssb-legend-item${tone || ''}` }, h('span', { className: 'ssb-legend-label' }, label), Number(value).toFixed(item.priceScale ?? 2)))) : null) : null,
        kline.loading ? h('div', { className: 'ssb-kline-skeleton', role: 'status' }, '加载K线…') : null,
        kline.error ? h(KlineError, { message: kline.error, busyOneClick: !!state.busy.configuration, onRetry: () => quiet(() => runtime.loadKline(item.id, period, true))(), guide: kline.errorCode === 'NO_ROUTE' ? { label: '一键开启', onClick: () => quiet(async () => { await runtime.oneClickKline(); await runtime.loadKline(item.id, period, true) })() } : kline.errorCode === 'UNSUPPORTED_CAPABILITY' ? { label: '去设置换源', onClick: () => runtime.updateView({ view: 'list', overlay: 'settings' }) } : null }) : null,
        !kline.loading && !kline.error && kline.candles && !kline.candles.length ? h('div', { className: 'ssb-empty' }, h('p', null, '暂无K线数据（停牌或已退市）')) : null,
        state.data.vendorAvailable === false ? h('div', { className: 'ssb-banner' }, '图表组件不可用，已降级为数字详情。') : null,
        // 出错时隐藏画布: 图表实例挂在同一个 DOM 节点上, 卸载会丢实例, 只做可见性切换
        h('div', { className: 'ssb-kline-chart', style: kline.error ? { display: 'none' } : undefined },
          h('div', { ref: holder, className: 'ssb-kline-holder' }),
          crosshair ? h('div', { className: 'ssb-kline-tip', style: crosshairTipStyle({ point: crosshair.point, width: holder.current?.clientWidth || 0, height: holder.current?.clientHeight || 340 }) },
            h('div', { className: 'ssb-kline-tip-time' }, crosshair.time),
            ...crosshair.lines.map((line, index) => h('div', { key: index }, line))) : null))
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
        if (hit?.dataset.securityId) runtime.updateView({ detailId: hit.dataset.securityId, selectedId: hit.dataset.securityId })
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
      const openNeighbor = id => runtime.openDetail(id)
      const inWatchlist = !!data.control.watchlist.items[view.detailId]
      if (!item) return h('aside', { className: 'ssb-detail ssb-empty' }, h('p', null, '选择一只证券查看基础行情。'))
      const entry = data.quotes[item.id], q = entry?.quote
      const direction = toneClass(q?.changePct)
      const marketLabel = MARKET_LABEL[item.exchange] || item.exchange
      // 币种唯一来源是自选条目 currency(watchlist 写入时由 MARKET_META 保证), client 不设回退表
      const currency = item.currency || ''
      const fields = [['今开', priceTextOf(q?.open, item.priceScale)], ['最高', priceTextOf(q?.high, item.priceScale)], ['最低', priceTextOf(q?.low, item.priceScale)], ['昨收', priceTextOf(q?.previousClose, item.priceScale)], ['涨跌额', q?.change == null ? null : signed(q.change)], ['成交量', q?.volume == null ? null : `${formatAmount(q.volume, { zeroIsMissing: false })}股`], ['成交额', formatAmount(q?.amount)], ['交易时段', ({ trading: '交易中', closed: '休市', break: '午间休市', auction: '集合竞价', preopen: '开市前', unknown: '未知' })[q?.sessionState] || '未知'], ['报价时间', timeText(q?.quoteAt)], ['获取时间', timeText(q?.receivedAt)], ['来源', q?.providerInstanceId], ['延迟', delayText(q)]]
      // 非自选详情: 加自选为主操作, 不显示别名/删除等自选管理
      const peekActions = inWatchlist ? null : h('div', { className: 'ssb-toolbar' }, h(Button, { primary: true, disabled: state.busy.write, onClick: quiet(() => runtime.mutate('add', { securityId: item.id })) }, '加自选'))
      // 价格标记: 每条带语义(成本/卖价), 各自算盈亏, 图上一条线
      const marks = item.marks || []
      const costBase = costBaseOf(marks)
      const lastN = Number(q?.last)
      const costPl = costBase != null && lastN ? { amount: Number((lastN - costBase).toFixed(item.priceScale ?? 2)), pct: Number(((lastN - costBase) / costBase * 100).toFixed(1)) } : null
      const applyMarks = next => quiet(() => runtime.mutate('marks', { securityId: item.id, marks: next }))
      // 增删都是整组替换: 协议面只有一个操作, 也不会出现半更新的中间态
      // 标记类型是成组分类切换, 用分段控件而不是两个按钮: 选中态不再靠"黑底按钮"承担
      const markKind = view.markDraft?.kind === 'target' ? 'target' : 'cost'
      const markForm = inWatchlist ? h('form', { className: 'ssb-inline-form', onSubmit: e => {
        e.preventDefault()
        const raw = String(view.markDraft?.price ?? '').trim()
        const price = Number(raw)
        if (!raw || !Number.isFinite(price) || price <= 0) { runtime.updateView({ markError: '价格需为正数' }); return }
        if (marks.length >= 12) { runtime.updateView({ markError: '最多 12 个标记' }); return }
        const kind = view.markDraft?.kind === 'target' ? 'target' : 'cost'
        if (marks.some(mark => mark.kind === kind && mark.price === price)) { runtime.updateView({ markError: '同类型不能有重复价格' }); return }
        applyMarks([...marks, { id: crypto.randomUUID().slice(0, 8), price, kind }])()
        runtime.updateView({ markDraft: null, markError: '' })
      } },
        h('div', { className: 'ssb-seg', role: 'group', 'aria-label': '标记类型' },
          h('button', { type: 'button', className: `ssb-seg-opt${markKind === 'cost' ? ' ssb-seg-on' : ''}`, 'aria-pressed': markKind === 'cost', onClick: () => runtime.updateView({ markDraft: { kind: 'cost', price: view.markDraft?.price ?? '' } }) }, '成本'),
          h('button', { type: 'button', className: `ssb-seg-opt${markKind === 'target' ? ' ssb-seg-on' : ''}`, 'aria-pressed': markKind === 'target', onClick: () => runtime.updateView({ markDraft: { kind: 'target', price: view.markDraft?.price ?? '' } }) }, '卖价')),
        h('label', { className: 'ssb-inline-field' },
          h('span', { className: 'ssb-field-label' }, '价格'),
          h('input', { className: 'ssb-input ssb-input-num', value: view.markDraft?.price ?? '', inputMode: 'decimal', onChange: e => runtime.updateView({ markDraft: { kind: view.markDraft?.kind ?? 'cost', price: e.target.value }, markError: '' }), placeholder: '输入价格' })),
        h('button', { type: 'submit', className: 'ssb-button ssb-primary', disabled: state.busy.write }, '添加标记'),
        view.markError ? h('small', { className: 'ssb-form-error', role: 'alert' }, view.markError) : null) : null
      const markList = marks.length ? h('ul', { className: 'ssb-mark-list', 'aria-label': '价格标记' }, ...marks.map(mark => {
        const pct = markPct(mark, lastN, costBase)
        return h('li', { key: mark.id, className: 'ssb-mark-row' },
          h('span', { className: 'ssb-mark-kind' }, mark.kind === 'cost' ? '成本' : '卖价'),
          h('span', { className: 'ssb-number' }, priceTextOf(mark.price, item.priceScale)),
          h('span', { className: `ssb-mark-pct${toneClass(pct)}` }, pct == null ? '—' : `${signed(pct.toFixed(2))}%`),
          h(Button, { danger: true, disabled: state.busy.write, onClick: applyMarks(marks.filter(other => other.id !== mark.id)) }, '删除'))
      })) : null
      // 分组标签: 一只票可同时属于多个分组, 整组替换提交; 已有标签 pill 一键加入, 新标签走输入框
      const tags = item.tags || []
      const allTags = [...new Set(Object.values(data.control.watchlist.items).flatMap(other => other.tags || []))]
      // 失败就地报错: 顶部横幅在抽屉之后, 详情里点标签出错时会被盖住
      const applyTags = next => () => runtime.mutate('tags', { securityId: item.id, tags: next }).then(() => runtime.updateView({ tagError: '' })).catch(e => runtime.updateView({ tagError: e?.message || '标签更新失败' }))
      const tagForm = inWatchlist ? h('div', { className: 'ssb-tag-editor' },
        tags.length ? h('div', { className: 'ssb-tag-chips', role: 'list', 'aria-label': '当前分组标签' }, ...tags.map(tag => h('span', { key: tag, className: 'ssb-tag-chip', role: 'listitem' }, tag,
          h('button', { type: 'button', className: 'ssb-tag-x', 'aria-label': `移除标签 ${tag}`, disabled: state.busy.write, onClick: applyTags(tags.filter(other => other !== tag)) }, '×'))))
          : h('p', { className: 'ssb-form-hint' }, '还没有分组标签；不加标签的票会落在「未分组」tab。'),
        (() => {
          const addable = allTags.filter(tag => !tags.includes(tag))
          return addable.length ? h('div', { className: 'ssb-tag-pills', role: 'group', 'aria-label': '已有分组标签' }, ...addable.map(tag => h('button', { key: tag, type: 'button', className: 'ssb-tag-pill', disabled: state.busy.write || tags.length >= MAX_TAGS, onClick: applyTags([...tags, tag]) }, `+ ${tag}`))) : null
        })(),
        h('form', { className: 'ssb-inline-form', onSubmit: e => {
          e.preventDefault()
          const raw = String(view.tagDraft || '').trim()
          if (!raw) { runtime.updateView({ tagError: '标签名不能为空' }); return }
          if ([...raw].length > 12) { runtime.updateView({ tagError: '标签名最多12字' }); return }
          if (tags.includes(raw)) { runtime.updateView({ tagError: '已有同名标签' }); return }
          if (tags.length >= MAX_TAGS) { runtime.updateView({ tagError: `每只最多 ${MAX_TAGS} 个标签` }); return }
          // 只有写入成功才清草稿: 失败要留着让用户改
          runtime.mutate('tags', { securityId: item.id, tags: [...tags, raw] }).then(() => runtime.updateView({ tagDraft: '', tagError: '' })).catch(() => { })
        } },
          h('label', { className: 'ssb-inline-field' }, h('span', { className: 'ssb-field-label' }, '新标签'), h('input', { className: 'ssb-input ssb-input-group', value: view.tagDraft || '', maxLength: 12, onChange: e => runtime.updateView({ tagDraft: e.target.value, tagError: '' }) })),
          h('button', { type: 'submit', className: 'ssb-button', disabled: state.busy.write }, '添加标签'),
          view.tagError ? h('small', { className: 'ssb-form-error', role: 'alert' }, view.tagError) : null)) : null
      const costBlock = costPl ? h('div', { className: `ssb-number${toneClass(costPl.amount)}` }, h('span', null, `持仓盈亏 ${signed(costPl.amount)} · ${signed(costPl.pct)}%`), h('span', { className: 'ssb-muted ssb-small' }, `成本价 ${priceTextOf(costBase, item.priceScale)}`)) : null
      // 自选设置: 低频管理动作收进区块头部, 表单按「价格标记 / 分组与别名」两栏并排,
      // 不再让四段表单各自占一列、按钮各自落一行
      const watchActions = inWatchlist ? h(React.Fragment, null,
        h('div', { className: 'ssb-forms-head' },
          h('h3', null, '自选设置'),
          h('div', { className: 'ssb-toolbar ssb-forms-actions' },
            h(Button, { disabled: state.busy.write, onClick: quiet(() => runtime.mutate('pin', { securityId: item.id, pinned: !item.pinned })) }, item.pinned ? '取消置顶' : '置顶'),
            h(Button, { danger: true, disabled: state.busy.write, onClick: () => { if (!confirm(`从自选移除「${item.alias || item.officialName}」?`)) return; quiet(() => runtime.mutate('remove', { securityId: item.id }))(); runtime.updateView({ detailId: null, selectedId: null, overlay: null, focusId: null }) } }, '移出自选'))),
        h('div', { className: 'ssb-forms-body' },
          h('section', { className: 'ssb-form-block' },
            h('h4', null, '价格标记'),
            markForm,
            markList,
            h('p', { className: 'ssb-form-hint' }, '多笔成本取最低价作为成本，盈亏按它算；每条成本单独显示与现价的百分比，卖价收益也按成本算。')),
          h('section', { className: 'ssb-form-block' },
            h('h4', null, '分组标签与别名'),
            tagForm,
            h('form', { className: 'ssb-inline-form', onSubmit: e => { e.preventDefault(); quiet(() => runtime.mutate('alias', { securityId: item.id, alias: view.alias }))() } },
              h('label', { className: 'ssb-inline-field' }, h('span', { className: 'ssb-field-label' }, '别名'), h('input', { className: 'ssb-input ssb-input-alias', value: view.alias || '', maxLength: 30, onChange: e => runtime.updateView({ alias: e.target.value }), 'aria-describedby': 'ssb-alias-hint' })),
              h('button', { type: 'submit', className: 'ssb-button', disabled: state.busy.write }, '保存别名')),
            h('p', { id: 'ssb-alias-hint', className: 'ssb-form-hint' }, '别名最多 30 个字符,留空显示正式名称。')))) : null
      return h('aside', { className: 'ssb-detail' }, h('div', { className: 'ssb-section-head' }, h('h2', null, item.alias || item.officialName), inWatchlist && order.length > 1 ? h('div', { className: 'ssb-toolbar' }, h(Button, { onClick: () => openNeighbor(neighbor(-1)) }, '上一只'), h(Button, { onClick: () => openNeighbor(neighbor(1)) }, '下一只')) : null),
        h('p', { className: 'ssb-muted' }, `${item.officialName} · ${marketLabel} ${item.code}${currency ? ` · ${currency}` : ''}`),
        h('div', { className: `ssb-detail-price ssb-number${direction}` }, priceTextOf(q?.last, item.priceScale), h('span', { className: 'ssb-small' }, q?.changePct == null ? '—' : `${signed(q.changePct)}%`)),
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
    // 悬浮窗自己的数据流: 列表模式批量拉勾选标的的报价, 图形模式只拉当前这只的分时
    function useFloatingPolling({ open, mode, securityId, picked, items, live, floatSeconds, quotes, fetched, revision, setFetched, setTrend, setError }) {
      // quotes 的每条是 { quote, health }, 交易时段在 quote 里
      // 时段取最新的一份: 自己拉的和面板的都可能旧, 不能无条件让自己的压过面板的。
      // 时间戳相同取自己那份——自己那份刚由这一拍的刷新拿到, 而面板可能在本次渲染前就已冻结
      const stateOf = id => pickNewest(fetched?.[id]?.quote, quotes?.[id]?.quote)?.sessionState
      const pickedKey = picked.join(','), stateKey = picked.map(stateOf).join(',')
      React.useEffect(() => {
        if (!open || !picked.length || live === false) return
        let dead = false
        setError('')
        // 间隔跟随设置页的刷新间隔; 全部收市后降到一分钟一拍
        // 间隔由 floatPollDelay 统一算, 这里只判断要不要降频
        // 午休与休市都不产生新数据, 一并归入安静档: 只认 closed 的话, 午休那一个半小时
        // 图形模式还在按交易频率打分时
        // 名字不能叫 quiet: 模块里已有一个 quiet() 帮助函数用来包住点击处理
        const allQuiet = picked.every(id => QUIET_STATES.has(stateOf(id)))
        // 页面不可见时不拉: 后台标签页继续轮询只会白耗来源额度
        let tick = 0
        const pull = () => {
          if (document.visibilityState !== 'visible') return
          tick += 1
          const plan = pollPlan({ mode, quiet: allQuiet, tick })
          if (plan === 'skip') return
          const refresh = () => fetch(`${BASE}/refresh`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ operationId: crypto.randomUUID(), expectedRevision: revision ?? 0, securities: picked.map(id => ({ id, exchange: items[id].exchange, code: items[id].code })) }),
          })
            .then(response => response.json())
            .then(payload => { if (dead) return; if (payload.ok) { setFetched(payload.data.quotes || {}); setError('') } else setError(payload.error?.message || '行情不可用') })
            .catch(() => { if (!dead) setError('行情不可用') })
          if (plan === 'refresh') refresh()
          else if (plan === 'snapshot') {
            // 只读快照: 省额度用, 但它不重算交易时段, 单靠它醒不过来
            fetch(`${BASE}/snapshot`)
              .then(response => response.json())
              .then(payload => { if (dead) return; if (payload.ok) setFetched(payload.data.quotes || {}); setError(payload.ok ? '' : payload.error?.message || '行情不可用') })
              .catch(() => { if (!dead) setError('行情不可用') })
          } else if (securityId) {
            fetch(`${BASE}/kline?${new URLSearchParams({ securityId, period: 'trend', limit: '250' })}`)
              .then(response => response.json())
              // 悬停读数是按 close 逐个对齐的, 必须先清洗: 坏一根就会让读数与光标错位
              .then(payload => { if (dead) return; if (payload.ok) { setTrend({ securityId, data: { ...payload.data, candles: sanitizeCandles(payload.data?.candles) } }); setError('') } else setError(payload.error?.message || '行情不可用') })
              .catch(() => { if (!dead) setError('行情不可用') })
          }
        }
        pull()
        // 休市时不设交易节奏的定时器, 但仍留一拍低频检查, 复盘后自动恢复
        const timer = setInterval(pull, floatPollDelay(floatSeconds, allQuiet))
        return () => { dead = true; clearInterval(timer) }
      }, [open, mode, securityId, pickedKey, live, floatSeconds, stateKey])
    }
    // 拖动: 按住非控件区域移动, 松手时把落点写回偏好
    function useFloatingDrag(onDrop) {
      const dragRef = React.useRef(null)
      const clamp = (x, y, el) => {
        const width = el?.offsetWidth || 288, height = el?.offsetHeight || 210, margin = 8
        return { x: Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - width - margin)), y: Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - height - margin)) }
      }
      return {
        onPointerDown: e => {
          // 只认左键, 且只从标题条拖: 窗体内要留纵向手势给列表滚动
          if (e.button !== 0 || !e.target.closest('.ssb-float-head') || e.target.closest('button, input, label')) return
          const box = e.currentTarget.getBoundingClientRect()
          dragRef.current = { dx: e.clientX - box.left, dy: e.clientY - box.top }
          e.currentTarget.setPointerCapture?.(e.pointerId)
        },
        onPointerMove: e => {
          if (!dragRef.current) return
          const { x, y } = clamp(e.clientX - dragRef.current.dx, e.clientY - dragRef.current.dy, e.currentTarget)
          e.currentTarget.style.left = `${x}px`
          e.currentTarget.style.top = `${y}px`
          e.currentTarget.style.right = 'auto'
          e.currentTarget.style.bottom = 'auto'
        },
        onPointerUp: e => {
          if (!dragRef.current) return
          dragRef.current = null
          e.currentTarget.releasePointerCapture?.(e.pointerId)
          const box = e.currentTarget.getBoundingClientRect()
          onDrop({ x: Math.round(box.left), y: Math.round(box.top) })
        },
      }
    }
    // 悬浮窗自己的快慢档位: 只影响这个窗口的请求节奏, 与列表刷新间隔各管各的
    const FLOAT_INTERVALS = [3, 5, 10, 15, 30], FLOAT_FALLBACK_SECONDS = 10
    // 档位归一: 定时器、按钮文案与陈旧判定共用同一份取值, 避免非法存量值让三者各说各话
    const floatIntervalOf = floatSeconds => FLOAT_INTERVALS.includes(Number(floatSeconds)) ? Number(floatSeconds) : FLOAT_FALLBACK_SECONDS
    // 轮询节奏: 全部收市后压到一分钟一拍
    const floatPollDelay = (floatSeconds, quiet) => {
      const base = floatIntervalOf(floatSeconds) * 1000
      return quiet ? Math.max(base, 60 * 1000) : base
    }
    // 主序列是蜡烛还是面积, 决定重涂时该下发哪一组键名: 两组键名互不相通, 用错等于没涂
    function seriesPaintPlan(theme, isArea) {
      return isArea
        ? { lineColor: theme.up, topColor: theme.up + '4d', bottomColor: theme.up + '07' }
        : { upColor: theme.up, downColor: theme.down, borderUpColor: theme.up, borderDownColor: theme.down, wickUpColor: theme.up, wickDownColor: theme.down }
    }
    // 宿主把主题 token 内联写在 body 的 style 上, 同色系两套主题切换时明暗标记并不变,
    // 只盯着那个标记会整次漏掉换肤。取实际色值当签名, 才算判断了「主题真的变了」。
    // background 也在签名里: 画布底色就铺的是它, canvas 不透明, 漏掉它等于背景永远不换
    const themeSignature = t => [t.background, t.textColor, t.gridLine, t.crosshair, t.up, t.down, t.volumeUp, t.volumeDown, t.cost, t.target, t.EMA, t.BBI, ...t.MA, ...t.BOLL].join('|')
    // 轮询决策。三件事必须同时成立: 收市后不再打上游、又不能永远停在那儿、还不能每分钟真刷一次。
    // trend 端点不进缓存, 收市后必须彻底停掉; 而 /snapshot 只读缓存不重算交易时段,
    // 单靠它永远发现不了开市, 所以每隔几拍要用真刷新把状态翻回来
    const POLL_EVERY = 10
    // 午休与收盘都不产生新数据, 归同一个安静档
    const QUIET_STATES = new Set(['closed', 'break'])
    const pollPlan = ({ mode, quiet, tick }) => {
      const beat = tick % POLL_EVERY === 0
      if (mode === 'list') return quiet && !beat ? 'snapshot' : 'refresh'
      // 整十拍必须真刷新一次, 且不能只在已知安静时才刷: 时段只能由刷新结果更新,
      // 而面板不活跃时它的报价会冻结在 trading —— 那样 quiet 永远翻不过来, 图形模式就
      // 会一直按交易频率打 trend(该端点不进缓存, 每拍都是真上游)
      // 刚切进来先把图画出来: 否则要等一个刷新周期, 图形模式会空白十几秒
      if (tick === 1) return 'trend'
      if (beat) return 'refresh'
      return quiet ? 'skip' : 'trend'
    }
    // 全部收市后只读快照: 只为发现迟到的复盘, 不必每分钟真打一次上游
    const FLOAT_KEY = 'ssb-floating'
    // ids 为空时退回自选前几只, 否则第一次打开会是一张空窗
    // ids 为 null 表示"从没勾过"(退回默认前五只), 空数组表示"明确一只都不盯", 两者不能混
    const FLOAT_DEFAULT = { open: false, live: true, mode: 'list', ids: null, securityId: null, x: null, y: null }
    // 标记价提醒默认关: 主动打扰必须由用户自己打开, 铃铛在悬浮窗底部
    const ALERT_PREF_KEY = 'ssb-float-alert'
    const ALERT_PREF_DEFAULT = { on: false }
    const ALERT_FLASH_MS = 5 * 1000
    // 刷新开关的两个图标: 形状即动作, 与其它悬浮窗按钮同一套图标语言
    const pauseIcon = () => h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'currentColor', 'aria-hidden': true, style: { display: 'block' } },
      h('rect', { x: '4', y: '3', width: '2.6', height: '10', rx: '1' }),
      h('rect', { x: '9.4', y: '3', width: '2.6', height: '10', rx: '1' }))
    const playIcon = () => h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'currentColor', 'aria-hidden': true, style: { display: 'block' } },
      h('path', { d: 'M5.2 3.2l6.6 4.8-6.6 4.8z' }))
    // 铃铛图标: 开与关同形, 关闭是空心轮廓、开启填实, 一眼看出当前是不是在提醒
    const bellIcon = filled => h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: filled ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true, style: { display: 'block' } },
      h('path', { d: 'M8 2.2a4 4 0 0 0-4 4v3.1l-1 2.2h10l-1-2.2V6.2a4 4 0 0 0-4-4z', strokeLinejoin: 'round' }),
      h('path', { d: 'M6.5 13.2a1.5 1.5 0 0 0 3 0', fill: 'none', strokeLinecap: 'round' }))
    // 分时曲线自绘: 只要一条折线加填充, 不值得为它再挂一个图表实例
    function Sparkline({ candles, preClose, marks, scale }) {
      const values = (candles || []).map(c => finiteOr(c.close)).filter(Number.isFinite)
      const [hover, setHover] = React.useState(null)
      const [zoom, setZoom] = React.useState(1)
      const wrapRef = React.useRef(null)
      // 滚轮缩放纵向范围: React 的 onWheel 走 passive 监听, 只有挂原生监听才拦得住页面滚动。
      // 依赖点数而不是空依赖: 首帧没有数据时容器还没挂上, 只挂一次会永远拿不到元素
      React.useEffect(() => {
        const element = wrapRef.current
        if (!element) return
        const onWheel = event => {
          event.preventDefault()
          // Shift+滚轮只给横向 delta: 不是缩放手势, 也不能被当成缩小
          if (!event.deltaY) return
          setZoom(value => Math.max(1, Math.min(12, value * (event.deltaY < 0 ? 1.2 : 1 / 1.2))))
        }
        element.addEventListener('wheel', onWheel, { passive: false })
        return () => element.removeEventListener('wheel', onWheel)
      }, [values.length])
      if (!values.length) return null
      const width = 264, height = 88, axisWidth = 40
      const plotWidth = width - axisWidth
      const base = finiteOr(preClose)
      // 纵轴只由价格与昨收决定: 标记不参与缩放, 否则成本价离得远时整条分时会被压成一条线
      const range = sparkRangeOf({ values, preClose, zoom })
      const low = range.low, high = range.high, span = high - low || 1
      const yOf = value => height - ((value - low) / span) * height
      const xOf = index => (index / Math.max(1, values.length - 1)) * plotWidth
      const line = values.map((value, index) => `${index ? 'L' : 'M'}${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}`).join('')
      const picked = hover == null ? null : candles?.[hover]
      const price = picked ? finiteOr(picked.close) : NaN
      const pct = Number.isFinite(price) && Number.isFinite(base) && base ? (price - base) / base * 100 : null
      // 标记线常驻, 但只画落在可视区间里的: 超范围的标记不显示, 也不改缩放
      const lines = (marks || []).map(mark => ({ mark, y: yOf(mark.price) })).filter(entry => entry.y >= 0 && entry.y <= height)
      const ticks = sparkTicksOf({ low, high })
      // 标签精度由步长推: 步长 0.1 却按两位显示会把 10.1 与 10.15 印成同一串
      const tickStep = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1
      const tickDigits = Math.min(4, tickStep >= 1 ? 0 : Math.ceil(-Math.log10(tickStep)))
      const move = event => {
        const rect = event.currentTarget.getBoundingClientRect()
        if (!rect.width) return
        const ratio = (event.clientX - rect.left) / rect.width
        // 指针落在右侧刻度区时不算读数: 那里没有曲线
        if (ratio > plotWidth / width) { setHover(null); return }
        setHover(sparkIndexAt(ratio * width / plotWidth, values.length))
      }
      return h('div', { ref: wrapRef, className: 'ssb-float-spark-wrap', onPointerMove: move, onPointerLeave: () => setHover(null) },
        h('svg', { className: 'ssb-float-spark', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': '分时走势' },
          Number.isFinite(base) ? h('line', { className: 'ssb-float-base', x1: 0, x2: plotWidth, y1: yOf(base), y2: yOf(base) }) : null,
          ...lines.map(entry => h('line', { key: entry.mark.id, className: `ssb-float-markline ssb-float-markline-${entry.mark.kind}`, x1: 0, x2: plotWidth, y1: entry.y, y2: entry.y })),
          h('path', { className: 'ssb-float-area', d: `${line}L${plotWidth},${height}L0,${height}Z` }),
          h('path', { className: 'ssb-float-line', d: line }),
          hover == null ? null : h('line', { className: 'ssb-float-cursor', x1: xOf(hover), x2: xOf(hover), y1: 0, y2: height }),
          hover == null || !Number.isFinite(price) ? null : h('circle', { className: 'ssb-float-dot', cx: xOf(hover), cy: yOf(price), r: 2.5 })),
        h('div', { className: 'ssb-float-axis', 'aria-hidden': true },
          ...ticks.flatMap(tick => {
            const top = `${Math.min(96, Math.max(4, ((high - tick) / span) * 100))}%`
            return [
              h('span', { key: `tick-${tick}`, className: 'ssb-float-tick', style: { top } }),
              h('span', { key: `value-${tick}`, className: 'ssb-float-tick-value', style: { top } }, priceTextOf(tick, tickDigits)),
            ]
          })),
        hover == null || !picked ? null : h('div', { className: 'ssb-float-hover' },
          h('span', null, candleTimeText(picked)),
          h('strong', { className: `ssb-number${toneClass(pct)}` }, Number.isFinite(price) ? priceTextOf(price, scale) : '—'),
          h('span', { className: toneClass(pct).trim() }, pct == null ? '' : `${signed(pct.toFixed(2))}%`)))
    }
    // 悬浮窗的各块只做渲染: 状态、轮询与提醒都留在 FloatingTicker, 这里只接数据与回调
    function FloatHeader({ mode, picker, current, picked, onStep, onMode, onPicker, onClose }) {
      return h('div', { className: 'ssb-float-head' },
        mode === 'kline' && !picker ? h('button', { className: 'ssb-float-icon', 'aria-label': '上一只', onClick: () => onStep(-1) }, '‹') : null,
        h('span', { className: 'ssb-float-name', title: current ? `${current.officialName} ${current.code}` : '' }, picker ? '选择观测目标' : mode === 'kline' && current ? (current.alias || current.officialName) : `盯盘 ${picked.length}`),
        mode === 'kline' && !picker && current ? h('span', { className: 'ssb-float-code' }, current.code) : null,
        mode === 'kline' && !picker ? h('button', { className: 'ssb-float-icon', 'aria-label': '下一只', onClick: () => onStep(1) }, '›') : null,
        h('div', { className: 'ssb-float-modes' },
          h('button', { type: 'button', className: `ssb-float-mode${mode === 'list' ? ' on' : ''}`, 'aria-pressed': mode === 'list', onClick: () => onMode('list') }, '列表'),
          h('button', { type: 'button', className: `ssb-float-mode${mode === 'kline' ? ' on' : ''}`, 'aria-pressed': mode === 'kline', onClick: () => onMode('kline') }, '图')),
        h('button', { type: 'button', className: 'ssb-float-icon', 'aria-label': picker ? '完成选择' : '选择观测目标', 'aria-expanded': picker, onClick: () => onPicker(!picker) }, picker ? '✓' : '☰'),
        h('button', { type: 'button', className: 'ssb-float-icon', 'aria-label': '关闭悬浮盯盘', onClick: () => onClose() }, '✕'))
    }
    // 多标签下一只票会同时属于多个分组, 按段列会重复出现: 选择器平铺全部标的, 顶部只留计数与全选
    function FloatPicker({ order, items, picked, onPicked }) {
      const toggleMany = (ids, on) => { const set = new Set(picked); ids.forEach(id => on ? set.add(id) : set.delete(id)); onPicked([...set]) }
      // 与 tagTabs 同口径: 只有确实存在的标的参与勾选, 否则渲染时读不到名字会整块浮窗消失
      const ids = order.filter(id => items[id])
      const allOn = ids.length > 0 && ids.every(id => picked.includes(id))
      return h('div', { className: 'ssb-float-picker' }, ...(ids.length
        ? [
          h('div', { key: 'summary', className: 'ssb-picker-head' },
            h('span', null, `已选 ${ids.filter(id => picked.includes(id)).length}/${ids.length}`),
            h('button', { type: 'button', className: 'ssb-picker-all', onClick: () => toggleMany(ids, !allOn) }, allOn ? '全不选' : '全选')),
          ...ids.map(id => h(Toggle, { key: id, label: items[id].alias || items[id].officialName, checked: picked.includes(id), onChange: () => toggleMany([id], !picked.includes(id)) })),
        ]
        : [h('p', { key: 'empty', className: 'ssb-muted' }, '自选为空')]))
    }
    function FloatList({ picked, items, securityId, entryOf, onPick, onTip, onLeave, onScroll }) {
      return h('div', { className: 'ssb-float-list', onScroll },
        ...(picked.length ? picked.map(id => {
          const item = items[id], quote = entryOf(id)?.quote, change = quote?.changePct
          return h('button', { key: id, type: 'button', className: `ssb-float-row${id === securityId ? ' ssb-float-row-on' : ''}`, onClick: () => onPick(id), onPointerEnter: event => onTip(id, event), onPointerLeave: onLeave },
            h('span', { className: 'ssb-float-row-name' }, item.alias || item.officialName),
            h('span', { className: 'ssb-float-code' }, item.code),
            h('span', { className: `ssb-float-row-price ssb-number${toneClass(change)}` }, priceTextOf(quote?.last, item.priceScale)),
            h('span', { className: `ssb-float-row-pct ssb-number${toneClass(change)}` }, change == null ? '—' : `${signed(Number(change).toFixed(2))}%`))
        }) : [h('p', { className: 'ssb-muted' }, '未选择标的，点 ☰ 勾选')]))
    }
    function FloatChart({ securityId, current, candles, preClose, error, last, pct }) {
      return h(React.Fragment, null,
        h('div', { className: `ssb-float-quote ssb-number${toneClass(pct)}` },
          h('span', { className: 'ssb-float-price' }, Number.isFinite(last) ? priceTextOf(last, current.priceScale) : '—'),
          h('span', { className: 'ssb-float-pct' }, pct == null ? '—' : `${signed(pct.toFixed(2))}%`)),
        error ? h('p', { className: 'ssb-float-error' }, error) : h('div', { className: `ssb-float-chart${toneClass(pct)}` }, h(Sparkline, { key: securityId, candles, preClose, marks: current.marks, scale: current.priceScale })),
        // 标记价常驻一行: 图里画得出的是范围内的横线, 范围外的用这行交代, 不必悬停才知道
        (current.marks || []).length ? h('div', { className: 'ssb-float-marks' }, ...(current.marks || []).map(mark => h('span', { key: mark.id, className: mark.kind === 'cost' ? 'ssb-legend-cost' : 'ssb-legend-target' }, `${mark.kind === 'cost' ? '成本' : '卖价'} ${priceTextOf(mark.price, current.priceScale)}`))) : null)
    }
    function FloatFoot({ mode, securityId, picked, current, stamp, stale, alertOn, error, liveOn, refresh, onBell, onLive, onDetail }) {
      const stampTitle = stamp == null ? '尚未取到行情' : `${stale ? '行情未更新，' : ''}最近价时刻 ${timeText(stamp)}`
      const stampLabel = stamp == null ? `${picked.length} 只，尚未取到行情` : `${picked.length} 只，最近价时刻 ${timeText(stamp)}${stale ? '，数据已过时' : ''}`
      const refreshLabel = !picked.length ? '还没有勾选观测目标' : error ? `更新失败：${error}，点击重试` : liveOn ? `行情每 ${refresh} 秒自动刷新，点击暂停` : '自动刷新已暂停，点击恢复'
      return h('div', { className: 'ssb-float-foot' },
        h('span', { className: `ssb-float-stamp${stale ? ' ssb-float-stamp-stale' : ''}`, title: stampTitle, 'aria-label': stampLabel },
          `${mode === 'kline' && securityId ? `${picked.indexOf(securityId) + 1}/${picked.length}` : `${picked.length} 只`}${stamp == null ? '' : ` · ${clockText(stamp)}`}`),
        h('button', { type: 'button', className: `ssb-float-icon ssb-float-bell${alertOn ? ' on' : ''}`, 'aria-label': alertOn ? '关闭标记价提醒' : '开启标记价提醒', 'aria-pressed': alertOn, title: alertOn ? '标记价提醒已开启：现价穿越成本或卖价时通知' : '标记价提醒已关闭', onClick: onBell }, bellIcon(alertOn)),
        h('button', { type: 'button', className: `ssb-float-icon ssb-float-live${error ? ' ssb-float-live-error' : ''}`, 'aria-label': !picked.length ? '自动刷新不可用' : error ? '重试自动刷新' : liveOn ? '暂停自动刷新' : '恢复自动刷新', 'aria-pressed': liveOn, title: refreshLabel, disabled: !picked.length, onClick: onLive }, liveOn ? pauseIcon() : playIcon()),
        h('button', { type: 'button', className: 'ssb-float-icon', 'aria-label': '打开详情', title: securityId ? `打开 ${current?.alias || current?.officialName} 详情` : '还没有可打开的标的', disabled: !securityId, onClick: onDetail }, '⤢'))
    }
    function FloatingTicker({ runtime }) {
      const state = React.useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
      const [floating, setFloating] = usePref(FLOAT_KEY, FLOAT_DEFAULT)
      const [fetched, setFetched] = React.useState({})
      const [trend, setTrend] = React.useState(null)
      const [error, setError] = React.useState('')
      const [picker, setPicker] = React.useState(false)
      const items = state.data?.control.watchlist.items || {}
      const order = state.data?.control.watchlist.order || []
      // 勾选的观测目标: 空则退回自选前几只, 但绝不隐式等于全部自选
      const picked = (Array.isArray(floating.ids) ? floating.ids : order.slice(0, 5)).filter(id => items[id])
      const mode = floating.mode === 'kline' ? 'kline' : 'list'
      const open = !!floating.open
      const securityId = (floating.securityId && picked.includes(floating.securityId) ? floating.securityId : picked[0]) || null
      const update = next => setFloating(next)
      const drag = useFloatingDrag(update)
      // 悬浮窗节奏取自独立偏好, 列表间隔不再参与
      const floatRefresh = floatIntervalOf(state.data?.control.preferences?.floatRefreshSeconds)
      useFloatingPolling({ open, mode, securityId, picked, items, live: floating.live, floatSeconds: floatRefresh, quotes: state.data?.quotes, fetched, revision: state.data?.control.revision, setFetched, setTrend, setError })
      // 面板已经刷过的报价先拿来渲染, 悬浮窗自己的 refresh 结果回来后再按 receivedAt 择优:
      // 否则首次打开要干等一轮上游请求, 列表是空的
      const entryOf = id => {
        const panel = state.data?.quotes?.[id], own = fetched[id]
        if (!panel) return own
        if (!own) return panel
        return pickNewest(own.quote, panel.quote) === own.quote ? own : panel
      }
      const quoteOf = id => entryOf(id)?.quote
      // 标记价提醒的开关与瞬时高亮都是本组件的常驻状态: 必须在提前 return 之前声明
      const [alert, setAlert] = usePref(ALERT_PREF_KEY, ALERT_PREF_DEFAULT)
      const [alerting, setAlerting] = React.useState(false)
      const [rowTip, setRowTip] = React.useState(null)
      const alertTimer = React.useRef(null)
      const alertStates = React.useRef({})
      const alertOn = alert.on === true
      const alertWatch = picked.map(id => {
        const quote = quoteOf(id)
        const marks = (items[id]?.marks || []).map(mark => `${mark.id}:${mark.kind}:${mark.price}`).join(',')
        return `${id}|${quote?.last ?? ''}|${quote?.receivedAt ?? ''}|${marks}`
      }).join(';')
      const flashAlert = () => {
        setAlerting(true)
        clearTimeout(alertTimer.current)
        alertTimer.current = setTimeout(() => setAlerting(false), ALERT_FLASH_MS)
      }
      React.useEffect(() => {
        // 暂停刷新时不判穿越: 面板行情仍在变, 靠它提醒会与"价格不会自己更新"的承诺打架
        if (!alertOn || !open || !picked.length || floating.live === false) return
        const hub = typeof window === 'undefined' ? null : window.__dshNotify
        const now = Date.now()
        for (const id of picked) {
          // 停牌或无成交时 last 是 null: 不能 Number(null) 成 0, 否则会报"现价 0.00 跌破成本"并吞掉真实提醒
          const target = items[id], price = finiteOr(quoteOf(id)?.last)
          if (!Number.isFinite(price) || !(target?.marks || []).length) continue
          for (const mark of target.marks) {
            // 键带插件前缀: 桥接那边的去重表是共享的, 不能让别家同形键把提醒吞掉
            const key = `stock:${id}|${mark.id}`
            const prev = alertStates.current[key] || {}
            const verdict = markAlertOf({ mark, price, prev: prev.side, lastFiredAt: prev.at, now })
            alertStates.current[key] = { side: verdict.side, at: verdict.fire ? now : prev.at }
            if (!verdict.fire) continue
            deliverMarkAlert({ alert: markAlertText({ name: target.alias || target.officialName, price, mark, scale: target.priceScale }), key, hub, blink: startAlertBlink, flash: flashAlert, notify: sendBrowserNotification })
          }
        }
      }, [alertWatch, alertOn, open, floating.live])
      // 卸载时清掉本组件的定时器与标题闪烁, 不能把降级提示留在宿主标题上
      React.useEffect(() => () => { clearTimeout(alertTimer.current); stopAlertBlink() }, [])
      // 切模式/开关面板时行浮层必须收掉: 列表已经不在, 留着就是一块幽灵卡片
      React.useEffect(() => { setRowTip(null) }, [mode, picker, open])
      if (!open) return null
      const position = floating.x == null || floating.y == null ? {} : { left: floating.x, top: floating.y, right: 'auto', bottom: 'auto' }
      const step = delta => {
        const at = picked.indexOf(securityId)
        const next = picked[(at + delta + picked.length) % picked.length]
        // 只有一只时 next 就是自己, 清掉 trend 反而让图空一转到下一拍才回来
        if (next && next !== securityId) { setTrend(null); update({ securityId: next }) }
      }
      const current = items[securityId]
      // 分时数据必须和标的绑在一起: 切标的时新请求还没回来, 直接用旧数据会把上一只的价格当成这一只
      const trendData = trend?.securityId === securityId ? trend.data : null
      const candles = trendData?.candles
      // 卡片上的更新时间: 停在旧价上而不显示时刻, 是"看着像实时"的唯一来源。
      // 列表取全部勾选里最旧的一份——有一只停更就有一只价格不能信; 图形模式认图上最后一根的时间
      const stampIds = mode === 'kline' && securityId ? [securityId] : picked
      const quoteTimes = stampIds.map(id => priceTimeOf(quoteOf(id))).filter(at => at != null)
      const liveQuoteTimes = picked.filter(id => !QUIET_STATES.has(quoteOf(id)?.sessionState)).map(id => timestampOf(quoteOf(id)?.receivedAt)).filter(at => at != null)
      const trendAt = mode === 'kline' ? (timestampOf(candles?.at(-1)?.at) ?? timestampOf(trendData?.fetchedAt)) : null
      const { stamp, stale } = floatFreshness({ mode, quoteTimes, liveQuoteTimes, trendAt, quiet: QUIET_STATES.has(quoteOf(securityId)?.sessionState), now: Date.now(), refreshSeconds: floatRefresh })
      // 这里必须先过 finiteOr: Number(null) 是 0, 会把缺失的昨收当成真实的 0 交给下游,
      // 结果是迷你图基准画在 0、价格显示 "0", 与图例里的「昨收 —」自相矛盾
      const last = finiteOr(candles?.at(-1)?.close)
      const base = finiteOr(trendData?.preClose)
      const pct = Number.isFinite(last) && Number.isFinite(base) && base ? (last - base) / base * 100 : null
      const showRowTip = (id, event) => {
        // 行提示走公共悬浮组件(common-tools Tooltip):portal 到 body, 不受列表 overflow 裁剪;
        // 组件自己按视口夹取与换侧, 不再预估高度
        const rect = event.currentTarget.getBoundingClientRect()
        setRowTip({ id, anchor: { kind: 'rect', left: rect.left, top: rect.top, width: rect.width, height: rect.height } })
      }
      const greenUp = state.data?.control.preferences.colorMode === 'green-up' ? ' ssb-green-up' : ''
      // 勾选写入一律按自选顺序重排, 否则反复勾选会把 ids 变成点击次序, 列表顺序会跳
      const setPicked = ids => { const set = new Set(ids); update({ ids: order.filter(id => set.has(id)) }) }
      return h('div', { className: `ssb-float${greenUp}${alerting ? ' ssb-float-alerting' : ''}`, role: 'complementary', 'aria-label': '悬浮盯盘', style: position, onPointerDown: drag.onPointerDown, onPointerMove: drag.onPointerMove, onPointerUp: drag.onPointerUp, onPointerCancel: drag.onPointerUp },
        React.createElement('style', { 'data-plugin': '@mzzsfy/dsh-stock-assistant', dangerouslySetInnerHTML: { __html: CSS } }),
        h(FloatHeader, { mode, picker, current, picked, onStep: step, onMode: next => update({ mode: next }), onPicker: setPicker, onClose: () => update({ open: false }) }),
        picker
          ? h(FloatPicker, { order, items, picked, onPicked: setPicked })
          : mode === 'list'
            ? h(FloatList, { picked, items, securityId, entryOf, onPick: id => update({ mode: 'kline', securityId: id }), onTip: showRowTip, onLeave: () => setRowTip(null), onScroll: () => setRowTip(null) })
            : !current ? h('p', { className: 'ssb-muted' }, '未选择标的') : h(FloatChart, { securityId, current, candles, preClose: base, error, last, pct }),
        h(FloatFoot, {
          mode, securityId, picked, current, stamp, stale, alertOn, error, liveOn: floating.live !== false, refresh: floatRefresh,
          onBell: () => { const next = !alertOn; alertStates.current = {}; setAlert({ on: next }); if (next) requestAlertPermission() },
          onLive: () => {
            if (!picked.length) return
            const liveOn = floating.live !== false
            update({ live: !liveOn })
            tools.toast?.show(liveOn ? '已暂停自动刷新，价格不会自己更新' : '已恢复自动刷新')
          },
          onDetail: () => { if (securityId) runtime.openDetail(securityId) },
        }),
        rowTip && items[rowTip.id] ? h(tools.Tooltip, { anchor: rowTip.anchor },
          ...quoteTipLines({ quote: quoteOf(rowTip.id), marks: items[rowTip.id].marks, scale: items[rowTip.id].priceScale }).map((text, index) => h('div', { key: index }, text))) : null)
    }
    function BrowseView({ runtime, state }) {
      const { view, busy, data } = state
      const rows = view.browseRows
      return h('section', { className: 'ssb-search-view' },
        h('div', { className: 'ssb-panel-head' }, h('h2', null, '浏览市场'), h('div', { className: 'ssb-toolbar' }, h(Button, { onClick: () => runtime.updateView({ view: 'list' }) }, '返回自选'))),
        h('div', { className: 'ssb-toolbar', style: { padding: '12px 16px 0' } }, ...Object.keys(BROWSE_MARKETS).filter(market => (data?.control.routes || []).some(r => r.capability === 'catalog' && r.market === market)).map(market => h(Button, { key: market, primary: (view.browseMarket || 'XSHG') === market, disabled: busy.browse, onClick: quiet(() => runtime.loadBrowse(market, 0)) }, BROWSE_MARKETS[market]))),
        data?.browseOverview ? (() => {
          // 缺 previousClose 时 change/changePct 会是 null, Number(null) 得 0, 直接拼会渲染出「+null（+null%）」
          const ov = data.browseOverview, change = finiteOr(ov.change), changePct = finiteOr(ov.changePct)
          const tone = toneClass(change)
          // 保留来源给的位数, 只补正负号; 缺失时给破折号而不是把 null 当 0
          const fmt = raw => { if (raw == null || raw === '') return '—'; const n = Number(raw); return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${raw}` : '—' }
          return h('div', { className: 'ssb-banner ssb-banner-ok', style: { margin: '12px 16px 0' } }, `${ov.name} ${ov.last ?? '—'}`, h('span', { className: `ssb-number${tone}` }, `${fmt(ov.change)}（${fmt(ov.changePct)}%）`), h('span', { className: 'ssb-muted' }, `${ov.source} · ${ov.delayKind === 'unknown' ? '延迟未知' : delayText(ov)}`))
        })() : null,
        !rows ? h('div', { className: 'ssb-empty' }, view.browseSyncing ? h('p', null, '目录首次同步中（约一两分钟），完成后重新点击该市场即可浏览。') : h(React.Fragment, null, h('p', null, '该市场目录未同步。可直接搜索添加自选，或同步目录后浏览。'), h(Button, { primary: true, onClick: () => runtime.updateView({ view: 'list', overlay: 'settings' }) }, '前往设置'), h(Button, { disabled: busy.sync, onClick: quiet(() => runtime.sync(view.browseMarket || 'XSHG')) }, '同步当前市场目录'))) :
          h('div', { className: 'ssb-results', role: 'list', 'aria-label': '市场证券列表' }, ...rows.map(item => {
            const added = !!data?.control.watchlist.items[item.id]
            return h('div', { className: 'ssb-candidate', role: 'listitem', key: item.id }, h('button', { type: 'button', className: 'ssb-stock-name', onClick: () => { runtime.updateView({ detailId: item.id, view: view.view, overlay: 'detail', browsePeek: { ...(view.browsePeek || {}), [item.id]: item } }); runtime.refresh([{ id: item.id, exchange: item.exchange, code: item.code, officialName: item.officialName }]).catch(() => {}) } }, h('strong', null, item.officialName), h('span', { className: 'ssb-muted' }, `${MARKET_LABEL[item.exchange] || item.exchange} ${item.code}`)), h(Button, { disabled: added || busy.write, onClick: quiet(() => runtime.mutate('add', { securityId: item.id })) }, added ? '已在自选' : '加自选'))
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
            h('div', { className: 'ssb-field' }, h('span', null, '市场'), h(Select, { value: view.searchMarket || 'all', label: '市场', options: [['all', '全部'], ['XSHG', '沪A股'], ['XSHE', '深A股'], ['XHKG', '港股'], ['XNAS', '美股(NASDAQ)'], ['XNYS', '美股(NYSE)'], ['XJPX', '日经'], ['XKRX', '韩证'], ['XLON', '伦敦']].map(([value, label]) => ({ value, label })), onChange: value => runtime.updateView({ searchMarket: value }) })),
            h('label', { className: 'ssb-search-label' }, '搜索名称、代码或拼音首字母', h('input', { type: 'search', autoFocus: true, value: view.query, placeholder: '例如 600519、茅台、腾讯、AAPL', onChange: e => runtime.search(e.target.value), onCompositionStart: () => runtime.composition(true), onCompositionEnd: () => runtime.composition(false), onKeyDown: e => {
          if (e.nativeEvent?.isComposing || state.composing) return
          const at = visible.findIndex(c => c.id === view.selectedId)
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const index = e.key === 'ArrowDown' ? Math.min(visible.length - 1, at + 1) : Math.max(0, at - 1); if (visible[index]) choose(visible[index]) }
          if (e.key === 'Escape') runtime.updateView({ view: 'list' })
        } }))),
        h('div', { role: 'listbox', 'aria-label': '证券搜索结果', className: 'ssb-results' }, ...visible.map(item => h('div', { role: 'option', 'aria-selected': view.selectedId === item.id, key: item.id, className: `ssb-candidate${view.selectedId === item.id ? ' ssb-selected' : ''}`, onClick: () => choose(item) }, h('span', { className: 'ssb-peek', role: 'button', tabIndex: 0, onClick: e => { e.stopPropagation(); runtime.updateView({ detailId: item.id, view: view.view, overlay: 'detail', browsePeek: { ...(view.browsePeek || {}), [item.id]: item } }); runtime.refresh([{ id: item.id, exchange: item.exchange, code: item.code, officialName: item.officialName }]).catch(() => {}) } }, h('strong', null, item.officialName), h('span', { className: 'ssb-muted' }, `${MARKET_LABEL[item.exchange] || item.exchange} ${item.code}${item.currency ? ` · ${item.currency}` : ''}`)), h(Button, { disabled: !!data?.control.watchlist.items[item.id] || state.busy.write, onClick: quiet(() => runtime.mutate('add', { securityId: item.id })) }, data?.control.watchlist.items[item.id] ? '已在自选' : '加自选')))),
        !visible.length ? h('p', { className: 'ssb-muted', style: { margin: 0 } }, view.query ? '暂无匹配。目录未同步时，请先到设置配置并同步目录。' : '输入关键词开始搜索，例如代码、名称或拼音首字母。') : null,
        state.errorCode === 'CATALOG_NOT_READY' ? h('div', { className: 'ssb-banner', style: { margin: 0 } }, '目录未就绪。可以直接浏览市场添加自选。', h(Button, { onClick: () => runtime.updateView({ view: 'browse' }) }, '前往浏览市场')) : null,
        h('div', { className: 'ssb-toolbar', style: { margin: 0 } }, h(Button, { primary: true, disabled: !view.selectedId || !!data?.control.watchlist.items[view.selectedId] || state.busy.write, onClick: quiet(async () => { await runtime.mutate('add', { securityId: view.selectedId }); runtime.updateView({ view: 'list', selectedId: null }) }) }, data?.control.watchlist.items[view.selectedId] ? '已在自选' : '确认添加'))))
    }
    const defaultProvider = (id, adapterId = 'tushare') => ({ id, adapterId, enabled: true, credentialRef: adapterId === 'tushare' ? 'DSH_STOCK_TUSHARE_TOKEN' : null, quotaGroup: adapterId + '-account', budget: { requestsPerMinute: adapterId === 'tushare' ? null : 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } })
    // 密钥输入: 值直接写宿主的凭据存储, 不进配置草稿, 也不回显。保存后重新拉一次快照让"已配置"状态跟上
    function CredentialField({ runtime, refName, present }) {
      const [value, setValue] = React.useState(''), [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState('')
      const submit = async next => {
        if (busy) return
        setBusy(true); setNotice('')
        try {
          await runtime.api('/credential', 'POST', { ref: refName, value: next })
          setValue('')
          setNotice(next === null ? '已清除' : '已保存')
          runtime.applySnapshot(await runtime.api('/snapshot'), true)
        } catch (e) { setNotice(e.message || '保存失败') }
        finally { setBusy(false) }
      }
      return h('div', { className: 'ssb-credential', style: { gridColumn: '1 / -1' } },
        h('label', { className: 'ssb-field' }, h('span', null, present ? '密钥（已配置，留空表示不修改）' : '密钥（未配置）'),
          h('input', { type: 'password', value, autoComplete: 'new-password', spellCheck: false, placeholder: present ? '留空则不修改' : '粘贴密钥后保存', onChange: e => setValue(e.target.value) })),
        h('div', { className: 'ssb-credential-actions' },
          h(Button, { disabled: busy || !value.trim(), onClick: () => submit(value.trim()) }, '保存密钥'),
          present ? h(Button, { disabled: busy, onClick: () => submit(null) }, '清除') : null,
          notice ? h('span', { className: 'ssb-muted', role: 'status' }, notice) : null))
    }
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
              h('div', { className: 'ssb-field ssb-provider-adapter' }, h('span', null, '适配器'), h(Select, { value: p.adapterId, label: '适配器', options: state.data.adapters.map(a => ({ value: a.adapterId, label: a.adapterId + (a.credential === 'none' ? '（免凭据）' : '') })), onChange: adapterId => { const descriptor = state.data.adapters.find(a => a.adapterId === adapterId); providerChange(p.id, { adapterId, credentialRef: descriptor?.credential === 'none' ? null : descriptor?.credential || null, quotaGroup: adapterId + '-account', budget: descriptor?.credential === 'none' && p.budget.requestsPerMinute === null ? { ...p.budget, requestsPerMinute: 60 } : p.budget }) } })),
              h('div', { className: 'ssb-provider-switches' },
                h(Toggle, { label: '启用', checked: p.enabled, onChange: value => providerChange(p.id, { enabled: value }) }),
                h(Button, { danger: true, onClick: () => change({ providers: draft.providers.filter(other => other.id !== p.id), routes: draft.routes.filter(r => r.primaryInstanceId !== p.id).map(r => ({ ...r, fallbackInstanceIds: r.fallbackInstanceIds.filter(id => id !== p.id), failoverMode: r.fallbackInstanceIds.includes(p.id) ? 'off' : r.failoverMode })) }) }, '移除'))),
            h('div', { className: 'ssb-provider-advanced-open' },
              h('div', { className: 'ssb-form-grid' },
                openSource ? h('span', { className: 'ssb-muted', style: { gridColumn: '1 / -1' } }, '公开来源，无需凭据') : field('密钥引用名', p.credentialRef, value => providerChange(p.id, { credentialRef: value }), { autoComplete: 'off', spellCheck: false }),
                field('共享额度组（同账号保持一致）', p.quotaGroup, value => providerChange(p.id, { quotaGroup: value })),
                openSource || !p.credentialRef ? null : h(CredentialField, { key: 'cred-' + p.id, runtime, refName: p.credentialRef, present: status?.credentialPresent }),
                field('每分钟请求上限（留空仅允许探针）', p.budget.requestsPerMinute, value => providerChange(p.id, { budget: { ...p.budget, requestsPerMinute: value ? Number(value) : null } }), { type: 'number', min: 1 }),
                field('每日请求上限（留空无限制）', p.budget.dailyRequestLimit, value => providerChange(p.id, { budget: { ...p.budget, dailyRequestLimit: value ? Number(value) : null } }), { type: 'number', min: 1 }),
                h('div', { className: 'ssb-field' }, h('span', null, '计费单位'), h(Select, { value: p.budget.billingUnit, label: '计费单位', options: [{ value: 'request', label: '请求' }, { value: 'symbol', label: '证券' }], onChange: value => providerChange(p.id, { budget: { ...p.budget, billingUnit: value } }) })),
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
          const options = [{ value: '', label: '未配置' }, ...draft.providers.filter(p => p.enabled && state.data.adapters.find(a => a.adapterId === p.adapterId)?.capabilities.includes(cap)).map(p => ({ value: p.id, label: p.id }))]
          // 每个能力可单独探一次: 结果只做诊断展示, 不影响能否保存
          const probeKey = route ? `${route.primaryInstanceId}:${cap}:${market}` : null
          const probe = probeKey ? (draft.probes || {})[probeKey] : null
          const probing = probeKey ? (draft.probing || {})[probeKey] : false
          return h('div', { className: 'ssb-route-cell ssb-route-cell-probe', key: cap },
            h('div', { className: 'ssb-route-cell-main' }, h('span', { className: 'ssb-route-cell-label' }, CAP_LABEL[cap]), h(Select, { value: route?.primaryInstanceId || '', label: CAP_LABEL[cap], options, onChange: value => change({ routes: [...draft.routes.filter(r => r !== route), ...(value ? [routeFor(market, cap, value)] : [])] }) })),
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
          const options = [{ value: '', label: '无' }, ...draft.providers.filter(p => p.enabled && state.data.adapters.find(a => a.adapterId === p.adapterId)?.capabilities.includes(cap) && p.id !== route.primaryInstanceId).map(p => ({ value: p.id, label: p.id }))]
          return h('div', { className: 'ssb-route-tune', key: cap },
            h('span', { className: 'ssb-route-tune-label' }, CAP_LABEL[cap]),
            h('div', { className: 'ssb-field' }, h('span', null, '备用源'), h(Select, { value: route.fallbackInstanceIds[0] || '', label: '备用源', options, onChange: value => updateRoute({ fallbackInstanceIds: value ? [value] : [], failoverMode: 'off' }) })),
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
        h(React.Fragment, null, h('h3', null, '显示偏好（即改即存）'), h('div', { className: 'ssb-toolbar' },
          h('div', { className: 'ssb-field' }, h('span', null, '刷新间隔'), h(Select, { value: saved.preferences.refreshSeconds, label: '刷新间隔', disabled: state.busy.write || state.busy.configuration, options: [15, 30, 60].map(n => ({ value: n, label: `${n}秒` })), onChange: value => quiet(() => runtime.preferences({ refreshSeconds: value }))() })),
          h('div', { className: 'ssb-field' }, h('span', null, '悬浮盯盘刷新'), h(Select, { value: saved.preferences.floatRefreshSeconds ?? FLOAT_FALLBACK_SECONDS, label: '悬浮盯盘刷新', disabled: state.busy.write || state.busy.configuration, options: FLOAT_INTERVALS.map(n => ({ value: n, label: `${n}秒` })), onChange: value => quiet(() => runtime.preferences({ floatRefreshSeconds: value }))() })),
          h('div', { className: 'ssb-field' }, h('span', null, '涨跌颜色'), h(Select, { value: saved.preferences.colorMode, label: '涨跌颜色', disabled: state.busy.write || state.busy.configuration, options: [{ value: 'red-up', label: '红涨绿跌' }, { value: 'green-up', label: '绿涨红跌' }], onChange: value => quiet(() => runtime.preferences({ colorMode: value }))() }))))
      const controlRoutes = saved.routes || []
      const enabled = (saved.providers || []).filter(p => p.enabled).length
      const markets = new Set(controlRoutes.map(r => r.market)).size
      const busyConfig = state.busy.configuration || state.busy.check
      return h('section', { className: 'ssb-settings' },
        h('div', { className: 'ssb-settings-head' },
          h('div', { className: 'ssb-settings-intro' }, h('h2', null, '设置'), h('p', { className: 'ssb-muted' }, `${enabled} 个数据源 · ${controlRoutes.length} 条能力路由 · ${markets} 个市场；凭据由宿主凭据服务保管（接口不全时回退环境变量），这里只保存引用名与数据路由`)),
          h('div', { className: 'ssb-toolbar' }, h(Button, { primary: true, disabled: busyConfig, title: '写入内置免凭据数据源与八市场能力路由，探针不可用的目标自动剔除；自选与显示偏好不受影响', onClick: quiet(() => runtime.applyRecommended()) }, state.checkProgress || (busyConfig ? '正在应用…' : '应用推荐配置')))),
        h('div', { className: 'ssb-tablist', role: 'tablist', 'aria-label': '设置分区' }, ...TABS.map(([key, label]) => h('button', { key, role: 'tab', 'aria-selected': tab === key, className: `ssb-tab${tab === key ? ' ssb-tab-on' : ''}`, onClick: () => change({ tab: key }, false) }, label))),
        pane)
    }
    const CSS = `
.ssb-root,.ssb-float-root { --ssb-accent:var(--dsw-alias-brand-primary); --ssb-accent-deep:var(--dsw-alias-button-primary-hover); --ssb-on-accent:var(--dsw-alias-label-primary-inverted); --ssb-accent-wash:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent); --ssb-ok:var(--dsw-alias-state-success-primary); --ssb-warn:var(--dsw-alias-state-warn-primary); --ssb-danger:var(--dsw-alias-state-error-primary); --ssb-bg:var(--dsw-alias-bg-layer-1); --ssb-bg-sub:var(--dsw-alias-bg-layer-2); --ssb-bg-muted:var(--dsw-alias-bg-module-platform); --ssb-border:var(--dsw-alias-border-l2); --ssb-text:var(--dsw-alias-label-primary); --ssb-text-sub:var(--dsw-alias-label-secondary); --ssb-text-dim:var(--dsw-alias-label-tertiary); --ssb-hover:var(--dsw-alias-interactive-bg-hover); --ssb-radius-sm:var(--dsw-radius-sm); --ssb-radius-md:var(--dsw-radius-md); --ssb-radius-lg:var(--dsw-radius-lg); }
/* 图表区分色: 亮色取中低明度保证白底上不糊, 取值由 test/chart-colors.test.mjs 卡对比度与线间色差 */
.ssb-root,.ssb-float-root { --ssb-chart-ma-fast: hsl(45 96% 40%); --ssb-chart-ma-mid: hsl(280 88% 52%); --ssb-chart-ma-slow: hsl(189 94% 38%); --ssb-chart-ma-long: hsl(239 84% 56%); --ssb-chart-ema: hsl(330 81% 50%); --ssb-chart-boll-mid: hsl(217 91% 50%); --ssb-chart-boll-rail: hsl(213 90% 62%); --ssb-chart-bbi: hsl(160 84% 34%); --ssb-chart-cost: hsl(20 92% 45%); --ssb-chart-target: hsl(305 80% 45%); }
/* 暗色整体提亮一档, 否则深色线条直接溶进背景; 明暗标记由宿主写在 body 上 */
[data-ds-dark-theme] .ssb-root,[data-ds-dark-theme] .ssb-float-root { --ssb-chart-ma-fast: hsl(45 96% 58%); --ssb-chart-ma-mid: hsl(280 90% 72%); --ssb-chart-ma-slow: hsl(189 90% 58%); --ssb-chart-ma-long: hsl(239 88% 76%); --ssb-chart-ema: hsl(330 85% 68%); --ssb-chart-boll-mid: hsl(217 92% 68%); --ssb-chart-boll-rail: hsl(213 94% 80%); --ssb-chart-bbi: hsl(160 80% 56%); --ssb-chart-cost: hsl(20 95% 58%); --ssb-chart-target: hsl(305 85% 70%); }
/* 悬浮盯盘挂在 body 上, 与面板同源取色但不需要面板的整屏布局 */
.ssb-root { height:100%; min-width:0; overflow:auto; color:var(--ssb-text); background:var(--ssb-bg); font:inherit; font-size:13px; line-height:20px; }
.ssb-float-root { color:var(--ssb-text); font:inherit; font-size:13px; line-height:20px; }
.ssb-root *,.ssb-float-root * { box-sizing:border-box; }
.ssb-page { max-width:1200px; margin:0 auto; padding:24px; }
.ssb-root h1 { margin:0; font-size:20px; font-weight:500; line-height:28px; }.ssb-root h2 { margin:0; font-size:16px; font-weight:600; line-height:24px; }.ssb-root h3 { margin:24px 0 12px; font-size:14px; }
.ssb-tablist { display:flex; gap:24px; border-bottom:.5px solid var(--ssb-border); margin:0 0 16px; }
/* 自选分组 tab: 横向可滚动, 与设置页 tab 同一形态, 只在容器边距上去掉页面级间距 */
.ssb-tabs { display:flex; gap:4px; border-bottom:.5px solid var(--ssb-border); padding:0 16px; overflow-x:auto; }.ssb-tabs .ssb-tab { flex:0 0 auto; padding:10px 8px; }
/* 分组标签编辑: 已选 tags 用 chips, 可加入的已有标签用虚线 pill, 都是可点按钮而不是纯装饰 */
.ssb-tag-editor { display:grid; gap:8px; }.ssb-tag-chips,.ssb-tag-pills { display:flex; flex-wrap:wrap; gap:6px; }
.ssb-tag-chip { display:inline-flex; align-items:center; height:24px; padding:0 4px 0 8px; border-radius:999px; background:var(--ssb-accent-wash); color:var(--ssb-accent); font-size:11px; }
.ssb-tag-x { display:inline-flex; align-items:center; justify-content:center; min-width:24px; height:24px; border:0; background:transparent; color:inherit; font:inherit; line-height:1; padding:0; cursor:pointer; }.ssb-tag-x:hover { color:var(--ssb-danger); }
.ssb-tag-pill { border:1px dashed var(--ssb-border); background:transparent; color:var(--ssb-text-sub); border-radius:999px; height:24px; padding:0 10px; font:inherit; font-size:11px; cursor:pointer; }.ssb-tag-pill:hover { border-color:var(--ssb-accent); color:var(--ssb-accent); }
.ssb-tag-rename { padding:0 16px 8px; }.ssb-section-head .ssb-toolbar { margin:0; }.ssb-tab { font:inherit; font-size:13px; color:var(--ssb-text-sub); background:transparent; border:0; border-bottom:2px solid transparent; padding:10px 2px; cursor:pointer; }.ssb-tab-on { color:var(--ssb-text); border-bottom-color:var(--ssb-accent); font-weight:600; }.ssb-header,.ssb-toolbar,.ssb-section-head,.ssb-row-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }.ssb-header { justify-content:space-between; align-items:flex-start; margin-bottom:16px; gap:16px; }.ssb-header-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }.ssb-header p { margin:6px 0 0; }.ssb-section-head { justify-content:space-between; padding:16px; }.ssb-section-head h2[tabindex="-1"]:focus { outline:none; }.ssb-toolbar { margin:12px 0; }
.ssb-button { color:var(--ssb-text); background:transparent; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); min-height:32px; padding:0 12px; font:inherit; font-size:13px; cursor:pointer; transition:background .15s; white-space:nowrap; }.ssb-button:hover { background:var(--dsw-alias-interactive-bg-hover); }.ssb-button.ssb-primary { background:var(--ssb-accent); color:var(--ssb-on-accent); border-color:var(--ssb-accent); }.ssb-button.ssb-primary:hover { background:var(--ssb-accent-deep); }.ssb-button.ssb-danger { color:var(--ssb-danger); }.ssb-root button:disabled { opacity:.5; cursor:not-allowed; }.ssb-root :focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }
.ssb-root input:not([type=checkbox]) { background:var(--ssb-bg); color:var(--ssb-text); border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); min-height:32px; padding:6px 8px; font:inherit; max-width:100%; }
.ssb-select { position:relative; display:inline-flex; min-width:0; max-width:100%; }
.ssb-select-trigger { display:inline-flex; align-items:center; justify-content:space-between; gap:8px; min-height:32px; padding:6px 8px; background:var(--ssb-bg); color:var(--ssb-text); border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); font:inherit; font-size:13px; line-height:1.4; text-align:left; cursor:pointer; max-width:100%; }
.ssb-select-trigger:hover:not(:disabled) { border-color:var(--ssb-text-dim); }
.ssb-select-trigger:disabled { opacity:.5; cursor:not-allowed; }
.ssb-select-value { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ssb-select-caret { flex:none; width:6px; height:6px; border-right:1.5px solid var(--ssb-text-sub); border-bottom:1.5px solid var(--ssb-text-sub); transform:translateY(-2px) rotate(45deg); }
.ssb-select-menu { position:fixed; z-index:70; display:flex; flex-direction:column; gap:1px; padding:4px; overflow:auto; background:var(--ssb-bg-sub); border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); box-shadow:var(--dsw-shadow-lv3); }
.ssb-select-menu[hidden] { display:none; }
.ssb-select-option { display:flex; align-items:center; min-height:28px; padding:4px 8px; border-radius:var(--ssb-radius-sm); font-size:13px; color:var(--ssb-text); white-space:nowrap; cursor:pointer; }
.ssb-select-option-active { background:var(--ssb-hover); }
.ssb-select-option[aria-selected="true"] { color:var(--ssb-accent); }
.ssb-select-option[aria-selected="true"].ssb-select-option-active { background:var(--ssb-accent-wash); }.ssb-field { display:flex; flex-direction:column; gap:6px; min-width:0; }.ssb-muted { color:var(--ssb-text-sub); }.ssb-code,.ssb-source { display:block; font-size:11px; }.ssb-code,.ssb-number { font-family:var(--ds-font-family-code); font-variant-numeric:tabular-nums; }.ssb-code { color:var(--ssb-text-sub); margin-top:4px; }.ssb-small { font-size:13px; margin-left:12px; }
.ssb-content { display:grid; grid-template-columns:minmax(0,1fr); gap:16px; }
/* 浮层须压过宿主侧栏拖拽手柄; 取 60 与其它插件弹窗同档, 仍在宿主抽屉遮罩之下 */
.ssb-overlay { position:fixed; inset:0; background:color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent); display:flex; z-index:60; animation:ssb-fade .15s ease-out; }.ssb-drawer { animation:ssb-slide .2s ease-out; }.ssb-modal-card {}@keyframes ssb-fade { from { opacity:0; } }@keyframes ssb-slide { from { transform:translateX(40px); opacity:0; } }.ssb-overlay-drawer { justify-content:flex-end; }.ssb-overlay-modal { align-items:center; justify-content:center; padding:24px; }.ssb-drawer { width:min(80vw,94vw); height:100%; overflow:auto; background:var(--ssb-bg); border-left:1px solid var(--ssb-border); box-shadow:var(--dsw-shadow-lv3); padding:16px; }.ssb-modal-card { width:min(880px,94vw); max-height:88vh; overflow:auto; background:var(--ssb-bg); border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-lg); box-shadow:var(--dsw-shadow-lv3); padding:16px; }.ssb-drawer-head { display:flex; justify-content:flex-end; }.ssb-drawer .ssb-detail, .ssb-drawer .ssb-settings { border:0; padding:0; background:transparent; }.ssb-list-pane,.ssb-detail { border:.5px solid var(--ssb-border); border-radius:var(--ssb-radius-md); min-width:0; }.ssb-detail { padding:16px; background:var(--ssb-bg-sub); }.ssb-detail .ssb-section-head { padding:0; }.ssb-detail-price { font-size:28px; margin:20px 0 4px; }.ssb-table-scroll { max-height:65vh; overflow:auto; border-radius:0 0 var(--ssb-radius-md) var(--ssb-radius-md); }.ssb-foot { margin:12px 0 4px; }.ssb-table { width:100%; border-collapse:collapse; table-layout:auto; }.ssb-table th { color:var(--ssb-text-sub); font-weight:400; font-size:12px; background:var(--ssb-bg-sub); position:sticky; top:0; z-index:1; }.ssb-table td,.ssb-table th { padding:8px 12px; text-align:left; border-top:.5px solid var(--ssb-border); }.ssb-table td.ssb-number { text-align:right; white-space:nowrap; }.ssb-table tr:hover { background:var(--dsw-alias-interactive-bg-hover); }.ssb-selected { background:var(--ssb-accent-wash); }.ssb-stock-name { font:inherit; color:inherit; background:transparent; border:0; padding:0; text-align:left; cursor:pointer; }.ssb-stale td.ssb-number { opacity:.65; }.ssb-up { color:var(--ssb-danger); }.ssb-down { color:var(--ssb-ok); }.ssb-green-up .ssb-up { color:var(--ssb-ok); }.ssb-green-up .ssb-down { color:var(--ssb-danger); }
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
.ssb-cell-price { font-size:14px; font-weight:600; }
.ssb-cell-amount,.ssb-cell-amplitude,.ssb-cell-open { color:var(--ssb-text-dim); }
.ssb-col-status { justify-self:end; }
.ssb-pill { display:inline-block; padding:0 6px; border-radius:var(--ssb-radius-sm); background:color-mix(in srgb, currentColor 12%, transparent); }



/* 窄容器降级: 单行拆两段, 隐藏列头与宽屏列 */
.ssb-row-sub { display:none; }
@container (max-width:700px) {
  .ssb-row-head { display:none; }
  .ssb-row { padding:6px 10px; }
  .ssb-row-main { grid-template-columns:12px minmax(80px,1fr) 68px 64px 56px 16px; height:auto; }
  .ssb-cell-open,.ssb-cell-range,.ssb-cell-amount,.ssb-cell-amplitude,.ssb-cell-pl { display:none; }
  .ssb-row-sub { display:flex; gap:10px; margin-top:2px; padding-left:20px; font-size:12px; color:var(--ssb-text-dim); font-variant-numeric:tabular-nums; font-family:var(--ds-font-family-code); }
}
.ssb-kv { display:inline-flex; gap:4px; white-space:nowrap; }
/* 悬浮盯盘: 固定右下角, 尺寸以 4px 刻度, 只做轻边框分层不挂阴影 */
.ssb-float { position:fixed; right:24px; bottom:24px; z-index:60; width:288px; max-height:calc(100vh - 48px); display:flex; flex-direction:column; gap:8px; padding:12px; background:var(--ssb-bg); border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-lg); box-shadow:var(--dsw-shadow-lv3); font-size:12px; }
/* 拖动只从标题条发起: touch-action 取的是路径交集, 父级给 none 会把列表的 pan-y 一起废掉 */
.ssb-float { touch-action:pan-y; }
.ssb-float-head { touch-action:none; cursor:grab; }
.ssb-float-list,.ssb-float-picker { touch-action:pan-y; }
.ssb-float-head { display:flex; align-items:center; gap:4px; }
.ssb-float-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
.ssb-float-icon { width:20px; height:20px; display:inline-flex; align-items:center; justify-content:center; font:inherit; font-size:12px; line-height:1; color:var(--ssb-text-sub); background:transparent; border:0; border-radius:var(--ssb-radius-sm); cursor:pointer; }
.ssb-float-icon:hover { color:var(--ssb-text); background:var(--ssb-accent-wash); }
.ssb-float-quote { display:flex; align-items:baseline; gap:8px; }
.ssb-float-price { font-size:20px; line-height:1.3; font-family:var(--ds-font-family-code); font-variant-numeric:tabular-nums; }
.ssb-float-pct { font-size:12px; }
.ssb-float-spark { width:100%; height:88px; display:block; }
/* 分时悬停: 光标线、标记线与读出浮层 */
.ssb-float-spark-wrap { position:relative; }
.ssb-float-markline { stroke:var(--ssb-text-dim); stroke-width:1; stroke-dasharray:2 3; vector-effect:non-scaling-stroke; opacity:.75; }
.ssb-float-markline-cost { stroke:var(--ssb-chart-cost); }
.ssb-float-markline-target { stroke:var(--ssb-chart-target); }
.ssb-float-cursor { stroke:var(--ssb-text-sub); stroke-width:1; vector-effect:non-scaling-stroke; opacity:.55; }
.ssb-float-dot { fill:var(--ssb-text); }
.ssb-float-hover { position:absolute; top:2px; right:44px; z-index:2; pointer-events:none; display:flex; align-items:baseline; gap:4px; padding:2px 4px; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); background:var(--ssb-bg); box-shadow:var(--dsw-shadow-lv3); font-size:11px; color:var(--ssb-text-sub); font-variant-numeric:tabular-nums; }
.ssb-float-hover strong { font-size:12px; font-weight:600; }
/* 右侧价格刻度: 每个价位配一个实心小点, 只给数字看不出对应位置 */
.ssb-float-axis { position:absolute; top:0; right:0; bottom:0; width:40px; pointer-events:none; font-size:11px; color:var(--ssb-text-dim); font-variant-numeric:tabular-nums; font-family:var(--ds-font-family-code); }
.ssb-float-tick { position:absolute; right:36px; width:6px; height:2px; border-radius:999px; background:var(--ssb-text-sub); transform:translateY(-50%); }
.ssb-float-tick-value { position:absolute; right:1px; transform:translateY(-50%); white-space:nowrap; }
/* 标记价常驻行: 图外再给一份完整清单, 范围外的标记也能看到 */
.ssb-float-marks { display:flex; flex-wrap:wrap; gap:2px 8px; font-size:11px; font-variant-numeric:tabular-nums; font-family:var(--ds-font-family-code); }
/* 列表悬停浮层用 fixed 定位, 列表容器的 overflow:auto 裁不到它 */
/* 曲线用 currentColor 取色: 有涨跌时由 .ssb-up/.ssb-down 决定, 只在两者都没有时退回次要文字色 */
.ssb-float-chart:not(.ssb-up):not(.ssb-down) { color:var(--ssb-text-sub); }
.ssb-float-line { fill:none; stroke:currentColor; stroke-width:1.5; vector-effect:non-scaling-stroke; }
.ssb-float-area { fill:currentColor; opacity:.12; stroke:none; }
.ssb-float-base { stroke:var(--ssb-text-dim); stroke-width:1; stroke-dasharray:3 3; vector-effect:non-scaling-stroke; opacity:.6; }
.ssb-float-error { margin:0; height:88px; display:flex; align-items:center; color:var(--ssb-text-sub); }
.ssb-float-foot { display:flex; align-items:center; gap:8px; }
.ssb-float-stamp { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color:var(--ssb-text-sub); font-family:var(--ds-font-family-code); font-variant-numeric:tabular-nums; }
/* 陈旧只给一个圆点: 告警色作 11px 正文在亮色主题上对比度不足, 颜色不当唯一信号, 文案由 aria-label 与 title 承担 */
.ssb-float-stamp-stale::before { content:''; display:inline-block; width:6px; height:6px; margin-right:4px; border-radius:50%; background:var(--ssb-warn); vertical-align:middle; }
/* 铃铛是开关不是动作: 打开后填实并取主色, 空心时与其它图标同色; 与右侧两个按钮成组, 不夹在时刻后面 */
.ssb-float-bell { margin-left:auto; }
.ssb-float-bell.on { color:var(--ssb-accent); }
/* 标记价被穿越时的瞬时高亮: 无通知插件可用的降级线路, 5 秒后由状态移除 */
.ssb-float-alerting { border-color:var(--ssb-accent); animation:ssb-float-pulse 1s ease-in-out 3; }
@keyframes ssb-float-pulse { 50% { box-shadow:0 0 0 4px var(--ssb-accent-wash), var(--dsw-shadow-lv3); } }
@media (prefers-reduced-motion:reduce) { .ssb-float-alerting { animation:none; } }
/* 刷新开关是图标按钮, 与铃铛、详情共用同一尺寸与颜色; 状态只由形状表达, 不给运行态单独上色 */
.ssb-float-live { color:var(--ssb-text-sub); }
.ssb-float-live-error { color:var(--ssb-warn) !important; }
.ssb-float-live:disabled { opacity:.5; cursor:not-allowed; }
/* 列表模式: 每行一只标的, 点击切到该只的图形 */
.ssb-float-list,.ssb-float-picker { flex:0 1 auto; min-height:0; display:flex; flex-direction:column; gap:2px; max-height:min(300px, 45vh); overflow:auto; }
.ssb-picker-head { display:flex; align-items:center; gap:6px; padding:4px 2px 2px; font-size:11px; color:var(--ssb-text-dim); border-top:1px solid var(--ssb-border); }
.ssb-float-picker .ssb-picker-head:first-child { border-top:none; }
.ssb-picker-head > span { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ssb-picker-all { flex:0 0 auto; padding:1px 6px; font:inherit; font-size:11px; color:var(--ssb-accent); background:transparent; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); cursor:pointer; }
.ssb-picker-all:hover { border-color:var(--ssb-accent); }
.ssb-float-row { display:flex; align-items:baseline; gap:8px; padding:4px 6px; font:inherit; text-align:left; color:inherit; background:transparent; border:0; border-radius:var(--ssb-radius-sm); cursor:pointer; }
.ssb-float-row:hover { background:var(--dsw-alias-interactive-bg-hover); }
.ssb-float-row-on { background:var(--ssb-accent-wash); }
.ssb-float-row-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* 代码用小号淡字: 只说清"是哪只", 不跟名称抢注意力 */
.ssb-float-code { flex:none; font-size:11px; font-weight:400; color:var(--ssb-text-dim); font-variant-numeric:tabular-nums; }
.ssb-float-row-price { font-size:12px; }
.ssb-float-row-pct { width:58px; text-align:right; font-size:11px; }
.ssb-float-modes { display:flex; gap:2px; }
.ssb-float-mode { padding:2px 6px; font:inherit; font-size:11px; color:var(--ssb-text-sub); background:transparent; border:1px solid transparent; border-radius:var(--ssb-radius-sm); cursor:pointer; }
.ssb-float-mode.on { color:var(--ssb-text); border-color:var(--ssb-border); background:var(--ssb-bg-sub); }
.ssb-float-picker .ssb-switch { font-size:11px; }
.ssb-dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--ssb-ok); flex:0 0 auto; }.ssb-dot.ssb-dot-warn { background:var(--ssb-warn); }.ssb-dot.ssb-dot-danger { background:var(--ssb-danger); }.ssb-dot.ssb-dot-idle { background:var(--ssb-text-dim); }
.ssb-facts { display:grid; grid-template-columns:1fr 1fr; gap:8px; border-top:1px solid var(--ssb-border); padding-top:16px; margin-top:16px; }.ssb-mark-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; }.ssb-mark-row { display:grid; grid-template-columns:44px minmax(0,1fr) 72px auto; align-items:center; gap:8px; min-height:32px; border-bottom:1px solid var(--ssb-border); }.ssb-mark-row:last-child { border-bottom:0; }.ssb-mark-row .ssb-number { justify-self:end; }.ssb-mark-row .ssb-button { min-height:24px; padding:2px 8px; border-color:transparent; }.ssb-mark-row .ssb-button:hover { background:color-mix(in srgb, var(--ssb-danger) 10%, transparent); }.ssb-mark-kind { color:var(--ssb-text-sub); font-size:11px; }.ssb-mark-pct { justify-self:end; font-variant-numeric:tabular-nums; }.ssb-credential { display:grid; gap:8px; justify-items:start; }.ssb-credential .ssb-field { width:100%; }.ssb-credential-actions { display:flex; align-items:center; gap:8px; }.ssb-facts dt { color:var(--ssb-text-sub); }.ssb-facts dd { margin:0; text-align:right; overflow-wrap:anywhere; font-family:var(--ds-font-family-code); }.ssb-detail-forms { display:grid; gap:12px; border-top:1px solid var(--ssb-border); padding-top:16px; margin-top:16px; }.ssb-forms-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }.ssb-forms-head h3 { margin:0; font-size:12px; font-weight:600; color:var(--ssb-text-sub); }.ssb-forms-actions { margin:0; }.ssb-forms-body { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px 32px; align-items:start; }.ssb-form-block { display:grid; gap:8px; align-content:start; min-width:0; max-width:480px; }.ssb-form-block h4 { margin:0; font-size:11px; font-weight:400; color:var(--ssb-text-dim); }.ssb-inline-form { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }.ssb-inline-field { display:flex; align-items:center; gap:8px; min-width:0; }.ssb-field-label { flex:0 0 auto; color:var(--ssb-text-sub); font-size:12px; }.ssb-root .ssb-inline-form input { min-height:28px; padding:4px 8px; font-size:12px; }.ssb-input-num { width:112px; }.ssb-input-group,.ssb-input-alias { width:168px; }.ssb-form-hint { margin:0; color:var(--ssb-text-dim); font-size:11px; }.ssb-form-error { color:var(--ssb-text-sub); font-size:11px; }.ssb-seg { display:inline-flex; height:28px; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); overflow:hidden; background:var(--ssb-bg); }.ssb-seg-opt { border:0; background:transparent; color:var(--ssb-text-sub); font:inherit; font-size:12px; padding:0 10px; cursor:pointer; transition:background .15s; }.ssb-seg-opt + .ssb-seg-opt { border-left:1px solid var(--ssb-border); }.ssb-seg-opt:hover { background:var(--dsw-alias-interactive-bg-hover); }.ssb-seg-opt.ssb-seg-on { background:var(--ssb-accent-wash); color:var(--ssb-accent); font-weight:500; }
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
.ssb-legend-cost { color:var(--ssb-chart-cost); }.ssb-legend-target { color:var(--ssb-chart-target); }
.ssb-legend-pct { margin-left:4px; }
/* 图例指标色与图表 series 色板一一对应(图表侧只能吃具体色值, 无法引用主题变量) */
.ssb-ma-0 { color:var(--ssb-chart-ma-fast); }.ssb-ma-1 { color:var(--ssb-chart-ma-mid); }.ssb-ma-2 { color:var(--ssb-chart-ma-slow); }.ssb-ma-3 { color:var(--ssb-chart-ma-long); }
.ssb-ema { color:var(--ssb-chart-ema); }
.ssb-boll-0 { color:var(--ssb-chart-boll-mid); }.ssb-boll-1 { color:var(--ssb-chart-boll-rail); }.ssb-boll-2 { color:var(--ssb-chart-boll-rail); }
.ssb-bbi { color:var(--ssb-chart-bbi); }
.ssb-menu-title { padding:8px 8px 2px; font-size:11px; color:var(--ssb-text-dim); }.ssb-kline-holder { height:340px; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); }
.ssb-kline-chart { position:relative; }
/* 十字线读数: 贴光标右上, 指针穿透, 不挡拖动时间轴 */
.ssb-kline-tip { position:absolute; z-index:3; width:200px; padding:8px 10px; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-md); background:var(--ssb-bg-sub); box-shadow:var(--dsw-shadow-lv3); font-size:12px; line-height:1.5; color:var(--ssb-text-sub); font-family:var(--ds-font-family-code); font-variant-numeric:tabular-nums; pointer-events:none; }
.ssb-kline-tip-time { color:var(--ssb-text); }.ssb-kline-skeleton { height:340px; border:1px dashed var(--ssb-border); border-radius:var(--ssb-radius-sm); display:flex; align-items:center; justify-content:center; color:var(--ssb-text-sub); margin-bottom:8px; }
.ssb-detail-grid { display:grid; grid-template-columns:minmax(0,1fr) 240px; gap:16px; align-items:start; }.ssb-detail-side { min-width:0; }.ssb-detail-side .ssb-facts { grid-template-columns:auto minmax(0,1fr); gap:6px 12px; }.ssb-detail-side .ssb-facts dt { white-space:nowrap; }
.ssb-empty { padding:48px 16px; color:var(--ssb-text-sub); text-align:center; font-size:14px; }.ssb-banner { border:1px solid var(--ssb-border); border-left:3px solid var(--ssb-warn); border-radius:var(--ssb-radius-sm); padding:12px; margin:12px 0; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }.ssb-banner-ok { border-left-color:var(--ssb-ok); }.ssb-error { border-left-color:var(--ssb-danger); }.ssb-banner p { margin:0; }.ssb-search-view { max-width:760px; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-md); background:var(--ssb-bg); padding-bottom:4px; }.ssb-panel-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:16px; border-bottom:.5px solid var(--ssb-border); flex-wrap:wrap; }.ssb-panel-head h2 { font-size:16px; margin:0; }.ssb-panel-body { padding:16px; display:flex; flex-direction:column; gap:12px; }.ssb-form-row { display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; }.ssb-form-row > .ssb-field { flex:0 0 176px; }.ssb-search-label { display:grid; gap:8px; margin-top:20px; }.ssb-form-row > .ssb-search-label { flex:1 1 300px; margin-top:0; }.ssb-results { display:grid; gap:8px; margin:16px; }.ssb-candidate { padding:10px 12px; display:flex; justify-content:space-between; align-items:center; gap:12px; background:transparent; border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-sm); color:var(--ssb-text); font:inherit; cursor:pointer; }.ssb-candidate:hover { border-color:var(--ssb-accent); }.ssb-candidate.ssb-selected { background:var(--ssb-accent-wash); border-color:var(--ssb-accent); }.ssb-peek { display:flex; flex:1; flex-direction:column; gap:2px; text-align:left; cursor:pointer; min-width:0; }.ssb-peek:hover strong { text-decoration:underline; }.ssb-provider { border:1px solid var(--ssb-border); border-radius:var(--ssb-radius-md); padding:16px; margin:12px 0; min-width:0; }.ssb-provider legend { padding:0 6px; color:var(--ssb-text-sub); }.ssb-provider details { grid-column:1 / -1; }.ssb-provider summary { cursor:pointer; }.ssb-reqlog { margin:8px 0 0; padding:0 0 0 18px; color:var(--ssb-text-sub); }.ssb-form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }.ssb-route-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(132px,1fr)); gap:12px; }.ssb-route-cell { display:grid; gap:6px; min-width:0; }.ssb-route-cell-label { color:var(--ssb-text-sub); font-size:11px; }.ssb-route-cell select { width:100%; min-width:0; }.ssb-route-advanced { margin-top:12px; }.ssb-route-advanced > summary { cursor:pointer; }.ssb-route-tune { display:flex; align-items:flex-end; gap:12px; flex-wrap:wrap; padding:8px 0; border-top:1px solid var(--ssb-border); }.ssb-route-tune-label { min-width:32px; color:var(--ssb-text-sub); }.ssb-route-delay { flex:0 0 120px; }
.ssb-switch { display:inline-flex; align-items:center; gap:8px; cursor:pointer; position:relative; }.ssb-switch input[type="checkbox"] { position:absolute; opacity:0; width:1px; height:1px; }.ssb-switch__track { display:inline-flex; flex-shrink:0; align-items:center; width:34px; height:19px; padding:3px; border-radius:999px; background:var(--ssb-bg-muted); border:1px solid var(--ssb-border); transition:background .15s ease; }.ssb-switch__thumb { width:13px; height:13px; border-radius:50%; background:var(--ssb-text-sub); transition:transform .15s ease; }.ssb-switch input[type="checkbox"]:checked + .ssb-switch__track { background:var(--ssb-accent); }.ssb-switch input[type="checkbox"]:checked + .ssb-switch__track .ssb-switch__thumb { transform:translateX(13px); background:var(--ssb-bg); }.ssb-switch input[type="checkbox"]:focus-visible + .ssb-switch__track { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }.ssb-switch input[type="checkbox"]:disabled + .ssb-switch__track { opacity:.5; cursor:not-allowed; }.ssb-switch:hover .ssb-switch__track { border-color:var(--ssb-accent); }
@media(max-width:720px) { .ssb-detail-grid { grid-template-columns:minmax(0,1fr); } }
@media(max-width:959px) { .ssb-content { grid-template-columns:minmax(0,1fr); }.ssb-page { padding:16px; } }
@media(max-width:479px) { .ssb-page { padding:12px; }.ssb-header { align-items:flex-start; gap:12px; }.ssb-aux { display:none; }.ssb-table td,.ssb-table th { padding:8px; }.ssb-form-grid { grid-template-columns:minmax(0,1fr); }.ssb-detail-price { font-size:24px; }.ssb-button { min-height:36px; }.ssb-section-head { padding:12px; } }
@media(prefers-reduced-motion:reduce) { .ssb-root * { transition:none; } }
`
    function StockPage({ runtime, layout }) {
      const state = React.useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot), { data, view } = state
      // 盯盘开关提到主导航: 它是这张面板最常被打开的东西, 收进「更多」等于藏起来
      const [floating, setFloating] = usePref(FLOAT_KEY, FLOAT_DEFAULT)
      const root = React.useRef(null)
      React.useEffect(() => {
        const node = view.view === 'search' ? root.current?.querySelector('input[type="search"]') : view.view === 'list' && view.focusId ? [...(root.current?.querySelectorAll('.ssb-stock-name') || [])].find(n => n.dataset.securityId === view.focusId) : root.current?.querySelector('h2')
        if (node?.tagName === 'H2') node.setAttribute('tabindex', '-1'); node?.focus({ preventScroll: true })
      }, [view.view])
      return h('div', { className: `ssb-root${data?.control.preferences.colorMode === 'green-up' ? ' ssb-green-up' : ''}`, ref: root },
        React.createElement('style', { 'data-plugin': '@mzzsfy/dsh-stock-assistant', dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'ssb-page' }, h('header', { className: 'ssb-header' },
          h('div', null, h('h1', null, '股票'), h('p', { className: 'ssb-muted' }, scopeText(data?.control.watchlist.order || []))),
          h('div', { className: 'ssb-header-actions' },
            h(Button, { disabled: !data || state.busy.refresh, onClick: quiet(() => runtime.refresh()) }, state.busy.refresh ? '刷新中…' : '刷新'),
            h(Button, { primary: floating.open, 'aria-pressed': floating.open, onClick: () => setFloating({ open: !floating.open }) }, floating.open ? '收起盯盘' : '悬浮盯盘'),
            h('div', { className: 'ssb-more', style: { position: 'relative' } }, h(Button, { 'aria-label': '更多操作', 'aria-expanded': !!view.menuOpen, onClick: () => runtime.updateView({ menuOpen: !view.menuOpen }) }, '更多'), view.menuOpen ? h('div', { className: 'ssb-menu', style: { position: 'absolute', right: 0, top: 'calc(100% + 4px)', background: 'var(--ssb-bg)', border: '1px solid var(--ssb-border)', borderRadius: 'var(--ssb-radius-md)', padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px', zIndex: 10, minWidth: '140px' }, role: 'menu' },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px' } }, h(Toggle, { label: '暂停采集', checked: state.paused, onChange: runtime.setPaused })),
              h('div', { className: 'ssb-muted', style: { padding: '0 8px', fontSize: '11px' } }, `${(data?.control.providers || []).filter(p => p.enabled).length}/${(data?.control.providers || []).length} 源启用${state.data?.klineReady ? ` · K线 ${Object.keys(state.data.klineReady).length} 市场` : ''}`),
              h(Button, { onClick: () => { runtime.updateView({ view: 'list', overlay: 'settings', menuOpen: false }) } }, '设置'),
              h(Button, { onClick: () => { runtime.updateView({ menuOpen: false }); layout.selectPanel(null) } }, '返回对话')) : null))),
        h('nav', { className: 'ssb-tablist', 'aria-label': '股票视图' },
          h('button', { type: 'button', className: 'ssb-tab' + (view.view === 'list' ? ' ssb-tab-on' : ''), 'aria-current': view.view === 'list' ? 'page' : undefined, onClick: () => runtime.updateView({ view: 'list' }) }, '自选'),
          h('button', { type: 'button', className: 'ssb-tab' + (view.view === 'browse' ? ' ssb-tab-on' : ''), 'aria-current': view.view === 'browse' ? 'page' : undefined, onClick: () => { runtime.updateView({ view: 'browse' }); if (!runtime.getSnapshot().view.browseRows) quiet(() => runtime.loadBrowse('XSHG', 0))() } }, '市场'),
          h('button', { type: 'button', className: 'ssb-tab' + (view.view === 'search' ? ' ssb-tab-on' : ''), 'aria-current': view.view === 'search' ? 'page' : undefined, onClick: () => runtime.updateView({ view: 'search' }) }, '搜索')),
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
      __testing: { createPageRuntime, StockPage, FloatingTicker, FloatHeader, FloatPicker, FloatList, FloatChart, FloatFoot, Sparkline, Select, dropdownPlacement, dragOrder, quiet, seriesMA, seriesEMA, seriesBoll, seriesBBI, readPref, writePref, klineKeyOf, klineShipPlan, finiteOr, formatAmount, toneClass, priceTextOf, tagTabs, resolveTab, costBaseOf, markPct, pollPlan, QUIET_STATES, POLL_EVERY, floatPollDelay, floatIntervalOf, FLOAT_INTERVALS, FLOAT_FALLBACK_SECONDS, timestampOf, floatFreshness, priceTimeOf, clockText, staleAfter, markAlertOf, markAlertText, deliverMarkAlert, sparkIndexAt, candleTimeText, quoteTipLines, crosshairTipLines, crosshairTimeText, timeKeyOf, crosshairTipStyle, rowTipPositionOf, sparkRangeOf, sparkTicksOf, seriesPaintPlan, sanitizeCandles, themeSignature },
    }
  },
})
