// 用量面板 Client 半区:settings.section 设置页,账号配置 + 手动查询读数。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 由 DSH client runtime 的模块表解析;
// 浏览器半区通过 webServer 路由('/api/usage-panel/*')访问 Host,样式随组件内联渲染。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-usage-panel',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef } = React

    // 面板反馈出口:公共依赖 @mzzsfy/dsh-toast,可选消费——占位条目由
    // session-manager 唯一代挂,权威方未安装时降级 console,不挂死不报错
    let toast = null
    try {
      toast = require('@mzzsfy/dsh-toast/client').show
    } catch {
      // 模块表无 toast → 反馈降级 console.warn
    }

    const notify = (text, kind) => {
      if (toast) toast(text, { kind: kind === 'ok' ? 'ok' : 'error' })
      else console.warn('[dsh-usage-panel] ' + text)
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
    /* LOGIC-END */

    // 页内通知轮询:client 激活即轮询,不依赖面板打开;toast 库缺失(权威代挂方
    // session-manager 未安装)整段跳过;批内逐条认领防多窗口重复弹;
    // 代际令牌自愈:HMR/闭包重建首挂清旧代 interval 再启新代,旧代不滞留不叠加
    const NOTIFY_POLL_MS = 5 * 1000
    const NOTIFY_TOAST_MS = 6 * 1000
    const KEY_POLL_TOKEN = 'usage-panel:notify-poll'
    if (toast) {
      // 句柄存在即清:旧版遗留布尔令牌传入 clearInterval 为无害空操作,顺带清偿旧形态
      if (window[KEY_POLL_TOKEN] !== undefined) clearInterval(window[KEY_POLL_TOKEN])
      window[KEY_POLL_TOKEN] = setInterval(() => {
        api('/api/usage-panel/notifications')
            .then((payload) => {
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
                if (!claimEvent(unit.id)) continue
                markDone(unit.id)
                toast(unit.text, { kind: unit.kind === 'reset' ? 'ok' : 'error', holdMs: NOTIFY_TOAST_MS })
              }
            })
            .catch(() => {})
      }, NOTIFY_POLL_MS)
    }

    // 导航图标声明:交给 dsh-settings-nav-icons 统一渲染(本插件分区 → plan);
    // 该插件未就绪时入队,由其启动时排空
    const NAV_ICON = { '账号余额': 'plan' }
    if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
    else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
    else window.__navicIconQueue = [NAV_ICON]

const CSS = [
  // 设计令牌:状态色语义固定,面层色走宿主变量保暗亮自适应
  '.up-panel { --up-warn:#d97706; --up-surface:var(--dsw-alias-surface-primary, #1b1d21);',
  '  --up-border:var(--dsw-alias-separator-primary, rgba(128,128,128,0.28));',
  '  --up-muted:var(--dsw-alias-label-secondary, rgba(160,166,178,0.9));',
  '  --up-ok:var(--dsw-alias-state-success-primary, #1a9e55);',
  '  --up-err:var(--dsw-alias-state-error-primary, #d43a3a);',
  '  --up-focus:var(--dsw-alias-state-focus-primary, #4c8dff);',
  '  display:flex; flex-direction:column; gap:14px; color:inherit; font-size:13px; }',
  // ---- 顶栏 ----
  '.up-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }',
  '.up-head__title { font-weight:600; font-size:15px; letter-spacing:0.2px; }',
  '.up-head__hint { color:var(--up-muted); font-size:12px; }',
  '.up-spacer { flex:1; }',
  // ---- 按钮体系:实底主按钮 / ghost 次按钮 / 危险红调 ----
  '.up-btn { cursor:pointer; border:1px solid var(--up-border); background:transparent;',
  '  color:inherit; border-radius:8px; padding:5px 12px; font-size:12px; font-family:inherit;',
  '  transition:background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease, transform 0.15s ease; }',
  '.up-btn:hover { border-color:var(--up-focus); background:rgba(128,148,180,0.12); }',
  '.up-btn:active { transform:translateY(1px); }',
  '.up-btn:disabled { opacity:0.45; cursor:default; transform:none; }',
  '.up-btn:focus-visible { outline:2px solid var(--up-focus); outline-offset:2px; }',
  '.up-btn--primary { background:var(--up-focus); border-color:var(--up-focus); color:#fff; font-weight:600; }',
  '.up-btn--primary:hover { background:var(--up-focus); opacity:0.88; }',
  '.up-btn--danger { color:var(--up-err); border-color:color-mix(in srgb, var(--up-err) 45%, transparent); }',
  '.up-btn--danger:hover { border-color:var(--up-err); background:color-mix(in srgb, var(--up-err) 12%, transparent); }',
  // ---- 账号卡:透明底随宿主主题,边框定界,hover 极淡提层 ----
  '.up-card { border:1px solid var(--up-border); border-radius:12px; padding:14px 16px;',
  '  display:flex; flex-direction:column; gap:10px;',
  '  transition:border-color 0.15s ease, background 0.15s ease; }',
  '.up-card:hover { border-color:color-mix(in srgb, var(--up-focus) 40%, var(--up-border));',
  '  background:rgba(128,148,180,0.06); }',
  '.up-card__row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }',
  '.up-card__name { font-weight:600; font-size:15px; }',
  // 平台徽章:按平台固定色相着色的胶囊 pill;缺省灰底(档位徽章与低调平台共用)
  '.up-badge { font-size:10px; font-weight:500; padding:1px 7px; border-radius:999px;',
  '  line-height:1.5; border:1px solid transparent; color:#fff;',
  '  background:var(--up-badge-color, rgba(128,128,128,0.55)); }',
  '.up-badge[data-type="deepseek"] { --up-badge-color:#4d6bfe; }',
  '.up-badge[data-type="openrouter"] { --up-badge-color:#57565b; }',
  '.up-badge[data-type="kimi"] { --up-badge-color:#0d9488; }',
  '.up-badge[data-type="minimax"] { --up-badge-color:#ea580c; }',
  '.up-badge[data-type="newapi"] { --up-badge-color:#8b5cf6; }',
  // ---- 读数行:标签 + 渐变进度条 + 等宽数字 ----
  '.up-reading { display:flex; flex-direction:column; gap:6px; }',
  '.up-row { display:flex; align-items:center; gap:10px; position:relative; }',
  '.up-row__label { width:52px; flex:none; font-size:12px; color:var(--up-muted); white-space:nowrap; }',
  '.up-bar { flex:1; min-width:120px; max-width:320px; height:8px; border-radius:999px; overflow:hidden; flex:none;',
  '  background:var(--up-border); }',
  '.up-bar__fill { display:block; height:100%; border-radius:999px;',
  '  background:linear-gradient(90deg, var(--up-ok), color-mix(in srgb, var(--up-ok) 72%, #3ddc84));',
  '  transition:width 0.4s ease; }',
  '.up-bar__fill--warn { background:linear-gradient(90deg, var(--up-warn), #f0a13e); }',
  '.up-bar__fill--crit { background:linear-gradient(90deg, var(--up-err), #f0574f); }',
  '.up-pct { font-variant-numeric:tabular-nums; font-weight:600; font-size:13px; min-width:44px; text-align:right; }',
  // ---- 数字与状态色 ----
  '.up-meta { color:var(--up-muted); font-size:12px; line-height:1.6; }',
  '.up-error { color:var(--up-err); font-size:12px; }',
  '.up-ok { color:var(--up-ok); }',
  '.up-warn { color:var(--up-warn); }',
  '.up-num { font-variant-numeric:tabular-nums; }',
  '.up-amount { font-variant-numeric:tabular-nums; font-weight:600; font-size:14px; }',
  '.up-dot { display:inline-block; width:6px; height:6px; border-radius:50%; margin-right:5px; vertical-align:middle;',
  '  background:var(--up-ok); box-shadow:0 0 0 3px color-mix(in srgb, var(--up-ok) 18%, transparent); }',
  '.up-dot--off { background:var(--up-err); box-shadow:0 0 0 3px color-mix(in srgb, var(--up-err) 18%, transparent); }',
  // ---- 悬浮提示(读数明细) ----
  '.up-tip { position:absolute; top:calc(100% + 8px); left:0; visibility:hidden; opacity:0;',
  '  transition:opacity 0.15s ease; background:rgba(22,24,28,0.94); color:#f0f1f3;',
  '  font-size:11px; line-height:1.7; padding:7px 11px; border-radius:9px; white-space:nowrap; text-align:left;',
  '  z-index:40; pointer-events:none; box-shadow:0 6px 20px rgba(0,0,0,0.35); }',
  '.up-row:hover .up-tip { visibility:visible; opacity:1; }',
  // ---- 趋势弹层:毛玻璃 ----
  '.up-trend { position:absolute; top:calc(100% + 8px); left:0; visibility:hidden; opacity:0;',
  '  transition:opacity 0.15s ease; background:rgba(24,26,31,0.86); color:#f0f1f3;',
  '  backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px);',
  '  border:1px solid rgba(255,255,255,0.12);',
  '  font-size:11px; line-height:1.6; padding:10px 12px; border-radius:12px; z-index:41;',
  '  box-shadow:0 10px 36px rgba(0,0,0,0.45); }',
  '.up-trend__title { font-weight:600; margin-bottom:4px; font-size:12px; }',
  '.up-trend__chart { margin:2px 0 6px; }',
  '.up-trend__chart text { fill:currentColor; font-size:9px; }',
  '.up-trend__point:hover circle { r:4; }',
  '.up-card:hover .up-trend { visibility:visible; opacity:1; }',
  '.up-card:hover { cursor:default; }',
  // ---- 对话框:毛玻璃遮罩 + 提升卡片 ----
  '.up-dialog-mask { position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:60;',
  '  backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px);',
  '  display:flex; align-items:center; justify-content:center; }',
  '.up-dialog { background:var(--up-surface); color:inherit; border:1px solid var(--up-border); border-radius:14px;',
  '  padding:18px 20px; max-width:680px; width:90%; max-height:80vh; overflow:auto;',
  '  display:flex; flex-direction:column; gap:10px; box-shadow:0 16px 48px rgba(0,0,0,0.5); }',
  '.up-dialog table { border-collapse:collapse; width:100%; font-size:12px; }',
  '.up-dialog th, .up-dialog td { text-align:left; padding:4px 10px;',
  '  border-bottom:1px solid var(--up-border); }',
  '.up-dialog th { color:var(--up-muted); font-weight:500; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; }',
  // ---- 表单:透明底与宿主融合 ----
  '.up-form { border:1px solid var(--up-border); border-radius:12px; padding:16px;',
  '  display:flex; flex-direction:column; gap:10px; }',
  '.up-form--nested { border-style:dashed; }',
  '.up-field { display:flex; flex-direction:column; gap:4px; }',
  '.up-field__label { font-size:12px; color:var(--up-muted); }',
  '.up-field input, .up-field select, .up-field textarea {',
  '  background:transparent; color:inherit; border:1px solid var(--up-border);',
  '  border-radius:8px; padding:6px 10px; font-size:13px; font-family:inherit; box-sizing:border-box; width:100%;',
  '  transition:border-color 0.15s ease, box-shadow 0.15s ease; }',
  '.up-field input:hover, .up-field select:hover, .up-field textarea:hover { border-color:color-mix(in srgb, var(--up-focus) 45%, var(--up-border)); }',
  '.up-field input:focus-visible, .up-field select:focus-visible, .up-field textarea:focus-visible {',
  '  outline:none; border-color:var(--up-focus); box-shadow:0 0 0 3px color-mix(in srgb, var(--up-focus) 22%, transparent); }',
  '.up-field textarea { font-family:ui-monospace, Consolas, monospace; font-size:12px; min-height:52px; resize:vertical; }',
  '.up-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }',
  // ---- 通知与提示 ----
  '.up-notice { font-size:12px; padding:7px 11px; border-radius:9px;',
  '  border:1px solid var(--up-border); background:color-mix(in srgb, var(--up-err) 8%, transparent); }',
  '.up-notice--error { color:var(--up-err); border-color:color-mix(in srgb, var(--up-err) 35%, transparent); }',
  // ---- 折叠卡:details/summary 原生折叠,摘要行常显状态 ----
  '.up-fold > summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:8px;',
  '  border-radius:8px; transition:opacity 0.15s ease; }',
  '.up-fold > summary::-webkit-details-marker { display:none; }',
  '.up-fold > summary:hover { opacity:0.8; }',
  '.up-fold > summary::after { content:""; width:6px; height:6px; flex:none; margin-left:auto; opacity:0.5;',
  '  border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor;',
  '  transform:rotate(-45deg); transition:transform 0.15s ease; }',
  '.up-fold[open] > summary::after { transform:rotate(45deg); }',
  '.up-fold:not([open]) { padding:10px 16px; }',
  // ---- 分区标题(通知卡内分组) ----
  '.up-section { display:flex; flex-direction:column; gap:8px; }',
  '.up-section__title { font-size:11px; font-weight:600; letter-spacing:0.8px; text-transform:uppercase;',
  '  color:var(--up-muted); padding-bottom:4px; border-bottom:1px solid var(--up-border); }',
  // ---- IM 目标列表行 ----
  '.up-list { display:flex; flex-direction:column; }',
  '.up-list__item { display:flex; align-items:center; gap:10px; padding:6px 2px; border-bottom:1px solid var(--up-border); }',
  '.up-list__item:last-child { border-bottom:none; }',
  '.up-list__grow { flex:1; font-size:12px; }',
  '.up-list__tag { font-size:11px; color:var(--up-muted); }',
  // ---- chips:已绑 bot 管理 ----
  '.up-chip { display:inline-flex; align-items:center; gap:2px; font-size:11px; padding:2px 4px 2px 9px; border-radius:999px;',
  '  border:1px solid var(--up-border); background:color-mix(in srgb, var(--up-focus) 7%, transparent); }',
  '.up-chip__name { cursor:pointer; border:none; background:transparent; color:inherit; padding:1px 2px; font-size:11px; font-family:inherit; }',
  '.up-chip__name--active { color:var(--up-focus); font-weight:600; }',
  '.up-chip__name:focus-visible { outline:2px solid var(--up-focus); outline-offset:1px; border-radius:4px; }',
  '.up-chip__x { cursor:pointer; border:none; background:transparent; color:var(--up-muted); padding:0 5px; font-size:12px; border-radius:50%; line-height:1.4; }',
  '.up-chip__x:hover { color:var(--up-err); }',
  '.up-chip__x:focus-visible { outline:2px solid var(--up-focus); outline-offset:1px; }',
  // ---- 布尔开关:规约形态(track 胶囊 + thumb 圆点,状态锚定 input) ----
  '.up-switch { display:inline-flex; align-items:center; gap:6px; cursor:pointer; position:relative; }',
  '.up-switch input[type="checkbox"] { position:absolute; opacity:0; width:0; height:0; }',
  '.up-switch__track { width:30px; height:16px; border-radius:999px; flex:none; position:relative;',
  '  background:var(--up-border); transition:background 0.15s ease; }',
  '.up-switch__thumb { position:absolute; top:2px; left:2px; width:12px; height:12px; border-radius:50%;',
  '  background:#fff; transition:left 0.15s ease; }',
  '.up-switch input[type="checkbox"]:checked + .up-switch__track { background:var(--up-ok); }',
  '.up-switch input[type="checkbox"]:checked + .up-switch__track .up-switch__thumb { left:16px; }',
  '.up-switch input[type="checkbox"]:focus-visible + .up-switch__track { outline:2px solid var(--up-focus); outline-offset:2px; }',
  '.up-switch input[type="checkbox"]:disabled + .up-switch__track { opacity:0.45; }',
  '.up-switch:hover { opacity:0.85; }',
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
        : h('span', { className: 'up-amount' }, main),
      usedPct !== null ? h('span', { className: 'up-pct ' + pctClass(usedPct) }, fmtPct(usedPct)) : null,
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
      h('span', { className: 'up-pct ' + pctClass(win.utilization) }, fmtPct(win.utilization)),
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
      h('span', { className: 'up-badge', 'data-type': account.type }, TYPE_LABELS[account.type] || account.type),
      level ? h('span', { className: 'up-badge', 'data-type': 'custom' }, level) : null,
      h('span', { className: 'up-spacer' }),
      h('button', { className: 'up-btn', disabled: busy, onClick: props.onRefresh }, busy ? '查询中…' : '刷新'),
      h('button', { className: 'up-btn', disabled: busy, onClick: props.onEdit }, '编辑'),
      h('button', {
        className: 'up-btn' + (armed ? ' up-btn--danger' : ''),
        disabled: busy, onClick: props.onDelete,
      }, armed ? '确认删除' : '删除'),
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
      h('div', { className: 'up-card__row' }, h('span', { className: 'up-head__title' }, '通知规则'), h('span', { className: 'up-meta' }, '加载中…')))
  }
  const targets = Array.isArray(config.imTargets) ? config.imTargets : []
  const boundBots = imBoundBotIds(targets)
  // 通知配置一次即久,默认折叠:summary 摘要行常显状态,展开才是完整配置
  return h('details', { className: 'up-card up-fold' },
    h('summary', { className: 'up-fold__summary' },
      h('span', { className: 'up-head__title' }, '通知规则'),
      h('span', { className: 'up-dot' + (config.enabled === true ? '' : ' up-dot--off') }),
      h('span', { className: 'up-meta' }, config.enabled === true ? '已启用' : '已关闭'),
      targets.length > 0 ? h('span', { className: 'up-meta' }, targets.length + ' 个 IM 目标') : null,
      config.webhookConfigured === true ? h('span', { className: 'up-meta' }, 'webhook 已配置') : null,
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
        title: '浏览器页内弹窗提醒;toast 库未装载时此通道不可用',
        onChange: (checked) => patch({ toast: checked }),
      }),
      h('div', { className: 'up-card__row' },
        h('span', { className: 'up-field__label', title: 'host 直发的 Slack 兼容 JSON 通知;填新地址保存后自动发送测试' }, 'Webhook'),
        config.webhookConfigured === true ? h('span', { className: 'up-dot', title: '已配置' }) : null,
        h('span', { className: 'up-field' },
          h('input', {
            type: 'password', style: { width: '260px' },
            value: webhookUrl,
            onChange: (e) => setWebhookUrl(e.target.value),
            placeholder: config.webhookConfigured === true ? '已配置,留空保持不变' : 'https://hooks.example.com/…',
          })),
        h('button', {
          className: 'up-btn',
          onClick: () => {
            if (webhookUrl.trim().length === 0) {
              if (config.webhookConfigured !== true) { notify('请先填写 webhook URL', 'error'); return }
              testWebhook()
              return
            }
            const part = { webhookUrl: webhookUrl.trim() }
            api('/api/usage-panel/notify-config', { method: 'POST', body: JSON.stringify(part) })
              .then((res) => { apply(res); setWebhookUrl(''); testWebhook() })
              .catch(fail)
          },
        }, webhookUrl.trim().length > 0 ? '保存并测试' : '测试'),
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

function UsagePanelApp() {
  const [accounts, setAccounts] = useState(null)
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState({})
  // 加载失败占位:与「读取失败/加载中」占位文案联动;操作反馈不经此状态
  const [notice, setNotice] = useState(null)
  const [armed, setArmed] = useState(null)
  const [sequences, setSequences] = useState({})
  const [pollIntervalSec, setPollIntervalSec] = useState(null)
  const [pollArmed, setPollArmed] = useState(null)

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
        if (alive) setNotice('读取配置失败:' + (error && error.message ? error.message : String(error)))
      })
    api('/api/usage-panel/history')
      .then((res) => { if (alive) setSequences(res && res.sequences ? res.sequences : {}) })
      .catch(() => {})
    api('/api/usage-panel/settings')
      .then((res) => {
        if (!alive) return
        setPollIntervalSec(res && res.pollIntervalSec ? res.pollIntervalSec : null)
        setPollArmed(res ? Boolean(res.pollArmed) : null)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  function savePollInterval(value) {
    api('/api/usage-panel/settings', { method: 'POST', body: JSON.stringify({ pollIntervalSec: value }) })
      .then((res) => {
        setPollIntervalSec(res && res.pollIntervalSec ? res.pollIntervalSec : value)
        notify('轮询间隔已保存', 'ok')
      })
      .catch((error) => {
        notify('保存失败:' + (error && error.message ? error.message : String(error)), 'error')
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
    return api('/api/usage-panel/query', { method: 'POST', body: JSON.stringify({ id }) })
      .then((res) => {
        if (res && res.account) replaceAccount(res.account)
        return api('/api/usage-panel/history')
      })
      .then((res) => { setSequences(res && res.sequences ? res.sequences : {}) })
      .catch((error) => {
        notify('查询失败:' + (error && error.message ? error.message : String(error)), 'error')
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
        notify('配置已保存', 'ok')
      })
      .catch((error) => {
        notify('保存失败:' + (error && error.message ? error.message : String(error)), 'error')
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
      onEdit: () => setEditing(account),
      onDelete: () => onDelete(account),
    })
  })

  const anyBusy = Object.keys(busy).some((id) => busy[id] === true)

  return h('div', { className: 'up-panel' },
    h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
    h('div', { className: 'up-head' },
      h('span', { className: 'up-head__title' }, '账号详情'),
      h('span', { className: 'up-spacer' }),
      h('label', { className: 'up-field__label', title: '自动刷新全部账号读数的间隔秒数;过短可能触发平台限流' }, '轮询间隔(秒)'),
      h('span', { className: 'up-field' },
        h('input', {
          type: 'number', min: 1, style: { width: '80px' },
          value: pollIntervalSec === null ? '' : pollIntervalSec,
          onChange: (e) => setPollIntervalSec(e.target.value === '' ? null : Number(e.target.value)),
        }),
      ),
      h('button', { className: 'up-btn', disabled: pollIntervalSec === null, onClick: () => savePollInterval(pollIntervalSec) }, '保存间隔'),
      h('button', { className: 'up-btn', title: '手动查询全部账号并更新读数', disabled: anyBusy || accounts.length === 0, onClick: refreshAll }, '全部刷新'),
      h('button', { className: 'up-btn up-btn--primary', onClick: () => setEditing({ isNew: true, id: null }) }, '添加账号'),
    ),
    pollArmed === false ? h('div', { className: 'up-notice up-notice--error' },
      '自动轮询未运行(宿主定时服务不可用);手动查询不受影响。') : null,
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
            { name: 'settings.section', id: 'usage-panel', order: 40, label: '账号余额' },
            () => React.createElement(UsagePanelApp),
          ))
      },
    }
  },
})
