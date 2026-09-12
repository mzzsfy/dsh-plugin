(() => {
// 定时任务看板 client 半区:设置页三 Tab(看板/环境变量/日志)+ 任务与变量的完整 CRUD。
// 无构建:createElement + 一次性样式注入;IIFE 书挡,顶层零词法声明(经典 script 全局词法环境跨 bundle 共享)。
// 开关一律 cb-switch(规约 switch 形态);状态色语义以 STATUS_META 单一来源,与 core status-meta.mjs 镜像(parity 锁定)。

/* LOGIC-BEGIN */
const STATUS_META = {
  success: { label: '成功', tone: 'ok' },
  fail: { label: '失败', tone: 'bad' },
  timeout: { label: '超时', tone: 'warn' },
  skipped: { label: '跳过', tone: 'mute' },
  interrupted: { label: '中断', tone: 'mute' },
  running: { label: '运行中', tone: 'run' },
}
const TRIGGER_META = { cron: { label: '定时' }, manual: { label: '手动' } }
const KIND_LABELS = { shell: '脚本', session: '会话' }
const MODE_LABELS = { fresh: '每次新建', pinned: '固定会话' }
const STATUS_TONE_COLOR = { ok: '#22a06b', bad: '#e5484d', warn: '#f5a524', mute: '#8b8d98', run: '#3b82f6' }
const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const PAD2 = (value) => String(value).padStart(2, '0')

// 相对时间人话:未来「x 后」过去「x 前」
function relativeTime(timestamp, now) {
  if (typeof timestamp !== 'number' || !(timestamp > 0)) return '-'
  const delta = timestamp - now
  const abs = Math.abs(delta)
  const suffix = delta >= 0 ? '后' : '前'
  if (abs < MINUTE_MS) return Math.max(1, Math.round(abs / SECOND_MS)) + ' 秒' + suffix
  if (abs < HOUR_MS) return Math.round(abs / MINUTE_MS) + ' 分钟' + suffix
  if (abs < DAY_MS) return Math.round(abs / HOUR_MS) + ' 小时' + suffix
  return Math.round(abs / DAY_MS) + ' 天' + suffix
}

function formatDateTime(timestamp) {
  if (typeof timestamp !== 'number' || !(timestamp > 0)) return '-'
  const date = new Date(timestamp)
  return date.getFullYear() + '-' + PAD2(date.getMonth() + 1) + '-' + PAD2(date.getDate()) + ' ' + PAD2(date.getHours()) + ':' + PAD2(date.getMinutes())
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !(ms >= 0)) return '-'
  if (ms < SECOND_MS) return ms + 'ms'
  if (ms < MINUTE_MS) return (ms / SECOND_MS).toFixed(1) + 's'
  return Math.round(ms / MINUTE_MS) + 'min'
}

function statusMeta(status) {
  return STATUS_META[status] || { label: status || '-', tone: 'mute' }
}
/* LOGIC-END */

/* SBUILD-BEGIN */
// 调度构建器纯函数:与 src/schedule-builder.mjs 逐字镜像(parity 测试锁定),client 无模块系统只能内联。
// 仅覆盖构建器可表达的形态,反解不出即 custom(表达式原样手输);触发点计算归 croner(经 cron/preview 接口)。
const SB_FREQS = ['daily', 'weekly', 'weekdays', 'interval', 'custom']
const SB_WEEKDAY_ORDER = ['1', '2', '3', '4', '5', '6', '0']
const SB_WEEKDAY_LABELS = { '0': '日', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六' }
const SB_MINUTE_MAX = 59
const SB_HOUR_MAX = 23
const SB_INTERVAL_MIN_MINUTES = 1

function createScheduleState(expression) {
  return {
    freq: 'daily',
    hour: 9,
    minute: 0,
    weekdays: ['1'],
    intervalMinutes: 30,
    expression,
  }
}

const sbClampInt = (raw, min, max, fallback) => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) return fallback
  return value
}

// cron(5 段)→ 构建器状态:匹配失败即 custom;非法数值一律归 custom,不猜
function parseSchedule(expression) {
  const raw = String(expression).trim()
  const parts = raw.split(/\s+/)
  const state = createScheduleState(raw)
  if (parts.length !== 5) { state.freq = 'custom'; return state }
  const [minute, hour, day, month, weekday] = parts
  if (day !== '*' || month !== '*') { state.freq = 'custom'; return state }
  if (minute === '*' && hour === '*') { state.freq = 'custom'; return state }
  if (/^\*\/\d+$/.test(minute) && hour === '*') {
    state.freq = 'interval'
    state.intervalMinutes = sbClampInt(minute.slice(2), SB_INTERVAL_MIN_MINUTES, SB_MINUTE_MAX, 0)
    if (state.intervalMinutes === 0) state.freq = 'custom'
    return state
  }
  const hourNum = sbClampInt(hour, 0, SB_HOUR_MAX, NaN)
  const minuteNum = sbClampInt(minute, 0, SB_MINUTE_MAX, NaN)
  if (!Number.isInteger(hourNum) || !Number.isInteger(minuteNum)) { state.freq = 'custom'; return state }
  state.hour = hourNum
  state.minute = minuteNum
  if (weekday === '*') { state.freq = 'daily'; return state }
  if (weekday === '1-5') { state.freq = 'weekdays'; return state }
  const days = weekday.split(',')
  if (days.every((d) => /^\d$/.test(d) && d in SB_WEEKDAY_LABELS)) {
    state.freq = 'weekly'
    state.weekdays = SB_WEEKDAY_ORDER.filter((d) => days.includes(d))
    return state
  }
  state.freq = 'custom'
  return state
}

// 构建器状态 → cron;custom 直接返回手工表达式
function buildSchedule(state) {
  if (state.freq === 'custom') return String(state.expression).trim()
  const minute = String(state.minute)
  const hour = String(state.hour)
  if (state.freq === 'daily') return minute + ' ' + hour + ' * * *'
  if (state.freq === 'weekdays') return minute + ' ' + hour + ' * * 1-5'
  if (state.freq === 'weekly') return minute + ' ' + hour + ' * * ' + [...state.weekdays].sort((a, b) => Number(a) - Number(b)).join(',')
  if (state.freq === 'interval') return '*/' + state.intervalMinutes + ' * * * *'
  return String(state.expression).trim()
}
/* SBUILD-END */

const API_PREFIX = '/api/cron-board/'
const REFRESH_INTERVAL_MS = 30 * SECOND_MS
const TABS = [
  { value: 'jobs', label: '看板' },
  { value: 'envs', label: '环境变量' },
  { value: 'logs', label: '日志' },
]
const CRON_PRESETS = [
  { label: '每天 08:30', value: '30 8 * * *' },
  { label: '每天 22:00', value: '0 22 * * *' },
  { label: '每 30 分钟', value: '*/30 * * * *' },
  { label: '每 2 小时', value: '0 */2 * * *' },
  { label: '工作日 09:00', value: '0 9 * * 1-5' },
  { label: '每周一 09:00', value: '0 9 * * 1' },
  { label: '每月 1 日 00:00', value: '0 0 1 * *' },
]

const STYLE = `
/* 组件令牌层(形制对齐 dsh-im):宿主 dsw-alias 定义在 body 作用域,cb- 令牌必须在 body 声明才能解析到主题值;
   fallback 取浅色中性(dsh-im 同款),深色主题由令牌接管,fallback 只兜裸宿主 */
body{
--cb-bg:var(--dsw-alias-bg-layer-1,#ffffff);
--cb-bg-sub:var(--dsw-alias-bg-layer-2,#f7f8fa);
--cb-bg-muted:var(--dsw-alias-bg-module-platform,#f2f3f5);
--cb-border:var(--dsw-alias-border-l2,#e5e6eb);
--cb-border-strong:var(--dsw-alias-border-l3,#dfe1e5);
--cb-text:var(--dsw-alias-label-primary,#1f2329);
--cb-text-sub:var(--dsw-alias-label-secondary,#646a73);
--cb-text-dim:var(--dsw-alias-label-tertiary,#8f959e);
--cb-accent:#1677ff;
--cb-accent-deep:#0958d9;
--cb-accent-wash:#eaf3ff;
--cb-danger:var(--dsw-alias-state-error-primary,#d54941);
--cb-ok:var(--dsw-alias-state-success-primary,#20a162);
--cb-warn:var(--dsw-alias-state-warn-primary,#d97706);
--cb-hover:var(--dsw-alias-interactive-bg-hover,#f7f8fa);
--cb-mask:var(--dsw-alias-bg-mask-1,rgba(31,35,41,.5));
--cb-shadow:0 1px 2px rgb(31 35 41 / 4%);
--cb-radius-sm:6px;--cb-radius-md:8px;--cb-radius-lg:14px;
--cb-space-1:4px;--cb-space-2:6px;--cb-space-3:8px;--cb-space-4:10px;--cb-space-5:12px;--cb-space-6:18px;
--cb-font-xs:12px;--cb-font-sm:12px;--cb-font-md:13px;--cb-font-lg:15px;
--cb-control-h:30px;
}
.cb-panel{display:flex;flex-direction:column;gap:var(--cb-space-5);min-width:0;max-width:880px;color:var(--cb-text);container-type:inline-size}
.cb-toolbar{display:flex;align-items:center;gap:var(--cb-space-3);flex-wrap:wrap}
.cb-tabs{display:flex;gap:var(--cb-space-1);background:var(--cb-bg-muted);border-radius:999px;padding:3px}
.cb-pill{border:none;border-radius:999px;padding:5px 14px;font-size:var(--cb-font-md);background:transparent;color:var(--cb-text-sub);cursor:pointer;font-weight:560;transition:color .15s,background .15s}
.cb-pill:hover{color:var(--cb-text)}
.cb-pill--on{background:var(--cb-bg);color:var(--cb-text);box-shadow:var(--cb-shadow)}
.cb-pill--on:hover{color:var(--cb-text)}
.cb-spacer{flex:1}
.cb-button{min-height:var(--cb-control-h);display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--cb-border-strong);border-radius:var(--cb-radius-md);padding:0 13px;font:inherit;font-size:var(--cb-font-md);font-weight:560;background:var(--cb-bg);color:var(--cb-text);cursor:pointer;transition:border-color .15s,background .15s,color .15s}
.cb-button:hover:not(:disabled){border-color:#aeb3bb;background:var(--cb-hover)}
.cb-button:disabled{cursor:not-allowed;opacity:.55}
.cb-button--primary{background:var(--cb-accent);border-color:var(--cb-accent);color:#fff}
.cb-button--primary:hover:not(:disabled){background:var(--cb-accent-deep);border-color:var(--cb-accent-deep)}
.cb-button--danger{color:var(--cb-danger)}
.cb-button--danger:hover:not(:disabled){border-color:var(--cb-danger);background:var(--cb-danger);color:#fff}
.cb-button--sm{min-height:28px;padding:0 10px;font-size:var(--cb-font-sm)}
.cb-button:focus-visible,.cb-icon:focus-visible,.cb-pill:focus-visible,.cb-select:focus-visible,.cb-entry:focus-visible{outline:2px solid color-mix(in srgb, var(--cb-accent) 70%, white);outline-offset:2px}
.cb-button:active:not(:disabled){transform:translateY(1px)}
.cb-cards{display:flex;flex-direction:column;gap:var(--cb-space-3)}
.cb-card{position:relative;display:flex;flex-direction:column;gap:var(--cb-space-2);border:1px solid var(--cb-border);border-radius:var(--cb-radius-lg);padding:var(--cb-space-4) var(--cb-space-5);cursor:pointer;overflow:hidden;background:var(--cb-bg);box-shadow:var(--cb-shadow);transition:border-color .15s,box-shadow .15s}
.cb-card:hover{border-color:var(--cb-accent);box-shadow:0 2px 8px rgb(31 35 41 / 8%)}
.cb-card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3.5px;background:var(--cb-status,#aeb3bb)}
.cb-card-row{display:flex;align-items:center;gap:var(--cb-space-3);flex-wrap:wrap}
.cb-name{font-size:14px;font-weight:600;color:var(--cb-text)}
.cb-badge{min-height:22px;display:inline-flex;align-items:center;padding:0 9px;border-radius:999px;color:var(--cb-text-sub);background:var(--cb-bg-muted);font-size:var(--cb-font-sm);white-space:nowrap}
.cb-dot{width:8px;height:8px;border-radius:50%;background:var(--cb-status,#aeb3bb);flex:none}
.cb-meta{font-size:var(--cb-font-sm);color:var(--cb-text-sub)}
.cb-actions{display:flex;align-items:center;gap:var(--cb-space-2);margin-left:auto}
.cb-icon{min-height:28px;border:none;background:transparent;color:var(--cb-text-sub);cursor:pointer;font-size:var(--cb-font-sm);padding:0 8px;border-radius:var(--cb-radius-sm);transition:background .15s,color .15s}
.cb-icon:hover{background:var(--cb-hover);color:var(--cb-text)}
.cb-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer;gap:var(--cb-space-2)}
.cb-switch input[type="checkbox"] { position:absolute;opacity:0;width:1px;height:1px }
.cb-switch__track{width:30px;height:17px;border-radius:999px;background:#aeb3bb;position:relative;transition:background .15s;flex:none}
.cb-switch__thumb{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.cb-switch input[type="checkbox"]:checked + .cb-switch__track{background:var(--cb-accent)}
.cb-switch input[type="checkbox"]:checked + .cb-switch__track .cb-switch__thumb{left:15px}
.cb-switch input[type="checkbox"]:focus-visible + .cb-switch__track{outline:2px solid color-mix(in srgb, var(--cb-accent) 70%, white);outline-offset:1px}
.cb-switch input[type="checkbox"]:disabled + .cb-switch__track{opacity:.4;cursor:not-allowed}
.cb-switch:not(:has(input[type="checkbox"]:disabled)):hover .cb-switch__track{background:var(--cb-accent-deep);opacity:.85}
.cb-switch input[type="checkbox"]:checked:not(:disabled) + .cb-switch__track:hover{background:var(--cb-accent-deep)}
/* 设置>插件页卡片(cb-pc):镜像官方 PluginCard/SubagentModelSelectionCard 形制,数值与令牌直取官方 CSS Module;
   官方壳未导出,slot 契约声明卡片外观归插件自持,同页同 dsw-alias 令牌即同观感(含深色主题) */
.cb-pc{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}
.cb-pc:hover{border-color:var(--dsw-alias-label-dimmed)}
.cb-pc--open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.cb-pc__head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.cb-pc__head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.cb-pc__text{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.cb-pc__name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.cb-pc__desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.cb-pc__chevron{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex;transition:transform .16s}
.cb-pc--open .cb-pc__chevron{transform:rotate(180deg)}
.cb-pc__body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.cb-pc__row{gap:6px;padding:12px 0;display:grid}
.cb-pc__rowLine{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:flex-start;gap:16px;font-size:13px;line-height:1.5;display:flex}
.cb-pc__rowLabel{flex:1;min-width:0}
.cb-pc__hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.cb-table{display:flex;flex-direction:column;gap:var(--cb-space-1);font-size:var(--cb-font-md)}
.cb-row{display:flex;align-items:center;gap:var(--cb-space-3);border:1px solid var(--cb-border);border-radius:var(--cb-radius-md);padding:var(--cb-space-2) var(--cb-space-4);flex-wrap:wrap;transition:background .15s,border-color .15s}
.cb-row:hover{background:var(--cb-hover)}
.cb-code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:var(--cb-font-sm);color:var(--cb-text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.cb-mask{color:var(--cb-text-sub)}
.cb-modal-mask{position:fixed;inset:0;background:var(--cb-mask);display:flex;align-items:center;justify-content:center;z-index:60;animation:cb-fade-in .16s ease-out}
.cb-modal{background:var(--cb-bg);color:var(--cb-text);border-radius:var(--cb-radius-lg);padding:var(--cb-space-6);max-width:640px;width:min(640px,94vw);max-height:90vh;overflow:auto;display:flex;flex-direction:column;gap:14px;box-shadow:0 12px 40px rgb(31 35 41 / 18%);animation:cb-pop-in .2s ease-out}
@keyframes cb-fade-in{from{opacity:0}to{opacity:1}}
@keyframes cb-pop-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.cb-modal-mask,.cb-modal{animation:none}.cb-card,.cb-row,.cb-button,.cb-pill,.cb-icon,.cb-switch__track,.cb-pc,.cb-pc__chevron{transition:none}}
.cb-modal-head{display:flex;align-items:center;justify-content:space-between;gap:var(--cb-space-3);padding-bottom:var(--cb-space-2);border-bottom:1px solid var(--cb-border)}
.cb-modal-title{font-size:16px;font-weight:600}
.cb-modal-body{display:flex;flex-direction:column;gap:var(--cb-space-4)}
.cb-section{display:flex;flex-direction:column;gap:var(--cb-space-2)}
.cb-section-title{font-size:var(--cb-font-sm);font-weight:600;color:var(--cb-text);display:flex;align-items:center;gap:var(--cb-space-2)}
.cb-section-title::before{content:'';width:3px;height:12px;border-radius:2px;background:var(--cb-accent)}
.cb-grid{display:grid;grid-template-columns:1fr 1fr;gap:var(--cb-space-3) var(--cb-space-4)}
.cb-field{display:flex;flex-direction:column;gap:4px;font-size:var(--cb-font-sm);min-width:0;color:var(--cb-text-sub)}
.cb-field--wide{grid-column:1 / -1}
.cb-field input[type="text"],.cb-field input[type="number"],.cb-field textarea,.cb-field select{min-height:30px;border:1px solid var(--cb-border-strong);border-radius:var(--cb-radius-md);padding:4px 10px;font:inherit;font-size:var(--cb-font-md);background:var(--cb-bg);color:var(--cb-text);min-width:0;transition:border-color .15s,box-shadow .15s}
.cb-field input:focus,.cb-field textarea:focus,.cb-field select:focus{outline:none;border-color:var(--cb-accent);box-shadow:0 0 0 3px var(--cb-accent-wash)}
.cb-field textarea{min-height:64px;resize:vertical;font-family:inherit}
.cb-hint{font-size:var(--cb-font-xs);color:var(--cb-text-dim)}
.cb-preview{font-size:var(--cb-font-sm);border:1px dashed var(--cb-border-strong);border-radius:var(--cb-radius-md);padding:var(--cb-space-2) var(--cb-space-3);color:var(--cb-text-sub);background:var(--cb-accent-wash);border-color:color-mix(in srgb, var(--cb-accent) 35%, transparent);color:var(--cb-text)}
/* —— 表单 v2:统一分段组件 + 调度构建器(设计稿 .superdesign/shots/7、8 锁定形态)—— */
/* seg:类型/会话模式/调度频率共用同一形态,禁止另起多套选择样式 */
.cb-seg{display:inline-flex;gap:2px;background:var(--cb-bg-muted);border-radius:8px;padding:2px;width:fit-content}
.cb-seg__opt{border:none;background:transparent;border-radius:6px;padding:5px 11px;font:inherit;font-size:var(--cb-font-sm);font-weight:520;color:var(--cb-text-sub);cursor:pointer;line-height:1.2;white-space:nowrap;transition:background .15s,color .15s}
.cb-seg__opt:hover{color:var(--cb-text)}
.cb-seg__opt--on{background:var(--cb-accent);color:#fff;font-weight:560}
.cb-seg__opt--on:hover{color:#fff}
.cb-seg__opt:focus-visible{outline:2px solid color-mix(in srgb, var(--cb-accent) 70%, white);outline-offset:1px}
/* 调度构建器:极浅洗底面板,收纳频率/上下文/表达式/预览 */
.cb-builder{background:var(--cb-bg-sub);border:1px solid var(--cb-border);border-radius:10px;padding:var(--cb-space-5);display:flex;flex-direction:column;gap:10px}
.cb-bline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.cb-blabel{font-size:var(--cb-font-sm);color:var(--cb-text-sub);flex:none}
.cb-time{width:44px;text-align:center;font-variant-numeric:tabular-nums}
.cb-colon{color:var(--cb-text-dim);font-size:var(--cb-font-sm)}
.cb-expr{font-family:ui-monospace,SFMono-Regular,monospace;font-size:var(--cb-font-sm);background:var(--cb-bg);border:1px solid var(--cb-border);border-radius:6px;padding:4px 9px;color:var(--cb-text);display:inline-flex;align-items:center;min-width:0}
.cb-expr input{border:none;background:transparent;font:inherit;color:var(--cb-text);padding:0;width:9em}
.cb-expr input:focus{outline:none}
.cb-linkbtn{border:none;background:transparent;color:var(--cb-accent);font:inherit;font-size:var(--cb-font-sm);font-weight:520;cursor:pointer;padding:0}
.cb-linkbtn:hover{color:var(--cb-accent-deep)}
.cb-runs{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.cb-run{display:inline-flex;align-items:center;gap:5px;font-size:var(--cb-font-xs);color:var(--cb-text-sub);background:var(--cb-bg);border:1px solid var(--cb-border);border-radius:999px;padding:3px 9px;white-space:nowrap}
.cb-run::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--cb-accent);flex:none}
.cb-run + .cb-run::before{background:var(--cb-text-dim)}
/* 紧凑行组:名称+类型 / 策略单行 */
.cb-formrow{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.cb-formrow > .cb-field{flex:1;min-width:180px}
.cb-formrow > .cb-field--fit{flex:0 0 auto;min-width:0}
/* 运行策略单行:标题+开关+内联数字段同一行 */
.cb-inline{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.cb-inlinesection{font-size:var(--cb-font-sm);font-weight:600;color:var(--cb-text);display:inline-flex;align-items:center;gap:6px}
.cb-inlinesection::before{content:'';width:3px;height:11px;border-radius:2px;background:var(--cb-accent)}
.cb-if{display:inline-flex;align-items:center;gap:6px}
.cb-if > .cb-field{flex-direction:row;align-items:center;gap:6px}
.cb-if input[type="number"]{width:104px}
.cb-log{font-family:ui-monospace,SFMono-Regular,monospace;font-size:var(--cb-font-sm);white-space:pre-wrap;word-break:break-all;background:var(--cb-bg-sub);border-radius:var(--cb-radius-md);padding:var(--cb-space-3);max-height:320px;overflow:auto}
.cb-empty{font-size:var(--cb-font-md);color:var(--cb-text-dim);padding:var(--cb-space-6) 0;text-align:center;display:flex;flex-direction:column;align-items:center;gap:var(--cb-space-3)}
.cb-select{min-height:30px;border:1px solid var(--cb-border-strong);border-radius:var(--cb-radius-md);padding:4px 8px;font:inherit;font-size:var(--cb-font-md);background:var(--cb-bg);color:var(--cb-text)}
.cb-confirm-text{font-size:var(--cb-font-md);color:var(--cb-text);line-height:1.5}
.cb-log::-webkit-scrollbar,.cb-modal::-webkit-scrollbar{width:8px;height:8px}
.cb-log::-webkit-scrollbar-thumb,.cb-modal::-webkit-scrollbar-thumb{background:var(--cb-border-strong);border-radius:999px}
.cb-log::-webkit-scrollbar-track,.cb-modal::-webkit-scrollbar-track{background:transparent}
.cb-error{font-size:var(--cb-font-sm);color:var(--cb-danger);background:var(--cb-bg-sub);border-left:3px solid var(--cb-danger);border-radius:var(--cb-radius-sm);padding:var(--cb-space-2) var(--cb-space-3)}
/* 容器查询:better-sidebar tab 与主视图宽度差异大,跟随面板自身宽度而非视口。
   模态不受面板容器宽度连累:mask 固定定位于视口,断点用视口媒体查询独立判定 */
@container (max-width: 560px){
.cb-card-row .cb-actions{margin-left:0;width:100%;justify-content:flex-end;flex-wrap:wrap}
.cb-view{padding:var(--cb-space-4)}
.cb-panel{gap:var(--cb-space-4)}
}
@media (max-width: 560px){
.cb-grid{grid-template-columns:1fr}
.cb-modal{max-height:92vh}
}
.cb-entry{display:flex;align-items:center;gap:var(--cb-space-3);width:100%;border:none;background:transparent;color:inherit;cursor:pointer;padding:var(--cb-space-2) var(--cb-space-4);border-radius:var(--cb-radius-md);font-size:var(--cb-font-md);text-align:left}
.cb-entry:hover{background:var(--cb-hover)}
.cb-entry[data-active="true"]{background:var(--cb-accent);color:#fff}
.cb-entry-icon{display:inline-flex;flex:none}
.cb-view{display:none;flex:1;min-height:0;flex-direction:column;padding:var(--cb-space-6);overflow:auto;background:var(--dsw-alias-bg-base,var(--cb-bg))}
.cb-view > .cb-panel{margin:0 auto;width:100%}
html[data-cb-board-active] [data-cb-view]{display:flex}
html[data-cb-board-active] [data-pane="conversation"] > :not([data-cb-view]){display:none !important}
html[data-cb-board-active] [class*="centerCol"] > :not([data-cb-view]){display:none !important}
html[data-cb-board-active] .dshDesktopConversationSurface > :not([data-cb-view]){display:none !important}
`

// 空模块兜底:react 缺席即整面板禁用(宿主必有 react,防御性)
function noopFactory() {
  return { inject: [], apply() {} }
}

if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({ id: '@mzzsfy/dsh-cron-board', factory })

  function factory(require) {
    let React = null
    let ReactDOMClient = null
    try {
      React = require('react')
      ReactDOMClient = require('react-dom/client')
    } catch {
      return noopFactory()
    }
    const { useState, useEffect, useRef, useCallback } = React
    const h = (type, props, ...children) => React.createElement(type, props ?? null, ...children)

    // 数据请求:统一 envelope,error 透传中文业务文案
    async function request(method, endpoint, body) {
      let response
      try {
        response = await fetch(API_PREFIX + endpoint, {
          method,
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) }
      }
      let json = null
      try { json = await response.json() } catch { json = null }
      if (!response.ok) return { ok: false, error: json && json.error ? json.error : '请求失败(' + response.status + ')' }
      return { ok: true, data: json }
    }

    function ensureStyle(document) {
      const existing = document.getElementById('dsh-cron-board-style')
      if (existing) return
      const style = document.createElement('style')
      style.id = 'dsh-cron-board-style'
      style.textContent = STYLE
      document.head.appendChild(style)
    }

    // 规约 switch:input 锚定状态选择器,视觉由 track+thumb 呈现
    function switchToggle(props) {
      return h('label', { className: 'cb-switch' },
        h('input', { type: 'checkbox', checked: props.checked, disabled: props.disabled, onChange: props.onChange,
          'aria-label': props.ariaLabel }),
        h('span', { className: 'cb-switch__track' }, h('span', { className: 'cb-switch__thumb' })),
        props.label ? h('span', { className: 'cb-meta' }, props.label) : null)
    }

    function PillGroup({ options, value, onChange }) {
      return h('div', { className: 'cb-tabs' },
        options.map((option) => h('button', {
          key: option.value,
          className: 'cb-pill' + (option.value === value ? ' cb-pill--on' : ''),
          onClick: () => onChange(option.value),
        }, option.label)))
    }

    function Field({ label, hint, wide, fit, children }) {
      return h('div', { className: 'cb-field' + (wide ? ' cb-field--wide' : '') + (fit ? ' cb-field--fit' : '') },
        h('span', null, label),
        children,
        hint ? h('span', { className: 'cb-hint' }, hint) : null)
    }

    function Modal({ title, onClose, children, width }) {
      const bodyRef = useRef(null)
      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        const first = bodyRef.current && bodyRef.current.querySelector('input, textarea, select')
        if (first) first.focus()
        return () => document.removeEventListener('keydown', onKey)
      }, [])
      return h('div', { className: 'cb-modal-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'cb-modal', style: width ? { width: 'min(' + width + 'px, 92vw)' } : null },
          h('div', { className: 'cb-modal-head' },
            h('span', { className: 'cb-modal-title' }, title),
            h('button', { className: 'cb-icon', 'aria-label': '关闭', onClick: onClose }, '✕')),
          h('div', { className: 'cb-modal-body', ref: bodyRef }, children)))
    }

    // 节标题:表单分区渐进披露(基础/执行/调度)
    function Section({ title, children }) {
      return h('div', { className: 'cb-section' },
        h('div', { className: 'cb-section-title' }, title),
        children)
    }

    // —— 任务表单(新建/编辑)——
    // v2 布局(设计稿 shots/7、8 锁定):统一分段组件(cb-seg)承担类型/会话模式/调度频率切换;
    // 调度构建器洗底面板:结构化频率生成表达式,反解不出即 custom 手输;触发点预览仍归后端 cron/preview。
    function Segmented({ options, value, onChange, ariaLabel, multi, selected }) {
      // multi:周几类多选切换;与单选共用同一 DOM/CSS 形态,仅选中判定不同
      const isOn = (optionValue) => (multi ? selected.includes(optionValue) : optionValue === value)
      return h('div', { className: 'cb-seg', role: 'group', 'aria-label': ariaLabel },
        options.map((option) => h('button', {
          key: option.value,
          type: 'button',
          'aria-pressed': multi ? isOn(option.value) : undefined,
          className: 'cb-seg__opt' + (isOn(option.value) ? ' cb-seg__opt--on' : ''),
          onClick: () => onChange(option.value),
        }, option.label)))
    }

    const FREQ_OPTIONS = [
      { value: 'daily', label: '每天' },
      { value: 'weekly', label: '每周' },
      { value: 'weekdays', label: '工作日' },
      { value: 'interval', label: '固定间隔' },
      { value: 'custom', label: '自定义' },
    ]

    // 调度构建器面板:频率分段 + 上下文选择器 + 表达式芯片 + 即将执行 chips
    function ScheduleBuilder({ scheduleState, onStateChange, preview }) {
      const state = scheduleState
      const setFreq = (freq) => onStateChange({ ...state, freq })
      const patchClock = (field, raw) => {
        const value = Math.max(0, Math.min(field === 'hour' ? SB_HOUR_MAX : SB_MINUTE_MAX, Number(raw) || 0))
        onStateChange({ ...state, [field]: value })
      }
      const toggleWeekday = (day) => {
        const days = state.weekdays.includes(day)
          ? state.weekdays.filter((d) => d !== day)
          : SB_WEEKDAY_ORDER.filter((d) => state.weekdays.includes(d) || d === day)
        if (days.length === 0) return
        onStateChange({ ...state, weekdays: days })
      }
      const clockRow = (h('div', { className: 'cb-bline' },
        h('span', { className: 'cb-blabel' }, '执行时间'),
        h('input', { type: 'number', className: 'cb-time', min: 0, max: SB_HOUR_MAX, value: state.hour, onChange: (e) => patchClock('hour', e.target.value) }),
        h('span', { className: 'cb-colon' }, ':'),
        h('input', { type: 'number', className: 'cb-time', min: 0, max: SB_MINUTE_MAX, value: state.minute, onChange: (e) => patchClock('minute', e.target.value) }),
        h('span', { className: 'cb-hint' }, state.freq === 'weekdays' ? '周一至周五在指定时刻运行' : state.freq === 'weekly' ? '所选星期在指定时刻运行' : '按天在指定时刻运行')))
      const intervalRow = (h('div', { className: 'cb-bline' },
        h('span', { className: 'cb-blabel' }, '间隔'),
        h('input', { type: 'number', className: 'cb-time', min: SB_INTERVAL_MIN_MINUTES, max: SB_MINUTE_MAX, value: state.intervalMinutes, onChange: (e) => onStateChange({ ...state, intervalMinutes: Math.max(SB_INTERVAL_MIN_MINUTES, Number(e.target.value) || SB_INTERVAL_MIN_MINUTES) }) }),
        h('span', { className: 'cb-hint' }, '分钟,每 N 分钟运行一次')))
      const customRow = (h('div', { className: 'cb-bline' },
        h('span', { className: 'cb-blabel' }, '表达式'),
        h('input', { type: 'text', value: state.expression, placeholder: '分 时 日 月 周', onChange: (e) => onStateChange({ ...state, expression: e.target.value }) }),
        h('span', { className: 'cb-hint' }, '分 时 日 月 周;预设: ' + CRON_PRESETS.slice(0, 3).map((p) => p.label + ' ' + p.value).join(' / '))))
      return h('div', { className: 'cb-builder' },
        h(Segmented, { options: FREQ_OPTIONS, value: state.freq, onChange: setFreq, ariaLabel: '调度频率' }),
        state.freq === 'interval' ? intervalRow : null,
        state.freq === 'custom' ? customRow : clockRow,
        state.freq === 'weekly'
          ? h('div', { className: 'cb-bline' },
              h('span', { className: 'cb-blabel' }, '星期'),
              h(Segmented, {
                multi: true,
                selected: state.weekdays,
                options: SB_WEEKDAY_ORDER.map((d) => ({ value: d, label: SB_WEEKDAY_LABELS[d] })),
                onChange: toggleWeekday,
                ariaLabel: '星期',
              }))
          : null,
        h('div', { className: 'cb-bline' },
          h('span', { className: 'cb-blabel' }, '生成表达式'),
          h('span', { className: 'cb-expr' }, buildSchedule(state)),
          state.freq === 'custom'
            ? null
            : h('button', { type: 'button', className: 'cb-linkbtn', onClick: () => setFreq('custom') }, '自定义'),
          state.freq === 'custom' ? null : h('span', { className: 'cb-hint' }, '由上方选择自动生成')),
        h('div', { className: 'cb-bline' },
          h('span', { className: 'cb-blabel' }, '即将执行'),
          preview
            ? h('span', { className: 'cb-runs' }, preview.nextAt.map((at) => h('span', { key: at, className: 'cb-run' }, formatDateTime(at))))
            : h('span', { className: 'cb-hint' }, '表达式非法或计算中')))
    }

    function JobForm({ job, onDone, wsModel }) {
      // 工作区清单:订阅 model 快照(服务缺失或形态不符即空表,仅保留手输)
      const [wsItems, setWsItems] = useState(() => (wsModel ? wsModel.getSnapshot().items || [] : []))
      useEffect(() => {
        if (!wsModel) return undefined
        const update = () => setWsItems(wsModel.getSnapshot().items || [])
        update()
        return wsModel.subscribe(update)
      }, [wsModel])
      const editing = Boolean(job && job.id)
      const initialSchedule = job ? job.schedule : '0 9 * * *'
      const [form, setForm] = useState(() => ({
        name: job ? job.name : '',
        kind: job ? job.kind : 'shell',
        command: job ? job.command : '',
        prompt: job ? job.prompt : '',
        workdir: job ? job.workdir : '',
        schedule: initialSchedule,
        timeoutMs: job ? job.timeoutMs : 60 * 60 * 1000,
        runOnce: job ? job.runOnce === true : false,
        concurrency: job && job.concurrency ? String(job.concurrency) : '',
        enabled: job ? job.enabled : true,
        session: {
          mode: job && job.session ? job.session.mode : 'fresh',
          pinnedSessionId: job && job.session ? job.session.pinnedSessionId : '',
          agentPreset: job && job.session ? job.session.agentPreset : '',
        },
      }))
      // 构建器状态:由既有表达式反解初始化;结构化变更写回 form.schedule
      const [scheduleState, setScheduleState] = useState(() => parseSchedule(initialSchedule))
      const [preview, setPreview] = useState(null)
      const [error, setError] = useState(null)
      const [saving, setSaving] = useState(false)
      const [presetCatalog, setPresetCatalog] = useState({ defaultId: '', items: [] })
      const set = (patch) => setForm((prev) => ({ ...prev, ...patch }))
      const setSession = (patch) => setForm((prev) => ({ ...prev, session: { ...prev.session, ...patch } }))
      const applyScheduleState = (next) => {
        setScheduleState(next)
        set({ schedule: buildSchedule(next) })
      }

      // 执行预设目录:会话任务表单打开时拉取一次;服务缺失即空目录,仅「跟随宿主默认」可选
      useEffect(() => {
        let alive = true
        request('GET', 'agent-presets').then((outcome) => {
          if (alive && outcome.ok && outcome.data && Array.isArray(outcome.data.items)) setPresetCatalog(outcome.data)
        })
        return () => { alive = false }
      }, [])

      useEffect(() => {
        let alive = true
        const timer = setTimeout(async () => {
          const outcome = await request('POST', 'cron/preview', { schedule: form.schedule })
          if (alive) setPreview(outcome.ok ? outcome.data : null)
        }, 300)
        return () => { alive = false; clearTimeout(timer) }
      }, [form.schedule])

      const submit = async () => {
        if (saving) return
        setSaving(true)
        setError(null)
        const payload = { ...form }
        payload.concurrency = form.concurrency === '' ? undefined : Number(form.concurrency)
        payload.session = form.kind === 'session' ? form.session : undefined
        const outcome = await request(editing ? 'PATCH' : 'POST', editing ? 'jobs/' + job.id : 'jobs', payload)
        setSaving(false)
        if (outcome.ok) onDone()
        else setError(outcome.error)
      }

      return h(Modal, { title: editing ? '编辑任务' : '新建任务', onClose: onDone, width: 640 },
        h('div', { className: 'cb-formrow' },
          h(Field, { label: '名称' }, h('input', { type: 'text', value: form.name, onChange: (e) => set({ name: e.target.value }) })),
          h(Field, { label: '类型', fit: true }, h(Segmented, {
            options: [{ value: 'shell', label: KIND_LABELS.shell }, { value: 'session', label: KIND_LABELS.session }],
            value: form.kind,
            onChange: (kind) => set({ kind }),
            ariaLabel: '类型',
          }))),
        h(Section, { title: '调度计划' },
          h(ScheduleBuilder, { scheduleState, onStateChange: applyScheduleState, preview })),
        form.kind === 'shell'
          ? h(Section, { title: '运行配置(shell)' },
              h(Field, { label: '命令', hint: '经由宿主 shell 执行,支持环境变量插值 $NAME' },
                h('input', { type: 'text', value: form.command, onChange: (e) => set({ command: e.target.value }) })),
              h('div', { className: 'cb-formrow' },
                h(Field, { label: '工作目录(可空)' }, h('input', { type: 'text', value: form.workdir, onChange: (e) => set({ workdir: e.target.value }) }))))
          : h(Section, { title: '运行配置(会话)' },
              h('div', { className: 'cb-formrow' },
                h(Field, {
                  label: '工作区(会话 cwd,可空)',
                  hint: wsItems.length > 0 ? '从宿主工作区选择,或留空使用默认目录' : '留空使用宿主默认目录;填入路径则会话在该目录下创建',
                },
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    wsItems.length > 0
                      ? h('select', {
                          className: 'cb-select',
                          value: wsItems.some((w) => w.path === form.workdir) ? form.workdir : '',
                          onChange: (e) => set({ workdir: e.target.value }),
                        },
                          h('option', { value: '' }, '默认目录'),
                          wsItems.map((w) => h('option', { key: w.path || w.workspaceId, value: w.path }, w.title || w.path)))
                      : null,
                    h('input', { type: 'text', placeholder: '或手输路径', value: form.workdir, onChange: (e) => set({ workdir: e.target.value }) }))),
                h(Field, { label: '会话模式', fit: true },
                  h(Segmented, {
                    options: [{ value: 'fresh', label: MODE_LABELS.fresh }, { value: 'pinned', label: MODE_LABELS.pinned }],
                    value: form.session.mode,
                    onChange: (mode) => setSession({ mode }),
                    ariaLabel: '会话模式',
                  })),
                form.session.mode === 'pinned'
                  ? h(Field, { label: '固定会话 ID(可空)', hint: '首跑自动绑定' },
                      h('input', { type: 'text', value: form.session.pinnedSessionId, onChange: (e) => setSession({ pinnedSessionId: e.target.value }) }))
                  : null),
              h(Field, { label: '执行预设', hint: '会话使用的 Agent Preset;跟随宿主默认时由宿主解析当前默认' },
                h('select', {
                  className: 'cb-select',
                  value: presetCatalog.items.some((item) => item.id === form.session.agentPreset) ? form.session.agentPreset : '',
                  onChange: (e) => setSession({ agentPreset: e.target.value }),
                },
                  h('option', { value: '' }, '跟随宿主默认'),
                  presetCatalog.items.map((item) => h('option', { key: item.id, value: item.id }, item.label)))),
              h(Field, { label: '任务文本', hint: '投递给会话的任务内容,环境变量会折叠在文本前部' },
                h('textarea', { value: form.prompt, onChange: (e) => set({ prompt: e.target.value }) }))),
        h('div', { className: 'cb-inline' },
          h('span', { className: 'cb-inlinesection' }, '运行策略'),
          switchToggle({ checked: form.runOnce, onChange: (e) => set({ runOnce: e.target.checked }), label: '单次运行' }),
          form.kind === 'shell'
            ? h('span', { className: 'cb-if' },
                h('span', { className: 'cb-blabel' }, '超时'),
                h('input', { type: 'number', value: form.timeoutMs, title: '毫秒,超时即中断并标记失败', onChange: (e) => set({ timeoutMs: Number(e.target.value) }) }),
                h('span', { className: 'cb-hint' }, 'ms'))
            : null,
          form.kind === 'shell'
            ? h('span', { className: 'cb-if' },
                h('span', { className: 'cb-blabel' }, '并发上限'),
                h('input', { type: 'number', value: form.concurrency, style: { width: 72 }, title: '限制该任务同时进行的执行数,可空', onChange: (e) => set({ concurrency: e.target.value }) }))
            : null,
          form.kind === 'session' ? h('span', { className: 'cb-hint' }, '会话任务投递即完成,无超时与并发语义') : null),
        error ? h('div', { className: 'cb-error' }, error) : null,
        h('div', { className: 'cb-toolbar' },
          h('button', { className: 'cb-button', onClick: onDone }, '取消'),
          h('div', { className: 'cb-spacer' }),
          switchToggle({ checked: form.enabled, onChange: (e) => set({ enabled: e.target.checked }), label: '启用' }),
          h('button', { className: 'cb-button cb-button--primary', disabled: saving, onClick: submit }, saving ? '保存中…' : '保存')))
    }

    function JobCard({ job, now, onToggle, onRun, onEdit, onDelete }) {
      const meta = statusMeta(job.lastStatus)
      const style = { '--cb-status': STATUS_TONE_COLOR[meta.tone] }
      return h('div', { className: 'cb-card', style, role: 'button', tabIndex: 0, onClick: onEdit },
        h('div', { className: 'cb-card-row' },
          h('span', { className: 'cb-dot' }),
          h('span', { className: 'cb-name' }, job.name),
          h('span', { className: 'cb-badge' }, KIND_LABELS[job.kind] || job.kind),
          job.kind === 'session' && job.session ? h('span', { className: 'cb-badge' }, MODE_LABELS[job.session.mode]) : null,
          h('div', { className: 'cb-actions', onClick: (event) => event.stopPropagation() },
            switchToggle({ checked: Boolean(job.enabled), onChange: onToggle }),
            h('button', { className: 'cb-button cb-button--primary cb-button--sm', disabled: !job.enabled, title: job.enabled ? '立即运行' : '已停用', onClick: onRun }, '运行'),
            h('button', { className: 'cb-icon', title: '编辑', onClick: onEdit }, '编辑'),
            h('button', { className: 'cb-icon cb-button--danger', title: '删除', onClick: onDelete }, '删除'))),
        h('div', { className: 'cb-card-row' },
          h('span', { className: 'cb-meta' }, job.lastStatus ? meta.label : '未运行'),
          h('span', { className: 'cb-meta' }, job.summary || job.schedule),
          typeof job.nextRunAt === 'number' && job.enabled ? h('span', { className: 'cb-meta' }, '下次 ' + relativeTime(job.nextRunAt, now)) : null,
          typeof job.lastDurationMs === 'number' ? h('span', { className: 'cb-meta' }, '耗时 ' + formatDuration(job.lastDurationMs)) : null),
        h('div', { className: 'cb-code' }, job.kind === 'session' ? job.prompt : job.command))
    }

    // 应用内删除确认(替换 window.confirm:风格统一 + ESC 可取消)
    function ConfirmDialog({ message, onConfirm, onCancel }) {
      return h(Modal, { title: '删除确认', onClose: onCancel, width: 420 },
        h('div', { className: 'cb-confirm-text' }, message),
        h('div', { className: 'cb-toolbar' },
          h('div', { className: 'cb-spacer' }),
          h('button', { className: 'cb-button', onClick: onCancel }, '取消'),
          h('button', { className: 'cb-button cb-button--danger', onClick: onConfirm }, '删除')))
    }

    function JobsTab({ jobs, status, now, reload, wsModel }) {
      const [formJob, setFormJob] = useState(null)
      const [notice, setNotice] = useState(null)
      const [kindFilter, setKindFilter] = useState('all')
      const [pendingDelete, setPendingDelete] = useState(null)

      const runJob = async (job) => {
        const outcome = await request('POST', 'jobs/' + job.id + '/run')
        setNotice(outcome.ok ? '已发起 ' + outcome.data.runIds.length + ' 个运行' : outcome.error)
        setTimeout(reload, 300)
      }
      const toggleJob = async (job) => {
        await request('PATCH', 'jobs/' + job.id, { enabled: !job.enabled })
        reload()
      }
      const deleteJob = async (job) => {
        await request('DELETE', 'jobs/' + job.id)
        setPendingDelete(null)
        setNotice('已删除「' + job.name + '」')
        reload()
      }

      const visible = jobs.filter((job) => kindFilter === 'all' || job.kind === kindFilter)
        .sort((a, b) => (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0))
      return h('div', { className: 'cb-panel' },
        h('div', { className: 'cb-toolbar' },
          h(PillGroup, {
            options: [{ value: 'all', label: '全部' }, { value: 'shell', label: KIND_LABELS.shell }, { value: 'session', label: KIND_LABELS.session }],
            value: kindFilter,
            onChange: setKindFilter,
          }),
          h('div', { className: 'cb-spacer' }),
          status && !status.timerRunning ? h('span', { className: 'cb-badge', style: { color: 'var(--cb-danger)' } }, status.timerReason || '调度停用') : null,
          h('button', { className: 'cb-button cb-button--primary', onClick: () => setFormJob({}) }, '新建任务')),
        notice ? h('div', { className: 'cb-hint' }, notice) : null,
        visible.length === 0
          ? h('div', { className: 'cb-empty' },
              h('div', null, kindFilter === 'all' ? '还没有定时任务' : '该类型下暂无任务'),
              h('button', { className: 'cb-button', onClick: () => setFormJob({}) }, '新建任务'))
          : h('div', { className: 'cb-cards' },
              visible.map((job) => h(JobCard, {
                key: job.id, job, now,
                onToggle: () => toggleJob(job),
                onRun: () => runJob(job),
                onEdit: () => setFormJob(job),
                onDelete: () => setPendingDelete(job),
              }))),
        pendingDelete ? h(ConfirmDialog, {
          message: '删除任务「' + pendingDelete.name + '」?运行记录与日志一并清除,操作不可撤销。',
          onConfirm: () => deleteJob(pendingDelete),
          onCancel: () => setPendingDelete(null),
        }) : null,
        formJob ? h(JobForm, { job: formJob.id ? formJob : null, wsModel, onDone: () => { setFormJob(null); reload() } }) : null)
    }

    // —— 环境变量 Tab ——
    // —— 环境变量表单(新建/编辑)——
    // 编辑经明文单条接口回填:列表接口的 value 已打码,直接回填保存会覆盖真实值
    function EnvForm({ row, onDone }) {
      const editing = Boolean(row && row.id)
      const [form, setForm] = useState(() => ({
        name: row ? row.name : '',
        value: row ? row.value : '',
        remarks: row ? row.remarks : '',
        multi: row ? row.multi : false,
        enabled: row ? row.enabled : true,
      }))
      const [error, setError] = useState(null)
      useEffect(() => {
        if (!editing) return
        let alive = true
        request('GET', 'envs/' + row.id).then((outcome) => {
          if (!alive) return
          if (outcome.ok) setForm((prev) => ({ ...prev, value: outcome.data.value }))
          else setError('读取变量明文失败:' + outcome.error)
        })
        return () => { alive = false }
      }, [editing, row && row.id])
      const set = (patch) => setForm((prev) => ({ ...prev, ...patch }))
      const submit = async () => {
        setError(null)
        const payload = { ...form }
        if (form.multi) payload.values = form.value.split('\n').map((line) => line.trim()).filter(Boolean)
        const outcome = await request(editing ? 'PATCH' : 'POST', editing ? 'envs/' + row.id : 'envs', payload)
        if (outcome.ok) onDone()
        else setError(outcome.error)
      }
      return h(Modal, { title: editing ? '编辑变量' : '新建变量', onClose: onDone, width: 520 },
        h('div', { className: 'cb-grid' },
          h(Field, { label: '名称' }, h('input', { type: 'text', value: form.name, onChange: (e) => set({ name: e.target.value }) })),
          h(Field, { label: '备注(可空)' }, h('input', { type: 'text', value: form.remarks, onChange: (e) => set({ remarks: e.target.value }) })),
          h(Field, { label: '值', wide: true, hint: '勾选多值后每行一个值,运行时按同名多值展开' },
            form.multi
              ? h('textarea', { value: form.value, onChange: (e) => set({ value: e.target.value }) })
              : h('input', { type: 'text', value: form.value, onChange: (e) => set({ value: e.target.value }) })),
          h('div', { className: 'cb-field' }, switchToggle({ checked: form.multi, onChange: (e) => set({ multi: e.target.checked }), label: '多值' })),
        ),
        error ? h('div', { className: 'cb-error' }, error) : null,
        h('div', { className: 'cb-toolbar' },
          h('button', { className: 'cb-button', onClick: onDone }, '取消'),
          h('div', { className: 'cb-spacer' }),
          switchToggle({ checked: form.enabled, onChange: (e) => set({ enabled: e.target.checked }), label: '启用' }),
          h('button', { className: 'cb-button cb-button--primary', onClick: submit }, '保存')))
    }

    function ImportForm({ onDone, reload }) {
      const [text, setText] = useState('')
      const [preview, setPreview] = useState(null)
      const [error, setError] = useState(null)
      const doPreview = async () => {
        const outcome = await request('POST', 'envs/import', { text, apply: false })
        if (outcome.ok) setPreview(outcome.data)
        else setError(outcome.error)
      }
      const doApply = async (overwrite) => {
        const outcome = await request('POST', 'envs/import', { text, apply: true, overwrite })
        if (outcome.ok) { onDone(); reload() } else setError(outcome.error)
      }
      return h(Modal, { title: '导入环境变量', onClose: onDone, width: 560 },
        h('div', { className: 'cb-field cb-field--wide' },
          h('textarea', { style: { minHeight: '120px' }, placeholder: 'NAME=value #备注', value: text, onChange: (e) => setText(e.target.value) })),
        preview ? h('div', { className: 'cb-preview' },
          '解析 ' + preview.parsed.length + ' 条,非法 ' + preview.invalid + ' 条') : null,
        error ? h('div', { className: 'cb-error' }, error) : null,
        h('div', { className: 'cb-toolbar' },
          h('button', { className: 'cb-button', onClick: onDone }, '取消'),
          h('div', { className: 'cb-spacer' }),
          h('button', { className: 'cb-button', onClick: doPreview }, '预览'),
          h('button', { className: 'cb-button', onClick: () => doApply(false) }, '追加导入'),
          h('button', { className: 'cb-button cb-button--danger', onClick: () => doApply(true) }, '覆盖导入')))
    }

    function EnvsTab({ envs, reload }) {
      const [formRow, setFormRow] = useState(null)
      const [importing, setImporting] = useState(false)
      const [exportText, setExportText] = useState(null)
      const [notice, setNotice] = useState(null)

      const toggleEnv = async (row) => {
        await request('PATCH', 'envs/' + row.id, { enabled: !row.enabled })
        reload()
      }
      const deleteEnv = async (row) => {
        if (!window.confirm('删除变量「' + row.name + '」?')) return
        await request('DELETE', 'envs/' + row.id)
        reload()
      }
      const doExport = async () => {
        const outcome = await request('GET', 'envs/export')
        if (outcome.ok) setExportText(outcome.data.text)
      }

      return h('div', { className: 'cb-panel' },
        h('div', { className: 'cb-toolbar' },
          h('div', { className: 'cb-spacer' }),
          h('button', { className: 'cb-button', onClick: doExport }, '导出'),
          h('button', { className: 'cb-button', onClick: () => setImporting(true) }, '导入'),
          h('button', { className: 'cb-button cb-button--primary', onClick: () => setFormRow({}) }, '新建变量')),
        notice ? h('div', { className: 'cb-hint' }, notice) : null,
        envs.length === 0 ? h('div', { className: 'cb-empty' }, '暂无环境变量') :
          h('div', { className: 'cb-table' },
            envs.map((row) => h('div', { key: row.id, className: 'cb-row' },
              switchToggle({ checked: Boolean(row.enabled), onChange: () => toggleEnv(row) }),
              h('span', { className: 'cb-code' }, row.name),
              h('span', { className: 'cb-code cb-mask' }, row.value),
              row.remarks ? h('span', { className: 'cb-meta' }, '# ' + row.remarks) : null,
              row.multi ? h('span', { className: 'cb-badge' }, '多值') : null,
              h('div', { className: 'cb-actions' },
                h('button', { className: 'cb-icon', onClick: () => setFormRow(row) }, '编辑'),
                h('button', { className: 'cb-icon cb-button--danger', onClick: () => deleteEnv(row) }, '删除'))))),
        formRow ? h(EnvForm, { row: formRow.id ? formRow : null, onDone: () => { setFormRow(null); reload() } }) : null,
        importing ? h(ImportForm, { onDone: () => setImporting(false), reload }) : null,
        exportText !== null ? h(Modal, { title: '导出(仅启用行)', onClose: () => setExportText(null) },
          h('div', { className: 'cb-field cb-field--wide' }, h('textarea', { readOnly: true, value: exportText, style: { minHeight: '160px' } })),
          h('div', { className: 'cb-toolbar' },
            h('button', { className: 'cb-button', onClick: () => { setNotice(null); navigator.clipboard && navigator.clipboard.writeText(exportText).then(() => setNotice('已复制到剪贴板')) } }, '复制'),
            h('div', { className: 'cb-spacer' }),
            h('button', { className: 'cb-button', onClick: () => setExportText(null) }, '关闭'))) : null)
    }

    // —— 日志 Tab ——
    function LogsTab({ jobs, reload, reloadFlag }) {
      const [jobId, setJobId] = useState(jobs.length > 0 ? jobs[0].id : null)
      const [runs, setRuns] = useState([])
      const [logText, setLogText] = useState(null)
      const [logRunId, setLogRunId] = useState(null)

      useEffect(() => {
        let alive = true
        if (!jobId) { setRuns([]); return undefined }
        request('GET', 'runs?jobId=' + encodeURIComponent(jobId)).then((outcome) => {
          if (alive && outcome.ok) setRuns(outcome.data.items)
        })
        return () => { alive = false }
      }, [jobId, reloadFlag])

      const openLog = async (run) => {
        const outcome = await request('GET', 'runs/' + run.runId + '/log')
        if (outcome.ok) { setLogRunId(run.runId); setLogText(outcome.data.text) }
      }
      const clearLog = async (run) => {
        await request('DELETE', 'runs/' + run.runId + '/log')
        setLogText(null)
        setLogRunId(null)
        reload()
      }

      return h('div', { className: 'cb-panel' },
        h('div', { className: 'cb-toolbar' },
          h('select', { className: 'cb-select', value: jobId || '', onChange: (e) => setJobId(e.target.value) },
            jobs.map((job) => h('option', { key: job.id, value: job.id }, job.name)))),
        runs.length === 0 ? h('div', { className: 'cb-empty' }, '该任务暂无运行记录') :
          h('div', { className: 'cb-table' },
            runs.map((run) => {
              const meta = statusMeta(run.status)
              return h('div', { key: run.runId, className: 'cb-row' },
                h('span', { className: 'cb-dot', style: { '--cb-status': STATUS_TONE_COLOR[meta.tone] } }),
                h('span', { className: 'cb-meta' }, meta.label),
                h('span', { className: 'cb-badge' }, TRIGGER_META[run.trigger] ? TRIGGER_META[run.trigger].label : run.trigger),
                h('span', { className: 'cb-meta' }, formatDateTime(run.createdAt)),
                typeof run.durationMs === 'number' ? h('span', { className: 'cb-meta' }, formatDuration(run.durationMs)) : null,
                run.message ? h('span', { className: 'cb-meta' }, run.message) : null,
                h('div', { className: 'cb-actions' },
                  h('button', { className: 'cb-icon', onClick: () => openLog(run) }, '日志'),
                  h('button', { className: 'cb-icon cb-button--danger', onClick: () => clearLog(run) }, '清空')))
            })),
        logText !== null ? h(Modal, { title: '运行日志', onClose: () => setLogText(null), width: 640 },
          h('div', { className: 'cb-log' }, logText || '(空)'),
          h('div', { className: 'cb-toolbar' },
            h('div', { className: 'cb-spacer' }),
            h('button', { className: 'cb-button', onClick: () => setLogText(null) }, '关闭'))) : null)
    }

    function CronBoardPanel({ visible, wsModel } = {}) {
      const active = visible !== false
      const [tab, setTab] = useState('jobs')
      const [jobs, setJobs] = useState([])
      const [envs, setEnvs] = useState([])
      const [status, setStatus] = useState(null)
      const [now, setNow] = useState(Date.now())
      const [reloadFlag, setReloadFlag] = useState(0)
      const reload = useCallback(() => setReloadFlag((value) => value + 1), [])

      useEffect(() => {
        if (!active) return undefined
        let alive = true
        const load = async () => {
          const [jobsOutcome, envsOutcome, statusOutcome] = await Promise.all([
            request('GET', 'jobs'),
            request('GET', 'envs'),
            request('GET', 'status'),
          ])
          if (!alive) return
          if (jobsOutcome.ok) setJobs(jobsOutcome.data.items)
          if (envsOutcome.ok) setEnvs(envsOutcome.data.items)
          if (statusOutcome.ok) setStatus(statusOutcome.data)
          setNow(Date.now())
        }
        load()
        const timer = setInterval(load, REFRESH_INTERVAL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [reloadFlag, active])

      return h('div', { className: 'cb-panel' },
        h('div', { className: 'cb-toolbar' },
          h(PillGroup, { options: TABS, value: tab, onChange: setTab }),
          h('div', { className: 'cb-spacer' }),
          status ? h('span', { className: 'cb-meta' },
            '运行中 ' + status.scheduler.active + ' · 队列 ' + status.scheduler.queued +
            (status.nextAt ? ' · 下次 ' + relativeTime(status.nextAt, now) : '')) : null),
        tab === 'jobs' ? h(JobsTab, { key: 'jobs', jobs, status, now, reload, wsModel }) : null,
        tab === 'envs' ? h(EnvsTab, { key: 'envs', envs, reload }) : null,
        tab === 'logs' ? h(LogsTab, { key: 'logs', jobs, reload, reloadFlag }) : null)
    }

    // —— 主页面挂载(形态对齐 dsh-taskboard,cb- 属性命名空间)——
    // 优先 better-sidebar 扩展槽(单实例 tab);未装回退主界面:侧栏入口行 + 中心列看板容器。

    const TAB_ID = 'cron-board:board'
    const ENTRY_ATTR = 'data-cb-entry'
    const VIEW_ATTR = 'data-cb-view'
    const BOARD_ACTIVE_ATTR = 'data-cb-board-active'
    const PANEL_ACTIVATE_EVENT = 'dsh-panel-activate'
    const PANEL_NAME = 'dsh-cron-board'
    const ENTRY_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 2v12M10 2v12"/></svg>'
    // 三代布局壳兼容:dev data-pane / 官方 CSS-Module centerCol / DSH Desktop 扩展面
    const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface'
    const SIDEBAR_ROOT_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface'
    // 家族面板入口条目(taskboard 系),插入时排其前,避免重渲染后顺序漂移
    const FAMILY_ENTRY_SELECTOR = '[data-dsh-atb-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry], [' + ENTRY_ATTR + ']'
    const OTHER_PANEL_ACTIVE_ATTRS = ['data-dsh-atb-active', 'data-dsh-taskboard-active', 'data-dsh-ssh-active']
    const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

    // 设置>插件页卡片:官方 PluginCard 形制(名称/描述头部 + chevron 折叠 + 行内开关);better-sidebar 在场可切换,否则仅展示禁用态
    const CARD_TITLE = '定时任务'
    const CARD_TOGGLE_LABEL = '看板移入 better-sidebar 侧边栏'
    const readSidebarTabPref = (outcome) => outcome.ok && outcome.data &&
      typeof outcome.data.ui === 'object' && outcome.data.ui !== null && outcome.data.ui.sidebarTab === true
    const CHEVRON_DOWN = () => h('svg', { viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
      h('path', { d: 'm3.5 5.5 3.5 3.5 3.5-3.5' }))

    function CronBoardPluginCard() {
      const [enabled, setEnabled] = useState(null)
      const [busy, setBusy] = useState(false)
      const [open, setOpen] = useState(false)
      // 渲染时重探:侧栏面晚于设置页挂载时,enabled 到达的重渲染会自动纠正禁用态
      const sidebarReady = Boolean(document.querySelector(SIDEBAR_ROOT_SELECTOR))
      useEffect(() => {
        let alive = true
        request('GET', 'status').then((outcome) => {
          if (alive) setEnabled(readSidebarTabPref(outcome))
        })
        return () => { alive = false }
      }, [])
      const toggle = async () => {
        if (busy || enabled === null || !sidebarReady) return
        setBusy(true)
        const outcome = await request('POST', 'ui-settings', { sidebarTab: !enabled })
        if (outcome.ok && outcome.data && outcome.data.ui) setEnabled(outcome.data.ui.sidebarTab === true)
        setBusy(false)
      }
      return h('li', { className: 'cb-pc' + (open ? ' cb-pc--open' : '') },
        h('button', { type: 'button', className: 'cb-pc__head', 'aria-expanded': open,
          'aria-label': (open ? '折叠' : '展开') + ': ' + CARD_TITLE, onClick: () => setOpen(!open) },
          h('span', { className: 'cb-pc__text' },
            h('span', { className: 'cb-pc__name' }, CARD_TITLE),
            h('span', { className: 'cb-pc__desc' }, '计划任务看板、环境变量与执行日志')),
          h('span', { className: 'cb-pc__chevron' }, h(CHEVRON_DOWN))),
        open ? h('div', { className: 'cb-pc__body' },
          h('div', { className: 'cb-pc__row' },
            h('div', { className: 'cb-pc__rowLine' },
              h('span', { className: 'cb-pc__rowLabel' }, CARD_TOGGLE_LABEL),
              switchToggle({
                checked: enabled === true,
                disabled: busy || enabled === null || !sidebarReady,
                onChange: toggle,
                ariaLabel: CARD_TOGGLE_LABEL,
              })),
            h('p', { className: 'cb-pc__hint' },
              sidebarReady ? '开启后看板以侧边栏页签呈现,关闭时始终使用主界面。' : '需安装 better-sidebar 后方可切换;未安装时看板始终使用主界面。'))) : null)
    }

    // better-sidebar tab:注册即单实例(single);只注册不主动打开,
    // 打开由用户从侧边栏目录手动进入(注册即 openTab 会在每次页面加载时抢占当前视图)
    function registerBoardTab(ctx, service, wsModel) {
      return ctx.effect(() => {
        const disposeTab = service.registerTab({
          id: TAB_ID,
          title: '定时任务',
          icon: (size) => h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
            stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
            h('rect', { x: 2, y: 2, width: 12, height: 12, rx: 2 }),
            h('path', { d: 'M6 2v12M10 2v12' })),
          order: 46,
          single: true,
          component: (props) => h(CronBoardPanel, { visible: props.visible, wsModel }),
        })
        return disposeTab
      }, 'cron-board sidebar tab')
    }

    function sidebarRoot() {
      const column = document.querySelector(SIDEBAR_ROOT_SELECTOR)
      if (!column) return undefined
      const logoOwner = column.querySelector('[class*="logoRow"]')
      return (logoOwner && logoOwner.parentElement) || column.firstElementChild || undefined
    }

    function newSessionButton(root) {
      const nested = root.querySelector('button[class*="newSession"]')
      if (nested) return nested
      for (const child of root.children) {
        if (child instanceof HTMLButtonElement && !child.matches('[' + ENTRY_ATTR + ']')) return child
      }
      return root.querySelector('button[aria-label="新建会话"], button[aria-label*="新会话"], button[aria-label*="new session" i]') || undefined
    }

    function placeEntry(root, entry) {
      const button = newSessionButton(root)
      if (!button) return false
      if (entry.parentElement !== root) {
        const row = button.closest('[class*="logoRow"]')
        const base = (row && row.parentElement === root) ? row : button
        const family = Array.from(root.children).filter((el) => el.matches(FAMILY_ENTRY_SELECTOR))
        const anchor = family.length > 0 ? family[0] : (base.nextElementSibling || null)
        root.insertBefore(entry, anchor)
      }
      return true
    }

    // 主界面形态:入口行 + 中心列容器 + html 属性显隐 + 面板互斥;返回幂等 disposer
    function mountStandaloneBoard(wsModel) {
      let disposed = false
      let entry = null
      let rootEl = undefined
      let placed = false
      let rootObserver = null
      let viewRoot = null
      let viewEl = null

      const setOpen = (open) => {
        if (open) {
          for (const attr of OTHER_PANEL_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
          document.documentElement.setAttribute(BOARD_ACTIVE_ATTR, '')
          document.dispatchEvent(new CustomEvent(PANEL_ACTIVATE_EVENT, { detail: PANEL_NAME }))
          entry.dataset.active = 'true'
        } else {
          document.documentElement.removeAttribute(BOARD_ACTIVE_ATTR)
          entry.dataset.active = 'false'
        }
      }
      const isOpen = () => document.documentElement.hasAttribute(BOARD_ACTIVE_ATTR)

      const ensureEntry = () => {
        if (rootEl !== undefined && !rootEl.isConnected) { placed = false; rootEl = undefined }
        if (placed && document.body.contains(entry)) return true
        placed = false
        rootEl = sidebarRoot()
        if (!rootEl) return false
        placed = placeEntry(rootEl, entry)
        if (placed && rootObserver) rootObserver.observe(rootEl, { childList: true, subtree: true })
        return placed
      }

      const ensureView = () => {
        if (viewEl && viewEl.isConnected) return true
        const column = document.querySelector(CONVERSATION_COLUMN_SELECTOR)
        if (!column) return false
        viewEl = document.createElement('div')
        viewEl.setAttribute(VIEW_ATTR, '')
        viewEl.className = 'cb-view'
        column.appendChild(viewEl)
        viewRoot = ReactDOMClient.createRoot(viewEl)
        viewRoot.render(React.createElement(CronBoardPanel, { visible: true, wsModel }))
        return true
      }

      const onClickDocument = (event) => {
        if (!isOpen()) return
        const target = event.target
        if (target && target.closest && target.closest('[' + ENTRY_ATTR + ']')) return
        if (target && target.closest && target.closest(SIDEBAR_ROW_SELECTOR)) setOpen(false)
      }
      const onOtherActivate = (event) => {
        if (event.detail !== PANEL_NAME && isOpen()) setOpen(false)
      }
      entry = document.createElement('button')
      entry.type = 'button'
      entry.setAttribute(ENTRY_ATTR, '')
      entry.className = 'cb-entry'
      entry.setAttribute('aria-label', '定时任务')
      entry.innerHTML = '<span class="cb-entry-icon">' + ENTRY_ICON + '</span><span>定时任务</span>'
      entry.addEventListener('click', () => setOpen(!isOpen()))
      document.addEventListener('click', onClickDocument, true)
      document.addEventListener(PANEL_ACTIVATE_EVENT, onOtherActivate)
      const waitObserver = new MutationObserver(() => { ensureEntry(); ensureView() })
      waitObserver.observe(document.body, { childList: true, subtree: true })
      rootObserver = new MutationObserver(() => {
        if (rootEl === undefined || !rootEl.isConnected) { ensureEntry(); return }
        if (!rootEl.contains(entry)) placeEntry(rootEl, entry)
      })
      const retry = setInterval(() => { ensureEntry(); ensureView() }, 2000)
      ensureEntry()
      ensureView()

      return () => {
        if (disposed) return
        disposed = true
        clearInterval(retry)
        waitObserver.disconnect()
        if (rootObserver) rootObserver.disconnect()
        document.removeEventListener('click', onClickDocument, true)
        document.removeEventListener(PANEL_ACTIVATE_EVENT, onOtherActivate)
        document.documentElement.removeAttribute(BOARD_ACTIVE_ATTR)
        entry.remove()
        if (viewRoot) viewRoot.unmount()
        if (viewEl) viewEl.remove()
      }
    }

    return {
      // workspaces 由宿主 client 常驻提供;slots 供设置页分区挂载(缺失则 fiber 未激活,即干净禁用)
      inject: ['workspaces', 'slots'],
      apply(ctx) {
        ensureStyle(document)
        // 工作区 model(list 即 getSnapshot/subscribe 契约的响应式模型;形态不符传 null,表单仅保留手输)
        const wsService = ctx.get('workspaces')
        const wsModel = wsService && wsService.list && typeof wsService.list.getSnapshot === 'function' ? wsService.list : null
        // 挂载权交给用户:默认永远主界面;设置 sidebarTab 开启且侧边栏服务在场才移入扩展槽,注册后不再自动回退
        const attachBoardTab = (sidebar) => registerBoardTab(ctx, sidebar, wsModel)
        let standalone = mountStandaloneBoard(wsModel)
        let tabDisposer = null
        let sidebarTabOn = false
        // betterSidebar 服务软探测 + 晚注册追踪:出现/变化时按当前偏好重新决策
        let currentSidebar = ctx.get('betterSidebar')
        const applyPref = () => {
          const wantTab = sidebarTabOn && currentSidebar !== undefined
          if (wantTab && tabDisposer === null) {
            standalone()
            standalone = null
            tabDisposer = attachBoardTab(currentSidebar)
          } else if (!wantTab && tabDisposer !== null) {
            tabDisposer()
            tabDisposer = null
          }
          if (!wantTab && standalone === null) standalone = mountStandaloneBoard(wsModel)
        }
        const prefWatch = setInterval(async () => {
          try {
            const outcome = await request('GET', 'status')
            const next = readSidebarTabPref(outcome)
            if (next !== sidebarTabOn) {
              sidebarTabOn = next
              applyPref()
            }
          } catch { /* 轮询失败保形态不变,下轮重试 */ }
        }, 5 * 1000)
        ctx.effect(() => () => {
          clearInterval(prefWatch)
          if (standalone) standalone()
          if (tabDisposer) tabDisposer()
        }, 'cron-board mount arbitration')
        // 设置>插件页卡片:key 配对 ns,宿主按 describe 命名空间分发;effect 随 fiber 回收
        ctx.effect(() => ctx.slots.inject('settings.plugin.item', function* () {
          yield ctx.slots.register(
            { name: 'settings.plugin.item', key: 'cron-board', label: '定时任务' },
            CronBoardPluginCard,
          )
        }), 'cron-board settings card')
        ctx.inject(['betterSidebar'], (bsCtx) => {
          currentSidebar = bsCtx.betterSidebar
          applyPref()
        })
        applyPref()
      },
    }
  }
}
})()
