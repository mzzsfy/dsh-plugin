// 用量统计面板 client 半区:设置页 settings.section 注入,阶段 1 基础面板。
// 无构建:createElement + 一次性样式注入;协议与渲染形态见 docs/feat-usage-dash/client-design.md。
import {
  API_PREFIX,
  CHART_HEIGHT,
  CHART_PAD,
  DAY_MAX_SLOTS,
  DAY_PRESETS,
  DEFAULT_HOUR_PRESET,
  DEFAULT_MINUTE_PRESET,
  DEFAULT_RANGE,
  ENDPOINTS,
  GROUP_TOP_COUNT,
  HOUR_PRESETS,
  MINUTE_PRESETS,
  OTHER_MODEL,
  cacheRateText,
  dayBucket,
  formatCompact,
  formatTokens,
  groupPointSlots,
  groupStats,
  hourTickLabel,
  isEmptyRange,
  maxSlotsFor,
  minuteTickLabel,
  modelNameOf,
  parseEnvelope,
  providerOf,
  resolveDayRange,
  resolveHourRange,
  resolveMinuteRange,
  shortDay,
  t,
  trimSlots,
  trendLayout,
} from './client-core.js'

if (typeof __ModuleLoader__ !== 'undefined') {
  __ModuleLoader__.load({ id: 'usage-dash', factory })

  function factory(require) {
    let React = null
    try {
      React = require('react')
    } catch {
      return { inject: [], apply() {} }
    }
    const { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } = React

    const h = (type, props, ...children) => React.createElement(type, props ?? null, ...children)
    const cx = (...values) => values.filter(Boolean).join(' ')

    // 交互与尺寸常量
    const STATUS_POLL_FAST_MS = 1000
    const STATUS_POLL_SLOW_MS = 5000
    const REBUILD_CONFIRM_MS = 3000
    const STATUS_REFRESH_DEBOUNCE_MS = 800
    const FIT_MAX_SIZE = 22
    const FIT_MIN_SIZE = 11
    const FIT_STEP_SIZE = 0.5
    const FIT_OVERFLOW_TOLERANCE = 1
    const CHART_NOMINAL_WIDTH = 720
    const CHART_WIDTH_EPSILON = 1
    const CHART_BUSY_OPACITY = 0.5
    const LABEL_PITCH_DAY = 46
    const LABEL_PITCH_TIME = 60
    const AXIS_LABEL_GAP = 6
    const AXIS_LABEL_BASELINE = 3
    const X_LABEL_OFFSET = 8
    const PROGRESS_FULL_PERCENT = 100
    const ICON_SIZE = 14
    const ICON_STROKE_WIDTH = 2
    const NOTE_SEPARATOR = ' · '
    const STYLE_ID = 'dsh-usage-dash'
    const DAY_PRESET_LABELS = {
      '7': t('rangePreset.7'),
      '14': t('rangePreset.14'),
      '30': t('rangePreset.30'),
      '90': t('rangePreset.90'),
    }
    const VIEW_TABS = [
      { id: 'day', labelKey: 'viewDay' },
      { id: 'hour', labelKey: 'viewHour' },
      { id: 'minute', labelKey: 'viewMinute' },
    ]

    const requestPost = async (endpoint, body) => {
      let response
      try {
        response = await fetch(API_PREFIX + endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? '{}' : JSON.stringify(body),
        })
      } catch (error) {
        return { ok: false, code: 'network', message: String(error?.message ?? error) }
      }
      let json = null
      try {
        json = await response.json()
      } catch {
        json = null
      }
      return parseEnvelope(json)
    }

    // lucide 同风格简笔图标(纯装饰)
    const ICONS = {
      coins: ['M15.5 9.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z', 'M20.5 13.5a5.5 5.5 0 1 1-7 7'],
      sessions: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z'],
      requests: ['M14 9a2 2 0 0 1-2 2H6l-3 3V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2Z', 'M17 7h2a2 2 0 0 1 2 2v10l-3-3h-5'],
      model: ['M5 5h14v14H5Z', 'M9 9h6v6H9Z', 'M9 2v3', 'M15 2v3', 'M9 19v3', 'M15 19v3', 'M2 9h3', 'M2 15h3', 'M19 9h3', 'M19 15h3'],
      rate: ['M22 12h-4l-3 9L9 3l-3 9H2'],
      days: ['M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z', 'M16 3v4', 'M8 3v4', 'M3 11h18'],
    }

    function Icon({ paths }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: ICON_SIZE, height: ICON_SIZE, fill: 'none',
        stroke: 'currentColor', strokeWidth: ICON_STROKE_WIDTH,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, paths.map((d, index) => h('path', { key: index, d })))
    }

    const STYLE_CSS = `
.ud-panel{display:flex;flex-direction:column;gap:16px;font-size:13px;color:var(--dsw-alias-label-primary);
--ud-chart-1:color-mix(in srgb,#0576ff 70%,white);--ud-chart-2:color-mix(in srgb,#2f6f37 70%,white);--ud-chart-3:color-mix(in srgb,#c46212 70%,white);--ud-chart-4:color-mix(in srgb,#975bf1 70%,white);--ud-chart-5:color-mix(in srgb,#d34591 70%,white);--ud-chart-other:color-mix(in srgb,#576270 70%,white)}
body[data-ds-dark-theme] .ud-panel{--ud-chart-1:color-mix(in srgb,#0576ff 65%,white);--ud-chart-2:color-mix(in srgb,#2f6f37 65%,white);--ud-chart-3:color-mix(in srgb,#c46212 65%,white);--ud-chart-4:color-mix(in srgb,#975bf1 65%,white);--ud-chart-5:color-mix(in srgb,#d34591 65%,white);--ud-chart-other:color-mix(in srgb,#576270 65%,white)}
.ud-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ud-group{display:flex;align-items:center;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.ud-seg-item{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;padding:5px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}
.ud-seg-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ud-seg-item--on{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.ud-custom-range{display:flex;align-items:center;gap:6px}
.ud-date-input{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:4px 6px}
.ud-custom-sep{color:var(--dsw-alias-label-tertiary)}
.ud-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:5px 14px;font-size:12px;line-height:1;cursor:pointer}
.ud-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ud-btn:disabled{opacity:.5;cursor:default}
.ud-refresh{margin-left:auto}
.ud-btn--text{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);padding:2px 4px}
.ud-error{border:1px solid var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-label);border-radius:8px;padding:8px 12px;font-size:12px}
.ud-loading{color:var(--dsw-alias-label-tertiary);text-align:center;padding:32px 0}
.ud-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-tertiary);text-align:center;padding:24px 16px;font-size:12px}
.ud-foot{color:var(--dsw-alias-label-tertiary);font-size:11px}
.ud-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ud-status-track{display:inline-block;width:120px;height:2px;border-radius:1px;background:var(--dsw-alias-border-l1);overflow:hidden}
.ud-status-fill{display:block;height:100%;background:var(--dsw-alias-state-business-primary)}
.ud-status-err{color:var(--dsw-alias-state-error-primary)}
.ud-cards{display:grid;grid-template-columns:1.35fr 1fr 1fr;gap:10px}
@media (max-width:560px){.ud-cards{grid-template-columns:1fr 1fr}}
@media (max-width:380px){.ud-cards{grid-template-columns:1fr}}
.ud-card{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;min-width:0}
.ud-card-head{display:flex;align-items:center;gap:6px}
.ud-card-icon{display:inline-flex;color:var(--dsw-alias-label-tertiary)}
.ud-card-label{font-size:13px;color:var(--dsw-alias-label-secondary)}
.ud-card-value{font-size:${FIT_MAX_SIZE}px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.ud-card-lines{display:flex;flex-direction:column;gap:2px;min-width:0}
.ud-card-name{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ud-card-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ud-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.ud-section-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.ud-section-title{font-size:15px;font-weight:600}
.ud-trend-note{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ud-chart-wrap{width:100%;min-width:0}
.ud-chart{display:block;width:100%}
.ud-grid{stroke:var(--dsw-alias-border-l1);stroke-width:1}
.ud-axis{fill:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.ud-legend{display:flex;flex-wrap:wrap;gap:4px 12px}
.ud-legend-item{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0}
.ud-legend-item span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ud-legend-swatch{width:8px;height:8px;border-radius:2px;flex:none}
`

    function ensureStyle(document) {
      if (document.querySelector(`style[data-plugin="${STYLE_ID}"]`)) return
      const element = document.createElement('style')
      element.setAttribute('data-plugin', STYLE_ID)
      element.textContent = STYLE_CSS
      document.head.appendChild(element)
    }

    const fitFontSize = (element) => {
      let size = FIT_MAX_SIZE
      element.style.fontSize = `${size}px`
      while (element.scrollWidth > element.clientWidth + FIT_OVERFLOW_TOLERANCE && size > FIT_MIN_SIZE) {
        size -= FIT_STEP_SIZE
        element.style.fontSize = `${size}px`
      }
    }

    function FitText({ children }) {
      const ref = useRef(null)
      useLayoutEffect(() => {
        fitFontSize(ref.current)
      }, [children])
      useEffect(() => {
        const element = ref.current
        let lastWidth = element.clientWidth
        const observer = new ResizeObserver(() => {
          const width = element.clientWidth
          if (width === lastWidth) return
          lastWidth = width
          fitFontSize(element)
        })
        observer.observe(element)
        return () => observer.disconnect()
      }, [])
      return h('div', { className: 'ud-card-value', ref }, children)
    }

    function Card({ icon, label, hint, children }) {
      return h('div', { className: 'ud-card', title: hint },
        h('div', { className: 'ud-card-head' },
          h('span', { className: 'ud-card-icon' }, h(Icon, { paths: icon })),
          h('span', { className: 'ud-card-label' }, label)),
        ...children)
    }

    function StatCards({ stats }) {
      return h('div', { className: 'ud-cards' },
        h(Card, { key: 'tokens', icon: ICONS.coins, label: t('tokens'), hint: t('tokensHint') },
          h(FitText, null, formatTokens(stats.tokens))),
        h(Card, { key: 'turns', icon: ICONS.sessions, label: t('sessions') },
          h(FitText, null, String(stats.turns))),
        h(Card, { key: 'requests', icon: ICONS.requests, label: t('requests') },
          h(FitText, null, String(stats.requests))),
        h(Card, { key: 'model', icon: ICONS.model, label: t('topModel'), hint: t('topModelHint') },
          stats.topModel
            ? h('div', { className: 'ud-card-lines' },
                h('span', { className: 'ud-card-name' }, modelNameOf(stats.topModel)),
                h('span', { className: 'ud-card-sub' }, providerOf(stats.topModel)))
            : h('div', { className: 'ud-card-value' }, '—')),
        h(Card, { key: 'cache', icon: ICONS.rate, label: t('cacheRate'), hint: t('cacheRateHint') },
          h(FitText, null, cacheRateText(stats.cacheHit, stats.cacheMiss)),
          h('span', { className: 'ud-card-sub' }, `${formatCompact(stats.cacheHit)} ${t('cachedTokens')}`)),
        h(Card, { key: 'days', icon: ICONS.days, label: t('activeDays') },
          h(FitText, null, String(stats.activeDays))))
    }

    function Legend({ models, colorFor }) {
      return h('div', { className: 'ud-legend' },
        models.map((item) => h('span', { key: item.model, className: 'ud-legend-item', title: item.model === OTHER_MODEL ? t('other') : item.model },
          h('i', { className: 'ud-legend-swatch', style: { background: colorFor(item.model) } }),
          h('span', null, item.model === OTHER_MODEL ? t('other') : item.model))))
    }

    const colorForModel = (models) => (model) => {
      if (model === OTHER_MODEL) return 'var(--ud-chart-other)'
      const slot = models.findIndex((item) => item.model === model)
      const rank = Math.min(slot < 0 ? 0 : slot, GROUP_TOP_COUNT - 1) + 1
      return `var(--ud-chart-${rank})`
    }

    function TrendChart({ title, notes, slots, modelOrder, colorFor, labelFor, labelMinPitch, busy, legendModels }) {
      const wrapRef = useRef(null)
      const [avail, setAvail] = useState(CHART_NOMINAL_WIDTH)
      useEffect(() => {
        const element = wrapRef.current
        const observer = new ResizeObserver((entries) => {
          const width = entries[0].contentRect.width
          setAvail((prev) => (Math.abs(prev - width) < CHART_WIDTH_EPSILON ? prev : width))
        })
        observer.observe(element)
        return () => observer.disconnect()
      }, [])
      const layout = trendLayout(slots, modelOrder, avail, labelMinPitch)
      const plotRight = CHART_PAD.left + (slots.length - 1) * layout.step + layout.barWidth
      return h('div', { className: 'ud-section' },
        h('div', { className: 'ud-section-head' },
          h('span', { className: 'ud-section-title' }, title),
          notes.length > 0 ? h('span', { className: 'ud-trend-note' }, notes.join(NOTE_SEPARATOR)) : null),
        h('div', { className: 'ud-chart-wrap', ref: wrapRef, style: busy ? { opacity: CHART_BUSY_OPACITY } : undefined },
          h('svg', { className: 'ud-chart', viewBox: `0 0 ${avail} ${CHART_HEIGHT}`, width: '100%', role: 'img', 'aria-label': title },
            layout.ticks.map((tick) => {
              const y = CHART_PAD.top + layout.plotHeight - (tick / layout.maxTotal) * layout.plotHeight
              return h('g', { key: tick },
                h('line', { className: 'ud-grid', x1: CHART_PAD.left, x2: plotRight, y1: y, y2: y }),
                h('text', { className: 'ud-axis', x: CHART_PAD.left - AXIS_LABEL_GAP, y: y + AXIS_LABEL_BASELINE, textAnchor: 'end' }, formatCompact(tick)))
            }),
            layout.bars.flatMap((bar) => bar.segments.map((segment) => h('rect', {
              key: `${bar.key}/${segment.model}`, className: 'ud-bar',
              x: bar.x - layout.barWidth / 2, y: segment.y, width: layout.barWidth, height: segment.height,
              fill: colorFor(segment.model),
            }))),
            slots.map((slot, index) => (index % layout.labelEvery === 0 || index === slots.length - 1)
              ? h('text', { key: slot.day, className: 'ud-axis', x: layout.bars[index].x, y: CHART_HEIGHT - X_LABEL_OFFSET, textAnchor: 'middle' }, labelFor(slot.day))
              : null))),
        h(Legend, { models: legendModels, colorFor }))
    }

    function StatusRow({ onChanged, onError }) {
      const [status, setStatus] = useState(null)
      const [armed, setArmed] = useState(false)
      const machineRef = useRef(null)
      const armedTimerRef = useRef(null)

      useEffect(() => {
        let timer = null
        let alive = true
        let baseDone = null
        const schedule = (delay) => {
          if (!alive) return
          if (timer) clearTimeout(timer)
          timer = setTimeout(tick, delay)
        }
        const tick = async () => {
          timer = null
          const result = await requestPost(ENDPOINTS.status)
          if (!alive) return
          if (!result.ok) {
            schedule(STATUS_POLL_SLOW_MS)
            return
          }
          const value = result.value
          setStatus(value)
          if (value.running) {
            if (baseDone === null || value.done < baseDone) baseDone = value.done
            else if (value.done > baseDone) {
              baseDone = value.done
              onChanged()
            }
            schedule(STATUS_POLL_FAST_MS)
          }
        }
        tick()
        machineRef.current = { restart: () => { baseDone = 0; schedule(STATUS_POLL_FAST_MS) } }
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
          machineRef.current = null
        }
      }, [])

      useEffect(() => () => {
        if (armedTimerRef.current) clearTimeout(armedTimerRef.current)
      }, [])

      const rebuild = async () => {
        if (!armed) {
          setArmed(true)
          armedTimerRef.current = setTimeout(() => setArmed(false), REBUILD_CONFIRM_MS)
          return
        }
        setArmed(false)
        const result = await requestPost(ENDPOINTS.reset)
        if (!result.ok) {
          onError(result.message)
          return
        }
        const value = result.value
        setStatus(value)
        if (value.running && machineRef.current) machineRef.current.restart()
      }

      const running = status?.running === true
      const progress = running && status.total > 0
        ? Math.min(PROGRESS_FULL_PERCENT, (status.done / status.total) * PROGRESS_FULL_PERCENT)
        : 0
      return h('div', { className: 'ud-status' },
        running
          ? h(React.Fragment, null,
              h('span', null, t('status.running', { done: status.done, total: status.total })),
              h('span', { className: 'ud-status-track' },
                h('span', { className: 'ud-status-fill', style: { width: `${progress}%` } })))
          : h('span', null, t('status.idle', { n: status?.scannedSessions ?? 0 })),
        status?.error ? h('span', { className: 'ud-status-err' }, status.error) : null,
        (status?.recordFailures ?? 0) > 0
          ? h('span', { className: 'ud-status-err' }, t('recordFailures', { n: status.recordFailures }))
          : null,
        h('button', { className: 'ud-btn ud-btn--text', disabled: running, onClick: rebuild },
          armed ? t('rebuildConfirm') : t('rebuild')))
    }

    const viewLabel = (id) => (id === 'day' ? t('viewDay') : id === 'hour' ? t('viewHour') : t('viewMinute'))
    const trendTitle = (id) => (id === 'day' ? t('dailyTrend') : id === 'hour' ? t('hourTrend') : t('minuteTrend'))
    const trendLimitedText = (id, count) => (id === 'day'
      ? t('trendLimited', { n: count })
      : id === 'hour' ? t('trendLimitedHour', { n: count }) : t('trendLimitedMinute', { n: count }))
    const presetLabel = (view, id) => (view === 'hour'
      ? t('hourPreset', { n: parseInt(id, 10) })
      : t('minutePreset', { n: parseInt(id, 10) }))
    const tickLabelFor = (view) => (view === 'day' ? shortDay : view === 'hour' ? hourTickLabel : minuteTickLabel)

    function UsageDashPanel() {
      const [view, setView] = useState('day')
      const [range, setRange] = useState(DEFAULT_RANGE)
      const [customFrom, setCustomFrom] = useState('')
      const [customTo, setCustomTo] = useState('')
      const [stats, setStats] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [hourPreset, setHourPreset] = useState(DEFAULT_HOUR_PRESET)
      const [minutePreset, setMinutePreset] = useState(DEFAULT_MINUTE_PRESET)
      const [pointStats, setPointStats] = useState(null)
      const [pointStatus, setPointStatus] = useState('idle')
      const [fetchTick, setFetchTick] = useState(0)
      const generationRef = useRef(0)
      const pointGenerationRef = useRef(0)

      const load = useCallback(async () => {
        const request = range === 'custom'
          ? { from: customFrom, to: customTo }
          : resolveDayRange(range, new Date())
        if (!request || !request.from || !request.to) return
        const generation = ++generationRef.current
        setLoading(true)
        const result = await requestPost(ENDPOINTS.range, request)
        if (generationRef.current !== generation) return
        setLoading(false)
        if (!result.ok) {
          setError(result.message)
          return
        }
        setError('')
        setStats(result.value)
      }, [range, customFrom, customTo])

      useEffect(() => {
        load()
      }, [load])

      const presetId = view === 'hour' ? hourPreset : view === 'minute' ? minutePreset : null

      useEffect(() => {
        if (view === 'day') return
        if (pointStats && pointStats.preset === presetId) return
        const request = view === 'hour'
          ? resolveHourRange(presetId, new Date())
          : resolveMinuteRange(presetId, new Date())
        const generation = ++pointGenerationRef.current
        setPointStatus('loading')
        requestPost(view === 'hour' ? ENDPOINTS.hours : ENDPOINTS.minutes, request).then((result) => {
          if (pointGenerationRef.current !== generation) return
          if (!result.ok) {
            setPointStatus('error')
            setError(result.message)
            return
          }
          setError('')
          setPointStatus('ok')
          setPointStats({ preset: presetId, value: result.value })
        })
      }, [view, presetId, fetchTick])

      const refreshPoints = useCallback(() => {
        setPointStats(null)
        setFetchTick((value) => value + 1)
      }, [])

      const refreshLatestRef = useRef(null)
      refreshLatestRef.current = () => {
        load()
        if (view !== 'day') refreshPoints()
      }
      const refreshTimerRef = useRef(null)
      const scheduleRefresh = useMemo(() => () => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = setTimeout(() => refreshLatestRef.current(), STATUS_REFRESH_DEBOUNCE_MS)
      }, [])
      useEffect(() => () => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      }, [])

      const refresh = () => {
        setError('')
        if (view === 'day') load()
        else refreshPoints()
      }

      const grouped = useMemo(() => (stats ? groupStats(stats) : null), [stats])
      const pointView = pointStats && pointStats.preset === presetId ? pointStats.value : null
      const pointGrouped = useMemo(() => (pointView ? groupPointSlots(pointView.daily) : null), [pointView])
      const colorFor = useMemo(() => colorForModel(stats ? stats.models : []), [stats])

      const pointActive = view !== 'day'
      const trendSource = pointActive
        ? (pointGrouped ? { slots: pointGrouped.daily, models: pointGrouped.models, value: pointView } : null)
        : (grouped ? { slots: grouped.daily, models: grouped.models, value: stats } : null)
      const maxSlots = pointActive ? maxSlotsFor(view, presetId) : DAY_MAX_SLOTS
      const trimmedSlots = trendSource ? trimSlots(trendSource.slots, maxSlots) : null
      const notes = []
      if (trendSource && trendSource.slots.length > trimmedSlots.length) notes.push(trendLimitedText(view, trimmedSlots.length))
      if (trendSource?.value?.truncated) notes.push(t('trendTruncated'))

      const busy = pointActive ? pointStatus === 'loading' : loading
      const loadingVisible = pointActive ? pointStatus === 'loading' && !pointView : loading && !stats
      const emptyVisible = !error && (pointActive ? pointView && isEmptyRange(pointView) : stats && isEmptyRange(stats))

      return h('div', { className: 'ud-panel' },
        h('div', { className: 'ud-toolbar' },
          h('div', { className: 'ud-group', role: 'group', 'aria-label': t('viewGroup') },
            VIEW_TABS.map((tab) => h('button', {
              key: tab.id,
              className: cx('ud-seg-item', view === tab.id && 'ud-seg-item--on'),
              'aria-pressed': view === tab.id,
              onClick: () => setView(tab.id),
            }, viewLabel(tab.id)))),
          pointActive
            ? h('div', { className: 'ud-group', role: 'group', 'aria-label': t('range') },
                (view === 'hour' ? HOUR_PRESETS : MINUTE_PRESETS).map((id) => h('button', {
                  key: id,
                  className: cx('ud-seg-item', presetId === id && 'ud-seg-item--on'),
                  'aria-pressed': presetId === id,
                  onClick: () => (view === 'hour' ? setHourPreset(id) : setMinutePreset(id)),
                }, presetLabel(view, id))))
            : h(React.Fragment, null,
                h('div', { className: 'ud-group', role: 'group', 'aria-label': t('range') },
                  DAY_PRESETS.map((id) => h('button', {
                    key: id,
                    className: cx('ud-seg-item', range === id && 'ud-seg-item--on'),
                    'aria-pressed': range === id,
                    onClick: () => setRange(id),
                  }, DAY_PRESET_LABELS[id]))),
                range === 'custom'
                  ? h('div', { className: 'ud-custom-range' },
                      h('input', {
                        type: 'date', className: 'ud-date-input', 'aria-label': t('from'),
                        value: customFrom, max: customTo || undefined,
                        onChange: (event) => setCustomFrom(event.target.value),
                      }),
                      h('span', { className: 'ud-custom-sep' }, '–'),
                      h('input', {
                        type: 'date', className: 'ud-date-input', 'aria-label': t('to'),
                        value: customTo, min: customFrom || undefined, max: dayBucket(new Date()),
                        onChange: (event) => setCustomTo(event.target.value),
                      }))
                  : null),
          h('button', { className: 'ud-btn ud-refresh', disabled: busy, onClick: refresh }, t('refresh'))),
        error ? h('div', { className: 'ud-error' }, error) : null,
        h(StatusRow, { onChanged: scheduleRefresh, onError: setError }),
        loadingVisible ? h('div', { className: 'ud-loading' }, `${t('loading')}…`) : null,
        stats ? h(StatCards, { key: 'cards', stats }) : null,
        trimmedSlots
          ? h(TrendChart, {
              key: 'trend',
              title: trendTitle(view),
              notes,
              slots: trimmedSlots,
              modelOrder: trendSource.models.map((item) => item.model),
              colorFor,
              labelFor: tickLabelFor(view),
              labelMinPitch: pointActive ? LABEL_PITCH_TIME : LABEL_PITCH_DAY,
              busy,
              legendModels: trendSource.models,
            })
          : null,
        stats?.to ? h('div', { className: 'ud-foot' }, `${t('asOf')} ${stats.to}`) : null,
        emptyVisible ? h('div', { className: 'ud-empty' }, t('empty')) : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyle(document)
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'usage-dash', order: 45, label: '使用统计' },
            () => h(UsageDashPanel),
          ))
      },
    }
  }
}
