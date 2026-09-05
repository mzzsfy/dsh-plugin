// dsh-maintain Client 半区:settings.section 设置页面板,版本监测 + 一键升级 + 安全重启。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 由 DSH client runtime 模块表解析;
// 浏览器半区经 webServer 路由('/api/maintain/*')访问 Host,样式随组件内联渲染。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-maintain',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef } = React

    // 导航图标声明:交给 dsh-settings-nav-icons 统一渲染(本插件分区 → wrench);
    // 该插件未就绪时入队,由其启动时排空
    const NAV_ICON = { '版本与运维': 'wrench' }
    if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
    else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
    else window.__navicIconQueue = [NAV_ICON]

const CSS = [
  '.dm-panel { display:flex; flex-direction:column; gap:12px; color:inherit; font-size:13px; --dm-warn:#d97706; }',
  '.dm-head { display:flex; align-items:center; gap:8px; }',
  '.dm-head__title { font-weight:600; font-size:14px; }',
  '.dm-head__hint { color:var(--dsw-alias-label-secondary); font-size:12px; }',
  '.dm-btn { cursor:pointer; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); background:transparent;',
  '  color:inherit; border-radius:6px; padding:3px 10px; font-size:12px; }',
  '.dm-btn:hover { opacity:0.8; }',
  '.dm-btn:disabled { opacity:0.45; cursor:default; }',
  '.dm-btn--danger { color:var(--dsw-alias-state-error-primary, #d43a3a); border-color:var(--dsw-alias-state-error-primary, #d43a3a); }',
  '.dm-card { border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); border-radius:10px; padding:10px 12px;',
  '  display:flex; flex-direction:column; gap:8px; }',
  '.dm-card__title { font-weight:600; font-size:12px; color:var(--dsw-alias-label-secondary); }',
  '.dm-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }',
  '.dm-row__label { width:72px; flex:none; font-size:12px; color:var(--dsw-alias-label-secondary); white-space:nowrap; }',
  '.dm-spacer { flex:1; }',
  '.dm-meta { color:var(--dsw-alias-label-secondary); font-size:12px; }',
  '.dm-error { color:var(--dsw-alias-state-error-primary, #d43a3a); font-size:12px; }',
  '.dm-ok { color:var(--dsw-alias-state-success-primary, #1a9e55); }',
  '.dm-warn { color:var(--dm-warn); }',
  '.dm-badge { font-size:11px; padding:1px 8px; border-radius:999px; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35));',
  '  color:var(--dsw-alias-label-secondary); }',
  '.dm-badge--new { color:var(--dsw-alias-state-error-primary, #d43a3a); border-color:var(--dsw-alias-state-error-primary, #d43a3a); }',
  '.dm-badge--ok { color:var(--dsw-alias-state-success-primary, #1a9e55); border-color:var(--dsw-alias-state-success-primary, #1a9e55); }',
  '.dm-select { background:transparent; color:inherit; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35));',
  '  border-radius:6px; padding:2px 6px; font-size:12px; font-family:inherit; }',
  '.dm-input { background:transparent; color:inherit; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35));',
  '  border-radius:6px; padding:2px 6px; font-size:12px; font-family:ui-monospace, Consolas, monospace; flex:1; min-width:160px; }',
  '.dm-input:focus { outline:none; border-color:var(--dsw-alias-label-secondary, rgba(128,128,128,0.6)); }',
  '.dm-input:disabled { opacity:0.45; }',
  '.dm-link { color:var(--dsw-alias-label-secondary); font-size:12px; }',
  '.dm-notice { font-size:12px; padding:6px 10px; border-radius:6px; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); }',
  '.dm-notice--error { color:var(--dsw-alias-state-error-primary, #d43a3a); }',
  '.dm-notice--warn { color:var(--dm-warn); border-color:var(--dm-warn); }',
  '.dm-notice--ok { color:var(--dsw-alias-state-success-primary, #1a9e55); }',
  '.dm-pre { margin:0; font-family:ui-monospace, Consolas, monospace; font-size:11px; line-height:1.6; white-space:pre-wrap;',
  '  word-break:break-all; color:var(--dsw-alias-label-secondary); max-height:120px; overflow:auto; }',
].join('\n')

const STATUS_URL = '/api/maintain/status'
const REFRESH_URL = '/api/maintain/refresh'
const CHANNEL_URL = '/api/maintain/channel'
const TEMPLATE_URL = '/api/maintain/upgrade-template'
const POLL_INTERVAL_URL = '/api/maintain/poll-interval'
const REGISTRY_BASE_URL = '/api/maintain/registry-base'
const UPGRADE_URL = '/api/maintain/upgrade'
const RESTART_URL = '/api/maintain/restart'
const UPGRADE_POLL_MS = 2 * 1000
// 升级提示浮条挂 body,脱离 React 组件树,SPA 切页不消失
const UPGRADE_FLOAT_ID = 'dsh-maintain-upgrade-float'
const UPGRADE_FLOAT_STYLE_ID = UPGRADE_FLOAT_ID + '__style'
// 与 host 侧轮询 tick(TICK_MS)同源:间隔设置的生效粒度受固定 tick 调度限制
const POLL_MIN_TICK_SECONDS = 60
// 与 host 侧默认值同源(DEFAULT_POLL_INTERVAL_SEC / DEFAULT_REGISTRY_BASE / DEFAULT_UPGRADE_TEMPLATE):
// 等于默认值时输入框留空以 placeholder 展示,清空保存即恢复默认
const DEFAULT_UPGRADE_TEMPLATE = 'npm install -g @deepseek-ai/dsh@{tag}'
const DEFAULT_POLL_INTERVAL_SEC = 6 * 60 * 60
const DEFAULT_REGISTRY_BASE = 'https://registry.npmjs.org'
const RESTART_POLL_MS = 1 * 1000
const RESTART_POLL_TIMEOUT_MS = 5 * 1000
// 重启等待总时长:超时说明宿主未被进程管理器拉起或退出失败,退出等待态转人工处理
const RESTART_TIMEOUT_MS = 30 * 1000
const NPM_VERSIONS_URL = 'https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions'

// 判定常量与 host 侧 core.mjs 保持一致:client 半区无法 import ESM,
// test/parity.test.mjs 按 const 名正则提取对拍,修改任一侧必须同步。
const VERDICT_OUTDATED = 'outdated'
const VERDICT_UP_TO_DATE = 'up-to-date'
const VERDICT_UNKNOWN = 'unknown'

async function api(url, options) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
  return payload
}

function post(url, body) {
  return api(url, { method: 'POST', body: body === undefined ? '{}' : JSON.stringify(body) })
}

// 网络层失败判定:fetch 连接失败抛 TypeError,请求被中止/超时抛 name 为 AbortError/TimeoutError 的异常;
// HTTP 业务错误(4xx/5xx)是携带服务端信息的普通 Error,不在此列
function isNetworkFailure(error) {
  if (error instanceof TypeError) return true
  return error !== null && error !== undefined && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

// 升级观察器:模块级单例,升级进行中每拍拉取状态并广播,组件挂载与否不影响;
// 发现任意一拍不在进行中即升级落定,展示结果浮条后停止轮询;
// 总时长上限与宿主升级命令超时同语义:超限说明宿主或进程管理器异常,浮条转状态未知
const UPGRADE_WATCH_MAX_MS = 10 * 60 * 1000
const upgradeWatch = { timer: null, startedAt: 0, listeners: new Set() }

function broadcastUpgradeStatus(status) {
  for (const listener of upgradeWatch.listeners) listener(status)
}

function stopUpgradeWatch() {
  if (upgradeWatch.timer !== null) {
    clearInterval(upgradeWatch.timer)
    upgradeWatch.timer = null
  }
}

function subscribeUpgradeStatus(listener) {
  upgradeWatch.listeners.add(listener)
  return () => upgradeWatch.listeners.delete(listener)
}

function ensureUpgradeWatch() {
  if (upgradeWatch.timer !== null) return
  upgradeWatch.startedAt = Date.now()
  showUpgradeFloat(null)
  upgradeWatch.timer = setInterval(() => {
    if (Date.now() - upgradeWatch.startedAt >= UPGRADE_WATCH_MAX_MS) {
      stopUpgradeWatch()
      showUpgradeFloat('unknown')
      return
    }
    api(STATUS_URL)
      .then((next) => {
        broadcastUpgradeStatus(next)
        const upgrade = next ? next.upgrade : null
        if (!upgrade || upgrade.running !== true) {
          stopUpgradeWatch()
          // 快照归零(last 为空)不做失败渲染,保持进行中文案,由重启流程接管
          if (upgrade && upgrade.last) showUpgradeFloat(upgrade.last)
        }
      })
      .catch(() => {})
  }, UPGRADE_POLL_MS)
}

function ensureUpgradeFloatStyle() {
  if (document.getElementById(UPGRADE_FLOAT_STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = UPGRADE_FLOAT_STYLE_ID
  style.textContent = [
    '#' + UPGRADE_FLOAT_ID + ' { position:fixed; right:20px; bottom:20px; z-index:9999; display:flex; align-items:center; gap:10px;',
    '  max-width:340px; padding:10px 14px; border-radius:10px; border:1px solid rgba(128,128,128,0.35);',
    '  background:var(--dsw-alias-bg-layer-3, #fff); box-shadow:0 4px 16px rgba(0,0,0,0.15); font-size:13px; }',
    '#' + UPGRADE_FLOAT_ID + '__close { cursor:pointer; border:0; background:transparent; color:inherit; font-size:14px; padding:0 2px; opacity:0.6; }',
    '#' + UPGRADE_FLOAT_ID + '__close:hover { opacity:1; }',
  ].join('\n')
  document.head.appendChild(style)
}

// state:null=进行中;对象=升级结果(last,ok 区分成败);'unknown'=观察超限状态未知
function showUpgradeFloat(state) {
  ensureUpgradeFloatStyle()
  removeUpgradeFloat()
  const text = document.createElement('span')
  const close = document.createElement('button')
  close.id = UPGRADE_FLOAT_ID + '__close'
  close.textContent = '×'
  close.addEventListener('click', removeUpgradeFloat)
  const box = document.createElement('div')
  box.id = UPGRADE_FLOAT_ID
  box.appendChild(text)
  box.appendChild(close)
  if (state === null) {
    text.textContent = '升级进行中,可离开本页,完成后此处提示'
  } else if (state === 'unknown') {
    text.textContent = '升级状态长时间未更新,请刷新页面查看'
  } else if (state.ok) {
    text.textContent = '升级完成,重启宿主后生效(版本与运维页可重启)'
  } else {
    // 浮条只做通知,stderr 摘要在版本与运维页完整展示
    text.textContent = '升级失败:' + (state.error || '详情见版本与运维页')
  }
  document.body.appendChild(box)
}

function removeUpgradeFloat() {
  const box = document.getElementById(UPGRADE_FLOAT_ID)
  if (box !== null) box.remove()
}

function fmtTime(ms) {
  const t = Number(ms)
  if (t !== t || !t) return null
  const d = new Date(t)
  const pad = (n) => (n < 10 ? '0' : '') + n
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function fmtElapsed(startedAt) {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  if (seconds < 60) return seconds + ' 秒'
  if (seconds < 60 * 60) return Math.floor(seconds / 60) + ' 分 ' + (seconds % 60) + ' 秒'
  return Math.floor(seconds / (60 * 60)) + ' 小时 ' + Math.floor((seconds % (60 * 60)) / 60) + ' 分'
}

function h(type, props) {
  const children = Array.prototype.slice.call(arguments, 2)
  return React.createElement.apply(React, [type, props || null].concat(children))
}

// 结论徽章:落后显示目标版本,未知给原因,最新为绿色。
function VerdictBadge(props) {
  const status = props.status
  if (status.verdict === VERDICT_OUTDATED) {
    return h('span', { className: 'dm-badge dm-badge--new' }, '有新版本 ' + status.channelLatest)
  }
  if (status.verdict === VERDICT_UP_TO_DATE) {
    return h('span', { className: 'dm-badge dm-badge--ok' }, '已是最新')
  }
  return h('span', { className: 'dm-badge' }, '未知:' + (status.reason || '等待检查'))
}

// 可编辑设置行:label + 文本框 + 保存按钮;value 为服务端当前值,key 变化即外部更新时重置输入。
function EditRow(props) {
  const inputRef = useRef(null)
  const read = () => (inputRef.current ? inputRef.current.value : '')
  return h('div', { className: 'dm-row' },
    h('span', { className: 'dm-row__label' }, props.label),
    h('input', {
      className: 'dm-input',
      ref: inputRef,
      key: props.value == null ? '' : props.value,
      defaultValue: props.value == null ? '' : props.value,
      placeholder: props.placeholder || '',
      disabled: props.busy || props.restarting,
      onKeyDown: (e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) props.onSave(read()) },
    }),
    h('button', {
      className: 'dm-btn',
      disabled: props.busy || props.restarting,
      onClick: () => props.onSave(read()),
    }, props.busy ? '保存中…' : '保存'),
    props.hint ? h('span', { className: 'dm-meta' }, props.hint) : null,
  )
}

// 版本区:当前版本、通道切换、通道最新版、结论、检查时间与错误、刷新与升级、升级命令编辑。
function VersionCard(props) {
  const status = props.status
  const tags = status.tags || {}
  const tagNames = Object.keys(tags)
  const checked = fmtTime(status.checkedAt)
  return h('div', { className: 'dm-card' },
    h('div', { className: 'dm-row' },
      h('span', { className: 'dm-row__label' }, '当前版本'),
      h('span', null, status.currentVersion || '未知'),
      h(VerdictBadge, { status }),
      h('span', { className: 'dm-spacer' }),
      h('button', {
        className: 'dm-btn',
        disabled: props.busy.refresh || props.restarting,
        onClick: props.onRefresh,
      }, props.busy.refresh ? '检查中…' : '刷新'),
      h('button', {
        className: 'dm-btn',
        disabled: props.busy.upgrade || props.restarting || (status.upgrade && status.upgrade.running),
        onClick: props.onUpgrade,
      }, props.upgradeArmed ? '确认升级' : '升级'),
    ),
    h('div', { className: 'dm-row' },
      h('span', { className: 'dm-row__label' }, '追踪通道'),
      tagNames.length > 0
        ? h('select', {
            className: 'dm-select',
            value: tagNames.indexOf(status.channel) >= 0 ? status.channel : tagNames[0],
            onChange: (e) => props.onChannel(e.target.value),
            disabled: props.busy.channel || props.restarting,
          }, tagNames.map((name) => h('option', { key: name, value: name }, name + (tags[name] ? '  (' + tags[name] + ')' : ''))))
        : h('span', { className: 'dm-meta' }, status.channel + '(通道表未就绪)'),
      checked ? h('span', { className: 'dm-meta' }, '上次检查 ' + checked) : null,
      status.checkError ? h('span', { className: 'dm-error' }, status.checkError) : null,
      h('a', { className: 'dm-link', href: NPM_VERSIONS_URL, target: '_blank', rel: 'noreferrer' }, 'npm 版本页'),
    ),
    h(EditRow, {
      label: '升级命令',
      value: status.upgradeTemplate === DEFAULT_UPGRADE_TEMPLATE ? '' : status.upgradeTemplate,
      placeholder: DEFAULT_UPGRADE_TEMPLATE,
      busy: props.busy.template,
      restarting: props.restarting,
      onSave: props.onTemplateSave,
      hint: '默认以灰字提示,清空保存即恢复默认;{tag} 执行时替换为追踪通道;升级完成后需重启生效',
    }),
  )
}

// 设置区:轮询间隔与 registry 基地址,保存即时生效。
function SettingsCard(props) {
  const status = props.status
  return h('div', { className: 'dm-card' },
    h('div', { className: 'dm-card__title' }, '设置'),
    h(EditRow, {
      label: '轮询间隔',
      value: status.pollIntervalSec === DEFAULT_POLL_INTERVAL_SEC ? '' : status.pollIntervalSec,
      placeholder: DEFAULT_POLL_INTERVAL_SEC,
      busy: props.busy.pollInterval,
      restarting: props.restarting,
      onSave: props.onPollInterval,
      hint: '默认以灰字提示,清空保存即恢复默认;0 表示仅手动检查;最小生效粒度 ' + POLL_MIN_TICK_SECONDS + ' 秒',
    }),
    h(EditRow, {
      label: '镜像地址',
      value: status.registryBase === DEFAULT_REGISTRY_BASE ? '' : status.registryBase,
      placeholder: DEFAULT_REGISTRY_BASE,
      busy: props.busy.registryBase,
      restarting: props.restarting,
      onSave: props.onRegistryBase,
      hint: '默认以灰字提示,清空保存即恢复默认;官方源不可达时改为镜像',
    }),
  )
}

// 升级状态区:进行中显示命令与已用时;结束后显示结果,成功附重启入口,失败附 stderr 摘要。
function UpgradeCard(props) {
  const upgrade = props.status.upgrade
  if (!upgrade || (!upgrade.running && !upgrade.last)) return null
  const last = upgrade.last
  return h('div', { className: 'dm-card' },
    h('div', { className: 'dm-card__title' }, '升级'),
    upgrade.running
      ? h('div', { className: 'dm-row' },
          h('span', { className: 'dm-warn' }, '升级进行中'),
          h('span', { className: 'dm-meta' }, last ? last.command : ''),
          h('span', { className: 'dm-meta' }, '已用时 ' + fmtElapsed(last ? last.startedAt : Date.now())),
        )
      : null,
    !upgrade.running && last
      ? h('div', { className: 'dm-row' },
          last.ok ? h('span', { className: 'dm-ok' }, '升级完成,重启宿主后生效')
            : h('span', { className: 'dm-error' }, '升级失败' + (last.code !== null && last.code !== undefined ? '(退出码 ' + last.code + ')' : '') + (last.timedOut ? ',已超时终止' : '')),
          h('span', { className: 'dm-spacer' }),
          last.ok ? h('button', {
            className: 'dm-btn',
            disabled: props.restarting,
            onClick: props.onRestart,
          }, props.restartArmed ? '确认重启' : '重启宿主') : null,
        )
      : null,
    !upgrade.running && last && !last.ok && last.stderrTail
      ? h('pre', { className: 'dm-pre' }, last.stderrTail)
      : null,
  )
}

// 运维区:两段式重启 + 托管环境说明。
function OpsCard(props) {
  const status = props.status
  return h('div', { className: 'dm-card' },
    h('div', { className: 'dm-card__title' }, '重启'),
    h('div', { className: 'dm-row' },
      h('button', {
        className: 'dm-btn dm-btn--danger',
        disabled: !status.canRestart || props.restarting,
        onClick: props.onRestart,
      }, props.armed ? '确认重启' : '重启宿主'),
      !status.canRestart ? h('span', { className: 'dm-meta' }, '当前启动方式不支持就地重启') : null,
    ),
    h('div', { className: 'dm-meta' },
      '重启依赖进程管理器(pm2 / systemd / nssm / Docker 等)自动拉起;手动终端启动的进程不会自动恢复。',
      '重启后本页自动检测宿主恢复并刷新;若长时间未恢复请手动刷新。运行中的 agent 将被中断,会话已持久化,重开后可 resume。'),
  )
}

function MaintainApp() {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState({})
  const [upgradeArmed, setUpgradeArmed] = useState(false)
  const [restartArmed, setRestartArmed] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const restartLostRef = useRef(false)
  const restartPidRef = useRef(null)
  const restartPendingRef = useRef(false)

  function markBusy(key, value) {
    setBusy((prev) => Object.assign({}, prev, { [key]: value }))
  }

  function load() {
    return api(STATUS_URL)
      .then((next) => { setStatus(next); setError(null); return next })
      .catch((loadError) => { setError('读取状态失败:' + (loadError && loadError.message ? loadError.message : String(loadError))); return null })
  }

  // 挂载即订阅观察器快照,页面刷新落在升级进行中时恢复浮条与观察
  useEffect(() => {
    const unsubscribe = subscribeUpgradeStatus((next) => {
      if (next !== null) setStatus(next)
    })
    void load().then((next) => {
      if (next !== null && next.upgrade !== null && next.upgrade.running === true) ensureUpgradeWatch()
    })
    return unsubscribe
  }, [])

  // 重启判定与 core.mjs shouldReloadAfterRestart 同源:client 半区无法 import ESM,修改需两处同步。
  // LOGIC-BEGIN shouldReloadAfterRestart
  function shouldReloadAfterRestart(params) {
    if (params.lost) return true
    return typeof params.pidBefore === 'number' && typeof params.pidAfter === 'number' && params.pidBefore !== params.pidAfter
  }
  // LOGIC-END shouldReloadAfterRestart

  // 重启确认后轮询状态:退出窗口的请求失败是预期中间态,静默记入 ref 不展示错误;
  // 失联后恢复或宿主 pid 变化(快速重启零失联)即宿主已重启,整页刷新以加载新版本;
  // 总时长超限说明宿主未被拉起或退出失败,退出等待态转人工处理
  useEffect(() => {
    if (!restarting) {
      restartLostRef.current = false
      restartPidRef.current = null
      return
    }
    const deadline = Date.now() + RESTART_TIMEOUT_MS
    const timer = setInterval(() => {
      if (Date.now() >= deadline) {
        clearInterval(timer)
        setRestarting(false)
        setError('重启未在 ' + RESTART_TIMEOUT_MS / 1000 + ' 秒内完成,宿主可能未被拉起,请检查进程管理器后手动刷新')
        return
      }
      api(STATUS_URL, { signal: AbortSignal.timeout(RESTART_POLL_TIMEOUT_MS) })
        .then((next) => {
          if (shouldReloadAfterRestart({ lost: restartLostRef.current, pidBefore: restartPidRef.current, pidAfter: next ? next.pid : null })) {
            window.location.reload()
          }
        })
        .catch(() => { restartLostRef.current = true })
    }, RESTART_POLL_MS)
    return () => clearInterval(timer)
  }, [restarting])

  function onRefresh() {
    markBusy('refresh', true)
    post(REFRESH_URL)
      .then((next) => { setStatus(next); setError(null) })
      .catch((refreshError) => setError('检查失败:' + (refreshError && refreshError.message ? refreshError.message : String(refreshError))))
      .then(() => markBusy('refresh', false))
  }

  function onChannel(channel) {
    markBusy('channel', true)
    post(CHANNEL_URL, { channel })
      .then((next) => { setStatus(next); setError(null) })
      .catch((channelError) => {
        setError('切换失败:' + (channelError && channelError.message ? channelError.message : String(channelError)))
        return load()
      })
      .then(() => markBusy('channel', false))
  }

  // 设置编辑公共提交链:校验通过后 POST 持久化,成功以响应快照刷新,失败回读兜底
  function submitEdit(url, body, busyKey, onSaveError) {
    markBusy(busyKey, true)
    post(url, body)
      .then((next) => { setStatus(next); setError(null) })
      .catch((saveError) => {
        setError(onSaveError(saveError))
        return load()
      })
      .then(() => markBusy(busyKey, false))
  }

  function onTemplateSave(template) {
    const text = typeof template === 'string' ? template.trim() : ''
    // 空输入即恢复默认:输入框留空时以 placeholder 展示默认命令,保存空 = 回到默认模板
    submitEdit(TEMPLATE_URL, { template: text.length > 0 ? text : DEFAULT_UPGRADE_TEMPLATE }, 'template', (error) => '保存失败:' + (error && error.message ? error.message : String(error)))
  }

  function onPollInterval(raw) {
    const text = typeof raw === 'string' ? raw.trim() : ''
    // 空输入即恢复默认:输入框留空时以 placeholder 展示默认间隔
    if (text.length === 0) {
      submitEdit(POLL_INTERVAL_URL, { seconds: DEFAULT_POLL_INTERVAL_SEC }, 'pollInterval', (error) => '保存失败:' + (error && error.message ? error.message : String(error)))
      return
    }
    const seconds = Number(text)
    if (!Number.isFinite(seconds) || seconds < 0) {
      setError('轮询间隔必须是不小于 0 的秒数')
      return
    }
    submitEdit(POLL_INTERVAL_URL, { seconds }, 'pollInterval', (error) => '保存失败:' + (error && error.message ? error.message : String(error)))
  }

  // 与 host 的 isValidRegistryBase 同源:client 半区无法 import ESM,修改需两处同步。
  // LOGIC-BEGIN isValidRegistryBase
  function isValidRegistryBase(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value.trim())
  }
  // LOGIC-END isValidRegistryBase

  function onRegistryBase(raw) {
    const base = typeof raw === 'string' ? raw.trim() : ''
    // 空输入即恢复默认:输入框留空时以 placeholder 展示官方源
    if (base.length === 0) {
      submitEdit(REGISTRY_BASE_URL, { base: DEFAULT_REGISTRY_BASE }, 'registryBase', (error) => '保存失败:' + (error && error.message ? error.message : String(error)))
      return
    }
    if (!isValidRegistryBase(base)) {
      setError('registry 基地址必须以 http:// 或 https:// 开头')
      return
    }
    submitEdit(REGISTRY_BASE_URL, { base }, 'registryBase', (error) => '保存失败:' + (error && error.message ? error.message : String(error)))
  }

  function onUpgrade() {
    if (!upgradeArmed) {
      setUpgradeArmed(true)
      setRestartArmed(false)
      return
    }
    setUpgradeArmed(false)
    markBusy('upgrade', true)
    post(UPGRADE_URL)
      .then((next) => {
        setStatus(next); setError(null)
        // 升级转后台执行:观察器接管状态跟踪与完成提示,页面可离开
        ensureUpgradeWatch()
      })
      .catch((upgradeError) => setError('升级触发失败:' + (upgradeError && upgradeError.message ? upgradeError.message : String(upgradeError))))
      .then(() => markBusy('upgrade', false))
  }

  function onRestart() {
    if (restartPendingRef.current) return
    if (!restartArmed) {
      setRestartArmed(true)
      setUpgradeArmed(false)
      return
    }
    setRestartArmed(false)
    setError(null)
    // 宿主重启后内存快照归零,升级观察与浮条随重启作废
    stopUpgradeWatch()
    removeUpgradeFloat()
    restartLostRef.current = false
    restartPidRef.current = status && typeof status.pid === 'number' ? status.pid : null
    // 先取实时 status 修正 pid 基线(页面可能经历过一次未经面板感知的宿主重启),失败退回已有快照
    restartPendingRef.current = true
    api(STATUS_URL, { signal: AbortSignal.timeout(RESTART_POLL_TIMEOUT_MS) })
      .then((fresh) => {
        if (fresh && typeof fresh.pid === 'number') restartPidRef.current = fresh.pid
      })
      .catch(() => {})
      .then(() => {
        setRestarting(true)
        return post(RESTART_URL)
      })
      .catch((restartError) => {
        // 网络层失败(TypeError/中止)是宿主退出窗口切断连接的预期中间态,置失联并入等待态轮询;
        // 业务错误(409/401/500 等)宿主仍在,展示原文,不得进入等待态(等待态会把失联误判为已重启)
        if (isNetworkFailure(restartError)) {
          restartLostRef.current = true
          setRestarting(true)
          return
        }
        setRestarting(false)
        setError('重启失败:' + (restartError && restartError.message ? restartError.message : String(restartError)))
      })
      .then(() => { restartPendingRef.current = false })
  }

  if (status === null) {
    return h('div', { className: 'dm-panel' },
      h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
      h('span', { className: 'dm-meta' }, error !== null ? '读取失败' : '加载中…'),
      error !== null ? h('div', { className: 'dm-notice dm-notice--error' }, error) : null)
  }

  return h('div', { className: 'dm-panel' },
    h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
    h('div', { className: 'dm-head' },
      h('span', { className: 'dm-head__title' }, '版本与运维'),
      h('span', { className: 'dm-head__hint' }, '追踪 npm 新版本,一键升级,安全重启'),
    ),
    restarting ? h('div', { className: 'dm-notice dm-notice--warn' },
      '重启指令已发送,宿主正在退出;恢复后本页自动刷新,请勿关闭页面。') : null,
    status !== null && status.pollRunning === false ? h('div', { className: 'dm-notice dm-notice--warn' },
      '自动轮询未运行(宿主定时服务不可用);可手动点「检查更新」,其余能力不受影响。') : null,
    error !== null ? h('div', { className: 'dm-notice dm-notice--error' }, error) : null,
    h(VersionCard, {
      status,
      busy,
      upgradeArmed,
      restartArmed,
      restarting,
      onRefresh,
      onChannel,
      onTemplateSave,
      onUpgrade,
      onRestart,
    }),
    h(SettingsCard, {
      status,
      busy,
      restarting,
      onPollInterval,
      onRegistryBase,
    }),
    h(UpgradeCard, { status, restartArmed, restarting, onRestart }),
    h(OpsCard, { status, armed: restartArmed, restarting, onRestart }),
  )
}

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'maintain', order: 45, label: '版本与运维' },
            () => React.createElement(MaintainApp),
          ))
      },
    }
  },
})

