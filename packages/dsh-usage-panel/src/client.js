// 用量面板 Client 半区:settings.section 设置页,账号配置 + 手动查询读数。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 由 DSH client runtime 的模块表解析;
// 浏览器半区通过 webServer 路由('/api/usage-panel/*')访问 Host,样式随组件内联渲染。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-usage-panel',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef } = React

    // 公共依赖 @mzzsfy/dsh-common-tools:总线订阅与 toast 均为硬消费(页内通知
    // 数据刷新唯一通道;模块表缺失即本 client factory 抛错,由装载层判定失败,
    // 无轮询回退);装载行随本包 cordis.patch.yml 自带
    const tools = require('@mzzsfy/dsh-common-tools/client')
    const toast = tools.toast.show

    const notify = (text, kind) => {
      toast(text, { kind: kind === 'ok' ? 'ok' : 'error' })
    }

    /* LOGIC-BEGIN */
    // 认领状态机:与 src/notify.mjs decideClaim 镜像,parity 测试锁定不漂移。
    const CLAIM_LOCK_TTL_MS = 30 * 1000
    const KEY_LOCK = 'usage-panel:notify-lock:'
    const KEY_DONE = 'usage-panel:notify-done:'
    const windowId = 'win-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000000).toString(36)
    // 存储可用性:首次写失败即标记 broken,后续认领放行本窗口直发(诚实降级不静默丢通知)
    let storageBroken = false
    const localGet = (key) => {
      try { return window.localStorage.getItem(key) } catch { storageBroken = true; return null }
    }
    const localSet = (key, value) => {
      try { window.localStorage.setItem(key, value) } catch { storageBroken = true }
    }
    const localDel = (key) => {
      try { window.localStorage.removeItem(key) } catch { storageBroken = true }
    }
    // undefined 判定与 src/notify.mjs decideClaim 同形:镜像语义含 undefined 域,parity 锁定
    function decideClaim(stored, done, now, wid) {
      if (done !== null && done !== undefined) return 'done'
      if (stored === null || stored === undefined) return 'claim'
      let lock = null
      try { lock = JSON.parse(stored) } catch { lock = null }
      if (lock === null || typeof lock !== 'object' || typeof lock.at !== 'number' || typeof lock.wid !== 'string') return 'takeover'
      if (now - lock.at >= CLAIM_LOCK_TTL_MS) return 'takeover'
      return lock.wid === wid ? 'claim' : 'skip'
    }
    // 单元级认领(写后读回确认):claim/takeover 持有展示权,skip/done 让渡;
    // 存储不可用时放行本窗口直发,多窗口去重让位于通知不丢
    function claimEvent(id) {
      if (storageBroken) return true
      const now = Date.now()
      const verdict = decideClaim(localGet(KEY_LOCK + id), localGet(KEY_DONE + id), now, windowId)
      if (verdict !== 'claim' && verdict !== 'takeover') return false
      localSet(KEY_LOCK + id, JSON.stringify({ wid: windowId, at: now }))
      let confirmed = null
      try { confirmed = JSON.parse(localGet(KEY_LOCK + id)) } catch { confirmed = null }
      // 读回确认失败即存储中途不可用,同样放行直发
      return (confirmed !== null && confirmed.wid === windowId) || storageBroken
    }
    const markDone = (id) => localSet(KEY_DONE + id, '1')

    // IM 目标列表操作:与 src/notify.mjs 同形,parity 测试锁定不漂移。
    // botId/targetId 字符集均不含 '/',拼接键无歧义;与 dsh-im delivery-service 共用 ID 规格。
    const imTargetKey = (item) => item.botId + '/' + item.targetId
    function toggleImTargetList(list, botId, targetId, checked) {
      const wanted = { botId, targetId }
      const rest = list.filter((item) => imTargetKey(item) !== imTargetKey(wanted))
      return checked ? rest.concat([wanted]) : rest
    }
    function removeImTargetFromList(list, botId, targetId) {
      return list.filter((item) => imTargetKey(item) !== botId + '/' + targetId)
    }
    function unregisterImBotList(list, botId) {
      return list.filter((item) => item.botId !== botId)
    }
    function imBoundBotIds(list) {
      const botIds = []
      for (const item of list) {
        if (!botIds.includes(item.botId)) botIds.push(item.botId)
      }
      return botIds
    }
    // 历史装载闸门:初始 /history 快照与对账 resync 谁先落地都不丢数据。
    // loaded 只在真正应用过一次全量历史后置位;未装载时 resync 即便修订号未变
    // 也要按全量账号补拉,覆盖初始快照请求失败/迟到/被事件抢先的情况。
    function createHistorySync() {
      let loaded = false
      return {
        isLoaded: () => loaded,
        needsLoad: (changed) => !loaded || changed === true,
        wantsFullSnapshot: () => !loaded,
        acceptsInitialSnapshot: () => !loaded,
        markApplied: (full) => { if (full) loaded = true },
      }
    }
    // 对账单飞+尾随:在途期间的触发只记一次,完成后补跑一轮。持久化广播成对到达时,
    // 第二枪落在首个 resync 往返窗口内,只置 false 不复查会丢掉尾随变更,
    // 面板停在旧 revision 直到下一条事件或聚焦(轮询间隔 10 分钟)
    function createTrailingSingleFlight(task) {
      let inFlight = false
      let trailing = false
      let disposed = false
      const start = () => {
        if (disposed) return
        inFlight = true
        let result
        try {
          result = task()
        } catch {
          result = undefined
        }
        Promise.resolve(result).catch(() => {}).then(() => {
          inFlight = false
          if (disposed || !trailing) return
          trailing = false
          start()
        })
      }
      return {
        trigger() {
          if (disposed) return
          if (inFlight) {
            trailing = true
            return
          }
          start()
        },
        isInFlight: () => inFlight,
        dispose() {
          disposed = true
          trailing = false
        },
      }
    }
    // 详情对话框可访问性属性:模态语义 + 标题关联 + 可编程聚焦
    const detailDialogA11y = (titleId) => ({
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      tabIndex: -1,
    })
    // 对话框键盘语义:仅 Escape 关闭,其余按键不拦截
    const isEscapeKey = (event) => Boolean(event) && event.key === 'Escape'
    // 键盘绑定返回解绑函数;目标不可用时不注册,卸载清理恒可调用
    const bindDialogKeys = (target, onClose) => {
      if (!target || typeof target.addEventListener !== 'function') return () => {}
      const onKeyDown = (event) => { if (isEscapeKey(event)) onClose() }
      target.addEventListener('keydown', onKeyDown)
      return () => target.removeEventListener('keydown', onKeyDown)
    }
    // 挂载即聚焦对话框容器;无焦点能力的环境跳过
    const focusDialog = (node) => { if (node && typeof node.focus === 'function') node.focus() }
    // 删除确认态:armed 只活一次点击——超时或任一其它交互即复位。无限期保留会让
    // 跨操作的下一轮点击直接构成确认(误删账号)。
    const DELETE_ARM_TIMEOUT_MS = 5 * 1000
    // 删除按钮按下语义:已武装同一账号即确认,其余情况(未武装/换账号)重新武装
    const deleteArmAction = (armed, id) => (id !== null && armed === id ? 'confirm' : 'arm')
    // 确认态超时复位:返回清理函数,换账号/确认/卸载时清定时器
    const scheduleDeleteArmReset = (reset, options = {}) => {
      const { timeoutMs = DELETE_ARM_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = options
      const timer = setTimer(reset, timeoutMs)
      return () => clearTimer(timer)
    }
    // 通知配置视图只消费 webhookConfigured 布尔(服务端不回传明文地址);
    // 非严格 true(含字符串 'true' 等脏值)一律按未配置
    const notifyConfigView = (config) => {
      const configured = Boolean(config) && config.webhookConfigured === true
      return {
        configured,
        placeholder: configured ? '已配置,留空保持不变' : 'https://hooks.example.com/…',
      }
    }

    // ---- 趋势图与总览纯逻辑:不触碰 DOM,client 与测试共用同一实现 ----
    const HOUR_MS = 60 * 60 * 1000
    const DAY_MS = 24 * HOUR_MS
    const PCT_BASE = 100
    const TREND_PAD = { left: 38, right: 8, top: 10, bottom: 20 }
    const TREND_CURRENCY_SYMBOLS = { CNY: '¥', USD: '$', EUR: '€' }
    const WINDOW_DURATION_MS = { '5h': 5 * HOUR_MS, '7d': 7 * DAY_MS }
    const SEQUENCE_WINDOW_LABELS = { '5h': '5小时', '7d': '7天' }
    const FORECAST_MIN_SLOPE_PCT_PER_HOUR = 0.05
    const FORECAST_MIN_OBSERVATION_HOURS = 1
    const BALANCE_FLAT_PER_DAY = 0.005

    // 读数只接受有限数值;null/空串/布尔不参与计算,避免 Number(null)=0 伪造数据
    function trendNumber(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : null
      }
      return null
    }

    // 悬停索引可能来自旧图(切范围/重同步后点位变少),越界一律视为未选中
    function activeTrendPoint(points, index) {
      if (!Array.isArray(points) || !Number.isInteger(index) || index < 0 || index >= points.length) return null
      return points[index]
    }

    function computeDiffSeries(points) {
      const series = []
      for (let index = 1; index < points.length; index += 1) {
        const current = trendNumber(points[index].v)
        const previous = trendNumber(points[index - 1].v)
        if (current === null || previous === null) continue
        series.push({ t: points[index].t, v: current - previous })
      }
      return series
    }

    function numericExtent(values) {
      let min = Infinity
      let max = -Infinity
      for (const value of values) {
        if (value < min) min = value
        if (value > max) max = value
      }
      return { min, max }
    }

    // 趋势几何:series -> SVG 坐标 + 三档 Y 轴 + 首中尾 X 轴;差值模式强制零点入域
    function computeTrendGeometry(points, mode, width, height, pad) {
      if (!Array.isArray(points)) return null
      const usable = points.filter((point) => point && Number.isFinite(point.t) && trendNumber(point.v) !== null)
      if (usable.length < 2) return null
      const series = mode === 'diff' ? computeDiffSeries(usable) : usable
      if (series.length < 2) return null
      const padding = pad || TREND_PAD
      const plotLeft = padding.left
      const plotTop = padding.top
      const plotWidth = Math.max(width - padding.left - padding.right, 1)
      const plotHeight = Math.max(height - padding.top - padding.bottom, 1)
      const values = series.map((point) => trendNumber(point.v)).filter((value) => value !== null)
      if (values.length < 2) return null
      const extent = numericExtent(values)
      let min = extent.min
      let max = extent.max
      if (mode === 'diff') {
        min = Math.min(min, 0)
        max = Math.max(max, 0)
      }
      if (min === max) {
        const offset = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1
        min -= offset
        max += offset
      }
      const yOf = (value) => plotTop + ((max - value) / (max - min)) * plotHeight
      const stepX = plotWidth / (series.length - 1)
      const plotted = series.map((point, index) => ({
        x: plotLeft + index * stepX,
        y: yOf(trendNumber(point.v)),
        v: trendNumber(point.v),
        t: point.t,
        index,
      }))
      const midIndex = Math.floor((series.length - 1) / 2)
      const xTicks = [{ t: series[0].t, x: plotLeft, anchor: 'start' }]
      if (series.length >= 3) {
        xTicks.push({ t: series[midIndex].t, x: plotLeft + plotWidth / 2, anchor: 'middle' })
      }
      xTicks.push({ t: series[series.length - 1].t, x: plotLeft + plotWidth, anchor: 'end' })
      return {
        width,
        height,
        plot: { left: plotLeft, top: plotTop, width: plotWidth, height: plotHeight },
        points: plotted,
        yTicks: [max, (min + max) / 2, min].map((value) => ({ value, y: yOf(value) })),
        xTicks,
        zeroY: mode === 'diff' ? yOf(0) : null,
        min,
        max,
      }
    }

    function trimNumber(value, digits) {
      const rounded = Math.round(value * Math.pow(10, digits)) / Math.pow(10, digits)
      return String(rounded)
    }

    // 序列单位:余额/月按币种,额度窗口有 remaining+limit 按计数,否则按利用率百分比
    function unitOfSequence(reading, suffix) {
      if (!reading || typeof reading !== 'object') return { kind: 'number' }
      if (suffix === 'balance' || suffix === 'month') {
        const entry = Array.isArray(reading.entries) ? reading.entries[0] : null
        if (!entry) return { kind: 'number' }
        const currency = typeof entry.currency === 'string' && entry.currency.length > 0 ? entry.currency : 'USD'
        return {
          kind: 'money',
          currency,
          symbol: Object.prototype.hasOwnProperty.call(TREND_CURRENCY_SYMBOLS, currency)
            ? TREND_CURRENCY_SYMBOLS[currency]
            : currency + ' ',
        }
      }
      const label = SEQUENCE_WINDOW_LABELS[suffix]
      const windows = Array.isArray(reading.windows) ? reading.windows : []
      const window = label === undefined ? null : windows.find((item) => item && item.label === label)
      const limit = window === null || window === undefined ? null : trendNumber(window.limit)
      const remaining = window === null || window === undefined ? null : trendNumber(window.remaining)
      if (limit !== null && limit > 0 && remaining !== null) return { kind: 'count', limit }
      return { kind: 'pct' }
    }

    function formatTrendValue(value, unit) {
      const number = trendNumber(value)
      if (number === null) return '—'
      const kind = unit && unit.kind ? unit.kind : 'number'
      if (kind === 'pct') return trimNumber(number, 1) + '%'
      if (kind === 'money') return (unit.symbol || '') + number.toFixed(2)
      if (kind === 'count') return String(Math.round(number))
      return trimNumber(number, 2)
    }

    function formatTrendDelta(value, unit) {
      const number = trendNumber(value)
      if (number === null) return '—'
      const kind = unit && unit.kind ? unit.kind : 'number'
      const sign = number > 0 ? '+' : number < 0 ? '-' : ''
      const absolute = Math.abs(number)
      if (kind === 'pct') return sign + trimNumber(absolute, 1) + '%'
      if (kind === 'money') return sign + (unit.symbol || '') + absolute.toFixed(2)
      if (kind === 'count') return sign + String(Math.round(absolute))
      return sign + trimNumber(absolute, 2)
    }

    // 导出文件写入本地时间;逐格加引号并转义双引号,首列带 BOM 由导出方负责
    function formatCsvTime(t) {
      const date = new Date(t)
      if (!Number.isFinite(date.getTime())) return ''
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
        ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
    }

    function buildTrendCsv(points, unit) {
      const rows = [['采样时间', '数值', '较前值']]
      for (let index = 0; index < points.length; index += 1) {
        const point = points[index]
        const previous = index === 0 ? null : trendNumber(points[index - 1].v)
        const current = trendNumber(point.v)
        rows.push([
          formatCsvTime(point.t),
          formatTrendValue(current, unit),
          previous === null || current === null ? '' : formatTrendDelta(current - previous, unit),
        ])
      }
      return rows.map((row) => row.map((cell) => '"' + String(cell).replace(/"/g, '""') + '"').join(',')).join('\r\n')
    }

    function pad2(value) {
      return (value < 10 ? '0' : '') + value
    }

    function formatAxisTime(t, spanMs) {
      const date = new Date(Number(t))
      if (Number.isNaN(date.getTime())) return ''
      if (spanMs >= 2 * DAY_MS) return pad2(date.getMonth() + 1) + '/' + pad2(date.getDate())
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }

    function formatAgo(now, t) {
      const timestamp = Number(t)
      if (!Number.isFinite(timestamp)) return ''
      const delta = Math.max(0, Number(now) - timestamp)
      if (delta < 60 * 1000) return '刚刚'
      if (delta < HOUR_MS) return Math.floor(delta / (60 * 1000)) + ' 分钟前'
      if (delta < DAY_MS) return Math.floor(delta / HOUR_MS) + ' 小时前'
      return Math.floor(delta / DAY_MS) + ' 天前'
    }

    function formatDuration(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value <= 0) return '0 分钟'
      if (value < HOUR_MS) return Math.max(1, Math.round(value / (60 * 1000))) + ' 分钟'
      if (value < DAY_MS) return trimNumber(value / HOUR_MS, 1) + ' 小时'
      return trimNumber(value / DAY_MS, 1) + ' 天'
    }

    // 额度行倒计时:与 fmtRelative 同口径,但直接以「后重置」结尾,避免重复后缀
    function formatResetCountdown(resetsAt, now) {
      const target = Date.parse(resetsAt)
      const current = Number(now)
      if (!Number.isFinite(target) || !Number.isFinite(current)) return null
      const delta = target - current
      if (delta <= 0) return '已可重置'
      if (delta < HOUR_MS) return Math.max(1, Math.round(delta / (60 * 1000))) + '分钟后重置'
      if (delta < DAY_MS) return Math.round(delta / HOUR_MS) + '小时后重置'
      return Math.round(delta / DAY_MS) + '天后重置'
    }

    // 总览统计:状态计数 / 按币种余额合计 / 最高额度占用 / 最近查询时间
    function buildOverview(accounts) {
      const list = Array.isArray(accounts) ? accounts : []
      const balances = new Map()
      let ok = 0
      let error = 0
      let never = 0
      let topQuota = null
      let lastUpdated = null
      for (const account of list) {
        const last = account && account.last
        if (!last) {
          never += 1
          continue
        }
        if (last.ok === true) ok += 1
        else if (last.ok === false) error += 1
        if (Number.isFinite(last.queriedAt) && (lastUpdated === null || last.queriedAt > lastUpdated)) lastUpdated = last.queriedAt
        if (last.ok !== true || !last.reading) continue
        const reading = last.reading
        if (reading.kind === 'balance') {
          for (const entry of Array.isArray(reading.entries) ? reading.entries : []) {
            const remaining = trendNumber(entry && entry.remaining)
            const value = remaining === null ? trendNumber(entry && entry.total) : remaining
            if (value === null) continue
            const currency = typeof entry.currency === 'string' && entry.currency.length > 0 ? entry.currency : 'USD'
            balances.set(currency, (balances.get(currency) || 0) + value)
          }
        }
        if (reading.kind === 'quota') {
          for (const window of Array.isArray(reading.windows) ? reading.windows : []) {
            const utilization = trendNumber(window && window.utilization)
            if (utilization === null) continue
            if (topQuota === null || utilization > topQuota.utilization) {
              topQuota = {
                accountName: account.name || '',
                label: window.label || '',
                utilization,
              }
            }
          }
        }
      }
      return {
        total: list.length,
        ok,
        error,
        never,
        balances: [...balances.entries()].map(([currency, value]) => ({ currency, value })),
        topQuota,
        lastUpdated,
      }
    }

    // 当前窗口内利用率斜率:预计触顶早于重置时返回 warn;不足两点或信息缺失去预测
    function forecastQuota(points, options) {
      const settings = options || {}
      const suffix = settings.suffix
      const duration = WINDOW_DURATION_MS[suffix]
      const resetAt = Date.parse(settings.resetsAt)
      const now = Number(settings.now)
      if (!duration || !Number.isFinite(resetAt) || !Number.isFinite(now)) return null
      const windowStart = resetAt - duration
      const windowPoints = (Array.isArray(points) ? points : [])
        .filter((point) => point && Number.isFinite(point.t) && point.t >= windowStart && point.t <= now)
      if (windowPoints.length < 2) return null
      const first = windowPoints[0]
      const last = windowPoints[windowPoints.length - 1]
      const hours = (last.t - first.t) / HOUR_MS
      if (!(hours >= FORECAST_MIN_OBSERVATION_HOURS)) return null
      const unit = settings.unit || { kind: 'pct' }
      const toUtilization = (value) => {
        const number = trendNumber(value)
        if (number === null) return null
        if (unit.kind === 'count') {
          const limit = trendNumber(unit.limit)
          if (limit === null || limit <= 0) return null
          return ((limit - number) / limit) * PCT_BASE
        }
        return number
      }
      const firstPct = toUtilization(first.v)
      const lastPct = toUtilization(last.v)
      if (firstPct === null || lastPct === null) return null
      const current = trendNumber(settings.currentUtilization)
      const currentPct = current === null ? lastPct : current
      const slopePerHour = (lastPct - firstPct) / hours
      if (!Number.isFinite(slopePerHour) || slopePerHour <= FORECAST_MIN_SLOPE_PCT_PER_HOUR) {
        return { kind: 'safe', slopePerHour, hoursToFull: null, hoursUntilReset: null }
      }
      const hoursUntilReset = (resetAt - now) / HOUR_MS
      if (!(hoursUntilReset > 0)) return null
      const hoursToFull = Math.max(0, (PCT_BASE - currentPct) / slopePerHour)
      return {
        kind: hoursToFull <= hoursUntilReset ? 'warn' : 'safe',
        slopePerHour,
        hoursToFull,
        hoursUntilReset,
      }
    }

    // 余额近 7 天日均变化;负斜率换算剩余可用天数
    function forecastBalance(points, options) {
      const settings = options || {}
      const now = Number(settings.now)
      if (!Number.isFinite(now)) return null
      const cutoff = now - 7 * DAY_MS
      const windowPoints = (Array.isArray(points) ? points : [])
        .filter((point) => point && Number.isFinite(point.t) && point.t >= cutoff && point.t <= now)
      if (windowPoints.length < 2) return null
      const first = windowPoints[0]
      const last = windowPoints[windowPoints.length - 1]
      const days = (last.t - first.t) / DAY_MS
      if (!(days * 24 >= FORECAST_MIN_OBSERVATION_HOURS)) return null
      const firstValue = trendNumber(first.v)
      const lastValue = trendNumber(last.v)
      if (firstValue === null || lastValue === null) return null
      const perDay = (lastValue - firstValue) / days
      if (Math.abs(perDay) < BALANCE_FLAT_PER_DAY) return { kind: 'flat', perDay: 0, daysLeft: null }
      if (perDay < 0) {
        const remaining = trendNumber(settings.remaining)
        return {
          kind: 'burn',
          perDay,
          daysLeft: remaining === null ? null : Math.max(0, remaining / -perDay),
        }
      }
      return { kind: 'gain', perDay, daysLeft: null }
    }

    // 卡片预测提示:额度只报"重置前触顶"风险,余额报近 7 天日均消耗
    function forecastNotes(account, sequences, now) {
      const last = account && account.last
      if (!last || last.ok !== true || !last.reading) return null
      const reading = last.reading
      if (reading.kind === 'quota') {
        for (const window of Array.isArray(reading.windows) ? reading.windows : []) {
          const suffix = window && window.label === '5小时' ? '5h' : window && window.label === '7天' ? '7d' : null
          if (suffix === null) continue
          const sequence = sequences && sequences[suffix]
          if (!sequence || !Array.isArray(sequence.points)) continue
          const forecast = forecastQuota(sequence.points, {
            suffix,
            resetsAt: window.resetsAt,
            unit: unitOfSequence(reading, suffix),
            currentUtilization: window.utilization,
            now,
          })
          if (forecast && forecast.kind === 'warn') {
            return {
              kind: 'warn',
              text: window.label + ':按当前速率约 ' + formatDuration(forecast.hoursToFull * HOUR_MS) + '后触顶,早于重置',
            }
          }
        }
        return null
      }
      if (reading.kind === 'balance') {
        const entry = Array.isArray(reading.entries) ? reading.entries[0] : null
        const sequence = sequences && sequences.balance
        if (!entry || !sequence || !Array.isArray(sequence.points)) return null
        const forecast = forecastBalance(sequence.points, { remaining: entry.remaining, now })
        if (forecast === null) return null
        const symbol = Object.prototype.hasOwnProperty.call(TREND_CURRENCY_SYMBOLS, entry.currency)
          ? TREND_CURRENCY_SYMBOLS[entry.currency]
          : (entry.currency || '') + ' '
        if (forecast.kind === 'burn') {
          const text = '近 7 天日均 -' + symbol + Math.abs(forecast.perDay).toFixed(2)
          if (forecast.daysLeft === null) return { kind: 'info', text: text + ',剩余余额未知' }
          if (forecast.daysLeft === 0) return { kind: 'info', text: text + ',余额已耗尽' }
          return { kind: 'info', text: text + ',余额约可用 ' + formatDuration(forecast.daysLeft * DAY_MS) }
        }
        if (forecast.kind === 'gain') {
          return { kind: 'info', text: '近 7 天日均 +' + symbol + Math.abs(forecast.perDay).toFixed(2) }
        }
        return { kind: 'info', text: '近 7 天余额无变化' }
      }
      return null
    }

    function summaryOf(points) {
      const values = (Array.isArray(points) ? points : [])
        .map((point) => trendNumber(point && point.v))
        .filter((value) => value !== null)
      if (values.length === 0) return null
      let min = Infinity
      let max = -Infinity
      let sum = 0
      for (const value of values) {
        if (value < min) min = value
        if (value > max) max = value
        sum += value
      }
      let totalChange = 0
      for (let index = 1; index < values.length; index += 1) totalChange += values[index] - values[index - 1]
      return { latest: values[values.length - 1], avg: sum / values.length, min, max, totalChange }
    }
    /* LOGIC-END */

    // 页内通知推送订阅:client 激活即订阅,不依赖面板打开;toast 取自公共依赖随本包
    // 装载行提供的 client 模块,取不到则整段跳过(防御);批内逐条认领防多窗口重复弹;
    // 代际令牌自愈:HMR/闭包重建首挂中止旧代快照请求与总线订阅再启新代,旧代不滞留不叠加
    const NOTIFY_REQUEST_TIMEOUT_MS = 30 * 1000
    const NOTIFY_TOAST_MS = 6 * 1000
    const KEY_POLL_TOKEN = 'usage-panel:notify-poll'
    const KEY_POLL_DISPOSE = 'usage-panel:notify-poll:dispose'
    const notificationOwners = new Set()
    let activeNotificationOwner = null
    let notificationWork = null
    const NOTIFY_TTL_MS = 60 * 1000
    const CLAIM_DB = 'dsh-usage-panel'
    const CLAIM_STORE = 'claims'
    const CLAIM_RETENTION_MS = NOTIFY_TTL_MS + NOTIFY_REQUEST_TIMEOUT_MS
    const announcedIds = new Map()
    let claimDegradeAnnounced = false
    let claimDbPromise = null
    function closeClaimDb() {
      const pending = claimDbPromise
      claimDbPromise = null
      pending?.then(db => db.close(), () => {})
    }
    function openClaimDb() {
      if (claimDbPromise) return claimDbPromise
      const pending = new Promise((resolve, reject) => {
        const request = window.indexedDB.open(CLAIM_DB, 1)
        request.onupgradeneeded = () => { request.result.createObjectStore(CLAIM_STORE, { keyPath: 'id' }) }
        request.onerror = () => reject(request.error)
        request.onblocked = () => reject(new Error('通知认领库被阻塞'))
        request.onsuccess = () => {
          const db = request.result
          if (claimDbPromise !== pending) { db.close(); reject(new Error('通知认领代已退出')); return }
          db.onversionchange = () => { if (claimDbPromise === pending) closeClaimDb() }
          resolve(db)
        }
      })
      claimDbPromise = pending
      pending.catch(() => { if (claimDbPromise === pending) claimDbPromise = null })
      return pending
    }
    // 同库 readwrite 事务串行，提交终态后才呈现；HTTP LAN 同样可用。
    async function claimNotification(unit, signal) {
      if (signal?.aborted) return false
      const now = Date.now()
      try {
        const db = await openClaimDb()
        if (signal?.aborted) return false
        const claimed = await new Promise((resolve, reject) => {
          const transaction = db.transaction(CLAIM_STORE, 'readwrite')
          const store = transaction.objectStore(CLAIM_STORE)
          let winner = false
          const abort = () => { try { transaction.abort() } catch { /* 已提交事务不能回滚 */ } }
          const cleanup = () => signal?.removeEventListener('abort', abort)
          signal?.addEventListener('abort', abort, { once: true })
          transaction.oncomplete = () => { cleanup(); resolve(winner) }
          transaction.onabort = transaction.onerror = () => { cleanup(); reject(transaction.error) }
          const request = store.getAll()
          request.onsuccess = () => {
            const now = Date.now()
            const rows = request.result
            for (const row of rows) if (row.expiresAt <= now) store.delete(row.id)
            if (signal?.aborted) return
            if (rows.some(row => row.id === unit.id && row.expiresAt > now)) return
            store.add({ id: unit.id, expiresAt: now + CLAIM_RETENTION_MS })
            winner = localGet(KEY_DONE + unit.id) === null
          }
        })
        return !signal?.aborted && claimed
      } catch {
        if (signal?.aborted) return false
        if (!claimDegradeAnnounced) {
          claimDegradeAnnounced = true
          console.warn('[dsh-usage-panel] IndexedDB 不可用，跨窗口通知认领已降级')
        }
        for (const [id, at] of announcedIds) if (now - at >= NOTIFY_TTL_MS) announcedIds.delete(id)
        if (announcedIds.has(unit.id) || !claimEvent(unit.id)) return false
        announcedIds.set(unit.id, now)
        return true
      }
    }
    function createNotificationWork() {
      const previousDispose = window[KEY_POLL_DISPOSE]
      if (typeof previousDispose === 'function') previousDispose()
      const notifyController = new AbortController()
      window[KEY_POLL_TOKEN] = notifyController
      async function notifyPollOnce(signal) {
        let payload, requestSignal
        try {
          // 恒全量快照(变更通知走总线);组合代际中止与请求超时防悬挂
          const timeoutSignal = AbortSignal.timeout(NOTIFY_REQUEST_TIMEOUT_MS)
          requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
          const response = await fetch('/api/usage-panel/notifications', { signal: requestSignal })
          if (!response.ok) {
            void response.body?.cancel()
            return false
          }
          payload = await response.json()
        } catch {
          return false
        }
        if (requestSignal.aborted) return false
        // 版本缺失即异常响应:按失败处理,由调用方决定是否通告
        if (typeof payload.version !== 'number') return false
        const units = payload && Array.isArray(payload.units) ? payload.units : []
        const liveIds = new Set(units.map((unit) => unit.id))
        // 投影中已过期的本地残留清理,防旧锁与完成标记无限滞留;
        // 存储不可用时跳过清理,认领侧已放行直发
        if (!storageBroken) {
          try {
            for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
              const key = window.localStorage.key(index)
              if (key === null || (key.indexOf(KEY_LOCK) !== 0 && key.indexOf(KEY_DONE) !== 0)) continue
              const id = key.indexOf(KEY_LOCK) === 0 ? key.slice(KEY_LOCK.length) : key.slice(KEY_DONE.length)
              if (!liveIds.has(id)) localDel(key)
            }
          } catch { storageBroken = true }
        }
        for (const unit of units) {
          const claimed = await claimNotification(unit, requestSignal)
          if (requestSignal.aborted) return false
          if (!claimed) continue
          markDone(unit.id)
          toast(unit.text, { kind: unit.kind === 'reset' ? 'ok' : 'error', holdMs: NOTIFY_TOAST_MS })
        }
        return true
      }
      // 订阅插件空间 WS 总线:首连 onReset 即首拉,消息到达重拉;
      // 公共总线重连成功再触发 onReset 全量对账自愈;快照失败不自动重试
      const snapshot = tools.createSnapshotRefresh(() => notifyPollOnce(notifyController.signal))
      const refresh = snapshot.refresh
      const dispose = () => {
        if (notificationWork?.dispose !== dispose) return
        notificationWork = null
        snapshot.dispose()
        notifyController.abort()
        closeClaimDb()
        for (const item of notificationOwners) item.unsubscribe?.()
        notificationOwners.clear()
        activeNotificationOwner = null
        if (window[KEY_POLL_TOKEN] === notifyController) delete window[KEY_POLL_TOKEN]
        if (window[KEY_POLL_DISPOSE] === dispose) delete window[KEY_POLL_DISPOSE]
      }
      notificationWork = { refresh, dispose }
      window[KEY_POLL_DISPOSE] = dispose
    }
    function startNotifications(bus) {
      const owner = { unsubscribe: null }
      if (notificationOwners.size === 0) createNotificationWork()
      notificationOwners.add(owner)
      if (activeNotificationOwner === null) activeNotificationOwner = owner
      const refresh = () => { if (activeNotificationOwner === owner) void notificationWork.refresh() }
      owner.unsubscribe = bus.subscribe(refresh, { onReset: refresh })
      return () => {
        if (!notificationOwners.delete(owner)) return
        owner.unsubscribe()
        if (activeNotificationOwner === owner) activeNotificationOwner = notificationOwners.values().next().value || null
        if (notificationOwners.size === 0) notificationWork.dispose()
      }
    }

    // 导航图标声明:交给 dsh-settings-nav-icons 统一渲染;双键 = 分区 label + 市场
    // 短名(发现页收录显示形态);该插件未就绪时入队,由其启动时排空
    const NAV_ICON = { '账号余额': 'wallet', 'dsh-usage-panel': 'wallet' }
    if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
    else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
    else window.__navicIconQueue = [NAV_ICON]

const CSS = [
  // 设计令牌:L1 设置分区与 L3 状态条经包局部 token 引用宿主语义别名,
  // 禁止字面 fallback(暗色主题漏色);状态语义只用 ok/warn/danger 三色
  // 图表区分色复用状态业务蓝,填充为同色低透明度派生;标签列宽由读数行与预测提示共用
  '.up-panel { --up-accent:var(--dsw-alias-brand-primary); --up-accent-deep:var(--dsw-alias-button-primary-hover); --up-accent-wash:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent); --up-ok:var(--dsw-alias-state-success-primary); --up-warn:var(--dsw-alias-state-warn-primary); --up-danger:var(--dsw-alias-state-error-primary); --up-danger-wash:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent); --up-text:var(--dsw-alias-label-primary); --up-text-sub:var(--dsw-alias-label-secondary); --up-text-dim:var(--dsw-alias-label-tertiary); --up-bg:var(--dsw-alias-bg-layer-1); --up-bg-sub:var(--dsw-alias-bg-layer-2); --up-bg-muted:var(--dsw-alias-bg-module-platform); --up-card:var(--dsw-alias-bg-layer-1); --up-card-border:var(--dsw-alias-border-l2); --up-border:var(--dsw-alias-border-l2); --up-border-strong:var(--dsw-alias-border-l3); --up-hover:var(--dsw-alias-interactive-bg-hover); --up-hover-danger:var(--dsw-alias-interactive-bg-hover-danger); --up-skeleton:var(--dsw-alias-bg-skeleton); --up-chart-line:var(--dsw-alias-state-business-primary); --up-chart-fill:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent); --up-label-w:56px; --up-radius-sm:var(--dsw-radius-sm); --up-radius-md:var(--dsw-radius-md); --up-radius-lg:var(--dsw-radius-lg);',
  '  display:flex; flex-direction:column; gap:12px; min-width:0; color:var(--up-text); font-size:14px; line-height:22px; }',
  // ---- 顶栏 ----
  '.up-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }',
  '.up-head__title { font-weight:500; font-size:16px; line-height:24px; }',
  '.up-head__hint { color:var(--up-text-sub); font-size:13px; line-height:20px; }',
  '.up-spacer { flex:1; }',
  // ---- 按钮体系:实底主按钮 / 次按钮 / ghost 危险 ----
  '.up-btn { cursor:pointer; border:1px solid var(--up-border-strong); background:transparent;',
  '  color:var(--up-text); border-radius:var(--up-radius-sm); min-height:32px; padding:0 10px; font-size:13px; line-height:20px; font-family:inherit;',
  '  transition:background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease; }',
  '.up-btn:hover { background:var(--up-hover); }',
  '.up-btn:disabled { opacity:0.5; cursor:not-allowed; }',
  '.up-btn:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }',
  '.up-btn--primary { background:var(--up-accent); border-color:var(--up-accent); color:var(--dsw-alias-bg-base); font-weight:600; }',
  '.up-btn--primary:hover { background:var(--up-accent-deep); border-color:var(--up-accent-deep); }',
  '.up-btn--danger { color:var(--up-danger); border-color:var(--up-danger); background:transparent; }',
  '.up-btn--danger:hover { background:var(--up-hover-danger); border-color:var(--up-danger); }',
  '.up-btn--small { min-height:28px; padding:0 10px; font-size:11px; line-height:18px; }',
  // ---- 总览统计:L1 卡片分区,数值用数据展示字号 ----
  '.up-overview { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }',
  '.up-stat { border:.5px solid var(--up-card-border); border-radius:var(--up-radius-md); background:var(--up-card);',
  '  padding:8px 12px; display:flex; flex-direction:column; gap:4px; min-width:0; }',
  '.up-stat__label { color:var(--up-text-dim); font-size:11px; line-height:16px; }',
  '.up-stat__value { font-weight:600; font-size:16px; line-height:24px; font-variant-numeric:tabular-nums;',
  '  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
  '.up-stat__sub { color:var(--up-text-sub); font-size:11px; line-height:16px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
  '@media (max-width:640px) { .up-overview { grid-template-columns:repeat(2,minmax(0,1fr)); } }',
  // ---- 账号卡:L1 卡片分组 ----
  '.up-card { position:relative; border:.5px solid var(--up-card-border); border-radius:var(--up-radius-md); padding:12px 14px;',
  '  background:var(--up-card); display:flex; flex-direction:column; gap:8px; min-width:0; }',
  '.up-card__row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }',
  // 头部操作组不拆行:标题与更新时间可收缩,刷新/编辑/删除保持同一行;读数行仍允许换行
  '.up-card > .up-card__row:first-child { flex-wrap:nowrap; gap:6px; }',
  '.up-card > .up-card__row:first-child .up-card__name { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
  '.up-card > .up-card__row:first-child .up-spacer { min-width:0; }',
  '.up-card > .up-card__row:first-child .up-meta, .up-card > .up-card__row:first-child .up-badge { flex:none; }',
  '.up-card > .up-card__row:first-child .up-btn { flex:none; }',
  '.up-card__name { font-weight:600; font-size:14px; line-height:22px; }',
  // 平台徽章:语义槽位着色(ok/warn/accent/text-sub),不引入第四种状态色
  '.up-badge { font-size:11px; line-height:18px; font-weight:500; padding:0 8px; border-radius:999px; white-space:nowrap;',
  '  border:1px solid transparent; color:var(--up-text-sub); background:var(--up-bg-muted); }',
  '.up-badge[data-type="deepseek"] { color:var(--up-accent); background:var(--up-accent-wash); }',
  '.up-badge[data-type="openrouter"] { color:var(--up-text-sub); background:var(--up-bg-muted); }',
  '.up-badge[data-type="kimi"] { color:var(--up-ok); background:color-mix(in srgb,var(--up-ok) 10%,transparent); }',
  '.up-badge[data-type="minimax"] { color:var(--up-warn); background:color-mix(in srgb,var(--up-warn) 10%,transparent); }',
  '.up-badge[data-type="newapi"] { color:var(--up-accent-deep); background:var(--up-accent-wash); }',
  '.up-badge[data-type="zhipu"] { color:var(--up-accent); background:var(--up-accent-wash); }',
  // ---- 读数行:标签 + 进度条 + 等宽数字 ----
  '.up-reading { display:flex; flex-direction:column; gap:8px; }',
  '.up-row { display:flex; align-items:center; gap:12px; position:relative; min-height:28px; }',
  '.up-row__label { width:var(--up-label-w); flex:none; font-size:13px; line-height:20px; color:var(--up-text-sub); white-space:nowrap; }',
  '.up-bar { flex:1; min-width:120px; max-width:320px; height:8px; border-radius:999px; overflow:hidden; flex:none;',
  '  background:var(--up-bg-muted); }',
  '.up-bar__fill { display:block; height:100%; border-radius:999px; background:var(--up-ok);',
  '  transition:width 0.4s ease; }',
  '.up-bar__fill--warn { background:var(--up-warn); }',
  '.up-bar__fill--crit { background:var(--up-danger); }',
  '.up-pct { font-variant-numeric:tabular-nums; font-weight:600; font-size:13px; line-height:20px; min-width:44px; text-align:right; }',
  '.up-row__reset { color:var(--up-text-dim); font-size:11px; line-height:16px; white-space:nowrap; flex:none; }',
  '.up-forecast { color:var(--up-text-sub); font-size:12px; line-height:18px; padding-left:calc(var(--up-label-w) + 12px); }',
  '.up-forecast--warn { color:var(--up-warn); }',
  // ---- 数字与状态色 ----
  '.up-meta { color:var(--up-text-sub); font-size:12px; line-height:18px; }',
  '.up-note { color:var(--up-text-sub); font-size:12px; line-height:18px; }',
  '.up-error { color:var(--up-danger); font-size:12px; line-height:18px; }',
  '.up-ok { color:var(--up-ok); }',
  '.up-warn { color:var(--up-warn); }',
  '.up-num { font-variant-numeric:tabular-nums; }',
  '.up-amount { font-variant-numeric:tabular-nums; font-weight:600; font-size:14px; line-height:22px; }',
  '.up-dot { display:inline-block; width:6px; height:6px; border-radius:50%; margin-right:4px; vertical-align:middle;',
  '  background:var(--up-ok); box-shadow:0 0 0 3px color-mix(in srgb,var(--up-ok) 18%,transparent); }',
  '.up-dot--off { background:var(--up-text-dim); box-shadow:none; }',
  '.up-dot--err { background:var(--up-danger); box-shadow:0 0 0 3px color-mix(in srgb,var(--up-danger) 18%,transparent); }',
  // ---- 趋势弹层 ----
  '.up-trend { position:absolute; top:calc(100% + 8px); left:0; width:320px; max-width:calc(100vw - 48px); visibility:hidden; opacity:0;',
  '  transition:opacity 0.15s ease; background:var(--up-bg-sub); color:var(--up-text); border:.5px solid var(--up-border);',
  '  font-size:12px; line-height:18px; padding:12px; border-radius:var(--up-radius-md); z-index:41;',
  '  box-shadow:var(--dsw-shadow-lv3); }',
  '.up-trend__chart { margin:4px 0 8px; }',
  '.up-trend__chart:last-child { margin-bottom:0; }',
  '.up-trend__head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:4px; }',
  '.up-trend__title { font-weight:600; font-size:12px; line-height:18px; }',
  '.up-trend__value { font-weight:600; font-size:16px; line-height:24px; font-variant-numeric:tabular-nums; }',
  '.up-trend__delta { color:var(--up-text-sub); font-size:11px; line-height:16px; }',
  '.up-chart { position:relative; }',
  '.up-chart svg { display:block; width:100%; height:auto; overflow:visible; }',
  '.up-chart__axis { fill:var(--up-text-dim); font-size:11px; font-variant-numeric:tabular-nums; }',
  '.up-chart__grid { stroke:var(--up-border); stroke-width:1; opacity:0.5; }',
  '.up-chart__line { stroke:var(--up-chart-line); fill:none; stroke-width:1.5; }',
  '.up-chart__area { fill:var(--up-chart-fill); }',
  '.up-chart__dot { fill:var(--up-chart-line); }',
  '.up-chart__bar { stroke-width:2; }',
  '.up-chart__bar--ok { stroke:var(--up-ok); }',
  '.up-chart__bar--err { stroke:var(--up-danger); }',
  '.up-chart__zero { stroke:var(--up-text-dim); stroke-width:1; opacity:0.5; }',
  '.up-chart__cursor { stroke:var(--up-text-dim); stroke-width:1; stroke-dasharray:2 2; }',
  '.up-chart__tip { position:absolute; z-index:1; pointer-events:none; transform:translate(-50%,-110%);',
  '  background:var(--up-bg-sub); color:var(--up-text); border:1px solid var(--up-border); border-radius:var(--up-radius-md);',
  '  box-shadow:var(--dsw-shadow-lv3); padding:10px 12px; font-size:12px; line-height:18px; max-width:420px; white-space:nowrap;',
  '  transition:opacity 0.12s ease; }',
  '.up-chart__tip::after { content:""; position:absolute; left:50%; bottom:-5px; width:8px; height:8px;',
  '  background:var(--up-bg-sub); border-right:1px solid var(--up-border); border-bottom:1px solid var(--up-border);',
  '  transform:translateX(-50%) rotate(45deg); }',
  '.up-chart__tip-value { font-weight:600; font-variant-numeric:tabular-nums; }',
  '.up-card:hover .up-trend, .up-card:focus-within .up-trend { visibility:visible; opacity:1; }',
  '.up-card:last-of-type .up-trend { top:auto; bottom:calc(100% + 8px); }',
  '.up-trend:focus-within { visibility:visible; opacity:1; }',
  '.up-card:hover { cursor:default; }',
  // ---- 对话框 ----
  '.up-dialog-mask { position:fixed; inset:0; background:color-mix(in srgb,var(--up-text) 45%,transparent); z-index:60;',
  '  display:flex; align-items:center; justify-content:center; padding:24px; }',
  '.up-dialog { background:var(--up-card); color:var(--up-text); border:.5px solid var(--up-card-border); border-radius:var(--up-radius-lg);',
  '  padding:20px; max-width:680px; width:90%; max-height:80vh; overflow:auto;',
  '  display:flex; flex-direction:column; gap:12px; box-shadow:var(--dsw-shadow-lv3); }',
  '.up-dialog--wide { max-width:760px; }',
  '.up-dialog:focus { outline:none; }',
  '.up-dialog__summary { display:flex; align-items:flex-start; gap:16px; flex-wrap:wrap; }',
  '.up-summary { display:flex; flex-direction:column; gap:4px; min-width:64px; }',
  '.up-summary__label { color:var(--up-text-dim); font-size:11px; line-height:16px; }',
  '.up-summary__value { font-weight:600; font-size:14px; line-height:22px; font-variant-numeric:tabular-nums; }',
  '.up-dialog__scroll { max-height:280px; overflow:auto; border-top:.5px solid var(--up-border); }',
  '.up-dialog table { border-collapse:collapse; width:100%; font-size:13px; line-height:20px; }',
  '.up-dialog th, .up-dialog td { text-align:left; padding:8px 12px;',
  '  border-bottom:.5px solid var(--up-border); }',
  '.up-dialog th { color:var(--up-text-dim); font-weight:400; font-size:12px; line-height:18px; position:sticky; top:0; background:var(--up-card); }',
  // ---- 表单:L1 卡片与 36px 控件 ----
  '.up-form { border:.5px solid var(--up-card-border); border-radius:var(--up-radius-md); padding:12px 14px;',
  '  background:var(--up-card); display:flex; flex-direction:column; gap:8px; }',
  '.up-form--nested { border:0; background:var(--up-bg-sub); padding:10px 12px; }',
  '.up-field { display:flex; flex-direction:column; gap:4px; min-width:0; }',
  '.up-field__label { font-size:13px; line-height:20px; color:var(--up-text-sub); }',
  '.up-field input, .up-field select, .up-field textarea {',
  '  background:var(--up-bg); color:var(--up-text); border:1px solid var(--up-border-strong);',
  '  border-radius:var(--up-radius-sm); min-height:36px; padding:0 10px; font-size:14px; line-height:22px; font-family:inherit; box-sizing:border-box; width:100%;',
  '  transition:border-color 0.15s ease; }',
  '.up-field input:focus-visible, .up-field select:focus-visible, .up-field textarea:focus-visible {',
  '  outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:0; }',
  '.up-field textarea { font-family:var(--ds-font-family-code); font-size:12px; line-height:18px; min-height:72px; padding:8px 10px; resize:vertical; }',
  '.up-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }',
  // ---- 通知与提示(L3 紧凑状态条) ----
  '.up-notice { font-size:12px; line-height:18px; padding:8px 12px; border-radius:var(--up-radius-sm);',
  '  border:.5px solid var(--up-border); background:var(--up-bg-muted); color:var(--up-text-sub); }',
  '.up-notice--error { border-color:var(--up-danger); background:var(--up-danger-wash); color:var(--up-text); }',
  // ---- 折叠卡:details/summary 原生折叠,摘要行常显状态 ----
  '.up-fold > summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:8px; min-height:24px;',
  '  border-radius:var(--up-radius-sm); transition:opacity 0.15s ease; }',
  '.up-fold > summary::-webkit-details-marker { display:none; }',
  '.up-fold > summary:hover { opacity:0.8; }',
  '.up-fold > summary::after { content:""; width:8px; height:8px; flex:none; margin-left:auto; opacity:0.6;',
  '  border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor;',
  '  transform:rotate(-45deg); transition:transform 0.15s ease; }',
  '.up-fold[open] > summary::after { transform:rotate(45deg); }',
  '.up-fold:not([open]) { padding:14px 20px; }',
  // ---- 分区标题(通知卡内分组) ----
  '.up-section { display:flex; flex-direction:column; gap:12px; }',
  '.up-section__title { font-size:13px; line-height:20px; font-weight:600;',
  '  color:var(--up-text-sub); padding-bottom:8px; border-bottom:.5px solid var(--up-border); }',
  // ---- IM 目标列表行 ----
  '.up-list { display:flex; flex-direction:column; }',
  '.up-list__item { display:flex; align-items:center; gap:12px; min-height:40px; padding:4px 0; border-top:.5px solid var(--up-border); }',
  '.up-list__item:first-child { border-top:none; }',
  '.up-list__grow { flex:1; font-size:13px; line-height:20px; }',
  '.up-list__tag { font-size:11px; line-height:18px; color:var(--up-text-dim); }',
  // ---- chips:已绑 bot 管理 ----
  '.up-chip { display:inline-flex; align-items:center; gap:2px; font-size:11px; line-height:18px; padding:2px 4px 2px 10px; border-radius:999px;',
  '  border:1px solid var(--up-border); background:var(--up-bg-muted); }',
  '.up-chip__name { cursor:pointer; border:none; background:transparent; color:inherit; padding:2px; font-size:11px; line-height:18px; font-family:inherit; }',
  '.up-chip__name--active { color:var(--up-accent); font-weight:600; }',
  '.up-chip__name:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:1px; border-radius:var(--up-radius-sm); }',
  '.up-chip__x { cursor:pointer; border:none; background:transparent; color:var(--up-text-dim); padding:0 6px; font-size:12px; border-radius:50%; line-height:18px; }',
  '.up-chip__x:hover { color:var(--up-danger); background:var(--up-hover-danger); }',
  '.up-chip__x:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:1px; }',
  // ---- 布尔开关:规约形态(track 胶囊 + thumb 圆点,状态锚定 input) ----
  '.up-switch { display:inline-flex; align-items:center; gap:8px; cursor:pointer; position:relative; min-height:36px; }',
  '.up-switch input[type="checkbox"] { position:absolute; opacity:0; width:0; height:0; }',
  '.up-switch__track { width:34px; height:19px; border-radius:999px; flex:none; position:relative; box-sizing:border-box;',
  '  background:var(--up-bg-muted); border:1px solid var(--up-border); transition:background 0.15s ease,border-color 0.15s ease; }',
  '.up-switch__thumb { position:absolute; top:50%; left:2px; width:13px; height:13px; border-radius:50%;',
  '  background:var(--up-text-dim); transform:translateY(-50%); transition:left 0.15s ease,background 0.15s ease; }',
  '.up-switch:hover .up-switch__track { border-color:var(--up-accent); }',
  '.up-switch input[type="checkbox"]:checked + .up-switch__track { background:var(--up-accent); border-color:var(--up-accent); }',
  '.up-switch input[type="checkbox"]:checked + .up-switch__track .up-switch__thumb { left:17px; background:var(--up-bg); }',
  '.up-switch input[type="checkbox"]:focus-visible + .up-switch__track { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }',
  '.up-switch input[type="checkbox"]:disabled + .up-switch__track { opacity:0.5; }',
  '.up-switch:has(input[type="checkbox"]:disabled) { opacity:0.5; cursor:not-allowed; }',
  // ---- 空态 ----
  '.up-empty { align-items:center; text-align:center; padding:48px 20px; color:var(--up-text-sub); }',
  '.up-empty__hint { font-size:12px; line-height:18px; color:var(--up-text-dim); }',
  '@media (max-width:640px) { .up-grid { grid-template-columns:1fr; } .up-form { padding:16px; } }',
].join('\n')

const TYPE_LABELS = {
  deepseek: 'DeepSeek 官方',
  openrouter: 'OpenRouter',
  kimi: 'Kimi Code',
  zhipu: '智谱 GLM',
  minimax: 'MiniMax',
  newapi: 'NewApi/OneApi',
  custom: '自定义端点',
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
const WARN_PCT = 70
const CRIT_PCT = 90
const PERCENT_BASE = 100

const NEWAPI_EXAMPLE_HEADERS = { Authorization: 'Bearer sk-你的key' }
const NEWAPI_EXAMPLE_EXTRACT = {
  remaining: { op: 'divide', path: 'data.total_available', by: 500000 },
  maxBudget: { op: 'divide', path: 'data.total_granted', by: 500000 },
  spend: { op: 'divide', path: 'data.total_used', by: 500000 },
  unit: 'USD',
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  const payload = await response.json()
  if (!response.ok) {
    const error = new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
    error.status = response.status
    throw error
  }
  return payload
}

function currencySymbol(code) {
  return Object.prototype.hasOwnProperty.call(TREND_CURRENCY_SYMBOLS, code) ? TREND_CURRENCY_SYMBOLS[code] : code + ' '
}

function fmtMoney(value) {
  const n = Number(value)
  if (n !== n) return '—'
  return n.toFixed(2)
}

function fmtInt(value) {
  const n = Number(value)
  return n === n ? String(Math.round(n)) : '—'
}

function fmtPct(value) {
  const n = Number(value)
  return n === n ? Math.round(n) + '%' : '—'
}

function fmtPctPrecise(value) {
  const n = Number(value)
  return n === n ? n.toFixed(1) + '%' : '—'
}

function pctClass(value) {
  const n = Number(value)
  if (n !== n) return ''
  if (n >= CRIT_PCT) return 'up-error'
  if (n >= WARN_PCT) return 'up-warn'
  return 'up-ok'
}

function fmtTime(ms) {
  const t = Number(ms)
  if (t !== t) return null
  const d = new Date(t)
  const pad = (n) => (n < 10 ? '0' : '') + n
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function fmtTimeFull(t) {
  const d = new Date(t)
  const pad = (n) => (n < 10 ? '0' : '') + n
  return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function fmtRelative(t) {
  const delta = t - Date.now()
  if (delta <= 0) return '已可重置'
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < hour) return Math.max(1, Math.round(delta / minute)) + '分钟后'
  if (delta < day) return Math.round(delta / hour) + '小时后'
  return Math.round(delta / day) + '天后'
}

// 悬浮窗重置时间行:本地完整时间 + 倒计时,无时间数据时不输出。
function resetLine(resetsAt) {
  if (!resetsAt) return null
  const t = Date.parse(resetsAt)
  if (t !== t) return null
  return '重置 ' + fmtTimeFull(t) + '(' + fmtRelative(t) + ')'
}

function barWidth(value) {
  const n = Number(value)
  if (n !== n) return '0%'
  return Math.max(0, Math.min(100, n)) + '%'
}

function fillClass(value) {
  const n = Number(value)
  if (n !== n) return ''
  if (n >= CRIT_PCT) return ' up-bar__fill--crit'
  if (n >= WARN_PCT) return ' up-bar__fill--warn'
  return ''
}

function h(type, props) {
  const children = Array.prototype.slice.call(arguments, 2)
  return React.createElement.apply(React, [type, props || null].concat(children))
}

function newId() {
  return 'acct-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000000).toString(36)
}

function ReadingRow(props) {
  const [anchor, setAnchor] = useState(null)
  const setFrom = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setAnchor({ kind: 'rect', left: rect.left, top: rect.top, width: rect.width, height: rect.height })
  }
  return h('div', {
    className: 'up-row',
    onMouseEnter: setFrom,
    onMouseLeave: () => setAnchor(null),
    onFocus: setFrom,
    onBlur: () => setAnchor(null),
  }, [
    ...props.children,
    h(tools.Tooltip, { key: 'tip', anchor, panelSelector: '.up-panel' },
      props.lines.map((line, index) => h('div', { key: String(index) }, line))),
  ])
}

function BalanceReading(props) {
  const entries = props.reading.entries || []
  const rows = entries.map((entry, index) => {
    const sym = currencySymbol(entry.currency)
    const tipLines = []
    let main
    if (entry.remaining !== null && entry.remaining !== undefined) {
      main = '余 ' + sym + fmtMoney(entry.remaining) +
        (entry.total !== null && entry.total !== undefined ? ' / 总 ' + sym + fmtMoney(entry.total) : '')
      if (entry.used !== null && entry.used !== undefined) {
        tipLines.push('已用 ' + sym + fmtMoney(entry.used))
        if (entry.total > 0) tipLines.push('已用 ' + fmtPctPrecise((entry.used / entry.total) * PERCENT_BASE) + ' 的额度')
      }
    } else {
      main = '余额 ' + sym + fmtMoney(entry.total)
    }
    const extra = []
    if (entry.granted !== null && entry.granted !== undefined) extra.push('赠送 ' + sym + fmtMoney(entry.granted))
    if (entry.toppedUp !== null && entry.toppedUp !== undefined) extra.push('充值 ' + sym + fmtMoney(entry.toppedUp))
    if (extra.length > 0) tipLines.push(extra.join(' · '))
    if (entry.isAvailable === false) tipLines.push('账户不可用')
    const usedPct = entry.total !== null && entry.total !== undefined && entry.total > 0 &&
      entry.used !== null && entry.used !== undefined
      ? (entry.used / entry.total) * PERCENT_BASE
      : null
    return h(ReadingRow, { key: String(index), lines: [main].concat(tipLines) },
      h('span', { className: 'up-row__label' }, entry.currency),
      usedPct !== null
        ? h('span', { className: 'up-bar' },
            h('span', { className: 'up-bar__fill' + fillClass(usedPct), style: { width: barWidth(usedPct) } }))
        : h('span', { className: 'up-amount' }, main),
      usedPct !== null ? h('span', { className: 'up-pct ' + pctClass(usedPct) }, fmtPct(usedPct)) : null,
    )
  })
  return h('div', { className: 'up-reading' }, rows)
}

function QuotaReading(props) {
  const windows = props.reading.windows || []
  const rows = windows.map((win, index) => {
    const tipLines = [win.label + '窗口:已用 ' + fmtPctPrecise(win.utilization)]
    const used = Number.isFinite(Number(win.limit)) && Number.isFinite(Number(win.remaining))
      ? Number(win.limit) - Number(win.remaining)
      : null
    if (used !== null && Number(win.limit) > 0) {
      tipLines.push('已用 ' + fmtInt(used) + ' · 余 ' + fmtInt(win.remaining) + ' · 总 ' + fmtInt(win.limit))
    } else if (Number(win.limit) > 0) {
      tipLines.push('余 ' + fmtInt(win.remaining) + ' · 总 ' + fmtInt(win.limit))
    }
    const reset = resetLine(win.resetsAt)
    if (reset !== null) tipLines.push(reset)
    if (Array.isArray(win.details) && win.details.length > 0) {
      tipLines.push('模型明细: ' + win.details.map((d) => d.model + ' ×' + fmtInt(d.usage)).join(', '))
    }
    const resetAt = win.resetsAt ? Date.parse(win.resetsAt) : NaN
    const resetText = formatResetCountdown(win.resetsAt, Date.now())
    return h(ReadingRow, { key: String(index), lines: tipLines },
      h('span', { className: 'up-row__label' }, win.label),
      h('span', { className: 'up-bar' },
        h('span', { className: 'up-bar__fill' + fillClass(win.utilization), style: { width: barWidth(win.utilization) } })),
      h('span', { className: 'up-pct ' + pctClass(win.utilization) }, fmtPct(win.utilization)),
      resetText !== null ? h('span', { className: 'up-row__reset', title: fmtTimeFull(resetAt) }, resetText) : null,
    )
  })
  return h('div', { className: 'up-reading' }, rows)
}

function ReadingView(props) {
  const last = props.last
  if (!last) return h('span', { className: 'up-meta' }, '未查询,点击「刷新」获取读数')
  if (!last.ok) return h('span', { className: 'up-note' }, '查询失败:' + (last.error || '未知错误'))
  const reading = last.reading
  if (!reading) return h('span', { className: 'up-note' }, '查询结果为空')
  if (reading.kind === 'quota') return h(QuotaReading, { reading })
  return h(BalanceReading, { reading })
}

// 档位徽章文案:已知档位首字母大写,未知值原样透传。
const LEVEL_LABELS = { pro: 'Pro', max: 'Max' }

function levelLabel(value) {
  const key = String(value).toLowerCase()
  return Object.prototype.hasOwnProperty.call(LEVEL_LABELS, key) ? LEVEL_LABELS[key] : String(value)
}

function AccountCard(props) {
  const account = props.account
  const busy = props.busy === true
  const armed = props.deleteArmed === true
  const now = Date.now()
  const reading = account.last && account.last.ok ? account.last.reading : null
  const level = reading && (reading.level || reading.membership) ? levelLabel(reading.level || reading.membership) : null
  const queriedAt = account.last && typeof account.last.queriedAt === 'number' && Number.isFinite(account.last.queriedAt)
    ? account.last.queriedAt
    : null
  const status = !account.last ? 'none' : account.last.ok === true ? 'ok' : 'error'
  const forecast = forecastNotes(account, props.sequences || {}, now)

  return h('div', { className: 'up-card' },
    h('div', { className: 'up-card__row' },
      h('span', {
        className: 'up-dot' + (status === 'error' ? ' up-dot--err' : status === 'none' ? ' up-dot--off' : ''),
        title: status === 'error' ? '查询失败' : status === 'none' ? '尚未查询' : '查询正常',
      }),
      h('span', { className: 'up-card__name' }, account.name),
      h('span', { className: 'up-badge', 'data-type': account.type }, TYPE_LABELS[account.type] || account.type),
      level ? h('span', { className: 'up-badge', 'data-type': 'custom' }, level) : null,
      h('span', { className: 'up-spacer' }),
      queriedAt !== null
        ? h('span', {
            className: 'up-meta',
            title: '上次' + (status === 'ok' ? '更新' : '查询') + ' ' + fmtTimeFull(queriedAt),
          }, formatAgo(now, queriedAt) + (status === 'ok' ? '更新' : '查询'))
        : null,
      h('button', { className: 'up-btn', disabled: busy, onClick: props.onRefresh }, busy ? '查询中…' : '刷新'),
      h('button', { className: 'up-btn', disabled: busy, onClick: props.onEdit }, '编辑'),
      h('button', {
        className: 'up-btn up-btn--danger',
        disabled: busy, onClick: props.onDelete,
        title: armed ? '再次点击确认删除;超时或其它操作后自动取消' : '删除该账号',
      }, armed ? '确认删除' : '删除'),
    ),
    h('div', { className: 'up-card__row' }, h(ReadingView, { last: account.last })),
    forecast !== null
      ? h('div', { className: 'up-forecast' + (forecast.kind === 'warn' ? ' up-forecast--warn' : '') }, forecast.text)
      : null,
    h(TrendPopover, { accountName: account.name, reading, sequences: props.sequences || {} }),
  )
}

// 表单草稿 <-> 账号对象互转,custom 的 headers/extract 以 JSON 文本编辑。
function draftFromAccount(account) {
  const empty = {
    id: null, isNew: true, name: '', type: 'deepseek',
    baseUrl: '', apiKey: '', url: '', method: 'GET', headersText: '', bodyText: '', extractText: '',
    notifyQuota: '', notifyBalance: '', notifyReset: '',
  }
  if (!account) return empty
  const custom = account.custom || {}
  const notify = account.notify && typeof account.notify === 'object' ? account.notify : {}
  return {
    id: account.id,
    isNew: false,
    hasKey: account.hasKey === true,
    name: account.name,
    type: account.type,
    baseUrl: account.baseUrl || '',
    apiKey: account.apiKey || '',
    url: custom.url || '',
    method: custom.method || 'GET',
    headersText: custom.headers && Object.keys(custom.headers).length > 0 ? JSON.stringify(custom.headers, null, 2) : '',
    bodyText: custom.body || '',
    extractText: custom.extract && Object.keys(custom.extract).length > 0 ? JSON.stringify(custom.extract, null, 2) : '',
    notifyQuota: notify.quotaThresholdPct === undefined ? '' : String(notify.quotaThresholdPct),
    notifyBalance: notify.balanceThreshold === undefined || notify.balanceThreshold === null ? '' : String(notify.balanceThreshold),
    notifyReset: notify.resetNotice === true ? 'on' : notify.resetNotice === false ? 'off' : '',
  }
}

function parseJsonField(text, fieldName) {
  if (typeof text !== 'string' || text.trim().length === 0) return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(fieldName + ' 必须是 JSON 对象')
  }
  return parsed
}

function buildAccountFromDraft(draft) {
  if (!draft.name || draft.name.trim().length === 0) throw new Error('请填写账号名称')
  const account = {
    id: draft.isNew ? newId() : draft.id,
    name: draft.name.trim(),
    type: draft.type,
    baseUrl: draft.baseUrl.trim(),
    apiKey: draft.apiKey.trim(),
    custom: { url: '', method: 'GET', headers: {}, body: '', extract: {} },
  }
  if (draft.type === 'custom') {
    account.custom.url = draft.url.trim()
    account.custom.method = draft.method
    account.custom.headers = parseJsonField(draft.headersText, '请求头')
    account.custom.body = draft.bodyText
    account.custom.extract = parseJsonField(draft.extractText, '提取规则')
    if (account.custom.url.length === 0) throw new Error('自定义端点必须填写完整 URL')
  } else if (draft.type === 'newapi' && account.baseUrl.length === 0) {
    throw new Error('NewApi/OneApi 需要填写 API 基础地址')
  } else if (draft.apiKey.length === 0 && !draft.hasKey) {
    throw new Error('该平台需要填写 API Key')
  }
  // 通知覆盖:仅非空字段写入,留空即继承全局(空串不产生覆盖键)
  const notifyOverride = {}
  if (draft.notifyQuota.trim().length > 0) {
    const quota = Number(draft.notifyQuota)
    if (!Number.isFinite(quota) || quota <= 0 || quota > PERCENT_BASE) throw new Error('用量阈值须为 (0,100] 内数值')
    notifyOverride.quotaThresholdPct = quota
  }
  if (draft.notifyBalance.trim().length > 0) {
    const balance = Number(draft.notifyBalance)
    if (!Number.isFinite(balance) || balance < 0) throw new Error('余额阈值须为非负数值')
    notifyOverride.balanceThreshold = balance
  }
  if (draft.notifyReset === 'on' || draft.notifyReset === 'off') notifyOverride.resetNotice = draft.notifyReset === 'on'
  if (Object.keys(notifyOverride).length > 0) account.notify = notifyOverride
  return account
}

function AccountForm(props) {
  const [draft, setDraft] = useState(() => draftFromAccount(props.initial))
  const [error, setError] = useState(null)

  function patch(part) {
    setDraft((prev) => Object.assign({}, prev, part))
  }

  function submit() {
    try {
      props.onSave(buildAccountFromDraft(draft))
    } catch (submitError) {
      setError(submitError && submitError.message ? submitError.message : String(submitError))
    }
  }

  const isCustom = draft.type === 'custom'
  const typeOptions = Object.keys(TYPE_LABELS).map((type) => h('option', { key: type, value: type }, TYPE_LABELS[type]))

  return h('div', { className: 'up-form' },
    h('div', { className: 'up-grid' },
      h('div', { className: 'up-field' },
        h('label', { className: 'up-field__label' }, '账号名称'),
        h('input', { value: draft.name, onChange: (e) => patch({ name: e.target.value }), placeholder: '如 DeepSeek 主号' }),
      ),
      h('div', { className: 'up-field' },
        h('label', { className: 'up-field__label' }, '平台类型'),
        h('select', { value: draft.type, onChange: (e) => patch({ type: e.target.value }) }, typeOptions),
      ),
    ),
    !isCustom ? h('div', { className: 'up-grid' },
      h('div', { className: 'up-field' },
        h('label', { className: 'up-field__label', title: '留空使用平台官方默认地址' }, 'API 基础地址'),
        h('input', {
          value: draft.baseUrl,
          onChange: (e) => patch({ baseUrl: e.target.value }),
          placeholder: draft.type === 'newapi' ? 'https://你的站点' : 'https://官方地址',
        }),
      ),
      h('div', { className: 'up-field' },
        h('label', { className: 'up-field__label', title: '仅存于本机配置,用于查询余额;已保存时留空保持不变' }, 'API Key'),
        h('input', {
          value: draft.apiKey,
          onChange: (e) => patch({ apiKey: e.target.value }),
          placeholder: draft.hasKey ? '已保存,留空保持不变' : 'sk-…',
        }),
      ),
    ) : null,
    isCustom ? h('div', { className: 'up-field' },
      h('label', { className: 'up-field__label', title: '自定义余额端点的完整地址' }, '请求 URL'),
      h('input', { value: draft.url, onChange: (e) => patch({ url: e.target.value }), placeholder: 'https://example.com/api/balance' }),
    ) : null,
    isCustom ? h('div', { className: 'up-grid' },
      h('div', { className: 'up-field' },
        h('label', { className: 'up-field__label' }, '请求方法'),
        h('select', { value: draft.method, onChange: (e) => patch({ method: e.target.value }) },
          HTTP_METHODS.map((method) => h('option', { key: method, value: method }, method))),
      ),
      h('div', { className: 'up-field' },
        h('label', { className: 'up-field__label', title: '非 GET 请求的请求体,GET 留空' }, '请求体'),
        h('input', { value: draft.bodyText, onChange: (e) => patch({ bodyText: e.target.value }) }),
      ),
    ) : null,
    isCustom ? h('div', { className: 'up-field' },
      h('label', { className: 'up-field__label', title: 'JSON 对象;鉴权头(如 Authorization)直接填真实 Key' }, '请求头'),
      h('textarea', {
        value: draft.headersText,
        onChange: (e) => patch({ headersText: e.target.value }),
        placeholder: '{"Authorization": "Bearer sk-xxx"}',
      }),
    ) : null,
    isCustom ? h('div', { className: 'up-field' },
      h('label', {
        className: 'up-field__label',
        title: 'JSON 对象;remaining 必填,取值支持点路径与 add/subtract/divide 运算',
      }, '提取规则'),
      h('textarea', {
        value: draft.extractText,
        onChange: (e) => patch({ extractText: e.target.value }),
        placeholder: '{"remaining": {"op": "divide", "path": "data.total_available", "by": 500000}, "unit": "USD"}',
      }),
      h('button', {
        className: 'up-btn',
        title: '一键填入 NewApi 站点的典型余额接口配置,按实际站点修改',
        onClick: () => patch({
          url: draft.url.length > 0 ? draft.url : 'https://你的站点/api/usage/token',
          method: 'GET',
          headersText: JSON.stringify(NEWAPI_EXAMPLE_HEADERS, null, 2),
          extractText: JSON.stringify(NEWAPI_EXAMPLE_EXTRACT, null, 2),
        }),
      }, '填入 NewApi 示例'),
    ) : null,
    h('details', { className: 'up-form up-form--nested' },
      h('summary', { className: 'up-field__label', style: { cursor: 'pointer' }, title: '留空的字段继承全局通知配置' }, '通知规则覆盖'),
      h('div', { className: 'up-grid' },
        h('div', { className: 'up-field' },
          h('label', { className: 'up-field__label', title: '该账号窗口用量达到此百分比时通知;留空继承全局' }, '用量阈值(%)'),
          h('input', {
            type: 'number', min: 1, max: 100,
            value: draft.notifyQuota,
            onChange: (e) => patch({ notifyQuota: e.target.value }),
            placeholder: '留空继承全局',
          })),
        h('div', { className: 'up-field' },
          h('label', { className: 'up-field__label', title: '该账号可用余额低于此值时通知;留空继承全局' }, '余额阈值'),
          h('input', {
            type: 'number', min: 0,
            value: draft.notifyBalance,
            onChange: (e) => patch({ notifyBalance: e.target.value }),
            placeholder: '留空继承全局',
          })),
      ),
      h('div', { className: 'up-field' },
        h('label', { className: 'up-field__label', title: '覆盖全局的窗口重置通知开关' }, '窗口重置通知'),
        h('select', { value: draft.notifyReset, onChange: (e) => patch({ notifyReset: e.target.value }) },
          NOTIFY_TRISTATE.map((item) => h('option', { key: item.value, value: item.value }, item.label))),
      ),
    ),
    error !== null ? h('div', { className: 'up-notice up-notice--error' }, error) : null,
    h('div', { className: 'up-card__row' },
      h('button', { className: 'up-btn up-btn--primary', onClick: submit }, draft.isNew ? '添加' : '保存'),
      h('button', { className: 'up-btn', onClick: props.onCancel }, '取消'),
    ),
  )
}

// ---- 趋势视图(自绘 SVG;几何与格式化纯逻辑在 LOGIC 段,渲染只消费结果) ----

const SPARK_WIDTH = 296
const SPARK_HEIGHT = 96
const DETAIL_WIDTH = 620
const DETAIL_HEIGHT = 190
const HOVER_WINDOW_POINTS = 24
const TREND_SEQUENCE_META = {
  '5h': { label: '5 小时滚动', short: true },
  '7d': { label: '7 天', short: false },
  month: { label: '月', short: false },
  balance: { label: '余额', short: false },
}

function exportTrendCsv(accountName, label, range, points, unit) {
  const csv = '\ufeff' + buildTrendCsv(points, unit)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = (accountName || 'account') + '-' + label + '-' + range + '.csv'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function TrendChart(props) {
  const [mode, setMode] = useState('abs')
  const [active, setActive] = useState(null)
  const width = props.large ? DETAIL_WIDTH : SPARK_WIDTH
  const height = props.large ? DETAIL_HEIGHT : SPARK_HEIGHT
  const padding = props.large
    ? { left: 46, right: 12, top: 12, bottom: 24 }
    : TREND_PAD
  const unit = props.unit || { kind: 'number' }
  const points = Array.isArray(props.points) ? props.points : []
  const chartPoints = points.filter((point) => point && Number.isFinite(point.t) && trendNumber(point.v) !== null)
  const geometry = computeTrendGeometry(points, mode, width, height, padding)
  const last = chartPoints.length > 0 ? chartPoints[chartPoints.length - 1] : null
  const previous = chartPoints.length > 1 ? chartPoints[chartPoints.length - 2] : null
  const latestDelta = last !== null && previous !== null ? trendNumber(last.v) - trendNumber(previous.v) : null
  const primary = last === null
    ? '—'
    : mode === 'diff'
      ? formatTrendDelta(latestDelta, unit)
      : formatTrendValue(last.v, unit)
  const secondary = last === null || previous === null
    ? ''
    : mode === 'diff'
      ? ''
      : '较前值 ' + formatTrendDelta(latestDelta, unit)
  const duration = last !== null && chartPoints.length > 1 ? last.t - chartPoints[0].t : 0
  const modeButton = h('button', {
    className: 'up-btn up-btn--small',
    'aria-pressed': mode === 'diff',
    onClick: () => { setMode(mode === 'abs' ? 'diff' : 'abs'); setActive(null) },
  }, mode === 'abs' ? '差值' : '绝对值')
  const detailButton = props.onDetail
    ? h('button', { className: 'up-btn up-btn--small', onClick: props.onDetail }, '详情')
    : null

  if (geometry === null) {
    return h('div', { className: 'up-trend__chart' },
      h('div', { className: 'up-trend__head' },
        h('span', { className: 'up-trend__title' }, props.label),
        h('span', { className: 'up-meta' }, '数据点不足'),
        h('span', { className: 'up-spacer' }),
        modeButton,
        detailButton,
      ),
    )
  }

  const plotBottom = geometry.plot.top + geometry.plot.height
  const areaPath = 'M ' + geometry.points[0].x + ' ' + plotBottom + ' L ' +
    geometry.points.map((point) => Math.round(point.x) + ' ' + Math.round(point.y)).join(' L ') +
    ' L ' + geometry.points[geometry.points.length - 1].x + ' ' + plotBottom + ' Z'
  const activePoint = activeTrendPoint(geometry.points, active)
  const stepWidth = geometry.points.length > 1
    ? geometry.points[1].x - geometry.points[0].x
    : geometry.plot.width
  const axisSpan = duration

  return h('div', { className: 'up-trend__chart' },
    h('div', { className: 'up-trend__head' },
      h('span', { className: 'up-trend__title' }, props.label),
      h('span', { className: 'up-trend__value' }, primary),
      secondary !== '' ? h('span', { className: 'up-trend__delta' }, secondary) : null,
      h('span', { className: 'up-spacer' }),
      modeButton,
      detailButton,
    ),
    h('div', { className: 'up-chart' },
      h('svg', {
        viewBox: '0 0 ' + width + ' ' + height,
        width: '100%',
        height: 'auto',
        role: 'img',
        'aria-label': props.label + '趋势图,最新 ' + primary,
      },
        geometry.yTicks.map((tick, index) => h('g', { key: 'y' + index },
          h('line', {
            className: 'up-chart__grid',
            x1: geometry.plot.left, x2: geometry.plot.left + geometry.plot.width,
            y1: tick.y, y2: tick.y,
          }),
          h('text', {
            className: 'up-chart__axis', x: geometry.plot.left - 6, y: tick.y + 3,
            textAnchor: 'end',
          }, mode === 'diff' ? formatTrendDelta(tick.value, unit) : formatTrendValue(tick.value, unit)),
        )),
        geometry.xTicks.map((tick, index) => h('text', {
          key: 'x' + index,
          className: 'up-chart__axis',
          x: tick.x, y: height - 6, textAnchor: tick.anchor,
        }, formatAxisTime(tick.t, axisSpan))),
        mode === 'abs'
          ? h('path', { className: 'up-chart__area', d: areaPath })
          : null,
        mode === 'abs'
          ? h('polyline', {
              className: 'up-chart__line',
              points: geometry.points.map((point) => Math.round(point.x) + ',' + Math.round(point.y)).join(' '),
            })
          : h('line', {
              className: 'up-chart__zero',
              x1: geometry.plot.left, x2: geometry.plot.left + geometry.plot.width,
              y1: geometry.zeroY, y2: geometry.zeroY,
            }),
        mode === 'diff'
          ? geometry.points.map((point, index) => h('line', {
              key: 'bar' + index,
              className: 'up-chart__bar ' + (point.v >= 0 ? 'up-chart__bar--ok' : 'up-chart__bar--err'),
              x1: point.x, x2: point.x, y1: geometry.zeroY, y2: point.y,
            }))
          : null,
        mode === 'abs'
          ? h('circle', {
              className: 'up-chart__dot',
              cx: geometry.points[geometry.points.length - 1].x,
              cy: geometry.points[geometry.points.length - 1].y,
              r: 3,
            })
          : null,
        geometry.points.map((point, index) => h('rect', {
          key: 'hit' + index,
          x: Math.max(0, point.x - stepWidth / 2), y: geometry.plot.top,
          width: stepWidth, height: geometry.plot.height,
          fill: 'transparent',
          onMouseEnter: () => setActive(index),
          onMouseLeave: () => setActive(null),
        })),
        activePoint !== null
          ? h('g', null,
              h('line', {
                className: 'up-chart__cursor',
                x1: activePoint.x, x2: activePoint.x,
                y1: geometry.plot.top, y2: plotBottom,
              }),
              h('circle', {
                className: 'up-chart__dot',
                cx: activePoint.x, cy: activePoint.y, r: 3.5,
              }),
            )
          : null,
      ),
      activePoint !== null
        ? h('div', {
            className: 'up-chart__tip',
            style: {
              left: (activePoint.x / width) * 100 + '%',
              top: (activePoint.y / height) * 100 + '%',
            },
          },
            h('div', null, fmtTimeFull(activePoint.t)),
            h('div', { className: 'up-chart__tip-value' },
              mode === 'diff' ? formatTrendDelta(activePoint.v, unit) : formatTrendValue(activePoint.v, unit)),
          )
        : null,
    ),
  )
}

function DetailDialog(props) {
  const ranges = props.shortWindow ? ['all', '7d'] : ['7d', '30d', 'all']
  const [range, setRange] = useState(ranges[0])
  const dialogRef = useRef(null)
  const titleId = 'up-detail-title'
  useEffect(() => {
    focusDialog(dialogRef.current)
    return bindDialogKeys(window, props.onClose)
  }, [])
  const cutoff = range === '7d' ? Date.now() - 7 * DAY_MS : range === '30d' ? Date.now() - 30 * DAY_MS : -Infinity
  const points = props.points.filter((p) => p.t >= cutoff)
  const summary = points.length >= 2 ? summaryOf(points) : null
  const unit = props.unit || { kind: 'number' }
  const rows = points.map((point, index) => ({
    point,
    delta: index === 0 ? null : point.v - points[index - 1].v,
  })).reverse()
  const summaryItems = summary === null ? [] : [
    { label: '最新', value: formatTrendValue(summary.latest, unit) },
    { label: '均值', value: formatTrendValue(summary.avg, unit) },
    { label: '最低', value: formatTrendValue(summary.min, unit) },
    { label: '最高', value: formatTrendValue(summary.max, unit) },
    { label: '总变化', value: formatTrendDelta(summary.totalChange, unit) },
  ]
  return h('div', { className: 'up-dialog-mask', onClick: props.onClose },
    h('div', {
      className: 'up-dialog up-dialog--wide',
      ...detailDialogA11y(titleId),
      ref: dialogRef,
      onClick: (e) => e.stopPropagation(),
    },
      h('div', { className: 'up-card__row' },
        h('span', { className: 'up-card__name', id: titleId }, props.accountName + ' · ' + props.label),
        h('span', { className: 'up-spacer' }),
        ranges.map((item) => h('button', {
          key: item, className: 'up-btn', disabled: item === range,
          onClick: () => setRange(item),
        }, item === 'all' ? '全部' : '近 ' + ({ '7d': '7 天', '30d': '30 天' })[item])),
        h('button', {
          className: 'up-btn',
          disabled: points.length === 0,
          onClick: () => exportTrendCsv(props.accountName, props.label, range, points, unit),
        }, '导出 CSV'),
        h('button', { className: 'up-btn', onClick: props.onClose }, '关闭'),
      ),
      h(TrendChart, { label: props.label, points, unit, large: true, onDetail: null }),
      summary !== null
        ? h('div', { className: 'up-dialog__summary' },
            summaryItems.map((item) => h('div', { className: 'up-summary', key: item.label },
              h('span', { className: 'up-summary__label' }, item.label),
              h('span', { className: 'up-summary__value' }, item.value))))
        : h('div', { className: 'up-meta' }, '所选范围快照不足'),
      h('div', { className: 'up-dialog__scroll' },
        h('table', null,
          h('thead', null, h('tr', null, h('th', null, '采样时间'), h('th', null, '数值'), h('th', null, '较前值'))),
          h('tbody', null, rows.map((row) =>
            h('tr', { key: String(row.point.t) },
              h('td', null, fmtTimeFull(row.point.t)),
              h('td', { className: 'up-num' }, formatTrendValue(row.point.v, unit)),
              h('td', { className: 'up-num' }, row.delta === null ? '—' : formatTrendDelta(row.delta, unit)))))),
      ),
    ),
  )
}

// 账号悬浮趋势弹层:短窗口与长窗口各自独立成图,余额账号单图;档点不足两条不伪造数据。
function TrendPopover(props) {
  const { sequences } = props
  const [detail, setDetail] = useState(null)
  const charts = Object.keys(TREND_SEQUENCE_META)
    .map((suffix) => ({ suffix, meta: TREND_SEQUENCE_META[suffix] }))
    .filter((item) => sequences[item.suffix] && sequences[item.suffix].points)
    .map((item) => {
      const all = sequences[item.suffix].points
      const points = all.slice(Math.max(0, all.length - HOVER_WINDOW_POINTS))
      if (points.length < 2) return null
      return h(TrendChart, {
        key: item.suffix,
        label: item.meta.label,
        points,
        unit: unitOfSequence(props.reading, item.suffix),
        onDetail: () => setDetail({ suffix: item.suffix }),
      })
    })
    .filter(Boolean)
  const detailSeq = detail ? sequences[detail.suffix] : null
  return h('div', { className: 'up-trend' },
    charts.length === 0 ? h('div', { className: 'up-meta' }, '暂无趋势数据') : charts,
    detailSeq !== null
      ? h(DetailDialog, {
          accountName: props.accountName,
          label: TREND_SEQUENCE_META[detail.suffix].label,
          shortWindow: TREND_SEQUENCE_META[detail.suffix].short === true,
          points: detailSeq.points,
          unit: unitOfSequence(props.reading, detail.suffix),
          onClose: () => setDetail(null),
        })
      : null,
  )
}

// 布尔开关:原生 checkbox 保可访问性,视觉为 track 胶囊 + thumb 圆点(规约形态);
// className/children 供列表行形态(如 IM 目录勾选行)扩展,title 为悬浮详解,checkbox 本体不外泄
function Switch(props) {
  return h('label', {
    className: 'up-switch' + (props.className ? ' ' + props.className : ''),
    title: props.title,
  },
  h('input', {
    type: 'checkbox',
    checked: props.checked === true,
    disabled: props.disabled === true,
    onChange: (e) => props.onChange(e.target.checked),
  }),
  h('span', { className: 'up-switch__track' }, h('span', { className: 'up-switch__thumb' })),
  props.label ? h('span', { className: 'up-field__label' }, props.label) : null,
  props.children || null,
  )
}

const NOTIFY_TRISTATE = [
  { value: '', label: '继承全局' },
  { value: 'on', label: '开启' },
  { value: 'off', label: '关闭' },
]

// 通知配置卡:全局规则 + 三通道(webhook / dsh-im / 页内 toast)配置与测试。
function NotifyConfigCard() {
  const [config, setConfig] = useState(null)
  const [imAvailable, setImAvailable] = useState(false)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [quotaPct, setQuotaPct] = useState('')
  const [balanceThreshold, setBalanceThreshold] = useState('')
  const [imBotIdDraft, setImBotIdDraft] = useState('')
  const [imCatalog, setImCatalog] = useState(null)
  const [imBusy, setImBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    api('/api/usage-panel/notify-config')
      .then((res) => {
        if (!alive) return
        setConfig(res && res.notify ? res.notify : {})
        setWebhookUrl('')
        setImAvailable(res ? res.imAvailable === true : false)
      })
      .catch((err) => { if (alive) setError('读取通知配置失败:' + (err && err.message ? err.message : String(err))) })
    return () => { alive = false }
  }, [])

  function apply(res) {
    if (res && res.notify) setConfig(res.notify)
    notify('通知配置已保存', 'ok')
  }
  function fail(err) {
    notify('保存失败:' + (err && err.message ? err.message : String(err)), 'error')
    // 失败权威回填:保存被拒时本卡展示态可能已偏离服务端(前序写/他人写生效),拉权威态收敛
    api('/api/usage-panel/notify-config')
      .then((res) => { if (res && res.notify) setConfig(res.notify) })
      .catch(() => {})
  }
  function patch(part) {
    api('/api/usage-panel/notify-config', { method: 'POST', body: JSON.stringify(part) })
      .then(apply)
      .catch(fail)
  }
  function saveThresholds() {
    const part = {}
    if (quotaPct.trim().length > 0) part.quotaThresholdPct = Number(quotaPct)
    if (balanceThreshold.trim().length > 0) part.balanceThreshold = Number(balanceThreshold)
    if (Object.keys(part).length === 0) {
      notify('无改动', 'ok')
      return
    }
    api('/api/usage-panel/notify-config', { method: 'POST', body: JSON.stringify(part) })
      .then((res) => { apply(res); setQuotaPct(''); setBalanceThreshold('') })
      .catch(fail)
  }
  function testWebhook() {
    api('/api/usage-panel/test-webhook', { method: 'POST', body: '{}' })
      .then((res) => notify(res && res.ok ? 'webhook 投递成功(' + res.detail + ')' : 'webhook 投递失败:' + (res ? res.detail : '无响应'), res && res.ok ? 'ok' : 'error'))
      .catch((err) => notify('测试失败:' + (err && err.message ? err.message : String(err)), 'error'))
  }
  function testIm() {
    api('/api/usage-panel/test-im', { method: 'POST', body: '{}' })
      .then((res) => {
        if (!res || !Array.isArray(res.results)) {
          notify('IM 测试失败:' + (res && res.detail ? res.detail : '无响应'), 'error')
          return
        }
        const failed = res.results.filter((item) => !item.ok)
        notify(failed.length === 0
          ? 'IM 通知已全部送达(' + res.results.length + ' 个目标)'
          : '部分失败:' + failed.map((item) => item.botId + '/' + item.targetId + ' ' + item.detail).join('; '),
        failed.length === 0 ? 'ok' : 'error')
      })
      .catch((err) => notify('测试失败:' + (err && err.message ? err.message : String(err)), 'error'))
  }

  // IM 目录加载:目录来自 dsh-im 已保存目标;失败(离线/ID 复制错误)如实展示错误码
  async function loadImTargets(botIdOverride) {
    const botId = (typeof botIdOverride === 'string' ? botIdOverride : imBotIdDraft).trim()
    if (botId.length === 0) {
      notify('请先粘贴 Bot ID(dsh-im 设置页 IM机器人 卡片)', 'error')
      return
    }
    setImBusy(true)
    try {
      const res = await api('/api/usage-panel/im-targets?botId=' + encodeURIComponent(botId))
      const loaded = Array.isArray(res && res.targets) ? res.targets : []
      setImCatalog({ botId, targets: loaded })
      notify('已加载 ' + loaded.length + ' 个目标,勾选即保存', 'ok')
    } catch (err) {
      notify('加载失败:' + (err && err.message ? err.message : String(err)), 'error')
    } finally { setImBusy(false) }
  }

  // 勾选即存:整体替换 imTargets,序列号防连续操作竞态,只 POST {imTargets} 不触碰其他配置;
  // 序列号驻 useRef 跨渲染保持,失败回填权威配置收敛 UI 与服务端(过期回填按序列号丢弃)
  const imPersistSeq = useRef(0)
  function persistImTargets(next, okMessage) {
    const seq = ++imPersistSeq.current
    setConfig((prev) => ({ ...prev, imTargets: next }))
    api('/api/usage-panel/notify-config', { method: 'POST', body: JSON.stringify({ imTargets: next }) })
      .then((res) => {
        if (seq !== imPersistSeq.current) return
        if (res && res.notify) setConfig(res.notify)
        if (okMessage !== undefined) notify(okMessage, 'ok')
      })
      .catch((err) => {
        notify('IM 目标保存失败:' + (err && err.message ? err.message : String(err)), 'error')
        api('/api/usage-panel/notify-config')
          .then((res) => { if (seq === imPersistSeq.current && res && res.notify) setConfig(res.notify) })
          .catch(() => {})
      })
  }
  function toggleImTarget(botId, target, checked) {
    persistImTargets(toggleImTargetList(config.imTargets || [], botId, target.targetId, checked))
  }
  function removeImTarget(item) {
    persistImTargets(removeImTargetFromList(config.imTargets || [], item.botId, item.targetId))
  }
  // 取消注册:移除该 bot 全部目标;bot 在 dsh-im 已删除时借此清理残留绑定
  function unregisterImBot(botId) {
    persistImTargets(unregisterImBotList(config.imTargets || [], botId), '已取消注册 ' + botId)
  }

  if (config === null) {
    return h('div', { className: 'up-card' },
      h('div', { className: 'up-card__row' }, h('span', { className: 'up-card__name' }, '通知规则'), h('span', { className: 'up-meta' }, '加载中…')))
  }
  const targets = Array.isArray(config.imTargets) ? config.imTargets : []
  const boundBots = imBoundBotIds(targets)
  // webhookUrl 属服务端 secret:配置态只回显 boolean;输入框是待保存草稿,留空表示不改
  const webhookView = notifyConfigView(config)
  const webhookConfigured = webhookView.configured
  const webhookDirty = webhookUrl.trim().length > 0
  // 通知配置一次即久,默认折叠:summary 摘要行常显状态,展开才是完整配置
  return h('details', { className: 'up-card up-fold' },
    h('summary', { className: 'up-fold__summary' },
      h('span', { className: 'up-card__name' }, '通知规则'),
      h('span', { className: 'up-dot' + (config.enabled === true ? '' : ' up-dot--off') }),
      h('span', { className: 'up-meta' }, config.enabled === true ? '已启用' : '已关闭'),
      targets.length > 0 ? h('span', { className: 'up-meta' }, targets.length + ' 个 IM 目标') : null,
      webhookConfigured ? h('span', { className: 'up-meta' }, 'webhook 已配置') : null,
    ),
    h('div', { className: 'up-card__row' },
      h(Switch, {
        checked: config.enabled === true,
        label: '启用通知',
        title: '越过用量/余额阈值或窗口重置时推送;关闭后刷新仅更新读数,不产生任何推送',
        onChange: (checked) => patch({ enabled: checked }),
      }),
    ),
    // 阈值分区
    h('div', { className: 'up-section' },
      h('span', { className: 'up-section__title' }, '阈值'),
      h('div', { className: 'up-card__row' },
        h('span', { className: 'up-field__label', title: '任一窗口用量达到该百分比时通知' }, '用量阈值(%)'),
        h('span', { className: 'up-field' },
          h('input', {
            type: 'number', min: 1, max: 100, style: { width: '70px' },
            value: quotaPct !== '' ? quotaPct : '',
            onChange: (e) => setQuotaPct(e.target.value),
            placeholder: config.quotaThresholdPct === undefined ? '' : String(config.quotaThresholdPct),
          })),
        h('span', { className: 'up-field__label', title: '可用余额低于该值时通知;留空不启用' }, '余额阈值'),
        h('span', { className: 'up-field' },
          h('input', {
            type: 'number', min: 0, style: { width: '90px' },
            value: balanceThreshold !== '' ? balanceThreshold : '',
            onChange: (e) => setBalanceThreshold(e.target.value),
            placeholder: '如 20',
          })),
        h('button', { className: 'up-btn up-btn--primary', onClick: saveThresholds }, '保存阈值'),
        config.balanceThreshold === null || config.balanceThreshold === undefined
          ? null
          : h('button', { className: 'up-btn up-btn--danger', onClick: () => patch({ balanceThreshold: null }) }, '清除余额阈值'),
      ),
      h(Switch, {
        checked: config.resetNotice !== false,
        label: '窗口重置通知',
        title: '用量窗口轮转时,通知上一窗口的峰值用量',
        onChange: (checked) => patch({ resetNotice: checked }),
      }),
    ),
    // 通道分区
    h('div', { className: 'up-section' },
      h('span', { className: 'up-section__title' }, '推送通道'),
      h(Switch, {
        checked: config.toast !== false,
        label: '页内 toast',
        title: '浏览器页内弹窗提醒',
        onChange: (checked) => patch({ toast: checked }),
      }),
      h('div', { className: 'up-card__row' },
        h('span', { className: 'up-field__label', title: 'host 直发的 Slack 兼容 JSON 通知;已配置地址不回显,输入新地址保存后自动发送测试' }, 'Webhook'),
        webhookConfigured ? h('span', { className: 'up-dot', title: '已配置' }) : null,
        h('span', { className: 'up-field' },
          h('input', {
            type: 'text', style: { width: '260px' },
            value: webhookUrl,
            onChange: (e) => setWebhookUrl(e.target.value),
            placeholder: webhookView.placeholder,
          })),
        h('button', {
          className: 'up-btn',
          onClick: () => {
            if (!webhookDirty) {
              if (!webhookConfigured) { notify('请先填写 webhook URL', 'error'); return }
              testWebhook()
              return
            }
            // 草稿为空不保存(=保持不变);清空已配置地址走显式「清除」按钮
            api('/api/usage-panel/notify-config', { method: 'POST', body: JSON.stringify({ webhookUrl: webhookUrl.trim() }) })
              .then((res) => {
                if (res && res.notify) setConfig(res.notify)
                setWebhookUrl('')
                notify('通知配置已保存', 'ok')
                testWebhook()
              })
              .catch(fail)
          },
        }, webhookDirty ? '保存并测试' : '测试'),
        webhookConfigured ? h('button', {
          className: 'up-btn up-btn--danger',
          onClick: () => {
            api('/api/usage-panel/notify-config', { method: 'POST', body: JSON.stringify({ webhookUrl: '' }) })
              .then((res) => {
                if (res && res.notify) setConfig(res.notify)
                setWebhookUrl('')
                notify('webhook 已禁用', 'ok')
              })
              .catch(fail)
          },
        }, '清除') : null,
      ),
      // IM 通道:目标来自 dsh-im 已保存目录,勾选即自动保存;新建与平台测试在 dsh-im 设置页完成
      imAvailable ? null : h('span', { className: 'up-meta' }, 'dsh-im 未安装,IM 通道不可用'),
      imAvailable ? h('div', { className: 'up-section' },
        h('div', { className: 'up-card__row' },
          h('span', { className: 'up-field__label', title: '经 dsh-im 推送到微信等渠道;目标在其设置页创建,此处勾选绑定' }, 'IM 投递'),
          h('span', { className: 'up-spacer' }),
          h('button', { className: 'up-btn', disabled: imBusy || targets.length === 0, onClick: testIm }, '测试 IM'),
        ),
        h('div', { className: 'up-card__row' },
          h('span', { className: 'up-field' },
            h('input', {
              value: imBotIdDraft,
              onChange: (e) => setImBotIdDraft(e.target.value),
              placeholder: '粘贴 Bot ID',
              title: '从 dsh-im 设置页「IM机器人」卡片复制 Bot ID,加载其已保存的投递目标目录',
              style: { width: '240px' },
            })),
          h('button', { className: 'up-btn', disabled: imBusy, title: '拉取该 bot 在 dsh-im 已保存的投递目标,勾选即保存', onClick: () => void loadImTargets() }, '加载目标'),
        ),
        boundBots.length > 0 ? h('div', { className: 'up-card__row' },
          h('span', { className: 'up-field__label' }, '已绑 bot'),
          boundBots.map((botId) => h('span', { className: 'up-chip', key: botId },
            h('button', {
              className: 'up-chip__name'
                + (imCatalog !== null && imCatalog.botId === botId ? ' up-chip__name--active' : ''),
              disabled: imBusy,
              onClick: () => { setImBotIdDraft(botId); void loadImTargets(botId) },
            }, botId),
            h('button', {
              className: 'up-chip__x', disabled: imBusy, title: '取消注册(移除该 bot 全部目标)',
              onClick: () => unregisterImBot(botId),
            }, '×'),
          )),
        ) : null,
        imCatalog !== null
          ? imCatalog.targets.length === 0
            ? h('span', { className: 'up-meta' }, '该 bot 尚无已保存投递目标,先在 dsh-im 设置页新建并测试')
            : h('div', { className: 'up-list' },
                imCatalog.targets.map((target) => {
                  const checked = targets.some((item) => item.botId === imCatalog.botId && item.targetId === target.targetId)
                  return h(Switch, {
                    key: target.targetId,
                    className: 'up-list__item',
                    checked,
                    onChange: (next) => toggleImTarget(imCatalog.botId, target, next),
                  },
                  h('span', { className: 'up-list__grow' },
                    target.targetId + (target.name ? ' (' + target.name + ')' : '')),
                  h('span', { className: 'up-list__tag' }, target.kind || ''),
                  )
                }),
              )
          : null,
        targets.length === 0
          ? h('span', { className: 'up-meta' }, '尚未绑定投递目标,通知不会推送 IM')
          : h('div', { className: 'up-list' },
              targets.map((item) => h('div', { className: 'up-list__item', key: imTargetKey(item) },
                h('span', { className: 'up-list__grow' }, item.targetId),
                h('span', { className: 'up-list__tag' }, item.botId),
                h('button', {
                  className: 'up-btn', disabled: imBusy, onClick: () => removeImTarget(item),
                }, '移除'),
              )),
            ),
      ) : null,
    ),
    error !== null ? h('div', { className: 'up-notice up-notice--error' }, error) : null,
  )
}

function OverviewBar(props) {
  const overview = buildOverview(props.accounts)
  const now = Date.now()
  const balanceText = overview.balances.length === 0
    ? '—'
    : overview.balances.map((item) => {
        const symbol = Object.prototype.hasOwnProperty.call(TREND_CURRENCY_SYMBOLS, item.currency)
          ? TREND_CURRENCY_SYMBOLS[item.currency]
          : item.currency + ' '
        return symbol + item.value.toFixed(2)
      }).join(' · ')
  const statusParts = ['正常 ' + overview.ok]
  if (overview.error > 0) statusParts.push('失败 ' + overview.error)
  if (overview.never > 0) statusParts.push('未查询 ' + overview.never)
  const stat = (label, value, sub, title) => h('div', { className: 'up-stat', title: title || undefined },
    h('span', { className: 'up-stat__label' }, label),
    h('span', { className: 'up-stat__value' }, value),
    sub ? h('span', { className: 'up-stat__sub' }, sub) : null,
  )
  return h('div', { className: 'up-overview' },
    stat('账号状态', overview.ok + '/' + overview.total, statusParts.join(' · ')),
    stat('余额合计', balanceText, '按当前读数', balanceText),
    stat('额度最高', overview.topQuota === null ? '—' : fmtPct(overview.topQuota.utilization),
      overview.topQuota === null ? '无额度账号' : overview.topQuota.accountName + ' · ' + overview.topQuota.label,
      overview.topQuota === null ? undefined : overview.topQuota.accountName + ' · ' + overview.topQuota.label),
    stat('最近查询', overview.lastUpdated === null ? '—' : formatAgo(now, overview.lastUpdated),
      overview.lastUpdated === null ? '暂无数据' : fmtTime(overview.lastUpdated)),
  )
}

function UsagePanelApp() {
  const [accounts, setAccounts] = useState(null)
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState({})
  // 加载失败占位:与「读取失败/加载中」占位文案联动;操作反馈不经此状态
  const [notice, setNotice] = useState(null)
  const [armed, setArmed] = useState(null)
  const [sequences, setSequences] = useState({})
  const [pollArmed, setPollArmed] = useState(null)
  // 账号表修订号:保存时随请求带上,服务端不一致即 409,避免旧窗口整表覆盖
  const revisionRef = useRef(null)
  // 最新账号快照:对账时按 queriedAt 差异只重拉变化账号的历史序列
  const accountsRef = useRef(null)

  function sequencesOfAccount(previous, id) {
    const next = { ...previous }
    const prefix = id + ':'
    for (const key of Object.keys(next)) if (key.indexOf(prefix) === 0) delete next[key]
    return next
  }

  // 按账号合并历史补丁:先删该账号旧序列再写入新值(账号删除场景同样适用)
  function mergeSequences(previous, patch, ids) {
    let next = previous
    for (const id of ids) next = sequencesOfAccount(next, id)
    for (const [key, value] of Object.entries(patch || {})) next[key] = value
    return next
  }

  const historyPath = (ids) => '/api/usage-panel/history?accountIds=' + encodeURIComponent(ids.join(','))

  useEffect(() => {
    let alive = true
    let knownRevision = null
    // 历史装载闸门:初始快照与 resync 谁先落地都不丢数据,装载完成与否只在
    // 真正应用过一次全量历史后置位(不能按「已发起」置位,失败/空转会把门关死)
    const historySync = createHistorySync()
    api('/api/usage-panel/accounts')
      .then((res) => {
        if (!alive) return null
        // 首个账号响应可能晚于一次 resync:旧 revision 不得覆盖较新的对账快照
        if (typeof res.revision === 'number' && typeof revisionRef.current === 'number' && res.revision < revisionRef.current) return null
        const list = res && res.accounts ? res.accounts : []
        setAccounts(list)
        accountsRef.current = list
        if (typeof res.revision === 'number') {
          revisionRef.current = res.revision
          // 首事件对账基线取自首次账号快照;事件早于本响应到达时 knownRevision 仍为 null,
          // resync 会无条件重拉,不会吞掉首个变更
          if (knownRevision === null) knownRevision = res.revision
        }
        // 即时性兜底:无缓存读数的账号触发一次自动查询(受 host 退避约束)
        list.filter((item) => !item.last).forEach((item) => {
          api('/api/usage-panel/query', { method: 'POST', body: JSON.stringify({ id: item.id, auto: true }) })
            .then((r) => { if (r && r.account) replaceAccount(r.account) })
            .catch(() => {})
        })
        return null
      })
      .catch((error) => {
        if (alive) setNotice('读取配置失败:' + (error && error.message ? error.message : String(error)))
      })
    api('/api/usage-panel/history')
      .then((res) => {
        if (!alive || !historySync.acceptsInitialSnapshot()) return
        setSequences(res && res.sequences ? res.sequences : {})
        historySync.markApplied(true)
      })
      .catch(() => {})
    api('/api/usage-panel/settings')
      .then((res) => {
        if (!alive) return
        setPollArmed(res ? Boolean(res.pollArmed) : null)
      })
      .catch(() => {})

    // 服务端数据对账(F31):账号/历史持久化经总线广播桥转 window 事件,
    // 面板收到即单飞重拉;窗口聚焦同样对账(兜底错过的广播)。历史只重拉
    // queriedAt 变化的账号,避免每次变更整表(20 账号约 6 万点)重传
    const resyncOnce = () =>
      api('/api/usage-panel/revision')
        .then((res) => {
          if (!alive || !res || typeof res.revision !== 'number') return null
          const changed = knownRevision === null || res.revision !== knownRevision
          knownRevision = res.revision
          // 历史未装载时修订号未变也要补拉:初始快照请求可能已失败或仍在途
          if (!historySync.needsLoad(changed)) return null
          return api('/api/usage-panel/accounts').then((accountsRes) => {
            if (!alive) return null
            const nextAccounts = accountsRes && Array.isArray(accountsRes.accounts) ? accountsRes.accounts : []
            const previousAccounts = accountsRef.current || []
            const previousById = new Map(previousAccounts.map((item) => [item.id, item]))
            const nextIds = new Set(nextAccounts.map((item) => item.id))
            const removedIds = previousAccounts.map((item) => item.id).filter((id) => !nextIds.has(id))
            const changedIds = nextAccounts
              .filter((item) => {
                const previous = previousById.get(item.id)
                const before = previous && previous.last ? previous.last.queriedAt : null
                const after = item.last ? item.last.queriedAt : null
                return previous !== undefined && before !== after
              })
              .map((item) => item.id)
            setAccounts(nextAccounts)
            accountsRef.current = nextAccounts
            if (accountsRes && typeof accountsRes.revision === 'number') revisionRef.current = accountsRes.revision
            if (removedIds.length > 0) setSequences((prev) => removedIds.reduce(sequencesOfAccount, prev))
            // 未装载过全量历史时无法按 queriedAt 只拉增量(本地没有基线),取全账号;
            // 之后只拉 queriedAt 变化的账号,避免每次变更整表重传
            const fullSnapshot = historySync.wantsFullSnapshot()
            const historyIds = fullSnapshot ? nextAccounts.map((item) => item.id) : changedIds
            if (historyIds.length === 0) return null
            return api(historyPath(historyIds)).then((historyRes) => {
              if (alive && historyRes && historyRes.sequences) {
                setSequences((prev) => mergeSequences(prev, historyRes.sequences, historyIds))
                historySync.markApplied(fullSnapshot)
              }
              return null
            })
          })
        })
        .catch(() => {})
    const resyncGate = createTrailingSingleFlight(resyncOnce)
    const onDataChanged = () => resyncGate.trigger()
    const onFocus = () => resyncGate.trigger()
    window.addEventListener('up-data-changed', onDataChanged)
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      resyncGate.dispose()
      window.removeEventListener('up-data-changed', onDataChanged)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // 确认态超时复位:确认只对上一步点击有效,停在确认态不因时间无限期保留
  useEffect(() => {
    if (armed === null) return undefined
    return scheduleDeleteArmReset(() => setArmed(null))
  }, [armed])

  // 被武装账号已不在表内(其它窗口删除/重载):确认态随之失效
  useEffect(() => {
    if (armed === null || accounts === null) return undefined
    if (accounts.some((item) => item.id === armed)) return undefined
    setArmed(null)
    return undefined
  }, [accounts, armed])

  // 任一其它交互复位确认态
  function disarmDelete() {
    setArmed(null)
  }

  function refreshSequences() {
    return api('/api/usage-panel/history')
      .then((res) => { setSequences(res && res.sequences ? res.sequences : {}) })
  }

  function markBusy(id, value) {
    setBusy((prev) => Object.assign({}, prev, { [id]: value }))
  }

  function replaceAccount(nextAccount) {
    const next = (accountsRef.current || []).map((item) => (item.id === nextAccount.id ? nextAccount : item))
    accountsRef.current = next
    setAccounts(next)
  }

  function refreshOne(id) {
    disarmDelete()
    markBusy(id, true)
    return api('/api/usage-panel/query', { method: 'POST', body: JSON.stringify({ id }) })
      .then((res) => {
        if (res && res.account) replaceAccount(res.account)
        // 只重拉本账号序列(过滤参数),不因单卡刷新整表重传
        return api(historyPath([id]))
      })
      .then((res) => { setSequences((prev) => mergeSequences(prev, res && res.sequences, [id])) })
      .catch((error) => {
        notify('查询失败:' + (error && error.message ? error.message : String(error)), 'error')
      })
      .then(() => markBusy(id, false))
  }

  function refreshAll() {
    if (!accounts) return
    disarmDelete()
    const ids = accounts.map((item) => item.id)
    ids.forEach((id) => markBusy(id, true))
    // 批量查询后单次拉取 history,不做每账号一次 history GET
    Promise.all(ids.map((id) =>
      api('/api/usage-panel/query', { method: 'POST', body: JSON.stringify({ id }) })
        .then((res) => { if (res && res.account) replaceAccount(res.account) })
        .catch((error) => {
          notify('查询失败:' + (error && error.message ? error.message : String(error)), 'error')
        })
    ))
      .then(refreshSequences)
      .catch(() => {})
      .then(() => ids.forEach((id) => markBusy(id, false)))
  }

  function reloadAccounts() {
    disarmDelete()
    return Promise.all([api('/api/usage-panel/accounts'), api('/api/usage-panel/history')])
      .then(([accountsRes, historyRes]) => {
        if (accountsRes && accountsRes.accounts) {
          accountsRef.current = accountsRes.accounts
          setAccounts(accountsRes.accounts)
        }
        if (accountsRes && typeof accountsRes.revision === 'number') revisionRef.current = accountsRes.revision
        if (historyRes && historyRes.sequences) setSequences(historyRes.sequences)
      })
  }

  function saveAccounts(nextAccounts) {
    // 保存(cancel 经表单回调同等)也算其它交互:确认态不得跨保存残留
    disarmDelete()
    const payload = { accounts: nextAccounts }
    if (typeof revisionRef.current === 'number') payload.revision = revisionRef.current
    return api('/api/usage-panel/accounts', { method: 'POST', body: JSON.stringify(payload) })
      .then((res) => {
        const list = res && res.accounts ? res.accounts : nextAccounts
        accountsRef.current = list
        setAccounts(list)
        if (res && typeof res.revision === 'number') revisionRef.current = res.revision
        setEditing(null)
        // 账号已保存但历史清理失败时如实告警,不显示「已保存成功」掩盖磁盘残留
        if (res && res.historyWarning) notify('配置已保存,但历史清理失败:' + res.historyWarning, 'error')
        else notify('配置已保存', 'ok')
      })
      .catch((error) => {
        if (error && error.status === 409) {
          setEditing(null)
          notify('配置已被其他窗口修改,已重新加载,请重试', 'error')
          return reloadAccounts().catch(() => {})
        }
        notify('保存失败:' + (error && error.message ? error.message : String(error)), 'error')
      })
  }

  function onDelete(account) {
    if (deleteArmAction(armed, account.id) === 'arm') {
      setArmed(account.id)
      return
    }
    setArmed(null)
    saveAccounts(accounts.filter((item) => item.id !== account.id))
  }

  if (accounts === null) {
    return h('div', { className: 'up-panel' },
      h('style', { 'data-plugin': '@mzzsfy/dsh-usage-panel', dangerouslySetInnerHTML: { __html: CSS } }),
      h('span', { className: 'up-meta' }, notice !== null ? '读取失败' : '加载中…'),
      notice !== null ? h('div', { className: 'up-notice up-notice--error' }, notice) : null)
  }

  const cards = accounts.map((account) => {
    const prefix = account.id + ':'
    const own = {}
    for (const key of Object.keys(sequences)) {
      if (key.indexOf(prefix) === 0) own[key.slice(prefix.length)] = sequences[key]
    }
    return h(AccountCard, {
      key: account.id,
      account,
      sequences: own,
      busy: busy[account.id] === true,
      deleteArmed: armed === account.id,
      onRefresh: () => refreshOne(account.id),
      onEdit: () => { disarmDelete(); setEditing(account) },
      onDelete: () => onDelete(account),
    })
  })

  const anyBusy = Object.keys(busy).some((id) => busy[id] === true)

  return h('div', { className: 'up-panel' },
    h('style', { 'data-plugin': '@mzzsfy/dsh-usage-panel', dangerouslySetInnerHTML: { __html: CSS } }),
    h('div', { className: 'up-head' },
      h('span', { className: 'up-head__title' }, '账号详情'),
      h('span', { className: 'up-spacer' }),
      h('button', { className: 'up-btn', title: '手动查询全部账号并更新读数', disabled: anyBusy || accounts.length === 0, onClick: refreshAll }, '全部刷新'),
      h('button', { className: 'up-btn up-btn--primary', onClick: () => { disarmDelete(); setEditing({ isNew: true, id: null }) } }, '添加账号'),
    ),
    pollArmed === false ? h('div', { className: 'up-notice up-notice--error' },
      '自动轮询未运行(宿主定时服务不可用);手动查询不受影响。') : null,
    accounts.length > 0 ? h(OverviewBar, { accounts }) : null,
    h(NotifyConfigCard),
    editing !== null
      ? h(AccountForm, {
          key: editing.id || 'new',
          initial: editing.isNew ? null : editing,
          onCancel: () => setEditing(null),
          onSave: (built) => {
            saveAccounts(accounts.filter((item) => item.id !== built.id).concat([built]))
          },
        })
      : null,
    cards.length === 0 && editing === null
      ? h('div', { className: 'up-card up-empty' },
          h('div', null, '还没有账号'),
          h('div', { className: 'up-empty__hint' }, '添加账号后在这里查看余额、额度与趋势。'),
          h('button', { className: 'up-btn up-btn--primary', onClick: () => { disarmDelete(); setEditing({ isNew: true, id: null }) } }, '添加账号'))
      : null,
    cards,
  )
}

    return {
      inject: ['slots'],
      apply(ctx) {
        const bus = tools.setupCommonTools(ctx)
        ctx.effect(() => startNotifications(bus), 'usage-panel notifications')
        // 数据失效广播桥(F31):服务端账号/历史持久化经总线发布变更,
        // 桥转 window 事件供面板组件对账(组件树无总线句柄)
        ctx.effect(() => bus.subscribe(() => {
          window.dispatchEvent(new CustomEvent('up-data-changed'))
        }, {}), 'usage-panel data-changed bridge')
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'usage-panel', order: 40, label: '账号余额' },
            () => React.createElement(UsagePanelApp),
          ))
      },
    }
  },
})
