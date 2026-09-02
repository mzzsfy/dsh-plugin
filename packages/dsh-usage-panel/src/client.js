// 用量面板 Client 半区:settings.section 设置页,账号配置 + 手动查询读数。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 由 DSH client runtime 的模块表解析;
// 浏览器半区通过 webServer 路由('/api/usage-panel/*')访问 Host,样式随组件内联渲染。

window.__ModuleLoader__.load({
  id: 'dsh-usage-panel',
  factory(require) {
    const React = require('react')
    const { useState, useEffect } = React

const CSS = [
  '.up-panel { display:flex; flex-direction:column; gap:12px; color:inherit; font-size:13px; }',
  '.up-trend { position:absolute; top:calc(100% + 8px); left:0; visibility:hidden; opacity:0;',
  '  transition:opacity 0.12s ease; background:rgba(22,24,28,0.96); color:#f0f1f3;',
  '  font-size:11px; line-height:1.6; padding:8px 10px; border-radius:8px; z-index:41;',
  '  box-shadow:0 4px 16px rgba(0,0,0,0.3); }',
  '.up-trend__title { font-weight:600; margin-bottom:4px; }',
  '.up-trend__chart { margin:2px 0 6px; }',
  '.up-trend__chart text { fill:currentColor; font-size:9px; }',
  '.up-trend__point:hover circle { r:4; }',
  '.up-dialog-mask { position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:60;',
  '  display:flex; align-items:center; justify-content:center; }',
  '.up-dialog { background:var(--dsw-alias-surface-primary, #1b1d21); color:inherit; border-radius:10px;',
  '  padding:14px 16px; max-width:640px; width:90%; max-height:80vh; overflow:auto;',
  '  display:flex; flex-direction:column; gap:8px; box-shadow:0 8px 32px rgba(0,0,0,0.4); }',
  '.up-dialog table { border-collapse:collapse; width:100%; font-size:12px; }',
  '.up-dialog th, .up-dialog td { text-align:left; padding:2px 8px;',
  '  border-bottom:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.25)); }',
  '.up-head { display:flex; align-items:center; gap:8px; }',
  '.up-head__title { font-weight:600; font-size:14px; }',
  '.up-head__hint { color:var(--dsw-alias-label-secondary); font-size:12px; }',
  '.up-btn { cursor:pointer; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); background:transparent;',
  '  color:inherit; border-radius:6px; padding:3px 10px; font-size:12px; }',
  '.up-btn:hover { opacity:0.8; }',
  '.up-btn:disabled { opacity:0.45; cursor:default; }',
  '.up-card { border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); border-radius:10px; padding:10px 12px;',
  '  display:flex; flex-direction:column; gap:6px; }',
  '.up-card__row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }',
  '.up-reading { display:flex; flex-direction:column; gap:4px; }',
  '.up-row { display:flex; align-items:center; gap:8px; position:relative; }',
  '.up-row__label { width:60px; flex:none; font-size:12px; color:var(--dsw-alias-label-secondary); white-space:nowrap; }',
  '.up-bar { width:140px; height:6px; border-radius:999px; overflow:hidden; flex:none;',
  '  background:var(--dsw-alias-separator-primary, rgba(128,128,128,0.25)); }',
  '.up-bar__fill { display:block; height:100%; border-radius:999px;',
  '  background:var(--dsw-alias-state-success-primary, #1a9e55); }',
  '.up-bar__fill--warn { background:#d97706; }',
  '.up-bar__fill--crit { background:var(--dsw-alias-state-error-primary, #d43a3a); }',
  '.up-tip { position:absolute; top:calc(100% + 8px); left:0; visibility:hidden; opacity:0;',
  '  transition:opacity 0.12s ease; background:rgba(22,24,28,0.94); color:#f0f1f3;',
  '  font-size:11px; line-height:1.7; padding:6px 10px; border-radius:8px; white-space:nowrap; text-align:left;',
  '  z-index:40; pointer-events:none; box-shadow:0 4px 16px rgba(0,0,0,0.3); }',
  '.up-row:hover .up-tip { visibility:visible; opacity:1; }',
  '.up-card__name { font-weight:600; }',
  '.up-badge { font-size:11px; padding:1px 6px; border-radius:999px;',
  '  border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); color:var(--dsw-alias-label-secondary); }',
  '.up-spacer { flex:1; }',
  '.up-meta { color:var(--dsw-alias-label-secondary); font-size:12px; }',
  '.up-error { color:var(--dsw-alias-state-error-primary, #d43a3a); font-size:12px; }',
  '.up-ok { color:var(--dsw-alias-state-success-primary, #1a9e55); }',
  '.up-warn { color:#d97706; }',
  '.up-num { font-variant-numeric:tabular-nums; }',
  '.up-form { border:1px dashed var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); border-radius:10px; padding:12px;',
  '  display:flex; flex-direction:column; gap:8px; }',
  '.up-field { display:flex; flex-direction:column; gap:3px; }',
  '.up-field__label { font-size:12px; color:var(--dsw-alias-label-secondary); }',
  '.up-field input, .up-field select, .up-field textarea {',
  '  background:transparent; color:inherit; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35));',
  '  border-radius:6px; padding:4px 8px; font-size:13px; font-family:inherit; box-sizing:border-box; width:100%; }',
  '.up-field textarea { font-family:ui-monospace, Consolas, monospace; font-size:12px; min-height:52px; resize:vertical; }',
  '.up-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }',
  '.up-notice { font-size:12px; padding:4px 8px; border-radius:6px;',
  '  border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); }',
  '.up-notice--error { color:var(--dsw-alias-state-error-primary, #d43a3a); }',
  '.up-dot { display:inline-block; width:6px; height:6px; border-radius:50%; margin-right:4px; vertical-align:middle;',
  '  background:var(--dsw-alias-state-success-primary, #1a9e55); }',
  '.up-dot--off { background:var(--dsw-alias-state-error-primary, #d43a3a); }',
  '.up-card:hover .up-trend { visibility:visible; opacity:1; }',
  '.up-card { cursor:default; }',
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

const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$', EUR: '€' }
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
  if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
  return payload
}

function currencySymbol(code) {
  return Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, code) ? CURRENCY_SYMBOLS[code] : code + ' '
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

function TipLines(props) {
  return h('span', { className: 'up-tip' },
    props.lines.map((line, index) => h('div', { key: String(index) }, line)),
  )
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
    return h('div', { className: 'up-row', key: String(index) },
      h('span', { className: 'up-row__label' }, entry.currency),
      usedPct !== null
        ? h('span', { className: 'up-bar' },
            h('span', { className: 'up-bar__fill' + fillClass(usedPct), style: { width: barWidth(usedPct) } }))
        : h('span', { className: 'up-num' }, main),
      usedPct !== null ? h('span', { className: 'up-num ' + pctClass(usedPct) }, fmtPct(usedPct)) : null,
      h(TipLines, { lines: [main].concat(tipLines) }),
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
    return h('div', { className: 'up-row', key: String(index) },
      h('span', { className: 'up-row__label' }, win.label),
      h('span', { className: 'up-bar' },
        h('span', { className: 'up-bar__fill' + fillClass(win.utilization), style: { width: barWidth(win.utilization) } })),
      h('span', { className: 'up-num ' + pctClass(win.utilization) }, fmtPct(win.utilization)),
      h(TipLines, { lines: tipLines }),
    )
  })
  return h('div', { className: 'up-reading' }, rows)
}

function ReadingView(props) {
  const last = props.last
  if (!last) return h('span', { className: 'up-meta' }, '未查询,点击「刷新」获取读数')
  if (!last.ok) return h('span', { className: 'up-error' }, '查询失败:' + (last.error || '未知错误'))
  const reading = last.reading
  if (!reading) return h('span', { className: 'up-error' }, '查询结果为空')
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
  const reading = account.last && account.last.ok ? account.last.reading : null
  const level = reading && (reading.level || reading.membership) ? levelLabel(reading.level || reading.membership) : null

  return h('div', { className: 'up-card' },
    h('div', { className: 'up-card__row' },
      h('span', { className: 'up-card__name' }, account.name),
      h('span', { className: 'up-badge' }, TYPE_LABELS[account.type] || account.type),
      level ? h('span', { className: 'up-badge' }, level) : null,
      h('span', { className: 'up-spacer' }),
      h('button', { className: 'up-btn', disabled: busy, onClick: props.onRefresh }, busy ? '查询中…' : '刷新'),
      h('button', { className: 'up-btn', disabled: busy, onClick: props.onEdit }, '编辑'),
      h('button', { className: 'up-btn', disabled: busy, onClick: props.onDelete }, armed ? '确认删除' : '删除'),
    ),
    h('div', { className: 'up-card__row' }, h(ReadingView, { last: account.last })),
    h(TrendPopover, { accountName: account.name, sequences: props.sequences || {} }),
  )
}

// 表单草稿 <-> 账号对象互转,custom 的 headers/extract 以 JSON 文本编辑。
function draftFromAccount(account) {
  const empty = {
    id: null, isNew: true, name: '', type: 'deepseek',
    baseUrl: '', apiKey: '', url: '', method: 'GET', headersText: '', bodyText: '', extractText: '',
  }
  if (!account) return empty
  const custom = account.custom || {}
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
        h('label', { className: 'up-field__label' }, 'API 基础地址(留空用官方默认)'),
        h('input', {
          value: draft.baseUrl,
          onChange: (e) => patch({ baseUrl: e.target.value }),
          placeholder: draft.type === 'newapi' ? 'https://你的站点' : 'https://官方地址',
        }),
      ),
      h('div', { className: 'up-field' },
        h('label', { className: 'up-field__label' }, 'API Key'),
        h('input', {
          value: draft.apiKey,
          onChange: (e) => patch({ apiKey: e.target.value }),
          placeholder: draft.hasKey ? '已保存,留空保持不变' : 'sk-…',
        }),
      ),
    ) : null,
    isCustom ? h('div', { className: 'up-field' },
      h('label', { className: 'up-field__label' }, '完整请求 URL'),
      h('input', { value: draft.url, onChange: (e) => patch({ url: e.target.value }), placeholder: 'https://example.com/api/balance' }),
    ) : null,
    isCustom ? h('div', { className: 'up-grid' },
      h('div', { className: 'up-field' },
        h('label', { className: 'up-field__label' }, '请求方法'),
        h('select', { value: draft.method, onChange: (e) => patch({ method: e.target.value }) },
          HTTP_METHODS.map((method) => h('option', { key: method, value: method }, method))),
      ),
      h('div', { className: 'up-field' },
        h('label', { className: 'up-field__label' }, '请求体(非 GET 可选)'),
        h('input', { value: draft.bodyText, onChange: (e) => patch({ bodyText: e.target.value }) }),
      ),
    ) : null,
    isCustom ? h('div', { className: 'up-field' },
      h('label', { className: 'up-field__label' }, '请求头(JSON,Key 直填)'),
      h('textarea', {
        value: draft.headersText,
        onChange: (e) => patch({ headersText: e.target.value }),
        placeholder: '{"Authorization": "Bearer sk-xxx"}',
      }),
    ) : null,
    isCustom ? h('div', { className: 'up-field' },
      h('label', { className: 'up-field__label' }, '提取规则(JSON:remaining 必填,支持点路径 / add / subtract / divide)'),
      h('textarea', {
        value: draft.extractText,
        onChange: (e) => patch({ extractText: e.target.value }),
        placeholder: '{"remaining": {"op": "divide", "path": "data.total_available", "by": 500000}, "unit": "USD"}',
      }),
      h('button', {
        className: 'up-btn',
        onClick: () => patch({
          url: draft.url.length > 0 ? draft.url : 'https://你的站点/api/usage/token',
          method: 'GET',
          headersText: JSON.stringify(NEWAPI_EXAMPLE_HEADERS, null, 2),
          extractText: JSON.stringify(NEWAPI_EXAMPLE_EXTRACT, null, 2),
        }),
      }, '填入 NewApi 示例'),
    ) : null,
    error !== null ? h('div', { className: 'up-notice up-notice--error' }, error) : null,
    h('div', { className: 'up-card__row' },
      h('button', { className: 'up-btn', onClick: submit }, draft.isNew ? '添加' : '保存'),
      h('button', { className: 'up-btn', onClick: props.onCancel }, '取消'),
    ),
  )
}

// ---- 趋势视图(自绘 SVG,点位算法与 src/spark.mjs 参考实现一致) ----

const SPARK_WIDTH = 220
const SPARK_HEIGHT = 60
const HOVER_WINDOW_POINTS = 24
const TREND_SEQUENCE_META = {
  '5h': { label: '5 小时滚动', short: true },
  '7d': { label: '7 天', short: false },
  month: { label: '月', short: false },
  balance: { label: '余额', short: false },
}

function computeDiffSeries(points) {
  const series = []
  for (let i = 1; i < points.length; i++) {
    series.push({ t: points[i].t, v: points[i].v - points[i - 1].v })
  }
  return series
}

function extentOf(values) {
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

function computeSparkPoints(points, mode, width, height) {
  const series = mode === 'diff' ? computeDiffSeries(points) : points
  if (series.length < 2) return []
  const half = height / 2
  const stepX = width / (series.length - 1)
  if (mode === 'diff') {
    const posMax = extentOf(series.map((bar) => Math.max(bar.v, 0))).max
    const negMin = extentOf(series.map((bar) => Math.min(bar.v, 0))).min
    const spanUp = posMax > 0 ? posMax : 1
    const spanDown = negMin < 0 ? -negMin : 1
    return series.map((bar, index) => ({
      x: index * stepX,
      y: bar.v >= 0 ? half - (bar.v / spanUp) * half : half + (-bar.v / spanDown) * half,
      v: bar.v,
      t: bar.t,
    }))
  }
  const { min, max } = extentOf(series.map((point) => point.v))
  return series.map((point, index) => ({
    x: index * stepX,
    y: max === min ? half : height - ((point.v - min) / (max - min)) * height,
    v: point.v,
    t: point.t,
  }))
}

function TrendChart(props) {
  const [mode, setMode] = useState('abs')
  const plotted = computeSparkPoints(props.points, mode, SPARK_WIDTH, SPARK_HEIGHT)
  const polyline = plotted.map((p) => Math.round(p.x) + ',' + Math.round(p.y)).join(' ')
  return h('div', { className: 'up-trend__chart' },
    h('div', null,
      h('span', { className: 'up-trend__title' }, props.label + ' '),
      h('button', { className: 'up-btn', onClick: () => setMode(mode === 'abs' ? 'diff' : 'abs') },
        mode === 'abs' ? '差值' : '绝对值'),
      props.onDetail ? h('button', { className: 'up-btn', onClick: props.onDetail }, '详情') : null,
    ),
    h('svg', { width: SPARK_WIDTH, height: SPARK_HEIGHT, viewBox: '0 0 ' + SPARK_WIDTH + ' ' + SPARK_HEIGHT },
      mode === 'abs'
        ? h('polyline', { points: polyline, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 })
        : plotted.map((p, index) => h('line', {
            key: String(index), className: 'up-trend__point',
            x1: p.x, x2: p.x, y1: SPARK_HEIGHT / 2, y2: p.y,
            stroke: p.v >= 0 ? '#1a9e55' : '#d43a3a', strokeWidth: 2,
          }, h('title', null, fmtTimeFull(p.t) + ' ' + (p.v >= 0 ? '+' : '') + p.v))),
      mode === 'abs' ? plotted.map((p, index) => h('circle', {
        key: String(index), className: 'up-trend__point', cx: p.x, cy: p.y, r: 2, fill: 'currentColor',
      }, h('title', null, fmtTimeFull(p.t) + ' ' + p.v))) : null,
      mode === 'diff' ? h('line', {
        x1: 0, x2: SPARK_WIDTH, y1: SPARK_HEIGHT / 2, y2: SPARK_HEIGHT / 2,
        stroke: 'currentColor', strokeOpacity: 0.3, strokeWidth: 1,
      }) : null,
    ),
  )
}

function summaryOf(points) {
  const values = points.map((p) => p.v)
  const min = Math.min.apply(null, values)
  const max = Math.max.apply(null, values)
  const sum = values.reduce((acc, v) => acc + v, 0)
  let totalChange = 0
  for (let i = 1; i < points.length; i++) totalChange += points[i].v - points[i - 1].v
  return { latest: values[values.length - 1], avg: sum / values.length, min, max, totalChange }
}

function DetailDialog(props) {
  const ranges = props.shortWindow ? ['all', '7d'] : ['7d', '30d', 'all']
  const [range, setRange] = useState(ranges[0])
  const dayMs = 24 * 60 * 60 * 1000
  const cutoff = range === '7d' ? Date.now() - 7 * dayMs : range === '30d' ? Date.now() - 30 * dayMs : -Infinity
  const points = props.points.filter((p) => p.t >= cutoff)
  const summary = points.length >= 2 ? summaryOf(points) : null
  return h('div', { className: 'up-dialog-mask', onClick: props.onClose },
    h('div', { className: 'up-dialog', onClick: (e) => e.stopPropagation() },
      h('div', { className: 'up-card__row' },
        h('span', { className: 'up-card__name' }, props.accountName + ' · ' + props.label),
        h('span', { className: 'up-spacer' }),
        ranges.map((r) => h('button', {
          key: r, className: 'up-btn', disabled: r === range,
          onClick: () => setRange(r),
        }, r === 'all' ? '全部' : '近 ' + r)),
        h('button', { className: 'up-btn', onClick: props.onClose }, '关闭'),
      ),
      h(TrendChart, { label: props.label, points, onDetail: null }),
      summary !== null
        ? h('div', { className: 'up-meta' },
            '最新 ' + summary.latest + ' · 均值 ' + summary.avg.toFixed(2) +
            ' · 最低 ' + summary.min + ' · 最高 ' + summary.max +
            ' · 总变化 ' + (summary.totalChange >= 0 ? '+' : '') + summary.totalChange.toFixed(2))
        : h('div', { className: 'up-meta' }, '所选范围快照不足'),
      h('table', null,
        h('thead', null, h('tr', null, h('th', null, '采样时间'), h('th', null, '数值'))),
        h('tbody', null, points.slice().reverse().map((p) =>
          h('tr', { key: String(p.t) }, h('td', null, fmtTimeFull(p.t)), h('td', { className: 'up-num' }, String(p.v))))),
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
        key: item.suffix, label: item.meta.label, points,
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
          onClose: () => setDetail(null),
        })
      : null,
  )
}

function UsagePanelApp() {
  const [accounts, setAccounts] = useState(null)
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState({})
  const [notice, setNotice] = useState(null)
  const [armed, setArmed] = useState(null)
  const [sequences, setSequences] = useState({})
  const [pollIntervalSec, setPollIntervalSec] = useState(null)

  useEffect(() => {
    let alive = true
    api('/api/usage-panel/accounts')
      .then((res) => {
        if (!alive) return null
        const list = res && res.accounts ? res.accounts : []
        setAccounts(list)
        // 即时性兜底:无缓存读数的账号触发一次自动查询(受 host 退避约束)
        list.filter((item) => !item.last).forEach((item) => {
          api('/api/usage-panel/query', { method: 'POST', body: JSON.stringify({ id: item.id, auto: true }) })
            .then((r) => { if (r && r.account) replaceAccount(r.account) })
            .catch(() => {})
        })
        return null
      })
      .catch((error) => {
        if (alive) setNotice({ kind: 'error', text: '读取配置失败:' + (error && error.message ? error.message : String(error)) })
      })
    api('/api/usage-panel/history')
      .then((res) => { if (alive) setSequences(res && res.sequences ? res.sequences : {}) })
      .catch(() => {})
    api('/api/usage-panel/settings')
      .then((res) => { if (alive) setPollIntervalSec(res && res.pollIntervalSec ? res.pollIntervalSec : null) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  function savePollInterval(value) {
    api('/api/usage-panel/settings', { method: 'POST', body: JSON.stringify({ pollIntervalSec: value }) })
      .then((res) => {
        setPollIntervalSec(res && res.pollIntervalSec ? res.pollIntervalSec : value)
        setNotice({ kind: 'ok', text: '轮询间隔已保存' })
      })
      .catch((error) => {
        setNotice({ kind: 'error', text: '保存失败:' + (error && error.message ? error.message : String(error)) })
      })
  }

  function markBusy(id, value) {
    setBusy((prev) => Object.assign({}, prev, { [id]: value }))
  }

  function replaceAccount(nextAccount) {
    setAccounts((prev) => prev.map((item) => (item.id === nextAccount.id ? nextAccount : item)))
  }

  function refreshOne(id) {
    markBusy(id, true)
    setNotice(null)
    return api('/api/usage-panel/query', { method: 'POST', body: JSON.stringify({ id }) })
      .then((res) => {
        if (res && res.account) replaceAccount(res.account)
        return api('/api/usage-panel/history')
      })
      .then((res) => { setSequences(res && res.sequences ? res.sequences : {}) })
      .catch((error) => {
        setNotice({ kind: 'error', text: '查询失败:' + (error && error.message ? error.message : String(error)) })
      })
      .then(() => markBusy(id, false))
  }

  function refreshAll() {
    if (!accounts) return
    Promise.all(accounts.map((item) => refreshOne(item.id)))
  }

  function saveAccounts(nextAccounts) {
    return api('/api/usage-panel/accounts', { method: 'POST', body: JSON.stringify({ accounts: nextAccounts }) })
      .then((res) => {
        setAccounts(res && res.accounts ? res.accounts : nextAccounts)
        setEditing(null)
        setNotice({ kind: 'ok', text: '配置已保存' })
      })
      .catch((error) => {
        setNotice({ kind: 'error', text: '保存失败:' + (error && error.message ? error.message : String(error)) })
      })
  }

  function onDelete(account) {
    if (armed !== account.id) {
      setArmed(account.id)
      return
    }
    setArmed(null)
    saveAccounts(accounts.filter((item) => item.id !== account.id))
  }

  if (accounts === null) {
    return h('div', { className: 'up-panel' },
      h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
      h('span', { className: 'up-meta' }, notice !== null ? '读取失败' : '加载中…'),
      notice !== null ? h('div', { className: 'up-notice up-notice--' + notice.kind }, notice.text) : null)
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
      onEdit: () => setEditing(account),
      onDelete: () => onDelete(account),
    })
  })

  const anyBusy = Object.keys(busy).some((id) => busy[id] === true)

  return h('div', { className: 'up-panel' },
    h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
    h('div', { className: 'up-head' },
      h('span', { className: 'up-head__title' }, '多平台用量与余额'),
      h('span', { className: 'up-head__hint' }, '配置保存在服务器不回传,无安全风险'),
      h('span', { className: 'up-spacer' }),
      h('span', { className: 'up-field' },
        h('label', { className: 'up-field__label' }, '轮询间隔(秒)'),
        h('input', {
          type: 'number', min: 1, style: { width: '80px' },
          value: pollIntervalSec === null ? '' : pollIntervalSec,
          onChange: (e) => setPollIntervalSec(e.target.value === '' ? null : Number(e.target.value)),
        }),
      ),
      h('button', { className: 'up-btn', disabled: pollIntervalSec === null, onClick: () => savePollInterval(pollIntervalSec) }, '保存间隔'),
      h('button', { className: 'up-btn', disabled: anyBusy || accounts.length === 0, onClick: refreshAll }, '全部刷新'),
      h('button', { className: 'up-btn', onClick: () => setEditing({ isNew: true, id: null }) }, '添加账号'),
    ),
    notice !== null ? h('div', { className: 'up-notice up-notice--' + notice.kind }, notice.text) : null,
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
      ? h('div', { className: 'up-meta' }, '还没有账号,点击「添加账号」手动填入 API 地址与 Key。')
      : null,
    cards,
  )
}

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'usage-panel', order: 40, label: '用量面板' },
            () => React.createElement(UsagePanelApp),
          ))
      },
    }
  },
})
