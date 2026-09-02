// 用量统计 Client 半区 v2:全屏仪表盘(shell.overlay)+ 输入区费用条 + 侧边栏卡 + 设置区。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory})。
// 仪表盘形态:client-modules 无插件可注册的全屏路由,按设计文档回退全屏覆盖层(shell.overlay)。

window.__ModuleLoader__.load({
  id: 'dsh-usage-stats',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useMemo } = React

const CSS = [
  '.us-panel { display:flex; flex-direction:column; gap:12px; color:inherit; font-size:13px; }',
  '.us-head { display:flex; align-items:center; gap:8px; }',
  '.us-head__title { font-weight:600; font-size:14px; }',
  '.us-head__hint { color:var(--dsw-alias-label-secondary); font-size:12px; }',
  '.us-spacer { flex:1; }',
  '.us-btn { cursor:pointer; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); background:transparent;',
  '  color:inherit; border-radius:6px; padding:3px 10px; font-size:12px; }',
  '.us-btn:disabled { opacity:0.45; cursor:default; }',
  '.us-btn--danger { border-color:rgba(220,80,80,0.6); }',
  '.us-table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }',
  '.us-table th { text-align:left; font-size:12px; color:var(--dsw-alias-label-secondary); font-weight:500; padding:2px 6px;',
  '  border-bottom:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); }',
  '.us-table td { font-size:12px; padding:3px 6px; }',
  '.us-meta { color:var(--dsw-alias-label-secondary); font-size:12px; }',
  '.us-badge { display:inline-block; font-size:11px; padding:1px 6px; border-radius:999px;',
  '  border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); color:var(--dsw-alias-label-secondary); }',
  '.us-dock { display:inline-flex; align-items:center; gap:6px; font-size:11px; line-height:1.5;',
  '  color:var(--dsw-alias-label-secondary); white-space:nowrap; user-select:none; }',
  '.us-dock__cost { color:inherit; font-variant-numeric:tabular-nums; }',
  '.us-spark { display:inline-flex; align-items:flex-end; gap:1px; height:12px; }',
  '.us-spark__bar { width:3px; background:currentColor; opacity:0.55; border-radius:1px; }',
  '.us-overlay { position:fixed; inset:0; z-index:1000; background:var(--dsw-alias-background-primary, inherit);',
  '  color:inherit; display:flex; flex-direction:column; padding:20px 24px; overflow:auto; box-sizing:border-box; }',
  '.us-overlay__head { display:flex; align-items:center; gap:12px; margin-bottom:16px; }',
  '.us-overlay__title { font-size:18px; font-weight:600; }',
  '.us-hero { display:flex; gap:24px; align-items:baseline; flex-wrap:wrap; }',
  '.us-hero__num { font-size:40px; font-weight:700; font-variant-numeric:tabular-nums; }',
  '.us-hero__sub { color:var(--dsw-alias-label-secondary); font-size:13px; }',
  '.us-kpis { display:flex; gap:16px; flex-wrap:wrap; color:var(--dsw-alias-label-secondary); font-size:12px;',
  '  font-variant-numeric:tabular-nums; }',
  '.us-heat { display:grid; grid-template-columns:repeat(7, 16px); gap:3px; }',
  '.us-heat__cell { width:16px; height:16px; border-radius:3px;',
  '  background:var(--dsw-alias-separator-primary, rgba(128,128,128,0.2)); }',
  '.us-bars { display:flex; align-items:flex-end; gap:2px; height:80px; font-variant-numeric:tabular-nums; }',
  '.us-bars__col { flex:1; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; gap:2px; }',
  '.us-bars__bar { width:70%; min-height:1px; background:var(--dsw-alias-separator-primary, rgba(128,128,128,0.6));',
  '  border-radius:2px 2px 0 0; }',
  '.us-edit { width:100%; min-height:120px; font-family:monospace; font-size:12px; color:inherit;',
  '  background:transparent; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35));',
  '  border-radius:6px; padding:8px; box-sizing:border-box; }',
].join('\n')

const POLL_INTERVAL_MS = 5 * 1000
const SPARK_DAYS = 7
const ID_PREFIX_LEN = 10
const STORE_KEYS = {
  feeBar: 'usage-stats.feebar.show',
  sidebarCard: 'usage-stats.sidebar.show',
  feeBarSource: 'usage-stats.feebar.source',
}
const DEFAULT_FEE_BAR_SOURCE = '(data) => "本会话 " + data.sessionCost.toFixed(4) + " CNY · 本轮 " + data.turnCost.toFixed(4)'

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
  return payload
}

function h(type, props) {
  const children = Array.prototype.slice.call(arguments, 2)
  return React.createElement.apply(React, [type, props || null].concat(children))
}

function readFlag(key) {
  try {
    return window.localStorage.getItem(key) !== '0'
  } catch {
    return true
  }
}

function writeFlag(key, value) {
  try {
    window.localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // 展示偏好持久化失败仅影响下次默认值
  }
}

function readSource() {
  try {
    return window.localStorage.getItem(STORE_KEYS.feeBarSource) || ''
  } catch {
    return ''
  }
}

function writeSource(source) {
  try {
    window.localStorage.setItem(STORE_KEYS.feeBarSource, source)
  } catch {
    // 同上
  }
}

// 费用条 CNY 展示口径:账本 cost 为 USD,展示层按当前汇率折 CNY。
function fmtCny(usd, rate) {
  const n = Number(usd)
  if (n !== n) return '—'
  const cny = n * (rate || 7.2)
  if (cny > 0 && cny < 0.01) return '¥' + cny.toFixed(4)
  return '¥' + cny.toFixed(2)
}

function fmtTokens(n) {
  const v = Number(n)
  if (v !== v) return '—'
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M'
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k'
  return String(v)
}

function fmtInt(value) {
  const n = Number(value)
  return n === n ? String(Math.round(n)) : '—'
}

// 首样本 turnCost 置 0 的差分口径,与 src/feebar.mjs 的 turnCostOf 保持一致。
function turnCostOf(currentCost, previousCost) {
  if (previousCost === null) return 0
  return Math.max(0, currentCost - previousCost)
}

// 与 src/feebar.mjs 保持一致的最小权限求值:new Function 编译函数表达式,
// 仅传入结构化快照,要求返回字符串;异常或非字符串返回回退原生渲染。
function renderFeeBar(source, data) {
  try {
    const factory = new Function('"use strict"; return (' + source + ');')
    const fn = factory()
    if (typeof fn !== 'function') return { fallback: true, error: '费用条函数编译失败' }
    const text = fn(data)
    if (typeof text !== 'string') return { fallback: true, error: '费用条函数返回非字符串' }
    return { fallback: false, text }
  } catch (error) {
    return { fallback: true, error: error && error.message ? error.message : String(error) }
  }
}

// 近 7 天 sparkline:高度按当日费用相对峰值归一。
function Sparkline(props) {
  const costs = props.costs || []
  const max = Math.max.apply(null, costs.concat([0]))
  if (max <= 0) return null
  return h('span', { className: 'us-spark' },
    costs.map((cost, i) => h('span', {
      key: i,
      className: 'us-spark__bar',
      style: { height: Math.max(1, Math.round((cost / max) * 12)) + 'px' },
    })),
  )
}

// 输入区费用条:本轮费用 + 会话累计 + 近 7 天 sparkline;支持自定义 JS。
function FeeBar(props) {
  const [session, setSession] = useState(null)
  const [summary, setSummary] = useState(null)
  const sessionId = props && props.sessionId ? props.sessionId : ''

  useEffect(() => {
    if (!sessionId) return undefined
    let alive = true
    let lastCost = null
    function load() {
      api('/api/usage-stats/session', { method: 'POST', body: JSON.stringify({ sessionId }) })
        .then((res) => {
          if (!alive) return
          res.turnCost = turnCostOf(res.cost, lastCost)
          lastCost = res.cost
          setSession(res)
        })
        .catch(() => {
          // 本地统计缺失时费用条静默隐藏
        })
    }
    load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [sessionId])

  useEffect(() => {
    let alive = true
    api('/api/usage-stats/summary')
      .then((res) => { if (alive) setSummary(res) })
      .catch(() => {
        // 趋势缺失时仅显示会话读数
      })
    return () => {
      alive = false
    }
  }, [])

  const source = readSource()
  if (!session || (!session.calls && !session.outputTokens)) return null
  const daily = summary && summary.summary && summary.summary.recentDays
    ? summary.summary.recentDays.slice(0, SPARK_DAYS).map((day) => day.cost)
    : []
  const rate = summary && summary.rate ? summary.rate.rate : null
  const snapshot = {
    turnCost: session.turnCost,
    sessionCost: session.cost,
    sessionTokens: session.inputTokens + session.cacheReadTokens + session.outputTokens,
    recentDailyCosts: daily,
  }
  if (source.trim().length > 0) {
    const rendered = renderFeeBar(source, snapshot)
    if (!rendered.fallback) return h('span', { className: 'us-dock' }, rendered.text)
    // 失败回退原生渲染,错误在设置区可见(此处静默)
  }
  return h('span', {
    className: 'us-dock',
    title: '本轮 ' + fmtCny(snapshot.turnCost, rate) + ' · 输入 ' + fmtTokens(session.inputTokens) +
      ' · 缓存 ' + fmtTokens(session.cacheReadTokens) + ' · 输出 ' + fmtTokens(session.outputTokens),
  },
    h('span', { className: 'us-dock__cost' }, '本会话 ' + fmtCny(session.cost, rate)),
    h('span', null, fmtTokens(snapshot.sessionTokens) + ' tok'),
    h(Sparkline, { costs: daily }),
  )
}

// 侧边栏触发卡:本月费用主数字 + 今日/本周副行(sidebar.footer.action,root 作用域)。
function SidebarCard() {
  const [data, setData] = useState(null)
  useEffect(() => {
    let alive = true
    function load() {
      api('/api/usage-stats/summary')
        .then((res) => { if (alive) setData(res) })
        .catch(() => {
          // 静默
        })
    }
    load()
    const timer = setInterval(load, POLL_INTERVAL_MS * 6)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  if (!data || !data.rate) return null
  const s = data.summary
  const rate = data.rate.rate
  return h('div', { style: { fontSize: '12px', padding: '4px 2px', userSelect: 'none' } },
    h('div', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 } }, fmtCny(s.month.cost, rate)),
    h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } },
      '今日 ' + fmtCny(s.today.cost, rate)),
  )
}

// 设置区自定义单价表:结构化条目(模型 id + 三栏单价 + 币种),经 /prices 通道持久化到 settings。
function PriceTable(props) {
  const [rows, setRows] = useState(props.rows)
  const [hint, setHint] = useState('')
  function save(next) {
    setRows(next)
    api('/api/usage-stats/prices', { method: 'POST', body: JSON.stringify({ customPrices: next }) })
      .then(() => setHint('已保存'))
      .catch((err) => setHint('保存失败:' + (err && err.message ? err.message : String(err))))
  }
  function edit(i, field, value) {
    const next = rows.map((row, j) => (j === i ? Object.assign({}, row, { [field]: value }) : row))
    setRows(next)
  }
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
    h('table', { className: 'us-table' },
      h('thead', null, h('tr', null,
        h('th', null, '模型 id'), h('th', null, '输入'), h('th', null, '缓存命中'), h('th', null, '输出'),
        h('th', null, '币种'), h('th', null, ''))),
      h('tbody', null, rows.map((row, i) =>
        h('tr', { key: i },
          ['model', 'input', 'cacheRead', 'output'].map((field) =>
            h('td', { key: field },
              h('input', {
                value: row[field] === null || row[field] === undefined ? '' : String(row[field]),
                onChange: (e) => edit(i, field, e.target.value),
                style: { width: '100%', background: 'transparent', color: 'inherit', border: '1px solid rgba(128,128,128,0.3)', borderRadius: '4px' },
              }))),
          h('td', null,
            h('select', {
              value: row.currency || 'USD',
              onChange: (e) => edit(i, 'currency', e.target.value),
              style: { background: 'transparent', color: 'inherit' },
            }, h('option', { value: 'USD' }, 'USD'), h('option', { value: 'CNY' }, 'CNY'))),
          h('td', null, h('button', { className: 'us-btn', onClick: () => save(rows.filter((_, j) => j !== i)) }, '删')),
        )))),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      h('button', {
        className: 'us-btn',
        onClick: () => save(rows.concat([{ model: '', input: '', cacheRead: '', output: '', currency: 'CNY' }])),
      }, '添加条目'),
      h('button', { className: 'us-btn', onClick: () => save(rows) }, '保存'),
      h('span', { className: 'us-meta' }, hint || '命中顺序:provider/model 精确 -> 模型名精确 -> 最长前缀 -> 目录价'),
    ),
  )
}

// 设置区「费用条自定义」:多行编辑框 + 恢复默认 + 试运行(样例数据即时回显错误)。
function FeeBarEditor() {
  const [source, setSource] = useState(readSource())
  const [result, setResult] = useState('')
  const SAMPLE = { turnCost: 0.01, sessionCost: 0.5, sessionTokens: 12345, recentDailyCosts: [0.1, 0.2, 0, 0.3, 0.15, 0.05, 0.5] }
  function trial() {
    if (source.trim().length === 0) {
      setResult('未配置,使用原生渲染')
      return
    }
    const rendered = renderFeeBar(source, SAMPLE)
    setResult(rendered.fallback ? '错误:' + rendered.error : '输出:' + rendered.text)
  }
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
    h('textarea', { className: 'us-edit', value: source, onChange: (e) => setSource(e.target.value),
      placeholder: '(data) => "本会话 " + data.sessionCost' }),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      h('button', { className: 'us-btn', onClick: () => { writeSource(source); setResult('已保存') } }, '保存'),
      h('button', { className: 'us-btn', onClick: () => { writeSource(''); setSource(''); setResult('已恢复默认') } }, '恢复默认'),
      h('button', { className: 'us-btn', onClick: trial }, '试运行'),
      h('span', { className: 'us-meta' }, result),
    ),
    h('span', { className: 'us-meta' },
      '入参:data.turnCost / sessionCost / sessionTokens / recentDailyCosts(近 7 天);须返回字符串。请勿粘贴来源不明的代码。'),
  )
}

function ToggleRow(props) {
  return h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer' } },
    h('input', { type: 'checkbox', checked: props.value, onChange: (e) => props.onChange(e.target.checked) }),
    props.label,
  )
}

// 设置区:仪表盘入口 / 开关 / 单价表 / JS 编辑 / 导出 / 两段式清零。
function SettingsPanel(props) {
  const [customPrices, setCustomPrices] = useState([])
  const [rate, setRate] = useState(null)
  const [resetArmed, setResetArmed] = useState(false)
  const [hint, setHint] = useState('')
  const [feeBarShow, setFeeBarShow] = useState(readFlag(STORE_KEYS.feeBar))
  const [sidebarShow, setSidebarShow] = useState(readFlag(STORE_KEYS.sidebar))
  const openDashboard = props && props.openDashboard

  useEffect(() => {
    api('/api/usage-stats/prices')
      .then((res) => setCustomPrices(res.customPrices || []))
      .catch(() => {
        // 单价表读取失败保持为空表
      })
    api('/api/usage-stats/summary')
      .then((res) => setRate(res.rate))
      .catch(() => {
        // 汇率标注缺失仅影响提示文案
      })
  }, [])

  function reset() {
    if (!resetArmed) {
      setResetArmed(true)
      setHint('再次点击确认清零,不可恢复')
      return
    }
    api('/api/usage-stats/reset', { method: 'POST', body: '{}' })
      .then(() => {
        setResetArmed(false)
        setHint('账本已清零')
      })
      .catch((err) => setHint('清零失败:' + (err && err.message ? err.message : String(err))))
  }

  return h('div', { className: 'us-panel' },
    h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
    h('div', { className: 'us-head' },
      h('span', { className: 'us-head__title' }, '用量统计'),
      h('span', { className: 'us-spacer' }),
      h('button', { className: 'us-btn', onClick: openDashboard }, '打开仪表盘'),
    ),
    h('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } },
      h(ToggleRow, {
        label: '显示输入区费用条',
        value: feeBarShow,
        onChange: (v) => { writeFlag(STORE_KEYS.feeBar, v); setFeeBarShow(v) },
      }),
      h(ToggleRow, {
        label: '显示侧边栏费用卡',
        value: sidebarShow,
        onChange: (v) => { writeFlag(STORE_KEYS.sidebar, v); setSidebarShow(v) },
      }),
    ),
    rate ? h('span', { className: 'us-meta' },
      'USD->CNY 汇率 ' + rate.rate + (rate.stale ? '(非实时,沿用上次汇率)' : '') +
      (rate.fetchedAt > 0 ? ',更新于 ' + new Date(rate.fetchedAt).toLocaleString() : '')) : null,
    h('span', { className: 'us-head__title' }, '自定义模型单价'),
    h(PriceTable, { rows: customPrices }),
    h('span', { className: 'us-head__title' }, '费用条自定义'),
    h(FeeBarEditor, null),
    h('span', { className: 'us-head__title' }, '导出'),
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('a', { className: 'us-btn', href: '/api/usage-stats/export?kind=days', style: { textDecoration: 'none' } }, '按日 CSV'),
      h('a', { className: 'us-btn', href: '/api/usage-stats/export?kind=sessions', style: { textDecoration: 'none' } }, '按会话 CSV'),
      h('a', { className: 'us-btn', href: '/api/usage-stats/export?kind=json', style: { textDecoration: 'none' } }, '全量 JSON'),
    ),
    h('span', { className: 'us-head__title' }, '维护'),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      h('button', { className: 'us-btn us-btn--danger', onClick: reset }, resetArmed ? '确认清零账本' : '清零账本'),
      h('span', { className: 'us-meta' }, hint),
    ),
  )
}

// 趋势柱状图:费用 / Token 双视角,无数据日期不留柱。
function TrendChart(props) {
  const points = props.points || []
  const max = Math.max.apply(null, points.map((p) => (props.metric === 'cost' ? p.cost || 0 : p.tokens)))
  if (max <= 0) return h('span', { className: 'us-meta' }, '所选范围无数据')
  return h('div', { className: 'us-bars' },
    points.map((p) => {
      const value = props.metric === 'cost' ? p.cost : p.tokens
      return h('div', {
        key: p.date,
        className: 'us-bars__col',
        title: p.date + ' · ' + (p.cost === null ? '无数据' : '¥' + (p.cost * props.rate).toFixed(2) + ' · ' + fmtInt(p.calls) + ' 次'),
      },
        h('div', { className: 'us-bars__bar', style: value === null || value === undefined ? { height: '1px', opacity: 0.2 } : { height: Math.max(1, Math.round((value / max) * 70)) + 'px' } }),
      )
    }),
  )
}

function Heatmap(props) {
  const grid = props.grid
  const TIER_OPACITY = [0.15, 0.4, 0.65, 1]
  return h('div', { className: 'us-heat' },
    grid.days.map((day) => h('div', {
      key: day.date,
      className: 'us-heat__cell',
      title: day.cost === null ? day.date + ' · 无数据' : day.date + ' · ¥' + (day.cost * props.rate).toFixed(2) + ' · ' + fmtInt(day.calls) + ' 次',
      style: day.cost !== null ? { opacity: TIER_OPACITY[day.tier] } : null,
    })),
  )
}

// 全屏仪表盘(shell.overlay 覆盖层):概览 / 趋势 / 热力图 / 明细 / 导出。
function Dashboard(props) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [range, setRange] = useState(30)
  const [metric, setMetric] = useState('cost')
  useEffect(() => {
    api('/api/usage-stats/dashboard')
      .then(setData)
      .catch((err) => setError(err && err.message ? err.message : String(err)))
  }, [])
  const rate = data && data.dashboard ? data.dashboard.rate.rate : null
  const points = useMemo(() => {
    if (!data || !data.dashboard) return []
    return range === 7 ? data.dashboard.trend7 : data.dashboard.trend30
  }, [data, range])
  return h('div', { className: 'us-overlay' },
    h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
    h('div', { className: 'us-overlay__head' },
      h('span', { className: 'us-overlay__title' }, '用量统计仪表盘'),
      h('span', { className: 'us-spacer' }),
      h('a', { className: 'us-btn', href: '/api/usage-stats/export?kind=days' }, '按日 CSV'),
      h('a', { className: 'us-btn', href: '/api/usage-stats/export?kind=sessions' }, '按会话 CSV'),
      h('a', { className: 'us-btn', href: '/api/usage-stats/export?kind=json' }, '全量 JSON'),
      h('button', { className: 'us-btn', onClick: props.onClose }, '关闭'),
    ),
    error !== null ? h('span', { className: 'us-meta' }, '读取失败:' + error) : null,
    data === null && error === null ? h('span', { className: 'us-meta' }, '加载中…') : null,
    data && data.dashboard ? (function () {
      const dash = data.dashboard
      const o = dash.overview
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '20px' } },
        h('div', { className: 'us-hero' },
          h('div', null,
            h('div', { className: 'us-hero__num' }, fmtCny(o.month.cost, rate)),
            h('div', { className: 'us-hero__sub' }, '本月费用(估算,非账单)')),
          h('div', { className: 'us-hero__sub' }, '本月预计 ¥' + (o.projection * (rate || 0)).toFixed(2)),
          h('div', { className: 'us-hero__sub' }, '今日环比 ' + (o.todayRatio === null ? '—' : (o.todayRatio * 100).toFixed(0) + '%')),
          h('div', { className: 'us-hero__sub' }, '本周环比 ' + (o.weekRatio === null ? '—' : (o.weekRatio * 100).toFixed(0) + '%')),
        ),
        h('div', { className: 'us-kpis' },
          h('span', null, '输入 ' + fmtTokens(o.month.inputTokens)),
          h('span', null, '缓存命中 ' + fmtTokens(o.month.cacheReadTokens)),
          h('span', null, '输出 ' + fmtTokens(o.month.outputTokens)),
          h('span', null, fmtInt(o.month.calls) + ' 次调用'),
          h('span', null, '汇率 ' + dash.rate.rate + (dash.rate.stale ? '(非实时)' : '')),
        ),
        h('div', null,
          h('span', { className: 'us-badge' }, '趋势'),
          h('span', { className: 'us-spacer' }),
          h('div', { style: { display: 'flex', gap: '8px', margin: '6px 0' } },
            h('button', { className: 'us-btn', onClick: () => setRange(7) }, '近 7 天'),
            h('button', { className: 'us-btn', onClick: () => setRange(30) }, '近 30 天'),
            h('button', { className: 'us-btn', onClick: () => setMetric('cost') }, '费用'),
            h('button', { className: 'us-btn', onClick: () => setMetric('tokens') }, 'Token'),
          ),
          h(TrendChart, { points, metric, rate }),
        ),
        h('div', null,
          h('span', { className: 'us-badge' }, dash.heatmap.month + ' 热力图'),
          h('div', { style: { marginTop: '8px' } }, h(Heatmap, { grid: dash.heatmap, rate })),
        ),
        h('div', null,
          h('span', { className: 'us-badge' }, '会话明细' + (data.totalSessions > dash.sessions.length ? '(前 ' + dash.sessions.length + ')' : '')),
          data.totalSessions === 0 ? h('div', { className: 'us-meta', style: { marginTop: '6px' } }, '会话明细自账本 v2 启用起累积') : null,
          h('table', { className: 'us-table', style: { marginTop: '6px' } },
            h('thead', null, h('tr', null,
              h('th', null, '会话'), h('th', null, '最后活跃'), h('th', null, '调用'),
              h('th', null, 'Token'), h('th', null, '费用(折 CNY)'))),
            h('tbody', null, dash.sessions.map((row) =>
              h('tr', { key: row.sessionId },
                h('td', null, row.title || row.sessionId.slice(0, ID_PREFIX_LEN) + '…'),
                h('td', null, new Date(row.lastAt).toLocaleString()),
                h('td', null, fmtInt(row.calls)),
                h('td', null, fmtTokens(row.inputTokens + row.cacheReadTokens + row.outputTokens)),
                h('td', null, fmtCny(row.cost, rate)),
              ))),
          ),
        ),
      )
    })() : null,
  )
}

function registerClient(ctx) {
  let setDashboardOpen = null
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'usage-stats-dashboard', order: 90 },
      function DashboardSlot() {
        const [open, setOpen] = useState(false)
        setDashboardOpen = setOpen
        if (!open) return null
        return React.createElement(Dashboard, { onClose: () => setOpen(false) })
      },
    ))
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'usage-stats-panel', order: 41, label: '用量统计' },
      () => React.createElement(SettingsPanel, { openDashboard: () => setDashboardOpen && setDashboardOpen(true) }),
    ))
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      { name: 'conversation.composer.dock', id: 'usage-stats-badge', order: 12, label: '会话费用' },
      function FeeBarSlot(props) {
        if (!readFlag(STORE_KEYS.feeBar)) return null
        return React.createElement(FeeBar, { sessionId: props && props.sessionId })
      },
    ))
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'usage-stats-sidebar-card', order: 90 },
      function SidebarSlot() {
        if (!readFlag(STORE_KEYS.sidebar)) return null
        return React.createElement(SidebarCard)
      },
    ))
}

    return {
      inject: ['slots'],
      apply(ctx) {
        registerClient(ctx)
      },
    }
  },
})
