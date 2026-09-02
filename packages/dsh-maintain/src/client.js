// dsh-maintain Client 半区:settings.section 设置页面板,版本监测 + 一键升级 + 安全重启。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 由 DSH client runtime 模块表解析;
// 浏览器半区经 webServer 路由('/api/maintain/*')访问 Host,样式随组件内联渲染。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-maintain',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef } = React

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
const UPGRADE_URL = '/api/maintain/upgrade'
const RESTART_URL = '/api/maintain/restart'
const POLL_WHILE_UPGRADING_MS = 2 * 1000
const RESTART_POLL_MS = 1 * 1000
const RESTART_POLL_TIMEOUT_MS = 5 * 1000
const NPM_VERSIONS_URL = 'https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions'

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

// 版本区:当前版本、通道切换、通道最新版、结论、检查时间与错误、刷新与升级。
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
    ),
    h('div', { className: 'dm-row' },
      h('a', { className: 'dm-link', href: NPM_VERSIONS_URL, target: '_blank', rel: 'noreferrer' }, 'npm 版本页'),
      h('span', { className: 'dm-meta' }, '升级执行自定义命令,完成后需重启生效'),
    ),
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
  const timerRef = useRef(null)
  const restartLostRef = useRef(false)
  const restartPidRef = useRef(null)
  const restartPendingRef = useRef(false)

  function markBusy(key, value) {
    setBusy((prev) => Object.assign({}, prev, { [key]: value }))
  }

  function load() {
    return api(STATUS_URL)
      .then((next) => { setStatus(next); setError(null) })
      .catch((loadError) => setError('读取状态失败:' + (loadError && loadError.message ? loadError.message : String(loadError))))
  }

  useEffect(() => { void load() }, [])

  // 升级进行中每 2 秒轮询;结束后停止;重启态暂停(退出窗口的失败不得污染错误提示)。
  useEffect(() => {
    const running = !restarting && status !== null && status.upgrade !== null && status.upgrade.running === true
    if (running && timerRef.current === null) {
      timerRef.current = setInterval(() => { void load() }, POLL_WHILE_UPGRADING_MS)
    }
    if (!running && timerRef.current !== null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [status, restarting])

  // 重启判定与 core.mjs shouldReloadAfterRestart 同源:client 半区无法 import ESM,修改需两处同步。
  function shouldReloadAfterRestart(params) {
    if (params.lost) return true
    return typeof params.pidBefore === 'number' && typeof params.pidAfter === 'number' && params.pidBefore !== params.pidAfter
  }

  // 重启确认后轮询状态:退出窗口的请求失败是预期中间态,静默记入 ref 不展示错误;
  // 失联后恢复或宿主 pid 变化(快速重启零失联)即宿主已重启,整页刷新以加载新版本。
  useEffect(() => {
    if (!restarting) {
      restartLostRef.current = false
      restartPidRef.current = null
      return
    }
    const timer = setInterval(() => {
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

  function onUpgrade() {
    if (!upgradeArmed) {
      setUpgradeArmed(true)
      setRestartArmed(false)
      return
    }
    setUpgradeArmed(false)
    markBusy('upgrade', true)
    post(UPGRADE_URL)
      .then((next) => { setStatus(next); setError(null) })
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
    error !== null ? h('div', { className: 'dm-notice dm-notice--error' }, error) : null,
    h(VersionCard, {
      status,
      busy,
      upgradeArmed,
      restartArmed,
      restarting,
      onRefresh,
      onChannel,
      onUpgrade,
      onRestart,
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

