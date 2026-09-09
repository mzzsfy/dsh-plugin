// dsh-maintain Client 半区:settings.section 设置页面板,版本监测 + 一键升级 + 安全重启。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 由 DSH client runtime 模块表解析;
// 浏览器半区经 webServer 路由('/api/maintain/*')访问 Host,样式随组件内联渲染。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-maintain',
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
      else console.warn('[dsh-maintain] ' + text)
    }

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
// 主文档连续就绪拍数门槛:单次 200 可能落在 fallback 刚注册的瞬间,连续多次确认启动链稳定
const RESTART_READY_REQUIRED = 2
// 刷新放行后的最后缓冲:给宿主启动链一段无请求干扰的稳定期再整页刷新
const RESTART_SETTLE_DELAY_MS = 1 * 1000
// 页面就绪探测目标:与整页刷新后浏览器实际请求的主文档同资源
const INDEX_URL = '/'
const NPM_VERSIONS_URL = 'https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions'

// abort-aware 睡眠:轮询顺序循环的拍间间隔,中止即提前唤醒
function restartSleep(ms, controller) {
  return new Promise((resolve) => {
    const done = () => {
      controller.signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, ms)
    controller.signal.addEventListener('abort', done)
  })
}

// 错误分类:重启 POST 失败后是否应视为"宿主失联"继续等待。
// 无应答(TypeError/abort)属失联;502-504 网关错误发生在宿主退出窗口内,同样属失联——
// 只有网关可达、宿主应答的状态(409 互斥/500 能力缺失等)才是活宿主的明确回绝。
// LOGIC-BEGIN restartPostLost
function restartPostLost(error) {
  const hasStatus = error !== null && typeof error === 'object' && typeof error.status === 'number'
  if (!hasStatus) return true
  return error.status >= 502 && error.status <= 504
}
// LOGIC-END restartPostLost

// 判定常量与 host 侧 core.mjs 保持一致:client 半区无法 import ESM,
// test/parity.test.mjs 按 const 名正则提取对拍,修改任一侧必须同步。
const VERDICT_OUTDATED = 'outdated'
const VERDICT_UP_TO_DATE = 'up-to-date'
const VERDICT_UNKNOWN = 'unknown'

// 非 2xx 应答抛带 status 与完整 payload 的错误对象:调用方据此区分"活宿主明确回绝"(有 status)
// 与"网络失联"(fetch reject TypeError/abort DOMException,无 status);payload 供活跃工作
// 409 回绝回写 items 计数
// LOGIC-BEGIN apiError
function apiError(response, payload) {
  const error = new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
  error.status = response.status
  error.payload = payload === undefined || payload === null ? {} : payload
  return error
}
// LOGIC-END apiError

async function api(url, options) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw apiError(response, payload)
  return payload
}

function post(url, body) {
  return api(url, { method: 'POST', body: body === undefined ? '{}' : JSON.stringify(body) })
}

// 升级观察器:模块级单例,升级进行中每拍拉取状态并广播,组件挂载与否不影响;
// 发现任意一拍不在进行中即升级落定,展示结果浮条后停止轮询;
// 总时长上限覆盖宿主重试链上限(尝试次数×单次超时+退避+强杀宽限,见 parity 对拍):
// 超限说明宿主或进程管理器异常,浮条转状态未知。
// 代际令牌防重叠拍:顺序自调度(settle 后排下一拍),单请求带超时,stop 后迟到拍经验代际丢弃
const UPGRADE_WATCH_MAX_MS = 32 * 60 * 1000
const UPGRADE_POLL_TIMEOUT_MS = 5 * 1000
// 落定补查宽限:宿主自动重启调度延迟与观察裕量之和(parity 对拍提取形态限单项乘积)
const UPGRADE_AUTO_RESTART_GRACE_MS = 5 * 1000
const upgradeWatch = { generation: null, startedAt: 0, listeners: new Set() }

function broadcastUpgradeStatus(status) {
  for (const listener of upgradeWatch.listeners) listener(status)
}

function stopUpgradeWatch() {
  upgradeWatch.generation = null
}

// 落定补查:延迟窗口后单拍重拉状态并广播(驱动自动重启接管守卫),按标记终判;
// 补查前后验让位——新一轮升级观察已启动即放弃,其自身落定拍会终判
async function recheckUpgradeSettle(previousLast) {
  let final = null
  try {
    final = await api(STATUS_URL, { signal: AbortSignal.timeout(UPGRADE_POLL_TIMEOUT_MS) })
  } catch {
    final = null
  }
  if (upgradeWatch.generation !== null) return
  if (final !== null) broadcastUpgradeStatus(final)
  const last = final !== null && final.upgrade ? final.upgrade.last : null
  if (last !== null && (last.autoRestartScheduled === true || last.requiresManualRestart === true)) showUpgradeFloat(last)
  else showUpgradeFloat(previousLast)
}

function subscribeUpgradeStatus(listener) {
  upgradeWatch.listeners.add(listener)
  return () => upgradeWatch.listeners.delete(listener)
}

function ensureUpgradeWatch() {
  if (upgradeWatch.generation !== null) return
  const generation = {}
  upgradeWatch.generation = generation
  upgradeWatch.startedAt = Date.now()
  showUpgradeFloat(null)
  let pollFailures = 0
  const tick = async () => {
    if (upgradeWatch.generation !== generation) return
    if (Date.now() - upgradeWatch.startedAt >= UPGRADE_WATCH_MAX_MS) {
      upgradeWatch.generation = null
      showUpgradeFloat('unknown')
      return
    }
    try {
      const next = await api(STATUS_URL, { signal: AbortSignal.timeout(UPGRADE_POLL_TIMEOUT_MS) })
      if (upgradeWatch.generation !== generation) return
      pollFailures = 0
      broadcastUpgradeStatus(next)
      const upgrade = next ? next.upgrade : null
      if (!upgrade || upgrade.running !== true) {
        upgradeWatch.generation = null
        // 快照归零(last 为空)不做失败渲染,保持进行中文案,由重启流程接管
        if (upgrade && upgrade.last) {
          // 落定拍可能早于宿主置调度标记:未见标记不立即终判,延迟宽限后补查一拍
          if (upgrade.last.autoRestartScheduled === true || upgrade.last.requiresManualRestart === true) {
            showUpgradeFloat(upgrade.last)
            return
          }
          setTimeout(() => {
            if (upgradeWatch.generation !== null) return
            void recheckUpgradeSettle(upgrade.last)
          }, UPGRADE_AUTO_RESTART_GRACE_MS)
        }
        return
      }
    } catch (pollError) {
      if (upgradeWatch.generation !== generation) return
      pollFailures += 1
      // 失败限频:首条与之后每 15 条(约 30 秒)一条,防宿主重启窗口刷屏
      if (pollFailures === 1 || pollFailures % 15 === 0) {
        console.warn('[dsh-maintain] 升级状态轮询失败: ' + (pollError && pollError.message ? pollError.message : String(pollError)))
      }
    }
    if (upgradeWatch.generation === generation) setTimeout(tick, UPGRADE_POLL_MS)
  }
  tick()
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

// 升级成功落定的浮条终态文案:stale(执行成功但目标未达成)最优先且不得提及重启,
// 其后按宿主是否自动重启分流指引
// LOGIC-BEGIN upgradeFinalText
function upgradeFinalText(state) {
  if (state.stale === true) return '升级命令执行完成,但磁盘版本未前进或未达目标,详情见版本与运维页'
  if (state.requiresManualRestart === true) return '升级完成,当前为手动直跑环境,请手动重启宿主后生效'
  if (state.autoRestartScheduled === true) return '升级完成,宿主将自动重启,页面恢复后可直接使用'
  return '升级完成,重启宿主后生效(版本与运维页可重启)'
}
// LOGIC-END upgradeFinalText

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
    text.textContent = upgradeFinalText(state)
  } else if (state.stillRunning === true) {
    // 强杀后进程树疑似仍存活:升级入口已由锁锁定直至过期,不做"可重跑"的误导指引
    text.textContent = '升级超时已终止;旧进程可能仍在运行,升级入口已锁定直至其退出或锁过期'
  } else if (state.timedOut === true) {
    // 超时强杀即包管理器被中途杀死,全局目录可能半写,提示先验证再重启
    text.textContent = '升级超时已终止;安装可能只完成一半,重启宿主前请先确认命令需否重跑'
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
      h('span', { className: 'dm-row__label' }, '版本'),
      h('span', null, '运行 ' + (status.runningVersion || '未知') + ' / 已装 ' + (status.installedVersion || '未知')),
      h(VerdictBadge, { status }),
      h('span', { className: 'dm-spacer' }),
      h('button', {
        className: 'dm-btn',
        disabled: props.busy.refresh || props.restarting,
        onClick: props.onRefresh,
      }, props.busy.refresh ? '检查中…' : '刷新'),
      h('button', {
        className: 'dm-btn',
        // upgradeLockHeld 为 host 权威信号(锁文件时效化):升级进行中或残留锁未过期时禁用;
        // 运行版本已是通道最新时同样禁用(host 侧同步 409 拒绝,防重装降级)
        disabled: props.busy.upgrade || props.restarting || (status.upgrade && status.upgrade.running)
          || status.upgradeLockHeld === true
          || status.verdict === VERDICT_UP_TO_DATE,
        title: status.verdict === VERDICT_UP_TO_DATE ? '当前已是通道最新版,无需升级;重装请走命令行' : undefined,
        onClick: props.onUpgrade,
      }, props.upgradeArmed ? '确认升级' : '升级'),
    ),
    status.restartPending === true
      ? h('div', { className: 'dm-notice dm-notice--warn' },
          '已装新版本 ' + (status.installedVersion || '') + ',重启宿主后生效。')
      : null,
    h('div', { className: 'dm-row' },
      h('span', { className: 'dm-row__label' }, '追踪通道'),
      tagNames.length > 0
        // 持久化通道不在通道表中(registry 侧删 tag/换镜像):作为标注项保留在 select 内,
        // 保留切换出口(否则通道切换能力不可达,只能手改 settings.yaml)
        ? h('select', {
            className: 'dm-select',
            value: tagNames.indexOf(status.channel) >= 0 ? status.channel : tagNames[0],
            onChange: (e) => props.onChannel(e.target.value),
            disabled: props.busy.channel || props.restarting,
          }, (tagNames.indexOf(status.channel) >= 0 ? [] : [status.channel]).concat(tagNames)
            .map((name) => h('option', { key: name, value: name }, name
              + (name === status.channel && tagNames.indexOf(name) < 0 ? '  (不在通道表中,请重新选择)' : '')
              + (tags[name] ? '  (' + tags[name] + ')' : ''))))
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
          // stale(执行成功但版本未前进/未达目标)时成功行降格为中性表述,不引导重启,
          // 与下方 stale 警告行自洽
          last.ok ? h('span', { className: last.stale === true ? 'dm-warn' : 'dm-ok' },
              last.stale === true ? '升级命令执行完成,但版本未前进或未达目标' : '升级完成,重启宿主后生效')
            : h('span', { className: 'dm-error' }, '升级失败'
                + (last.code !== null && last.code !== undefined ? '(退出码 ' + last.code + ')' : '')
                + (Array.isArray(last.attempts) && last.attempts.length > 1 ? '(已尝试 ' + last.attempts.length + ' 次)' : '')
                + (last.timedOut ? ',已超时终止;安装可能只完成一半,重启前先确认命令需否重跑' : '')),
          h('span', { className: 'dm-spacer' }),
          last.ok && last.stale !== true ? h('button', {
            className: 'dm-btn',
            // 与 OpsCard 入口行为归一:appExit 缺失时必然 500,不得开放重启入口
            disabled: props.restarting || !props.status.canRestart,
            onClick: props.onRestart,
          }, restartConfirmLabel(props.restartArmed, props.activeWorkTotal)) : null,
        )
      : null,
    !upgrade.running && last && last.ok === true && last.stale === true
      ? h('div', { className: 'dm-row' },
          h('span', { className: 'dm-warn' }, '磁盘版本未前进或未达目标: ' + (last.reason || '镜像可能滞后')))
      : null,
    !upgrade.running && last && !last.ok && last.stderrTail
      ? h('pre', { className: 'dm-pre' }, last.stderrTail)
      : null,
  )
}

// 重启确认按钮文案:armed 且有活跃计数时改「仍要重启」,点发即带 force 越过门控
// LOGIC-BEGIN restartConfirmLabel
function restartConfirmLabel(armed, activeWorkTotal) {
  if (!armed) return '重启宿主'
  return activeWorkTotal > 0 ? '仍要重启(' + activeWorkTotal + ' 项活跃工作)' : '确认重启'
}
// LOGIC-END restartConfirmLabel

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
      }, restartConfirmLabel(props.armed, props.activeWorkTotal)),
      !status.canRestart ? h('span', { className: 'dm-meta' }, '当前启动方式不支持就地重启') : null,
    ),
    h('div', { className: 'dm-meta' },
      '重启依赖进程管理器(pm2 / systemd / supervisord / Kubernetes / 容器等)自动拉起;手动终端启动的进程不会自动恢复。',
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
  // 重启探测的跨拍状态快照 {lost,pid,bootAt,readyStreak}:lost 与 readyStreak 随拍更新,
  // pid/bootAt 保持确认时刻基线不可被拍结果覆盖,否则重启判定恒 false;null=未在等待态
  const restartPrevRef = useRef(null)
  const restartPendingRef = useRef(false)
  // 自动重启接管防重入:接管无 POST 在途语义(restartPendingRef),需独立一次性令牌
  const autoRestartTakenRef = useRef(false)

  function markBusy(key, value) {
    setBusy((prev) => Object.assign({}, prev, { [key]: value }))
  }

  function load() {
    return api(STATUS_URL)
      .then((next) => { setStatus(next); setError(null); return next })
      .catch((loadError) => { setError('读取状态失败:' + (loadError && loadError.message ? loadError.message : String(loadError))); return null })
  }

  // 挂载即订阅观察器快照,页面刷新落在升级进行中时恢复浮条与观察;
  // 订阅回调(落定拍)与初始 load 快照(刷新落在调度窗口)两路同走接管守卫
  useEffect(() => {
    const unsubscribe = subscribeUpgradeStatus((snapshot) => {
      if (snapshot !== null) setStatus(snapshot)
      takeOverAutoRestart(snapshot)
    })
    void load().then((next) => {
      if (next !== null) takeOverAutoRestart(next)
      if (next !== null && next.upgrade !== null && next.upgrade.running === true) ensureUpgradeWatch()
    })
    return unsubscribe
  }, [])

  // 自动重启接管守卫:快照带调度标记且未在等待/接管态时,以该快照为基线自动进入
  // 重启等待(复用 restartTick 探测,无需用户点击);autoRestartTakenRef 防多拍重入
  function takeOverAutoRestart(snapshot) {
    if (snapshot === null || snapshot.autoRestartScheduled !== true) return
    if (restartPendingRef.current === true || autoRestartTakenRef.current === true) return
    autoRestartTakenRef.current = true
    beginRestartWait({ lost: false, pid: snapshot.pid, bootAt: snapshot.bootAt, readyStreak: 0 })
  }

  function beginRestartWait(baseline) {
    restartPrevRef.current = baseline
    setError(null)
    setRestarting(true)
  }

  // 重启判定与 core.mjs shouldReloadAfterRestart 同源:client 半区无法 import ESM,修改需两处同步。
  // prev/next 均为 {lost,pid,bootAt} 快照:lost=经历失联(强信号);bootAt=宿主进程启动时刻,
  // 变化即重启(容器 pid 恒 1 场景的唯一可靠信号);pid 比对为 bootAt 缺失时的退化路径
  // LOGIC-BEGIN shouldReloadAfterRestart
  function shouldReloadAfterRestart(prev, next) {
    if (prev.lost) return true
    if (typeof prev.bootAt === 'number' && typeof next.bootAt === 'number') return prev.bootAt !== next.bootAt
    return typeof prev.pid === 'number' && typeof next.pid === 'number' && prev.pid !== next.pid
  }
  // LOGIC-END shouldReloadAfterRestart

  // LOGIC-BEGIN pageReady
  function pageReady(pageFetch) {
    return pageFetch.then(
      (response) => Boolean(response && response.ok)
        && /^text\/html\b/i.test(String(response.headers.get('content-type') || '')),
      () => false,
    )
  }
  // LOGIC-END pageReady

  // LOGIC-BEGIN restartTick
  // 重启等待的单拍决策:超时收尾;status 失败记失联;宿主重启判定通过后还须主文档可加载才刷新——
  // status 可达只证明 API 路由已注册,宿主页面服务的 fallback 注册晚于插件路由,
  // 该窗口期内整页刷新会拿到宿主裸 404;就绪须连续多拍确认(readyStreak 跨拍由调用方持有,
  // 任何失联/未确认/未就绪拍都清零),达标返回 reload,刷新动作由调用方延迟执行
  async function restartTick({ now, deadlineAt, prev, readyStreak, statusFetch, pageFetch }) {
    if (now >= deadlineAt) return { action: 'timeout', lost: prev.lost, readyStreak }
    let next
    try {
      next = await statusFetch()
    } catch {
      return { action: 'wait', lost: true, readyStreak: 0 }
    }
    const snapshot = { lost: false, pid: next ? next.pid : null, bootAt: next ? next.bootAt : null }
    if (!shouldReloadAfterRestart(prev, snapshot)) {
      return { action: 'wait', lost: prev.lost, readyStreak: 0 }
    }
    const ready = await pageReady(pageFetch())
    const streak = ready ? readyStreak + 1 : 0
    return { action: streak >= RESTART_READY_REQUIRED ? 'reload' : 'wait', lost: prev.lost, readyStreak: streak }
  }
  // LOGIC-END restartTick

  // 重启确认后顺序轮询(restartTick 拍决策):任意时刻至多一拍在途(settle 后排下一拍),
  // 消除 setInterval 重叠拍的失联标记回退与超时后迟到拍 reload 竞态;卸载经 AbortController 中止
  useEffect(() => {
    if (!restarting) {
      restartPrevRef.current = null
      return
    }
    const deadlineAt = Date.now() + RESTART_TIMEOUT_MS
    const controller = new AbortController()
    const probeSignal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(RESTART_POLL_TIMEOUT_MS)])
    ;(async () => {
      while (!controller.signal.aborted) {
        const prev = restartPrevRef.current
        if (prev === null) return
        const tick = await restartTick({
          now: Date.now(),
          deadlineAt,
          prev,
          readyStreak: prev.readyStreak,
          statusFetch: () => api(STATUS_URL, { signal: probeSignal() }),
          pageFetch: () => fetch(INDEX_URL, { cache: 'no-store', signal: probeSignal() }),
        })
        if (controller.signal.aborted) return
        // 基线不可变契约:仅回写 lost 与 readyStreak,pid/bootAt 保持确认时刻值(见 ref 注释)
        restartPrevRef.current = { ...prev, lost: tick.lost, readyStreak: tick.readyStreak }
        if (tick.action === 'reload') {
          // 刷新放行后的最后缓冲:中止即作废本次刷新(等待态已退出,页面归用户控制)
          await restartSleep(RESTART_SETTLE_DELAY_MS, controller)
          if (controller.signal.aborted) return
          window.location.reload()
          return
        }
        if (tick.action === 'timeout') {
          setRestarting(false)
          setError('重启未在 ' + RESTART_TIMEOUT_MS / 1000 + ' 秒内完成,宿主可能未被拉起,请检查进程管理器后手动刷新')
          return
        }
        await restartSleep(RESTART_POLL_MS, controller)
      }
    })()
    return () => controller.abort()
  }, [restarting])

  function onRefresh() {
    markBusy('refresh', true)
    post(REFRESH_URL)
      .then((next) => { setStatus(next); setError(null) })
      .catch((refreshError) => notify('检查失败:' + (refreshError && refreshError.message ? refreshError.message : String(refreshError)), 'error'))
      .then(() => markBusy('refresh', false))
  }

  function onChannel(channel) {
    markBusy('channel', true)
    post(CHANNEL_URL, { channel })
      .then((next) => { setStatus(next); setError(null) })
      .catch((channelError) => {
        notify('切换失败:' + (channelError && channelError.message ? channelError.message : String(channelError)), 'error')
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
        notify(onSaveError(saveError), 'error')
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
      notify('轮询间隔必须是不小于 0 的秒数', 'error')
      return
    }
    submitEdit(POLL_INTERVAL_URL, { seconds }, 'pollInterval', (error) => '保存失败:' + (error && error.message ? error.message : String(error)))
  }

  // 与 host 的 isValidRegistryBase 同源:client 半区无法 import ESM,修改需两处同步。
  // 拒绝带 query/hash 的输入:拼接 dist-tags API 路径时 search 会吞掉路径导致检查恒败
  // LOGIC-BEGIN isValidRegistryBase
  function isValidRegistryBase(value) {
    if (typeof value !== 'string') return false
    try {
      const parsed = new URL(value.trim())
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.search === '' && parsed.hash === ''
    } catch {
      return false
    }
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
      notify('registry 基地址须为 http(s) 地址且不带查询串或锚点', 'error')
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
      .catch((upgradeError) => notify('升级触发失败:' + (upgradeError && upgradeError.message ? upgradeError.message : String(upgradeError)), 'error'))
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
    restartPrevRef.current = {
      lost: false,
      pid: status && typeof status.pid === 'number' ? status.pid : null,
      bootAt: status && typeof status.bootAt === 'number' ? status.bootAt : null,
      readyStreak: 0,
    }
    // 先取实时 status 修正基线(页面可能经历过一次未经面板感知的宿主重启),失败退回已有快照
    restartPendingRef.current = true
    api(STATUS_URL, { signal: AbortSignal.timeout(RESTART_POLL_TIMEOUT_MS) })
      .then((fresh) => {
        if (fresh) {
          restartPrevRef.current = {
            lost: false,
            pid: typeof fresh.pid === 'number' ? fresh.pid : restartPrevRef.current.pid,
            bootAt: typeof fresh.bootAt === 'number' ? fresh.bootAt : restartPrevRef.current.bootAt,
            readyStreak: 0,
          }
        }
      })
      .catch(() => {})
      .then(() => {
        setRestarting(true)
        // 宿主重启后内存快照归零,升级观察与浮条随重启作废;
        // 放在受理成功之后:明确回绝(409 互斥)时升级仍在跑,观察器必须存活
        stopUpgradeWatch()
        removeUpgradeFloat()
        return post(RESTART_URL, activeWorkTotal > 0 ? { force: true } : undefined)
      })
      .catch((restartError) => {
        if (restartPostLost(restartError)) {
          // 无应答(连接失败/网关失联/中止)不构成宿主状态证据:视为失联继续等待,
          // 由恢复探测或总时长超时收尾
          if (restartPrevRef.current !== null) restartPrevRef.current = { ...restartPrevRef.current, lost: true }
          return
        }
        // 有应答的明确回绝(409 升级互斥/500 能力缺失等):宿主未退出,不得进入等待轮询,
        // 否则会凭"活宿主 + pageReady 恒真"误判已重启而整页刷新
        setRestarting(false)
        // 活跃工作回绝:保留确认态并回写计数(下一拍确认即可带 force)
        if (restartError && restartError.payload && restartError.payload.items) {
          setRestartArmed(true)
          void load()
          notify('存在活跃工作(共 ' + restartError.payload.items.total + ' 项),已保留确认态,再次点击将以 force 重启', 'error')
          return
        }
        notify('重启失败:' + (restartError && restartError.message ? restartError.message : String(restartError)), 'error')
      })
      .then(() => { restartPendingRef.current = false })
  }

  if (status === null) {
    return h('div', { className: 'dm-panel' },
      h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
      h('span', { className: 'dm-meta' }, error !== null ? '读取失败' : '加载中…'),
      error !== null ? h('div', { className: 'dm-notice dm-notice--error' }, error) : null)
  }

  // 升级入口不可用即解除两段式待发:渲染时派生,不引入 effect。
  // 不可用与 VersionCard 按钮 disabled 条件同源(升级进行中/残留锁/已最新/重启中)
  const upgradeUnavailable = restarting
    || (status !== null && ((status.upgrade && status.upgrade.running === true)
      || status.upgradeLockHeld === true
      || status.verdict === VERDICT_UP_TO_DATE))
  const upgradeArmedLive = upgradeArmed && !upgradeUnavailable
  // 活跃工作计数:重启确认态显示计数并发 force 越过门控
  const activeWorkTotal = status !== null && status.activeWork ? status.activeWork.total : 0

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
      upgradeArmed: upgradeArmedLive,
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
    h(UpgradeCard, { status, restartArmed, restarting, activeWorkTotal, onRestart }),
    h(OpsCard, { status, armed: restartArmed, restarting, activeWorkTotal, onRestart }),
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

