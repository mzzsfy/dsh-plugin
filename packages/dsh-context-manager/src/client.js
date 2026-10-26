// dsh-context-manager Client 半区:「插件」设置页可配置卡片(七启停开关)
// + 历史输入浮层(Alt+↑ 或输入框工具排按钮唤起,范围导航/搜索/收藏回填)
// + 插话撤回 + 对话 fork
// + 标题栏复制 sessionId(悬停显隐)
// + 克隆仓库打开工作区(官方浏览目录弹窗注入按钮,git clone 后自动打开新工作区)。
// 历史输入挂官方 conversation.input.dock 插槽(渲染为零高度锚点),回填走宿主公共
// 契约 inputActions.setDraft;插话撤回为投影驱动的自绘撤回行(订阅 inbox face);
// fork 注入消息气泡操作排,分叉到该轮之前并把该轮用户输入回填子会话输入框(重试
// 语义),RPC 走宿主 sessions 服务面(fork+open),锚点经 remote.session.follow
// 开场帧建立轮号→{ 结束 seq, 首问文本 } 映射;回填前经官方 input 快照(useInput)
// 探测输入框占用,已被用户输入则不覆盖(权限高于回填);复制 sessionId 挂官方
// conversation.session.header.actions 插槽。浏览器半区经 webServer 路由
// ('/api/context/*')访问 Host。打包为单文件自包含格式,无法跨文件 require;
// 与 src/core.mjs 镜像的纯函数(filterHistoryInputs/forkFailureText/forkRetryText)
// 修改需两处同步。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-context-manager',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef } = React
    const PKG_ID = '@mzzsfy/dsh-context-manager'

    // 导航图标声明:交给 dsh-settings-nav-icons 统一渲染;键 = 市场短名(发现页
    // 收录显示形态);该插件未就绪时入队,由其启动时排空
    const NAV_ICON = { 'dsh-context-manager': 'git' }
    if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
    else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
    else window.__navicIconQueue = [NAV_ICON]

    // 通知出口:公共依赖 @mzzsfy/dsh-common-tools 可选消费(占位条目全仓唯一,由
    // dsh-session-manager 代挂;模块表缺失或导出缺 show 即通知通道置空)
    let toast = () => {}
    try {
      toast = require('@mzzsfy/dsh-common-tools/client').toast.show || (() => {})
    } catch {
      toast = () => {}
    }

const CSS = [
  // 开关行(规约 switch 形态):track 胶囊 + thumb 圆点,状态选择器锚定 checkbox
  '.cx-switch { display:inline-flex; align-items:center; gap:8px; margin-top:10px; cursor:pointer;',
  '  font:var(--dsw-font-xxs-12, 12px/18px sans-serif); color:var(--dsw-alias-label-caption, rgba(127,127,127,.9)); }',
  '.cx-switch input[type="checkbox"] { position:absolute; width:1px; height:1px; margin:-1px; opacity:0; }',
  '.cx-switch__track { position:relative; flex:none; width:28px; height:16px; border-radius:999px;',
  '  background:light-dark(rgba(15,17,21,.22), rgba(255,255,255,.26)); transition:background .15s; }',
  '.cx-switch__thumb { position:absolute; left:2px; top:2px; width:12px; height:12px; border-radius:999px;',
  '  background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.25); transition:transform .15s; }',
  '.cx-switch input[type="checkbox"]:checked + .cx-switch__track { background:#1677ff; }',
  '.cx-switch input[type="checkbox"]:checked + .cx-switch__track .cx-switch__thumb { transform:translateX(12px); }',
  '.cx-switch input[type="checkbox"]:focus-visible + .cx-switch__track { outline:2px solid #1677ff; outline-offset:1px; }',
  '.cx-switch:hover { color:var(--dsw-alias-label-primary, inherit); }',
  '@media (prefers-reduced-motion: reduce) { .cx-switch__track, .cx-switch__thumb { transition:none; } }',
  // 设置分区容器
  '.cx-panel { display:flex; flex-direction:column; gap:2px; align-items:flex-start; min-width:0;',
  '  color:var(--dsw-alias-label-primary); font:var(--dsw-font-s-14); }',
  '.cx-panel__hint { font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-caption); margin:10px 0 4px; }',
  // 插件页折叠卡:视觉值与官方 PluginCard 同源实测(border/bg/radius/间距),
  // open 态换底层色并加深边框,chevron 随开合旋转
  '.cx-card { border:.5px solid var(--dsw-alias-border-l4); background:var(--dsw-alias-bg-layer-3);',
  '  border-radius:16px; list-style:none; transition:border-color .16s, background .16s; width:100%; }',
  '.cx-card:hover { border-color:var(--dsw-alias-label-dimmed); }',
  '.cx-card--open { background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-label-dimmed); }',
  '.cx-card__header { appearance:none; width:100%; font:inherit; color:inherit; text-align:left; cursor:pointer;',
  '  background:none; border:0; border-radius:12px; align-items:center; gap:12px; padding:14px 16px; display:flex; }',
  '.cx-card__header:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-2px; }',
  '.cx-card__head-text { display:flex; flex-direction:column; flex:1 1 0%; gap:4px; min-width:0; }',
  '.cx-card__name { color:var(--dsw-alias-label-primary); font-size:15px; font-weight:600; line-height:1.4; }',
  '.cx-card__description { color:var(--dsw-alias-label-tertiary); font-size:13px; line-height:1.5; }',
  '.cx-card__chevron { color:var(--dsw-alias-label-tertiary); flex:0 0 auto; transition:transform .16s; display:inline-flex; }',
  '.cx-card--open .cx-card__chevron { transform:rotate(180deg); }',
  '.cx-card__body { border-top:.5px solid var(--dsw-alias-border-l2); margin:0 16px; padding:0 0 8px;',
  '  display:flex; flex-direction:column; align-items:flex-start; gap:8px; }',
  '.cx-card__body .cx-panel__hint { margin:10px 0 0; }',
  // 历史输入:零高度锚点容器 + 浮层(Alt+↑ 唤起);浮层与输入框同宽对齐,
  // 不透明实底 + 宿主同款卡片投影,与消息流明确区隔。
  // 色值取自宿主实测(白底卡片/墨色文字/蓝色强调):dsw alias 变量在宿主为空,不可依赖
  '.cx-hist { position:relative; height:0; }',
  // z-index 须高于同插槽兄弟浮层(sm-hist 同为 50,DOM 序靠前时会被其盖住)
  '.cx-hist__pop { position:absolute; left:0; right:0; bottom:10px; z-index:' + (50 + 1) + ';',
  '  max-height:min(420px, 46vh); display:flex; flex-direction:column; overflow:hidden;',
  '  color-scheme:light dark; color:light-dark(#0f1115, #e8eaed);',
  '  background:light-dark(#fff, #1e1f22); border-radius:14px;',
  '  box-shadow:0 0 0 0.5px light-dark(rgba(15,17,21,.18), rgba(255,255,255,.14)), 0 4px 16px rgba(0,0,0,.08), 0 16px 48px rgba(0,0,0,.16); }',
  '.cx-hist__hint { display:flex; flex-wrap:wrap; align-items:center; gap:10px; padding:9px 14px; flex:none;',
  '  border-bottom:1px solid light-dark(rgba(15,17,21,.08), rgba(255,255,255,.1));',
  '  font:var(--dsw-font-xxs-12, 12px/18px sans-serif); color:light-dark(rgba(15,17,21,.55), rgba(232,234,237,.55)); }',
  // 范围 pill 组:点击直达切换,选中实底蓝,未选淡底
  '.cx-hist__scopebar { display:flex; align-items:center; gap:4px; flex:none; }',
  '.cx-hist__pill { appearance:none; border:0; cursor:pointer; flex:none; padding:2px 9px;',
  '  border-radius:999px; font:var(--dsw-font-xxs-12, 12px/18px sans-serif);',
  '  color:light-dark(rgba(15,17,21,.6), rgba(232,234,237,.6));',
  '  background:light-dark(rgba(15,17,21,.06), rgba(255,255,255,.08)); }',
  '.cx-hist__pill:hover { color:light-dark(rgba(15,17,21,.85), rgba(232,234,237,.85));',
  '  background:light-dark(rgba(15,17,21,.1), rgba(255,255,255,.14)); }',
  '.cx-hist__pill--on, .cx-hist__pill--on:hover { background:#1677ff; color:#fff; font-weight:600; }',
  '.cx-hist__pill:focus-visible { outline:2px solid #1677ff; outline-offset:1px; }',
  '.cx-hist__search { flex:1; min-width:0; padding:3px 10px; border-radius:8px; color-scheme:light dark;',
  '  border:1px solid light-dark(rgba(15,17,21,.14), rgba(255,255,255,.18));',
  '  background:transparent; color:inherit; font:var(--dsw-font-xxs-12, 12px/18px sans-serif); }',
  '.cx-hist__search:focus { outline:2px solid #1677ff; outline-offset:-1px; }',
  '.cx-hist__count { flex:none; font:12px/18px var(--ds-font-family-code, monospace);',
  '  color:light-dark(rgba(15,17,21,.4), rgba(232,234,237,.4)); font-variant-numeric:tabular-nums; }',
  '.cx-hist__list { overflow-y:auto; padding:6px; }',
  '.cx-hist__row { position:relative; display:flex; align-items:center; gap:10px; width:100%; border:0;',
  '  background:transparent; cursor:pointer; text-align:left; padding:8px 12px 8px 14px;',
  '  border-radius:8px; min-width:0; }',
  '.cx-hist__row:hover { background:light-dark(rgba(15,17,21,.05), rgba(255,255,255,.07)); }',
  '.cx-hist__row--on, .cx-hist__row--on:hover { background:light-dark(rgba(22,119,255,.1), rgba(22,119,255,.22)); }',
  '.cx-hist__row--on::before { content:""; position:absolute; left:0; top:6px; bottom:6px; width:3px;',
  '  border-radius:2px; background:#1677ff; }',
  '.cx-hist__row--on .cx-hist__text { color:#1677ff; font-weight:600; }',
  '.cx-hist__row:focus-visible { outline:2px solid #1677ff; outline-offset:-2px; }',
  '.cx-hist__text { flex:1; min-width:0; font:var(--dsw-font-s-14, 14px/22px sans-serif);',
  '  color:inherit; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
  '.cx-hist__time { font:12px/18px var(--ds-font-family-code, monospace);',
  '  color:light-dark(rgba(15,17,21,.4), rgba(232,234,237,.4));',
  '  font-variant-numeric:tabular-nums; flex:none; }',
  '.cx-hist__star { border:0; background:transparent; cursor:pointer; flex:none;',
  '  font-size:15px; line-height:1; padding:2px 4px; border-radius:6px;',
  '  color:light-dark(rgba(15,17,21,.35), rgba(232,234,237,.35));',
  '  opacity:0; transition:opacity .12s; }',
  '.cx-hist__row:hover .cx-hist__star, .cx-hist__star:focus-visible { opacity:1; }',
  '.cx-hist__star--on { opacity:1; color:#f5a623; }',
  '.cx-hist__star:hover { color:#f5a623; }',
  '.cx-hist__editbtn { border:0; background:transparent; cursor:pointer; flex:none; padding:2px 8px;',
  '  border-radius:999px; font:12px/18px sans-serif; font-weight:600;',
  '  color:#1677ff; background:light-dark(rgba(22,119,255,.1), rgba(22,119,255,.22)); }',
  '.cx-hist__editbtn:hover { background:light-dark(rgba(22,119,255,.18), rgba(22,119,255,.3)); }',
  '.cx-hist__editwrap { display:flex; flex-direction:column; flex:1; min-height:0; }',
  '.cx-hist__editwrap .cx-hist__list { flex:1; min-height:0; }',
  '.cx-hist__editrow { display:flex; align-items:center; gap:6px; padding:4px 8px; }',
  '.cx-hist__editinput { flex:1; min-width:0; border:1px solid light-dark(rgba(15,17,21,.14), rgba(255,255,255,.18));',
  '  border-radius:8px; padding:6px 10px; font:var(--dsw-font-s-14, 14px/22px sans-serif);',
  '  color:inherit; background:transparent; }',
  '.cx-hist__editinput:focus { outline:2px solid #1677ff; outline-offset:-1px; }',
  '.cx-hist__del { border:0; background:transparent; cursor:pointer; flex:none;',
  '  font-size:16px; line-height:1; padding:2px 8px; border-radius:6px;',
  '  color:light-dark(rgba(15,17,21,.45), rgba(232,234,237,.45)); }',
  '.cx-hist__del:hover { color:#e5484d; }',
  '.cx-hist__addrow { display:flex; gap:6px; padding:8px; flex:none;',
  '  border-top:1px solid light-dark(rgba(15,17,21,.08), rgba(255,255,255,.1)); }',
  '.cx-hist__empty { padding:24px 14px; text-align:center; font:var(--dsw-font-s-14, 14px/22px sans-serif);',
  '  color:light-dark(rgba(15,17,21,.5), rgba(232,234,237,.5)); }',
  '.cx-hist__banner { padding:7px 14px; flex:none; text-align:center; font:var(--dsw-font-xxs-12, 12px/18px sans-serif);',
  '  color:light-dark(rgba(15,17,21,.55), rgba(232,234,237,.55));',
  '  background:light-dark(rgba(15,17,21,.04), rgba(255,255,255,.06)); }',
  // 插话撤回 dock:DOM 注入形态(steering 气泡操作排克隆官方按钮类),本体零占位;
  // 按钮样式全部来自克隆的官方 action 类,无自有样式
  '.cx-steer-host { display:none; }',
  '.cx-fork-host { display:none; }',
  // 标题栏复制 sessionId:与官方 icon 按钮同尺寸,默认隐藏(opacity 保占位,
  // 隐形盒自身仍可悬停/聚焦),悬停标题栏任一位置或按钮自身/键盘聚焦时显示;
  // 宿主 CSS module 类名带哈希前缀但名称后缀稳定,子串选择器跨构建匹配,
  // :has 不可用时自身悬停兜底
  '.cx-sid { appearance:none; border:0; background:transparent; cursor:pointer; flex:none;',
  '  display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; padding:0;',
  '  border-radius:6px; color:var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));',
  '  opacity:0; transition:opacity .15s, color .15s; }',
  '.cx-sid:hover, .cx-sid:focus-visible { opacity:1; color:var(--dsw-alias-label-primary, inherit); }',
  '.cx-sid:focus-visible { outline:2px solid #1677ff; outline-offset:1px; }',
  '[class*="_header"]:has(.cx-sid):hover .cx-sid, [class*="_header"]:has(.cx-sid):focus-within .cx-sid { opacity:1; }',
  '@media (prefers-reduced-motion: reduce) { .cx-sid { transition:none; } }',
  // 克隆仓库弹窗:官方浏览目录弹窗之上的自绘覆盖层,视觉基线取 cx-hist 浮层
  // (不透明实底 + 宿主同款卡片投影,dsw alias 变量在宿主为空不可依赖)
  '.cx-clone-overlay { position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center;',
  '  background:rgba(0,0,0,.35); }',
  '.cx-clone { width:min(460px, calc(100vw - 32px)); display:flex; flex-direction:column; gap:10px; padding:18px;',
  '  border-radius:14px; color-scheme:light dark; color:light-dark(#0f1115, #e8eaed);',
  '  background:light-dark(#fff, #1e1f22);',
  '  box-shadow:0 0 0 0.5px light-dark(rgba(15,17,21,.18), rgba(255,255,255,.14)), 0 4px 16px rgba(0,0,0,.08), 0 16px 48px rgba(0,0,0,.16); }',
  '.cx-clone__title { margin:0; font-size:15px; font-weight:600; }',
  '.cx-clone__field { display:flex; flex-direction:column; gap:4px;',
  '  font:var(--dsw-font-xxs-12, 12px/18px sans-serif); color:light-dark(rgba(15,17,21,.55), rgba(232,234,237,.55)); }',
  '.cx-clone__input { border:1px solid light-dark(rgba(15,17,21,.14), rgba(255,255,255,.18)); border-radius:8px;',
  '  padding:6px 10px; font:var(--dsw-font-s-14, 14px/22px sans-serif); color:inherit; background:transparent; }',
  '.cx-clone__input:focus { outline:2px solid #1677ff; outline-offset:-1px; }',
  '.cx-clone__input:disabled { opacity:.5; }',
  '.cx-clone__switch { margin-top:0; }',
  '.cx-clone__status { min-height:18px; font:var(--dsw-font-xxs-12, 12px/18px sans-serif);',
  '  color:light-dark(rgba(15,17,21,.55), rgba(232,234,237,.55)); white-space:pre-wrap; word-break:break-all; }',
  '.cx-clone__status--error { color:#e5484d; }',
  '.cx-clone__actions { display:flex; justify-content:flex-end; gap:8px; }',
  '.cx-clone__btn { appearance:none; border:0; cursor:pointer; padding:6px 14px; border-radius:8px;',
  '  font:var(--dsw-font-s-14, 14px/22px sans-serif); font-weight:600;',
  '  color:#fff; background:#1677ff; }',
  '.cx-clone__btn:disabled { opacity:.5; cursor:default; }',
  '.cx-clone__btn--ghost { color:inherit; background:light-dark(rgba(15,17,21,.06), rgba(255,255,255,.08)); }',
  '.cx-clone__btn--ghost:hover { background:light-dark(rgba(15,17,21,.1), rgba(255,255,255,.14)); }',
].join('\n')

const INPUTS_URL = '/api/context/inputs'
const PROMPTS_TOGGLE_URL = '/api/context/prompts/toggle'
const HISTORY_ENABLED_URL = '/api/context/history-enabled'
const HISTORY_BUTTON_ENABLED_URL = '/api/context/history-button-enabled'
const STEER_ENABLED_URL = '/api/context/steer-recall-enabled'
const FORK_ENABLED_URL = '/api/context/fork-enabled'
const FORK_AUTO_RESEND_URL = '/api/context/fork-auto-resend-enabled'
const COPY_SID_ENABLED_URL = '/api/context/copy-sid-enabled'
const CLONE_ENABLED_URL = '/api/context/clone-enabled'
const CLONE_API_URL = '/api/context/git-clone'

// 请求默认超时:host 被批量解压等同步任务阻塞时路由会迟滞数秒,
// 无超时则浮层停在「正在读取…」假死;超时按错误抛出,由调用方兜底,
// 轮询链继续,host 恢复后自动跟上
const API_TIMEOUT_MS = 8 * 1000

async function api(url, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      ...options,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
    return payload
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('响应超时(' + Math.round(API_TIMEOUT_MS / 1000) + 's),宿主繁忙中')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function h(type, props) {
  const children = Array.prototype.slice.call(arguments, 2)
  return React.createElement.apply(React, [type, props || null].concat(children))
}

function fmtTime(ms) {
  const t = Number(ms)
  if (t !== t || !t) return '—'
  const d = new Date(t)
  const pad = (n) => (n < 10 ? '0' : '') + n
  const date = d.getFullYear() === new Date().getFullYear()
    ? pad(d.getMonth() + 1) + '/' + pad(d.getDate())
    : d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate())
  return date + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

// 历史范围:按 ←/→ 切换序排列(索引 0 为常用提示词个人收藏,1 为当前会话默认落点,
// → 向更大范围,← 返回收藏);与 host core.mjs HISTORY_SCOPES 镜像,parity 测试锁定
const HISTORY_SCOPES = ['prompts', 'session', 'workspace', 'global']
const HISTORY_SCOPE_LABELS = ['常用', '当前会话', '本工作区', '全部工作区']
const HISTORY_SCOPE_DEFAULT = HISTORY_SCOPES.indexOf('session')
// 浮层打开期间固定轮询节奏:host 侧对齐是异步的,数据可能晚于首次响应到达
const HISTORY_REPULL_MS = 3 * 1000

// 历史浮层搜索镜像(与 core.mjs filterHistoryInputs 同步维护):
// 查询词去首尾空白后按不区分大小写子串匹配,空查询原样返回全量
function filterHistoryInputs(entries, query) {
  const list = Array.isArray(entries) ? entries : []
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return list
  return list.filter((entry) => String((entry && entry.text) ?? '').toLowerCase().includes(needle))
}

// fork 错误文案映射镜像(与 core.mjs forkFailureText 同步维护)
function forkFailureText(code) {
  if (code === 'session/fork-unavailable') return '该轮尚未完成,不可分叉'
  if (code === 'session/workspace-attach-failed') return '分叉成功,但挂载到工作区失败'
  return '分叉失败: ' + String(code ?? '未知错误')
}

// fork 重试文本提取镜像(与 core.mjs forkRetryText 同步维护):
// 仅用户本人消息,文本块按行拼接;空白/纯图返回 null——无法重试的轮不注入按钮
function forkRetryText(data) {
  const message = data && typeof data === 'object' ? data : {}
  if (!message.source || message.source.kind !== 'user') return null
  const text = (Array.isArray(message.content) ? message.content : [])
    .filter((block) => block && block.type === 'text' && block.text !== '')
    .map((block) => block.text)
    .join('\n')
  return text.trim() === '' ? null : text
}

// ── 输入框历史按钮:注入官方输入工具排,点击开关浮层(与 Alt+↑ 等效)──

// 注入标记:识别自家节点,防重复注入;停用/卸载按标记全量移除
const HISTORY_BTN_FLAG = 'data-cx-hist-trigger'
// 官方输入工具排定位锚点:行类名后缀 + 官方 _add 图标按钮,双锚点一致才认;
// 官方类名漂移时寻行返回 null,注入静默跳过(干净禁用)
const TOOLS_ROW_SUFFIX = '_tools'
// 按钮悬停说明:点击与 Alt+↑ 等效
const HISTORY_BUTTON_TITLE = '历史输入(Alt+↑)'

// 官方输入工具排寻行:遍历官方 _add 图标按钮取其所属行
function findToolsRow(doc) {
  for (const button of doc.querySelectorAll('button[class$="_add"]')) {
    const row = button.parentElement
    if (row && typeof row.className === 'string' && row.className.endsWith(TOOLS_ROW_SUFFIX)) return row
  }
  return null
}

// 历史图标 svg(时钟回拨):fill 继承 currentColor,视觉重量与官方 14px 图标一致
function histButtonSvg(doc) {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = doc.createElementNS(namespace, 'svg')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  const path = doc.createElementNS(namespace, 'path')
  path.setAttribute('fill', 'currentColor')
  path.setAttribute('d', 'M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L8.85 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 16.99 10.51 18 13 18c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z')
  svg.appendChild(path)
  return svg
}

// 幂等注入:未注入时克隆官方 _add 类名创建按钮(尺寸/hover 全部原生),位置
// 固定在最后一个官方 _add 之后(与指令/附件同簇);已注入原样返回。
// doc 注入便于测试与宿主文档解耦
function ensureHistoryButton(doc, row, onToggle) {
  const existing = row.querySelector('[' + HISTORY_BTN_FLAG + ']')
  if (existing) return existing
  const official = row.querySelector('button[class$="_add"]')
  if (!official) return null
  const button = doc.createElement('button')
  button.type = 'button'
  button.setAttribute(HISTORY_BTN_FLAG, '')
  button.className = official.className
  button.title = HISTORY_BUTTON_TITLE
  button.setAttribute('aria-label', '历史输入')
  button.addEventListener('click', onToggle)
  button.appendChild(histButtonSvg(doc))
  const officialButtons = row.querySelectorAll('button[class$="_add"]')
  const last = officialButtons[officialButtons.length - 1]
  row.insertBefore(button, (last && last.nextSibling) || null)
  return button
}

function HistoryDock({ session, inputActions }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState(null)
  const [cursor, setCursor] = useState(-1)
  const [scopeIndex, setScopeIndex] = useState(HISTORY_SCOPE_DEFAULT)
  // 范围标签展开态:默认单胶囊只显当前范围,点击展开 pill 组,选择后收起
  const [scopeOpen, setScopeOpen] = useState(false)
  const [aligning, setAligning] = useState(false)
  const [loadError, setLoadError] = useState(false)
  // 收藏集合:浮层打开时并行拉一次,行悬停星标据此显示实/空心;
  // editing 仅常用范围可进入(行内改/删 + 底部新增)
  const [collected, setCollected] = useState(() => new Set())
  const [editing, setEditing] = useState(false)
  // 搜索:query 驱动渲染,原始条目存 rawRef,items 恒为过滤后列表;
  // 组合输入(IME)期间不过滤,上屏后才应用
  const [query, setQuery] = useState('')
  const composingRef = useRef(false)
  const rootRef = React.useRef(null)
  // 键盘层权威状态:监听器挂载一次(空依赖),读写全走 ref,规避 effect 重挂
  // 时序造成的闭包陈旧;state 仅驱动渲染,变更处双写
  const viewRef = React.useRef({ open: false, items: null, cursor: -1, scopeIndex: 0, aligning: false })
  const sessionRef = React.useRef(session)
  const inputActionsRef = React.useRef(inputActions)
  const rawItemsRef = React.useRef(null)
  const queryRef = React.useRef('')
  // 历史浮层启停(设置开关):挂载拉取一次,停用即整体不渲染、键盘放行
  const enabledRef = React.useRef(true)
  const [historyEnabled, setHistoryEnabled] = useState(true)
  // 输入框历史按钮启停(设置开关):false 仅隐藏按钮,快捷键与浮层不受影响
  const buttonEnabledRef = React.useRef(true)
  const [buttonEnabled, setButtonEnabled] = useState(true)
  sessionRef.current = session
  inputActionsRef.current = inputActions
  // 条件 return 之前同步:停用路径的扫描守卫也要看到最新值(与 SteerRecallDock 同构)
  buttonEnabledRef.current = buttonEnabled
  useEffect(() => {
    api(HISTORY_ENABLED_URL)
      .then((payload) => {
        const on = payload ? payload.enabled !== false : true
        enabledRef.current = on
        setHistoryEnabled(on)
      })
      .catch(() => {})
    api(HISTORY_BUTTON_ENABLED_URL)
      .then((payload) => setButtonEnabled(payload ? payload.enabled !== false : true))
      .catch(() => {})
  }, [])

  function syncView(patch) {
    viewRef.current = { ...viewRef.current, ...patch }
  }

  // 应用搜索词:原始条目重新过滤并重置光标(过滤后集合上的选择位无意义)
  function applyFilter(next) {
    queryRef.current = next
    const raw = rawItemsRef.current
    const displayed = raw === null ? null : filterHistoryInputs(raw, next)
    syncView({ items: displayed, cursor: -1 })
    setItems(displayed)
    setCursor(-1)
  }

  // host 响应信封 { inputs, aligned };解包并防御形态漂移,消费侧恒为数组。
  // aligned=false 表示工作区缓存尚未建立(首次),host 已在后台对齐
  function fetchInputs(scope) {
    return api(INPUTS_URL + '?sessionId=' + encodeURIComponent(sessionRef.current.sessionId) + '&scope=' + scope)
      .then((payload) => ({
        inputs: (payload && Array.isArray(payload.inputs)) ? payload.inputs : [],
        aligned: Boolean(payload && payload.aligned),
      }))
  }

  // 收藏集合与浮层列表共用 inputs 路由(scope=prompts),毫秒级缓存读
  function refreshCollected() {
    return api(INPUTS_URL + '?sessionId=' + encodeURIComponent(sessionRef.current.sessionId) + '&scope=prompts')
      .then((payload) => {
        const list = payload && Array.isArray(payload.inputs) ? payload.inputs : []
        setCollected(new Set(list.map((item) => item.text)))
      })
      .catch(() => {})
  }

  // 收藏切换:行悬停星标与编辑态删除共用;成功后同步星标集,
  // 当前正处于常用范围时立即重拉列表(不等轮询)
  function togglePrompt(text) {
    return api(PROMPTS_TOGGLE_URL, { method: 'POST', body: JSON.stringify({ text }) })
      .then((payload) => {
        const on = Boolean(payload && payload.collected)
        toast(on ? '已收藏到常用' : '已取消收藏')
        setCollected((prev) => {
          const next = new Set(prev)
          if (on) next.add(text)
          else next.delete(text)
          return next
        })
        if (viewRef.current.open && viewRef.current.scopeIndex === HISTORY_SCOPES.indexOf('prompts')) requestScope(viewRef.current.scopeIndex)
        return on
      })
  }

  // 编辑态改文本 = 移除旧文本 + 收藏新文本(两次 toggle 原子性由"同文本去重"保证:
  // 中断最坏留下旧文本,重改一次即自愈)
  function renamePrompt(from, to) {
    return togglePrompt(from)
      .then(() => (to === '' ? Promise.resolve() : togglePrompt(to)))
  }

  // 应用一次响应:仅当范围未变时生效,防止快速切范围后迟到响应覆盖新范围。
  // 原始条目深度不变的重复响应不重置光标(轮询期间保持用户选位);
  // 落地后经当前搜索词过滤再呈现
  function applyResult(scopeIdx, result) {
    if (viewRef.current.scopeIndex !== scopeIdx) return
    const prev = rawItemsRef.current
    if (prev !== null && JSON.stringify(prev) === JSON.stringify(result.inputs)) {
      syncView({ aligning: !result.aligned })
      setAligning(!result.aligned)
      return
    }
    rawItemsRef.current = result.inputs
    syncView({ aligning: !result.aligned })
    setAligning(!result.aligned)
    applyFilter(queryRef.current)
  }

  // 浮层打开期间固定节奏轮询当前范围:host 侧对齐/焦点对齐是异步的,
  // 数据可能晚于首次响应到达,一次性重拉预算耗尽后迟到的数据将永不出现
  // (实机验证实测:API 已就绪而浮层停在旧列表)。轮询开销为毫秒级缓存读;
  // 请求失败(含超时)也保持轮询,host 恢复后列表自愈,不假死
  function requestScope(scopeIdx) {
    const scope = HISTORY_SCOPES[scopeIdx]
    const scheduleNext = () => {
      if (!viewRef.current.open || viewRef.current.scopeIndex !== scopeIdx) return
      setTimeout(() => {
        if (viewRef.current.open && viewRef.current.scopeIndex === scopeIdx) requestScope(scopeIdx)
      }, HISTORY_REPULL_MS)
    }
    fetchInputs(scope)
      .then((result) => {
        applyResult(scopeIdx, result)
        scheduleNext()
      })
      .catch((error) => {
        if (viewRef.current.scopeIndex !== scopeIdx) return
        rawItemsRef.current = []
        syncView({ items: [] })
        setLoadError(true)
        setItems([])
        toast(error && error.message ? error.message : String(error), { kind: 'error' })
        scheduleNext()
      })
  }

  function fill(text) {
    inputActionsRef.current.setDraft(text)
    syncView({ open: false })
    setOpen(false)
  }

  function openPopup() {
    rawItemsRef.current = null
    queryRef.current = ''
    setQuery('')
    setScopeOpen(false)
    syncView({ open: true, items: null, cursor: -1, scopeIndex: HISTORY_SCOPE_DEFAULT, aligning: false })
    setOpen(true)
    setScopeIndex(HISTORY_SCOPE_DEFAULT)
    setCursor(-1)
    setAligning(false)
    setLoadError(false)
    setItems(null)
    setEditing(false)
    refreshCollected()
    requestScope(HISTORY_SCOPE_DEFAULT)
  }

  // 范围切换共用落点:清过滤与选择态后拉取目标范围;同范围不动,切换即收起展开态
  function selectScope(next) {
    if (next === viewRef.current.scopeIndex) return
    setScopeOpen(false)
    rawItemsRef.current = null
    queryRef.current = ''
    setQuery('')
    syncView({ scopeIndex: next, items: null, cursor: -1, aligning: false })
    setScopeIndex(next)
    setCursor(-1)
    setAligning(false)
    setLoadError(false)
    setItems(null)
    setEditing(false)
    requestScope(next)
  }

  // ←/→ 相对切换:→ 向大(工作区/全局),← 返回收藏;边界停住
  function switchScope(delta) {
    const next = viewRef.current.scopeIndex + delta
    if (next < 0 || next >= HISTORY_SCOPES.length) return
    selectScope(next)
  }

  // Alt+↑ 唤起浮层;浮层开 = 菜单模态,捕获阶段拦截导航键,先于 Lexical 光标移动。
  // 设置开关停用时监听器直接放行(读 ref,开关值挂载拉取后即时反映)
  useEffect(() => {
    function onKeyDown(event) {
      if (enabledRef.current === false) return
      const view = viewRef.current
      if (event.isComposing) return
      if (!view.open) {
        if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'ArrowUp') {
          event.preventDefault()
          event.stopPropagation()
          openPopup()
        }
        return
      }
      // 编辑态输入(重命名/新增行)聚焦时导航键留给输入本身,仅保留 Esc 关闭;
      // 搜索框不豁免:过滤后 ↑/↓ 选中与 Enter 回填正是搜索态的主路径
      const root = rootRef.current
      const searchEl = root && root.querySelector('.cx-hist__search')
      const active = document.activeElement
      if (root && active && active !== searchEl && root.contains(active)
        && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        if (event.key !== 'Escape') return
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        if (view.items === null || view.items.length === 0) return
        const delta = event.key === 'ArrowUp' ? -1 : 1
        const next = Math.min(Math.max(view.cursor + delta, 0), view.items.length - 1)
        syncView({ cursor: next })
        setCursor(next)
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        // 搜索框聚焦时方向键留给光标移动,不切范围
        if (rootRef.current && rootRef.current.querySelector('.cx-hist__search') === document.activeElement) return
        event.preventDefault()
        event.stopPropagation()
        switchScope(event.key === 'ArrowLeft' ? -1 : 1)
        return
      }
      if (event.key === 'Enter') {
        // 有选中条目即回填,搜索框聚焦同样成立(IME 组合已在函数头放行,
        // 搜索词过滤后 ↑/↓ 选中 → Enter 是搜索态的主要回填路径)
        if (view.items !== null && view.cursor >= 0 && view.cursor < view.items.length) {
          event.preventDefault()
          event.stopPropagation()
          fill(view.items[view.cursor].text)
        }
        return
      }
      if (event.key === 'Escape') {
        // 两级退出:搜索词非空先清搜索,再按才关闭;为空直接关闭(与现版一致)
        event.preventDefault()
        event.stopPropagation()
        if (queryRef.current.trim() !== '') {
          setQuery('')
          applyFilter('')
          return
        }
        syncView({ open: false })
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // 选中行滚入可视区:键盘移动后高亮行保持在视野内
  useEffect(() => {
    if (!open || cursor < 0) return
    const row = rootRef.current && rootRef.current.querySelector('.cx-hist__row--on')
    if (row) row.scrollIntoView({ block: 'nearest' })
  }, [open, cursor, items])

  // 浮层外点击关闭(双写:漏写 viewRef 会让键盘层误判浮层仍开,吞掉输入框方向键)。
  // 注入按钮在本容器外,closest 守卫跳过:否则 mousedown 先关、click 再开,
  // 浮层开时点按钮等于常开,toggle 语义失效
  useEffect(() => {
    if (!open) return undefined
    function onPointerDown(event) {
      const target = event.target
      if (target && typeof target.closest === 'function' && target.closest('[' + HISTORY_BTN_FLAG + ']')) return
      if (rootRef.current && !rootRef.current.contains(target)) {
        syncView({ open: false })
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown, true)
    return () => document.removeEventListener('mousedown', onPointerDown, true)
  }, [open])

  // 注入按钮点击:开→关,关→唤起;经 ref 接线,挂载一次的监听器恒读最新闭包
  function toggleFromButton() {
    if (viewRef.current.open) {
      syncView({ open: false })
      setOpen(false)
      return
    }
    openPopup()
  }
  const toggleRef = React.useRef(() => {})
  toggleRef.current = toggleFromButton

  // 输入框工具排按钮(设置开关):挂载后扫描官方工具排注入;官方工具排随布局
  // 状态被 React 重建时经观察器补注,开关值异步到达(无 DOM 变更)经重扫对账。
  // 启停读 ref(开关值挂载拉取后即时反映),停用/卸载按标记全量移除
  const buttonScanRef = React.useRef(null)
  useEffect(() => {
    function removeAll() {
      document.querySelectorAll('[' + HISTORY_BTN_FLAG + ']').forEach((button) => button.remove())
    }
    function sync() {
      if (enabledRef.current === false || buttonEnabledRef.current === false) {
        removeAll()
        return
      }
      const row = findToolsRow(document)
      if (row) ensureHistoryButton(document, row, () => toggleRef.current())
    }
    buttonScanRef.current = sync
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { childList: true, subtree: true })
    sync()
    return () => {
      buttonScanRef.current = null
      observer.disconnect()
      removeAll()
    }
  }, [])
  // 开关状态/浮层启停变化即时重扫(观察器只覆盖 DOM 变更,状态变化需主动对账)
  useEffect(() => {
    if (buttonScanRef.current) buttonScanRef.current()
  }, [historyEnabled, buttonEnabled])

  // 零高度锚点:平时不占任何界面空间,仅浮层打开时渲染;设置停用整体不渲染
  if (session === undefined || inputActions === undefined || historyEnabled === false) return null
  const promptsIdx = HISTORY_SCOPES.indexOf('prompts')
  const inPrompts = scopeIndex === promptsIdx
  // 行悬停星标:非常用范围显示,已收藏实星(点击取消),未收藏空心(点击收藏);
  // stopPropagation 防止触发行回填
  const starButton = (item) => h('button', {
    className: 'cx-hist__star' + (collected.has(item.text) ? ' cx-hist__star--on' : ''),
    title: collected.has(item.text) ? '取消收藏' : '收藏',
    onClick: (event) => {
      event.stopPropagation()
      togglePrompt(item.text)
    },
  }, collected.has(item.text) ? '★' : '☆')
  const rowButton = (item, index) => h('button', {
    key: index + ':' + item.at,
    className: 'cx-hist__row' + (index === cursor ? ' cx-hist__row--on' : ''),
    onClick: () => fill(item.text),
  },
    h('span', { className: 'cx-hist__text', title: item.text }, item.text),
    h('span', { className: 'cx-hist__time' }, fmtTime(item.at)),
    !inPrompts ? starButton(item) : null,
  )
  // 编辑态行:key 用文本而非索引——常用范围内文本唯一,过滤后索引漂移不再重建
  // 行节点(重建会让编辑中的 input 卸载,未保存的修改静默丢失)
  const editRow = (item, index) => h('div', {
    key: item.text,
    className: 'cx-hist__editrow',
  },
    h('input', {
      className: 'cx-hist__editinput',
      defaultValue: item.text,
      title: item.text,
      onKeyDown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          renamePrompt(item.text, event.target.value.trim())
        }
      },
      onBlur: (event) => {
        const next = event.target.value.trim()
        if (next !== item.text) renamePrompt(item.text, next)
      },
    }),
    h('button', {
      className: 'cx-hist__del',
      title: '删除',
      onClick: () => togglePrompt(item.text),
    }, '×'),
  )
  const hitCount = query.trim() === '' ? null : (items === null ? 0 : items.length)
  return h('div', { className: 'cx-hist', ref: rootRef },
    open && h('div', { className: 'cx-hist__pop' },
      h('div', { className: 'cx-hist__hint' },
        h('span', { className: 'cx-hist__scopebar' },
          scopeOpen
            ? HISTORY_SCOPE_LABELS.map((label, idx) => h('button', {
                key: label,
                className: 'cx-hist__pill' + (idx === scopeIndex ? ' cx-hist__pill--on' : ''),
                title: idx === scopeIndex ? '收起' : '切换到' + label,
                onClick: () => (idx === scopeIndex ? setScopeOpen(false) : selectScope(idx)),
              }, label))
            : h('button', {
                className: 'cx-hist__pill cx-hist__pill--on',
                title: '点击选择范围',
                onClick: () => setScopeOpen(true),
              }, HISTORY_SCOPE_LABELS[scopeIndex] + ' ▾'),
        ),
        inPrompts
          ? h('button', {
              className: 'cx-hist__editbtn',
              onClick: () => setEditing(!editing),
            }, editing ? '完成' : '编辑')
          : null,
        h('input', {
          className: 'cx-hist__search',
          placeholder: '搜索历史输入',
          value: query,
          onChange: (event) => {
            const next = event.target.value
            setQuery(next)
            if (!composingRef.current) applyFilter(next)
          },
          onCompositionStart: () => { composingRef.current = true },
          onCompositionEnd: (event) => {
            composingRef.current = false
            applyFilter(event.target.value)
          },
        }),
        hitCount !== null ? h('span', { className: 'cx-hist__count' }, String(hitCount)) : null,
        h('span', null, '↑/↓ 选择 · ←/→ 切换范围 · Enter 填入 · Esc 关闭')),
      aligning && h('div', { className: 'cx-hist__banner' }, '首次对齐历史中,可能需要稍等'),
      items === null
        ? h('div', { className: 'cx-hist__empty' }, '正在读取历史输入…')
        : editing && inPrompts
          ? h('div', { className: 'cx-hist__editwrap' },
              items.length === 0
                ? h('div', { className: 'cx-hist__empty' }, '还没有常用提示词,可从历史行悬停收藏,或在下方添加')
                : h('div', { className: 'cx-hist__list' }, items.map(editRow)),
              h('div', { className: 'cx-hist__addrow' },
                h('input', {
                  className: 'cx-hist__editinput',
                  placeholder: '输入常用提示词,Enter 添加',
                  ref: (el) => { if (el) el.dataset.addinput = '1' },
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      const text = event.target.value.trim()
                      if (text !== '') {
                        togglePrompt(text)
                        event.target.value = ''
                      }
                    }
                  },
                }),
              ),
            )
          : items.length === 0
            ? h('div', { className: 'cx-hist__empty' }, loadError
              ? '历史输入加载失败,可关闭后重试'
              : (query.trim() !== '' ? '无匹配' : (inPrompts ? '还没有常用提示词' : '该范围内还没有历史输入')))
            : h('div', { className: 'cx-hist__list' }, items.map(rowButton)),
    ),
  )
}

// 插话撤回投影:未应用插话驻留会话 inbox 的 next-step 队列(dsh 0.2.0 语义,经
// 会话绑定面 inbox 投影读取);仅 user 来源且有 id 的插话可撤回,含非文本块的
// 插话 text 置空(不可撤回)
function steerRowsOfInbox(messages) {
  const rows = Array.isArray(messages) ? messages : []
  return rows
    .filter((item) => item && item.id !== undefined && item.source && item.source.kind === 'user')
    .map(steerRowOfMessage)
}

function steerRowOfMessage(item) {
  const blocks = Array.isArray(item.content) ? item.content : []
  const textBlocks = blocks.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
  const text = blocks.length > 0 && textBlocks.length === blocks.length
    ? textBlocks.map((block) => block.text).join('')
    : null
  return { id: item.id, text, preview: text === null ? null : text.slice(0, STEER_PREVIEW_MAX) }
}

// 撤回失败文案:queue-item-not-found = 消息已被 step 边界 claim(应用),无法撤回;
// 其余透传宿主错误消息
function withdrawFailureText(result) {
  const error = result && result.error
  if (error && error.code === 'session/queue-item-not-found') return '插话已被应用,无法撤回'
  return '撤回失败: ' + ((error && error.message) || '未知错误')
}

// 撤回动作:先宿主移除(inbox next-step 摘除,未应用即消失),成功才回填草稿,
// 顺序保证「移除失败绝不覆盖输入框」;actions 注入便于测试与组件解耦
async function withdrawSteer(row, actions) {
  let result
  try {
    result = await actions.updateQueue(row.id, { kind: 'remove' })
  } catch (error) {
    actions.notify('撤回失败: ' + String(error && error.message || error), { kind: 'error' })
    return false
  }
  if (!(result && result.ok)) {
    actions.notify(withdrawFailureText(result), { kind: 'error' })
    return false
  }
  try {
    actions.setDraft(row.text)
  } catch (error) {
    // 摘除已成功,草稿回填失败(会话切换等竞态)时文本必须可达:通知兜底展示原文
    actions.notify('草稿回填失败,原文: ' + row.text, { kind: 'error' })
    return false
  }
  actions.notify('已撤回到输入框')
  return true
}

// 撤回图标 svg(undo 弯箭头):DOM 形态(注入按钮走 DOM 路径,与 forkSvg 同构),
// stroke 继承按钮色,尺寸 width/height 与官方操作排图标一致
function steerRecallSvg() {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(namespace, 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('aria-hidden', 'true')
  const strokePath = (d) => {
    const path = document.createElementNS(namespace, 'path')
    path.setAttribute('d', d)
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '1.5')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(path)
  }
  strokePath('M3 6.5h6.5a3.5 3.5 0 0 1 0 7H6')
  strokePath('M6 3.5 3 6.5l3 3')
  return svg
}

// fork 图标 svg:与官方分支按钮(IconBranchOutline16)同源,fill 细路径形态;
// path 数据采自官方运行时 DOM,官方图标升级时需同步
function forkSvg() {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(namespace, 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(namespace, 'path')
  path.setAttribute('fill-rule', 'evenodd')
  path.setAttribute('clip-rule', 'evenodd')
  path.setAttribute('fill', 'currentColor')
  path.setAttribute('d', 'M13.0762 1.37207C14.0846 1.37228 14.9021 2.19077 14.9023 3.19922C14.9022 4.20772 14.0847 5.02518 13.0762 5.02539C12.2967 5.02539 11.6325 4.53691 11.3701 3.84961H4.35547C4.79397 4.26458 5.15861 4.7644 5.41699 5.33496L7.10645 9.06738C7.88526 10.7875 9.55104 11.9228 11.4189 12.0371C11.7085 11.4109 12.3411 10.9756 13.0762 10.9756C14.0843 10.9759 14.9023 11.7936 14.9023 12.8018C14.9023 13.81 14.0843 14.6277 13.0762 14.6279C12.2534 14.6279 11.5574 14.0832 11.3291 13.335C8.9868 13.1879 6.89981 11.7612 5.92285 9.60352L4.23242 5.87109C3.67503 4.64033 2.44878 3.84961 1.09766 3.84961V2.54883C1.10665 2.54883 1.11601 2.54975 1.125 2.5498L11.3701 2.54883C11.6326 1.86151 12.2969 1.37207 13.0762 1.37207ZM13.0762 12.2764C12.7858 12.2764 12.5508 12.5114 12.5508 12.8018C12.5508 13.0921 12.7858 13.3281 13.0762 13.3281C13.3664 13.3279 13.6025 13.092 13.6025 12.8018C13.6025 12.5115 13.3664 12.2766 13.0762 12.2764ZM13.0762 2.67285C12.7855 2.67285 12.55 2.90861 12.5498 3.19922C12.5499 3.48987 12.7855 3.72559 13.0762 3.72559C13.3667 3.72538 13.6024 3.48975 13.6025 3.19922C13.6023 2.90874 13.3666 2.67306 13.0762 2.67285Z')
  svg.appendChild(path)
  return svg
}

// fork 注入按钮标记:识别自家节点与官方按钮,防止重复注入与误删官方节点
const FORK_BTN_FLAG = 'data-cx-fork'
// 撤回注入按钮标记:语义同 FORK_BTN_FLAG,作用于 steering 气泡操作排
const STEER_BTN_FLAG = 'data-cx-steer-recall'
// 宿主消息气泡操作图标排的 CSS module 类名后缀(哈希前缀随构建漂移,后缀稳定),
// fork 注入按它定位官方按钮排
const BUBBLE_ACTIONS_SUFFIX = '[class$="_actions"]'
// 气泡 node-key 的 messageId 提取:形如 {seq}:input-message{messageId},
// 后缀与 inbox next-step 投影行 id 同源(官方两侧同用 String(event.data.id))
const STEER_NODE_KEY_RE = /input-message(.+)$/
// 气泡 node-key 属性名(与 TURN_ATTR/FLOW_KIND_ATTR 同族的官方流标记)
const NODE_KEY_ATTR = 'data-chat-node-key'
// 宿主插话气泡标记(0.2.1-rc.2 源码形态,ChatFlow.pendingInputs):
// 发送会话内投影行被本地 submission 替换渲染,气泡 = data-pending-steering +
// data-submission-echo 双标记;切会话回来/刷新(本地 state 清空)渲染纯
// data-pending-steering 单标记。pending 顺序对齐覆盖两种形态,行存在性检查
// 天然保证 Host 未确认(无行)不注入
const STEER_PENDING_ATTR = 'data-pending-steering'
// 宿主 inbox 投影:未应用插话驻留的队列键(dsh 0.2.0 语义)
const INBOX_STEER_KEY = 'inbox'
const INBOX_STEER_QUEUE = 'next-step'
const STEER_PREVIEW_MAX = 40
// 消息节点的轮号标记(fork 锚点输入)
const TURN_ATTR = 'data-chat-turn'
// 官方消息流气泡的语义类型标记:user=用户输入气泡(turn-tail=官方轮尾,官方分支按钮驻留处)
const FLOW_KIND_ATTR = 'data-chat-flow-kind'
// fork 锚点窗口:follow 开场帧回溯的事件数上限(长会话全量回溯的内存/耗时护栏;
// 窗口覆盖不到的更早轮与进行中的轮不注入分叉按钮,新近轮——fork 的主要目标——总在覆盖内)
const FORK_PAGE_MAX_MESSAGES = 2000

// 重试草稿通道:分叉成功后子会话尚未挂载,原输入先按子会话 id 暂存,
// 子会话的 dock 挂载(inputActions 就绪)时消费回填并清除
const pendingForkDrafts = new Map()
// 已消费会话:effect 依赖(inputActions 身份)变化会重跑,重跑时草稿已被 delete,
// 若不做标记会落入「无草稿」路径并对输入框产生二次写入(空写即清空)
const consumedForkDrafts = new Set()
// 草稿消费重查:覆盖 open 切换期间「挂载先于登记」的窗口(单次即可,上限留裕量)
const FORK_DRAFT_POLL_MS = 400
const FORK_DRAFT_POLLS = 3

// 取 follow 开场帧(回溯窗口内的事件快照,自带 seq)后立即断开:
// for-await break 触发 iterator.return,流即关闭,不消费 live 帧
async function followOpening(remote, sessionId) {
  const frames = remote.follow({ address: { kind: 'session', sessionId }, maxMessages: FORK_PAGE_MAX_MESSAGES })
  for await (const frame of frames) {
    if (frame && frame.type === 'snapshot') return Array.isArray(frame.records) ? frame.records : []
    return []
  }
  return []
}

// 插话撤回:未应用插话气泡(消息流 steering 项,永久驻留)的操作排注入撤回图标,
// 与 fork 注入同机制。显隐由 inbox 投影行集驱动(行在=未应用):scan 时行在注入、
// 行不在摘除,投影订阅驱动重扫,应用后按钮即时消失;点击与投影更新之间的竞态窗口
// 由「行不在降级提示 / remove 失败提示」兜底(旧'行消失即摘按钮'的实时性由订阅保证)。
function SteerRecallDock({ useSession, inputActions, updateQueue, inboxFace }) {
  const queueMutable = useSession((state) => state.subagent === null || state.subagent.address.mode === 'continuable')
  // 启停开关(设置页):挂载拉取一次,停用即移除已注入按钮并不再注入;失败按启用兜底
  const [enabled, setEnabled] = useState(true)
  useEffect(() => {
    api(STEER_ENABLED_URL)
      .then((payload) => setEnabled(payload ? payload.enabled !== false : true))
      .catch(() => {})
  }, [])
  // 条件 return 之前同步全部依赖:scan 门控与点击处理器都要看到最新值(会话切换
  // 后旧 face 的快照不得继续服务新 DOM,与 ForkDock 的 ref 同步纪律同构)
  const depsRef = useRef(null)
  const enabledRef = useRef(true)
  depsRef.current = { queueMutable, inputActions, updateQueue, inboxFace }
  enabledRef.current = enabled
  useEffect(() => {
    function removeAll() {
      document.querySelectorAll('[' + STEER_BTN_FLAG + ']').forEach((button) => button.remove())
    }
    function scan() {
      if (!enabledRef.current) {
        removeAll()
        return
      }
      const deps = depsRef.current
      if (!deps || !deps.queueMutable || !deps.inboxFace || typeof deps.inboxFace.getSnapshot !== 'function') {
        // 锁定态(subagent prompt)与停用同构:无可撤语义,残留图标一律摘除
        // (解锁时宿主输入区复挂触发 mutation → scan 重注入,收敛无死角)
        removeAll()
        return
      }
      const snapshot = deps.inboxFace.getSnapshot()
      const rows = steerRowsOfInbox(snapshot && snapshot[INBOX_STEER_QUEUE])
      const rowsById = new Map(rows.map((item) => [String(item.id), item]))
      const injectRecall = (bubble) => {
        const actionsRow = bubble.querySelector(BUBBLE_ACTIONS_SUFFIX)
        if (!actionsRow) return
        const official = actionsRow.querySelector('button:not([' + STEER_BTN_FLAG + '])')
        if (!official) return
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute(STEER_BTN_FLAG, '')
        // 克隆官方按钮类名:尺寸/hover/悬停显隐(reveal)全部原生
        button.className = official.className
        button.title = '撤回该插话:原文填回输入框重新编辑;插话被应用后无法撤回'
        button.addEventListener('click', () => {
          // 与 scan 同款依赖守卫:渲染停用后残留按钮的点击不得继续(face 为 null
          // 会 TypeError,queueMutable=false 时 updateQueue/回填目标均不可用);
          // 行归属点击时实时重读——React 复用气泡 DOM 更新 node-key/序列后,
          // 注入瞬间固化的行会指向已不在此气泡的消息
          const current = depsRef.current
          if (!current || !current.queueMutable || !current.inboxFace || typeof current.inboxFace.getSnapshot !== 'function') return
          const node = button.closest('[' + FLOW_KIND_ATTR + '="steering"], [' + STEER_PENDING_ATTR + ']')
          if (!node) return
          const currentSnapshot = current.inboxFace.getSnapshot()
          const currentRows = steerRowsOfInbox(currentSnapshot && currentSnapshot[INBOX_STEER_QUEUE])
          // 点击重读行:durable 按 messageId;pending(含双标记 echo 形态)按文档序对齐(与 scan 同构)
          const nodeMatch = STEER_NODE_KEY_RE.exec(node.getAttribute(NODE_KEY_ATTR) || '')
          let currentRow = null
          if (nodeMatch) {
            currentRow = currentRows.find((item) => String(item.id) === nodeMatch[1]) || null
          } else if (node.hasAttribute(STEER_PENDING_ATTR)) {
            const pendingList = Array.prototype.slice.call(
              document.querySelectorAll('[' + STEER_PENDING_ATTR + ']'),
            )
            const seq = pendingList.indexOf(node)
            currentRow = seq >= 0 ? (currentRows[seq] || null) : null
          }
          if (!currentRow) {
            toast('插话已被应用,无法撤回', { kind: 'error' })
            return
          }
          if (currentRow.text === null) {
            toast('含附件的插话不支持撤回', { kind: 'error' })
            return
          }
          button.disabled = true
          void withdrawSteer(currentRow, { updateQueue: current.updateQueue, setDraft: current.inputActions.setDraft, notify: toast })
            .finally(() => { button.disabled = false })
        })
        button.appendChild(steerRecallSvg())
        actionsRow.appendChild(button)
      }
      // durable:flow wrapper 带 node-key,按 messageId 匹配投影行
      document.querySelectorAll('[' + FLOW_KIND_ATTR + '="steering"]').forEach((bubble) => {
        const existing = bubble.querySelector('[' + STEER_BTN_FLAG + ']')
        const match = STEER_NODE_KEY_RE.exec(bubble.getAttribute(NODE_KEY_ATTR) || '')
        const row = match ? rowsById.get(match[1]) : null
        if (!row) {
          if (existing) existing.remove()
          return
        }
        if (existing) return
        injectRecall(bubble)
      })
      // pending:带 data-pending-steering 的气泡(发送会话内双标记 echo 形态 +
      // 切会话回来的纯 pending 形态)与 next-step user 行同源保序渲染(宿主
      // pendingInputs 即 next-step user 行 flatMap,本地 submission 仅替换同序
      // 行不改序),按文档序与投影序一一配对;渲染文本不参与匹配(Markdown 插话
      // 的 textContent 与原文必不一致);无行排尾(Host 未确认)由行存在性检查
      // 天然不注入
      const pendingList = Array.prototype.slice.call(
        document.querySelectorAll('[' + STEER_PENDING_ATTR + ']'),
      )
      pendingList.forEach((bubble, index) => {
        const existing = bubble.querySelector('[' + STEER_BTN_FLAG + ']')
        const row = rows[index] || null
        if (!row) {
          if (existing) existing.remove()
          return
        }
        if (existing) return
        injectRecall(bubble)
      })
    }
    if (typeof MutationObserver === 'undefined' || typeof document.querySelectorAll !== 'function') return undefined
    const scanRef = { current: scan }
    const observer = new MutationObserver(() => { if (scanRef.current) scanRef.current() })
    observer.observe(document.documentElement, { childList: true, subtree: true })
    // 投影订阅:应用/撤回改变 next-step 行集时重扫,按钮显隐不依赖气泡 DOM 变化
    const face = depsRef.current && depsRef.current.inboxFace
    const unsubscribe = face && typeof face.subscribe === 'function'
      ? face.subscribe(() => { if (scanRef.current) scanRef.current() })
      : null
    scan()
    return () => {
      scanRef.current = null
      if (typeof unsubscribe === 'function') unsubscribe()
      observer.disconnect()
      removeAll()
    }
  }, [enabled, inboxFace])
  if (inputActions === undefined || updateQueue === undefined || inboxFace === undefined) return null
  if (!enabled || !queueMutable) return null
  return h('div', { className: 'cx-steer-host' })
}

// 对话 fork:重写式分叉——从消息气泡处分叉到该轮之前(该轮不带入子会话消息流),
// 该轮用户输入回填子会话输入框供编辑重发(与插话撤回同构,作用于 fork 场景,不动原会话)。
// 锚点通道:消息气泡 DOM 携带官方轮号标记 data-chat-turn,轮号 → { 结束 seq, 首问文本 }
// 映射经 remote.session.follow 开场帧一次拉取(点分门控,旧宿主缺失即整体不注册);
// 轮号无映射 = 该轮未完成,首问无文本(纯图等)= 无法重试,均不注入;
// 首轮无前锚(宿主 fork 边界必须落在 turn/end 上,复制零事件不可表达),也不注入。
// 分叉动作经宿主 sessions 服务面 fork+open(与官方 chat 同构),成功 toast 并切换
function ForkDockWithBootstrap({ session, inputActions, useInput, forkSession, cancelSession, submitPrompt, loadTurnEnds }) {
  // 依赖键 = 会话 id:session 快照身份随每次投影更新漂移,不能作 effect 依赖;
  // loadTurnEnds 闭包身份同样不稳定,经 ref 取用
  const sessionId = session && session.sessionId
  const loadRef = useRef(loadTurnEnds)
  loadRef.current = loadTurnEnds
  // 自动重发通道:宿主 prompt 调用经 apply 闭包注入(与 forkSession 同构),ref 取用
  const submitRef = useRef(null)
  submitRef.current = submitPrompt
  const [turnEnds, setTurnEnds] = useState(null)
  // 映射基线:重拉结果与基线比对,相同则不 setState——setState 会触发重渲染并再次
  // 触发扫描,新轮在映射中缺失时形成 拉取→setState→扫描→拉取 的无限循环
  const turnEndsRef = useRef(null)
  // 在途门控:MutationObserver 在流式输出期间高频触发,无门控会造成请求风暴
  const refreshPendingRef = useRef(false)
  // 重拉入口装配到 ref 供扫描调用:新轮 turn/end 落在拉取窗口之后时映射里没有该轮,
  // 注入资格判空即跳过,按钮永不出现(实测:必须刷新页面才恢复)。门控保证同时在途
  // 最多一次;结果与基线相同则不 setState,避免 setState→扫描→拉取的循环
  const refreshRef = useRef(null)
  refreshRef.current = () => {
    if (refreshPendingRef.current) return
    refreshPendingRef.current = true
    Promise.resolve(loadRef.current())
      .then((map) => {
        refreshPendingRef.current = false
        if (turnEndsRef.current === map) return
        turnEndsRef.current = map
        setTurnEnds(map)
      })
      .catch(() => { refreshPendingRef.current = false })
  }
  useEffect(() => {
    if (sessionId === undefined) return undefined
    let disposed = false
    // 拉取前置空:会话切换后旧会话的映射不得继续服务新会话——轮号跨会话重叠,
    // 旧 seq 会让分叉锚点错位;置空期间 ForkDock 以 null 短路,不注入按钮
    setTurnEnds(null)
    turnEndsRef.current = null
    loadRef.current()
      .then((map) => {
        if (disposed) return
        turnEndsRef.current = map
        setTurnEnds(map)
      })
      .catch((error) => {
        // 映射拉取失败(网络/宿主繁忙):fork 无锚点可用,保持禁用不注入;
        // 刷新页面重试,不做自动重试风暴
        console.warn('[context-manager] fork 轮号映射拉取失败', error)
      })
    return () => { disposed = true }
  }, [sessionId])
  // 重试草稿消费:open 切到子会话后本 dock 随之挂载,inputActions 绑定子会话,
  // 暂存文本此刻回填;消费即清除。open 失败时暂存保留,用户手动打开子会话仍兑现。
  // 宿主 open 可能先于点击处登记草稿完成子会话 dock 挂载(实测 ~400ms 切换),
  // 挂载时草稿未到即空跑一次且依赖不再变化——安排有限次延迟重查兜底。
  // 自动重发(开关开):草稿带 autoSubmit 标记,setDraft 后经 remote.session.prompt
  // 立即提交原文(重生成语义);prompt 失败仅 toast——文本已在输入框,可手动发送
  const [draftPollTick, setDraftPollTick] = useState(0)
  // 回填前探测输入框当前草稿:宿主输入快照(useInput)只在快照面可用,
  // 缺失时按空草稿处理(旧宿主降级为原行为)
  const liveDraft = typeof useInput === 'function' ? useInput((state) => state.draft) : ''
  const liveDraftRef = useRef('')
  liveDraftRef.current = typeof liveDraft === 'string' ? liveDraft : ''
  useEffect(() => {
    if (sessionId === undefined || !inputActions || typeof inputActions.setDraft !== 'function') return undefined
    if (consumedForkDrafts.has(sessionId)) return undefined
    const draft = pendingForkDrafts.get(sessionId)
    if (draft === undefined) {
      if (draftPollTick >= FORK_DRAFT_POLLS) return undefined
      const timer = setTimeout(() => setDraftPollTick(draftPollTick + 1), FORK_DRAFT_POLL_MS)
      return () => clearTimeout(timer)
    }
    pendingForkDrafts.delete(sessionId)
    consumedForkDrafts.add(sessionId)
    const text = draft && typeof draft === 'object' ? draft.text : draft
    const autoSubmit = Boolean(draft && typeof draft === 'object' && draft.autoSubmit === true)
    // 用户已开始输入:回填是破坏性整体替换(setDraft 清根重建),优先级低于用户输入;
    // 放弃回填并提示,避免吞掉用户在 dock 挂载窗口内的击键
    const draftOccupied = liveDraftRef.current.trim() !== ''
    if (autoSubmit && submitRef.current) {
      // 提交即无草稿(官方发送语义):原文已发出,输入框不得残留,否则用户再发即重复消息;
      // 提交失败才回填文本,供手动重发
      if (draftOccupied) {
        toast('子会话已有输入,原输入未自动发送')
        return undefined
      }
      Promise.resolve(submitRef.current({ sessionId, text })).catch((error) => {
        if (typeof inputActions.setDraft === 'function') inputActions.setDraft(text)
        toast('自动重发失败,文本已回填输入框可手动发送: ' + String(error && error.message || error), { kind: 'error' })
      })
    } else if (draftOccupied) {
      toast('子会话已有输入,原输入未回填')
    } else {
      inputActions.setDraft(text)
    }
    return undefined
  }, [sessionId, inputActions, draftPollTick])
  return h(ForkDock, { session, forkSession, cancelSession, turnEnds, refreshRef })
}

function ForkDock({ session, forkSession, cancelSession, turnEnds, refreshRef }) {
  const [enabled, setEnabled] = useState(true)
  const [autoResend, setAutoResend] = useState(false)
  const turnEndsRef = useRef(null)
  const forkRef = useRef(null)
  const cancelRef = useRef(null)
  const sessionRef = useRef(null)
  const enabledRef = useRef(true)
  const autoResendRef = useRef(false)
  useEffect(() => {
    api(FORK_ENABLED_URL)
      .then((payload) => setEnabled(payload ? payload.enabled !== false : true))
      .catch(() => {})
    api(FORK_AUTO_RESEND_URL)
      .then((payload) => setAutoResend(Boolean(payload && payload.enabled === true)))
      .catch(() => {})
  }, [])
  // 条件 return 之前同步全部 ref:停用与映射置空窗口内 scan 门控也要看到最新值,
  // 否则旧会话的映射会继续服务新 DOM(轮号跨会话重叠,锚点错位)
  enabledRef.current = enabled
  autoResendRef.current = autoResend
  turnEndsRef.current = turnEnds
  forkRef.current = forkSession
  cancelRef.current = cancelSession
  sessionRef.current = session
  useEffect(() => {
    function removeAll() {
      document.querySelectorAll('[' + FORK_BTN_FLAG + ']').forEach((button) => button.remove())
    }
    function scan() {
      // 停用即不注入并移除已注入按钮(开关可在挂载后才到达停用值)
      if (!enabledRef.current) {
        removeAll()
        return
      }
      if (turnEndsRef.current === null) return
      const bubbles = document.querySelectorAll('[' + TURN_ATTR + ']')
      bubbles.forEach((bubble) => {
        // 只注入用户输入气泡:重写该轮改的是该轮的输入;官方分支按钮已驻留在
        // 轮尾操作排(含该轮的完整分叉),两者语义互补,位置也不重叠
        if (bubble.getAttribute(FLOW_KIND_ATTR) !== 'user') return
        const actionsRow = bubble.querySelector(BUBBLE_ACTIONS_SUFFIX)
        if (!actionsRow) return
        if (actionsRow.querySelector('[' + FORK_BTN_FLAG + ']')) return
        // 空属性串 Number('') = 0,会把无轮号气泡误判为第 0 轮,先判空
        const rawTurn = bubble.getAttribute(TURN_ATTR)
        if (rawTurn === null || rawTurn.trim() === '') return
        const turn = Number(rawTurn)
        if (!Number.isInteger(turn)) return
        // 重试资格三查:映射缺失的轮(超窗口/新轮)不可分叉;首轮无前锚(宿主
        // fork 边界必须落在 turn/end,复制零事件不可表达);无首问文本(纯图等)
        // 回填无从谈起。open=true 的进行中轮 turn/end 未落账,同样可分叉——
        // 锚点取其前一个闭合轮,该轮未完成的回复分叉后停掉(见点击处理器)。
        // 按钮在场即暗示可用,禁用态文案无法区分成因,不注入即误导
        const entry = turnEndsRef.current.get(turn)
        if (entry === undefined) {
          // 新轮:映射是挂载时的一次快照,补拉后由 setState 触发重扫
          if (refreshRef.current) refreshRef.current()
          return
        }
        if (entry.text === null) return
        let previous = null
        for (const key of turnEndsRef.current.keys()) {
          const candidate = turnEndsRef.current.get(key)
          if (key < turn && candidate && candidate.seq !== null && (previous === null || key > previous)) previous = key
        }
        if (previous === null) return
        const anchor = turnEndsRef.current.get(previous)
        const official = actionsRow.querySelector('button:not([' + FORK_BTN_FLAG + '])')
        if (!official) return
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute(FORK_BTN_FLAG, '')
        // 克隆官方按钮类名:尺寸/hover/悬停显隐(reveal)全部原生
        button.className = official.className
        button.title = entry.open
          ? '重写该轮(进行中):分叉到该轮之前,原输入回填输入框重新编辑;分叉后停止本会话该轮未完成的回复'
          : '重写该轮:分叉到该轮之前,原输入回填输入框重新编辑(官方「在新对话中分支」含该轮,两者互补)'
        button.addEventListener('click', () => {
          const forkSessionFn = forkRef.current
          const cancelSessionFn = cancelRef.current
          const autoResendOn = autoResendRef.current
          const current = sessionRef.current
          const currentEntry = turnEndsRef.current === null ? undefined : turnEndsRef.current.get(turn)
          const previousEntry = turnEndsRef.current === null || previous === null ? undefined : turnEndsRef.current.get(previous)
          if (!forkSessionFn || !currentEntry || !previousEntry || !current) {
            toast('该轮不可分叉', { kind: 'error' })
            return
          }
          forkSessionFn({ sessionId: current.sessionId, atSeq: previousEntry.seq, increaseTitle: true })
            .then((childId) => {
              // 暂存先于 toast:open 的子会话挂载可能紧随 resolve,回填承诺必须先就位;
              // open 失败时暂存保留,用户手动打开子会话仍兑现;
              // 自动重发开关开:登记带标记草稿,子会话消费时直接提交(不留草稿)
              if (typeof childId === 'string' && childId !== '') {
                pendingForkDrafts.set(childId, { text: currentEntry.text, autoSubmit: autoResendOn })
                consumedForkDrafts.delete(childId)
              }
              // 进行中轮分叉后原会话该轮无人再读,停掉止损;失败不影响分叉成功事实
              if (currentEntry.open === true && typeof cancelSessionFn === 'function') {
                Promise.resolve(cancelSessionFn({ sessionId: current.sessionId })).catch((error) => {
                  console.warn('[context-manager] 分叉后停止原会话进行中回复失败', error)
                })
              }
              toast(autoResendOn ? '已分叉,原输入已自动发送到子会话' : '已分叉,原输入已填入子会话输入框')
              return childId
            })
            .catch((error) => {
              const code = error && error.code
              toast(forkFailureText(code ?? (error && error.message)), { kind: 'error', sticky: true })
            })
        })
        button.appendChild(forkSvg())
        actionsRow.appendChild(button)
      })
    }
    if (typeof MutationObserver === 'undefined' || typeof document.querySelectorAll !== 'function') return undefined
    const scanRef = { current: scan }
    const observer = new MutationObserver(() => { if (scanRef.current) scanRef.current() })
    observer.observe(document.documentElement, { childList: true, subtree: true })
    scan()
    return () => {
      scanRef.current = null
      observer.disconnect()
      removeAll()
    }
  }, [turnEnds])
  if (session === undefined || turnEnds === null) return null
  if (!enabled) return null
  return h('div', { className: 'cx-fork-host' })
}

// 面板设置项悬停说明:原生 title(设置侧栏为滚动容器,CSS 气泡会被 overflow
// 裁剪,JS 定位复杂度不成比例);文案与功能行为同源维护,由源码契约测试锁定
const HISTORY_SWITCH_TITLE = '在输入框按 Alt+↑ 唤起历史输入浮层,浏览并回填历史输入;浮层内 ←/→ 切换范围,点击顶栏范围标签展开选择(常用 / 当前会话 / 本工作区 / 全部工作区),顶部搜索框过滤条目,行悬停星标可收藏常用提示词。停用后快捷键与浮层整体关闭,刷新页面生效。'
const HISTORY_BUTTON_SWITCH_TITLE = '输入框下方工具排显示历史输入按钮,点击打开浮层,再点关闭,与 Alt+↑ 等效;停用仅隐藏按钮,快捷键与浮层不受影响;刷新页面生效。'
const STEER_SWITCH_TITLE = '未应用插话气泡的操作排显示撤回图标(与复制按钮同排),点击撤回并把原文填回输入框(覆盖输入框现有草稿);图标覆盖插话的 pending 阶段(刚发出、尚未进入对话流)与 durable 阶段(已进入对话流未应用),被应用后随队列投影摘除;点击瞬间恰好被应用的仅提示不可撤回;含附件的插话不支持撤回;停用即移除已注入图标,刷新页面生效。'
const FORK_SWITCH_TITLE = '消息气泡操作排显示分叉按钮,点击分叉出新会话到该轮之前(该轮不带入子会话),该轮的用户输入自动回填子会话输入框供编辑重发,子会话自动打开且标题尾号递增;进行中的轮(回复尚未完成)同样可分叉,分叉后自动停止本会话该轮未完成的回复;首轮(无更早上下文可继承,新建会话即为同义操作)与无文本输入的轮(纯图等,无从重发)不注入;停用即不再注入,刷新页面生效。'
const FORK_AUTO_RESEND_SWITCH_TITLE = '分叉成功后自动把该轮原输入发送到子会话立即开跑(重生成语义,相当于原输入重跑一遍);关闭时分叉仅把原输入回填子会话输入框,由你编辑后再手动发送。'
const COPY_SID_SWITCH_TITLE = '会话标题栏显示复制 sessionId 按钮,平时隐藏,鼠标移到标题栏任意位置时显示,点击复制当前会话 id 到剪贴板(便于粘贴给他人排查或脚本引用);关闭后按钮整体不渲染,刷新页面生效。'
const CLONE_SWITCH_TITLE = '官方「添加工作区」浏览目录弹窗内显示「克隆仓库…」按钮:输入远程仓库地址,克隆到弹窗当前所选目录(或记忆/手填的父目录)并自动打开为新工作区,空会话立即可发消息;私有仓库使用 git 自身凭据;关闭后按钮不再注入,刷新页面生效。'

// 复制动作(纯函数,剪贴板与文档依赖注入):clipboard.writeText 优先,缺失或
// 抛错(LAN http 非安全上下文无 navigator.clipboard)回退隐藏文本域 execCommand;
// 全部失败返回 false,由调用方 toast 反馈
async function copySidText(text, clipboard, doc) {
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // 非安全上下文拒绝等,落回退路径
    }
  }
  try {
    const area = doc.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    doc.body.appendChild(area)
    try {
      area.select()
      return doc.execCommand('copy') === true
    } finally {
      // 含会话 id 的临时节点必须无条件清理,异常路径不得残留 DOM
      area.remove()
    }
  } catch {
    return false
  }
}

// 标题栏复制 sessionId 按钮:挂官方 conversation.session.header.actions 插槽
// (标准模式标签右侧,sessionId 由插槽 standardProps 下发),开关停用即整体
// 不渲染;启停读取失败按启用兜底(与 HistoryDock/switchRow 一致)
function CopySidButton({ sessionId }) {
  const [enabled, setEnabled] = useState(true)
  useEffect(() => {
    api(COPY_SID_ENABLED_URL)
      .then((payload) => setEnabled(payload ? payload.enabled !== false : true))
      .catch(() => {})
  }, [])
  if (!sessionId || !enabled) return null
  // copySidText 为 async 函数(内部全路径吞异常),必 resolve,失败以 false 表达
  const copy = () => {
    copySidText(sessionId, navigator.clipboard, document)
      .then((ok) => toast(ok ? '已复制 sessionId' : '复制失败', ok ? undefined : { kind: 'error' }))
  }
  return h('button', { type: 'button', className: 'cx-sid', title: '复制 sessionId', 'aria-label': '复制 sessionId', onClick: copy },
    h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
      h('rect', { x: 5.75, y: 5.75, width: 7.5, height: 7.5, rx: 1.5, stroke: 'currentColor', 'stroke-width': '1.2' }),
      h('path', { d: 'M10.25 3.25H4.25a1.5 1.5 0 0 0-1.5 1.5v6', stroke: 'currentColor', 'stroke-width': '1.2', 'stroke-linecap': 'round' }),
    ),
  )
}

// ── 克隆仓库打开工作区:官方「添加工作区」浏览目录弹窗内注入「克隆仓库…」按钮 ──
// IDEA "Get from VCS" 同构:按钮点击读取弹窗当前目录为父目录,自绘弹窗收集
// 仓库地址/目录名/浅克隆,宿主 git clone 成功后 workspaces.create +
// uiWorkspace.startSession 直接落入新工作区空会话。

const CLONE_BTN_FLAG = 'data-cx-clone-trigger'
// 工作区 header 常驻克隆入口:官方「添加工作区」按钮旁。浏览弹窗的打开依赖
// web-startup-auth 环境组合,未装时基座按钮无反应,此按钮为独立可用入口
// (生产有 auth 环境同为快捷入口,行为一致不做环境探测)
const HEADER_CLONE_BTN_FLAG = 'data-cx-clone-header-btn'
const HEADER_CLONE_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M4 2v8"/><circle cx="12" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><path d="M12 6a6 6 0 0 1-6 6"/></svg>'
// 官方浏览目录弹窗识别:含面包屑导航(role=navigation)的 dialog 卡片即唯一;
// 新建文件夹子弹窗无导航,天然排除
const BROWSE_NAV_SELECTOR = '[role="dialog"]'
// 父目录与浅克隆偏好记忆:localStorage,读写全吞异常(隐私模式可能拒绝)
const CLONE_PARENT_MEMORY_KEY = 'cxCloneParent'
const CLONE_SHALLOW_MEMORY_KEY = 'cxCloneShallow'
// 弹窗与 Escape 竞态:捕获阶段吃掉弹窗打开期的 Escape,防官方浏览弹窗同时被关
const CLONE_SCAN_WINDOW_MS = 5 * 1000
const CLONE_SCAN_LIMIT = 2000

// 目录名推导镜像(与 clone.mjs deriveRepoName 同步维护,parity 测试锁定):
// https(s)/ssh/git 协议取路径尾段,git@host:path scp 语法取冒号后尾段,
// 去 .git 后缀;推导不出非空名返回 null,由弹窗要求手填
function deriveRepoNameClient(rawUrl) {
  const url = String(rawUrl ?? '').trim()
  if (url === '') return null
  let tail = url
  const scp = /^git@[^:]+:(.+)$/.exec(url)
  if (scp) tail = scp[1]
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) tail = url.slice(url.indexOf('://') + 3)
  tail = tail.replace(/\/+$/, '')
  const name = tail.split('/').pop().replace(/\.git$/i, '').trim()
  return name === '' || name === '.' || name === '..' ? null : name
}

// 读取浏览弹窗当前目录:点击官方「编辑路径」按钮切到输入态,轮询读完整路径。
// 代价与边界(实测锁定):合成 Escape 在 portal 内到不了 React 面但会触发官方
// Modal 的 document 级监听——还原动作必然把浏览弹窗整体收起,故读取即收起,
// 克隆弹窗随后顶上;读取失败(按钮缺失/输入态未渲染)返回 null,由调用方回退
// 记忆值。poll 注入便于测试
async function readBrowseCurrentPath(card, doc, { poll = defaultPoll } = {}) {
  try {
    const crumbBar = card.querySelector('[role="navigation"]').parentElement
    const editZone = crumbBar.querySelector('button[class*="_crumbEditZone"]')
    if (!editZone || editZone.disabled) return null
    editZone.click()
    const pathInput = await poll(() => crumbBar.querySelector('input'))
    if (!pathInput) return null
    const value = pathInput.value
    try {
      pathInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    } catch {
      // 测试环境无 KeyboardEvent;浏览器内该派发必然收起官方弹窗(函数头注释)
    }
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  } catch {
    return null
  }
}

// 轮询默认实现:30ms 步进,上限 600ms(后台标签 rAF 被节流,不可用)
function defaultPoll(query) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const tick = () => {
      const found = query()
      if (found || Date.now() - startedAt > 600) {
        resolve(found)
        return
      }
      setTimeout(tick, 30)
    }
    tick()
  })
}

// 官方浏览目录弹窗寻卡:含面包屑的 dialog 卡片
function findBrowseDialog(doc) {
  for (const card of doc.querySelectorAll(BROWSE_NAV_SELECTOR)) {
    if (card.querySelector('[role="navigation"]')) return card
  }
  return null
}

// 弹窗 footer 定位:面包屑向上走到卡片直子(editorScope),其末子 div 即
// footerBar;打开按钮=末个 button,取消按钮=其前一个兄弟 button。
// 结构不符返回 null(官方改版时整体静默跳过,干净禁用)
function findBrowseFooter(card) {
  let scope = card.querySelector('[role="navigation"]')
  if (!scope) return null
  while (scope.parentElement && scope.parentElement !== card) scope = scope.parentElement
  if (scope.parentElement !== card) return null
  const footer = scope.lastElementChild
  if (!footer || !footer.querySelectorAll || footer.querySelectorAll('button').length < 3) return null
  const openButton = footer.querySelector('button:last-of-type')
  if (!openButton) return null
  const previous = openButton.previousElementSibling
  const cancelButton = previous && previous.tagName === 'BUTTON' ? previous : null
  return { footer, openButton, cancelButton }
}

// 幂等注入:未注入时克隆取消按钮类名(outline 形态)创建,置于打开按钮之前;
// 已注入时同步 disabled 镜像(镜像打开按钮:loading/拖拽态/无目标目录同样不可克隆)
function ensureCloneButton(doc, footerParts, onOpen) {
  const existing = footerParts.footer.querySelector('[' + CLONE_BTN_FLAG + ']')
  if (existing) {
    // 条件写入:disabled 无变化不落属性,防「观察→写属性→再观察」变异环
    const next = footerParts.openButton.disabled
    if (existing.disabled !== next) {
      existing.disabled = next
      return true
    }
    return false
  }
  const button = doc.createElement('button')
  button.type = 'button'
  button.setAttribute(CLONE_BTN_FLAG, '')
  button.className = footerParts.cancelButton ? footerParts.cancelButton.className : footerParts.openButton.className
  button.textContent = '克隆仓库…'
  button.title = '输入远程仓库地址,克隆到当前所选目录并打开为新工作区'
  button.disabled = footerParts.openButton.disabled
  button.addEventListener('click', onOpen)
  footerParts.footer.insertBefore(button, footerParts.openButton)
  return true
}

// header 常驻克隆入口:悬浮定位在官方「添加工作区」按钮右侧。必须挂 body——
// 插进 headerActions 会被基座 React 重渲染反复卸载,注入→卸载→再注入自激成
// 变异风暴(隔离环境实测);body 直挂节点 React 管不到,位置校正用条件写
// (值不变不落样式),稳态零变异
function ensureHeaderCloneButton(doc, onOpen, allowed) {
  const existing = doc.querySelector('[' + HEADER_CLONE_BTN_FLAG + ']')
  const addBtn = doc.querySelector('button[aria-label=添加工作区]')
  if (allowed === false) {
    // auth 在场:header 保持官方布局,隐藏(而非移除)已注入按钮,状态翻转可复显
    if (!existing) return false
    if (existing.style.display !== 'none') { existing.style.display = 'none'; return true }
    return false
  }
  if (!addBtn || !addBtn.parentElement) {
    if (!existing) return false
    if (existing.style.display !== 'none') existing.style.display = 'none'
    return true
  }
  if (existing) {
    let touched = false
    if (existing.style.display === 'none') { existing.style.display = ''; touched = true }
    // disabled 镜像:基座重渲染会重建按钮并重置镜像,条件写跟进
    const next = addBtn.disabled
    if (existing.disabled !== next) { existing.disabled = next; touched = true }
    // 容器宽度护栏:官方样式对 headerActions 硬编码 max-width(仅容 2 图标)+
    // overflow:hidden,第 3 个图标会被整体裁掉;条件写解除,隐藏分支回落原状
    if (addBtn.parentElement.style.maxWidth !== 'none') { addBtn.parentElement.style.maxWidth = 'none'; touched = true }
    return touched
  }
  const button = doc.createElement('button')
  button.type = 'button'
  button.setAttribute(HEADER_CLONE_BTN_FLAG, '')
  // 不带 data-plugin:该标记会被宿主样式 claim 逻辑登记为插件名下节点被回收
  button.className = addBtn.className
  button.setAttribute('aria-label', '克隆仓库打开工作区')
  button.title = '克隆仓库打开工作区(输入远程地址与目标全路径,无需浏览目录)'
  button.innerHTML = HEADER_CLONE_ICON
  button.disabled = addBtn.disabled
  button.addEventListener('click', onOpen)
  addBtn.parentElement.insertBefore(button, addBtn.nextSibling)
  addBtn.parentElement.style.maxWidth = 'none'
  return true
}
function readMemory(key) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeMemory(key, value) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // 隐私模式等存储不可用场景,记忆缺失仅影响下次预填
  }
}

// 克隆弹窗(纯 DOM,无 ReactDOM 依赖):收集仓库地址/目标目录全路径/浅克隆
// (IDEA Get from VCS 同构,单一路径字段);目标目录预填 = 弹窗当前目录(或记忆)
// + 推导目录名,地址变更时未手改的目标自动重算尾段;提交经 onSubmit 注入,
// 弹窗只管状态呈现。返回 close
function openCloneModal(doc, { parentDir, onSubmit }) {
  const overlay = doc.createElement('div')
  overlay.className = 'cx-clone-overlay'

  const close = () => { overlay.remove(); doc.removeEventListener('keydown', onKey, true) }
  const onKey = (event) => {
    if (event.key !== 'Escape') return
    if (busy) return
    event.stopPropagation()
    close()
  }

  const title = doc.createElement('h3')
  title.className = 'cx-clone__title'
  title.textContent = '克隆仓库'

  const mkField = (labelText, value, placeholder) => {
    const field = doc.createElement('label')
    field.className = 'cx-clone__field'
    const label = doc.createElement('span')
    label.textContent = labelText
    const input = doc.createElement('input')
    input.className = 'cx-clone__input'
    input.value = value
    input.placeholder = placeholder || ''
    field.appendChild(label)
    field.appendChild(input)
    return { field, input }
  }

  const urlField = mkField('仓库地址', '', 'https://github.com/user/repo.git')
  const targetField = mkField('目标目录(完整路径)', '', '如 C:\\Users\\you\\projects\\repo')

  // 预填基准:弹窗当前目录(读取即含尾分隔符)优先,记忆父目录次之;
  // 地址变更时未手改的目标重算尾段为推导目录名
  const baseDir = parentDir
  const joinTarget = (name) => {
    if (baseDir === '') return name
    const sep = /[\\/]$/.test(baseDir) ? '' : (baseDir.includes('\\') ? '\\' : '/')
    return baseDir + sep + name
  }
  let targetDirty = false
  urlField.input.addEventListener('change', () => {
    if (targetDirty) return
    const derived = deriveRepoNameClient(urlField.input.value)
    if (derived !== null) targetField.input.value = joinTarget(derived)
  })
  targetField.input.addEventListener('input', () => { targetDirty = true })
  const initialName = deriveRepoNameClient('')
  targetField.input.value = baseDir === '' ? '' : joinTarget(initialName || 'repo')

  const switchLabel = doc.createElement('label')
  switchLabel.className = 'cx-switch cx-clone__switch'
  const shallowBox = doc.createElement('input')
  shallowBox.type = 'checkbox'
  shallowBox.checked = readMemory(CLONE_SHALLOW_MEMORY_KEY) === '1'
  const track = doc.createElement('span')
  track.className = 'cx-switch__track'
  const thumb = doc.createElement('span')
  thumb.className = 'cx-switch__thumb'
  track.appendChild(thumb)
  const switchText = doc.createElement('span')
  switchText.textContent = '浅克隆(--depth 1,只取最新提交)'
  switchLabel.appendChild(shallowBox)
  switchLabel.appendChild(track)
  switchLabel.appendChild(switchText)

  const status = doc.createElement('div')
  status.className = 'cx-clone__status'

  const actions = doc.createElement('div')
  actions.className = 'cx-clone__actions'
  const cancelBtn = doc.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'cx-clone__btn cx-clone__btn--ghost'
  cancelBtn.textContent = '取消'
  const submitBtn = doc.createElement('button')
  submitBtn.type = 'button'
  submitBtn.className = 'cx-clone__btn'
  submitBtn.textContent = '克隆'
  actions.appendChild(cancelBtn)
  actions.appendChild(submitBtn)

  const card = doc.createElement('div')
  card.className = 'cx-clone'
  card.appendChild(title)
  card.appendChild(urlField.field)
  card.appendChild(targetField.field)
  card.appendChild(switchLabel)
  card.appendChild(status)
  card.appendChild(actions)
  overlay.appendChild(card)

  let busy = false
  const setBusy = (value) => {
    busy = value
    for (const input of [urlField.input, targetField.input, shallowBox]) input.disabled = value
    submitBtn.disabled = value
    cancelBtn.disabled = value
  }
  const setStatus = (text, isError) => {
    status.textContent = text
    status.className = 'cx-clone__status' + (isError ? ' cx-clone__status--error' : '')
  }

  cancelBtn.addEventListener('click', () => { if (!busy) close() })
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay && !busy) close()
  })
  submitBtn.addEventListener('click', () => {
    if (busy) return
    const payload = {
      url: urlField.input.value.trim(),
      target: targetField.input.value.trim(),
      shallow: shallowBox.checked,
    }
    if (payload.url === '') {
      setStatus('仓库地址不能为空', true)
      return
    }
    if (payload.target === '') {
      setStatus('目标目录不能为空', true)
      return
    }
    setBusy(true)
    setStatus('克隆中…(大仓库可能需要数分钟,请勿关闭页面)', false)
    onSubmit(payload)
      .then((result) => {
        writeMemory(CLONE_PARENT_MEMORY_KEY, parentOfClient(payload.target))
        writeMemory(CLONE_SHALLOW_MEMORY_KEY, shallowBox.checked ? '1' : '0')
        close()
        return result
      })
      .catch((error) => {
        setBusy(false)
        setStatus(error && error.message ? error.message : String(error), true)
      })
  })

  doc.addEventListener('keydown', onKey, true)
  doc.body.appendChild(overlay)
  urlField.input.focus()
  return close
}

// 目标全路径的父目录(记忆下次预填基准);正反斜杠分隔符均支持
function parentOfClient(targetPath) {
  const trimmed = String(targetPath ?? '').replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return cut <= 0 ? trimmed : trimmed.slice(0, cut)
}

// 全局注入循环:MutationObserver(childList,与 steer/fork dock 同构)跟踪官方
// 弹窗出现,rescan 幂等;弹窗不在场或开关关闭时摘除自家按钮。变异风暴熔断:
// 计数对象是「自家写入」——注入/摘除/条件写各计一次,窗口内超限即断开观察器
// 并摘除自家节点。页面水合期的高频自身变异零自家写入,不会误伤;而
// 「注入→基座卸载→再注入」类自激环必然高频自家写入,稳定触发熔断。
// 返回清理函数
function setupCloneInjection(doc, { enabledRef, onOpen }) {
  if (typeof MutationObserver === 'undefined' || typeof doc.querySelectorAll !== 'function') return () => {}
  let disposed = false
  let writes = 0
  let windowStart = Date.now()
  let observer = null
  // header 兜底入口:默认注入(无闸门环境基座按钮无反应,第 4 按钮是唯一入口),
  // 启动后轮询探测登录闸门——`/login` 是 auth 包的排他性路由,带闸门宿主返回
  // 200,无闸门宿主 404;命中即物理移除按钮还原官方 3 按钮布局,克隆入口收敛到
  // 浏览弹窗 footer。探测窗口 30s 封顶(每秒一次),超时未见闸门则按钮常驻
  let headerAllowed = true
  const HEADER_PROBE_INTERVAL_MS = 1000
  const HEADER_PROBE_ROUNDS = 30
  let headerProbeTimer = null
  let headerProbeRounds = 0
  const armAuthProbe = () => {
    if (typeof fetch !== 'function' || headerProbeTimer) return
    const probe = () => {
      if (disposed || !headerAllowed) { clearInterval(headerProbeTimer); headerProbeTimer = null; return }
      headerProbeRounds += 1
      fetch('/login', { credentials: 'omit' })
        .then((res) => {
          if (disposed || !headerAllowed) return
          if (res.ok) {
            headerAllowed = false
            clearInterval(headerProbeTimer)
            headerProbeTimer = null
            removeAllHeader()
            rescan()
          }
        })
        .catch(() => {})
      if (headerProbeRounds >= HEADER_PROBE_ROUNDS) { clearInterval(headerProbeTimer); headerProbeTimer = null }
    }
    probe()
    headerProbeTimer = setInterval(probe, HEADER_PROBE_INTERVAL_MS)
  }
  // header 按钮被外部(基座重渲染卸载/早期净化)移除时指数退避重试;重试由
  // setTimeout 主动调度——静置期无变异驱动 observer,被动等变异会死锁在退避期
  let headerInjected = false
  let headerRetryAt = 0
  let headerBackoffMs = 1000
  let headerRetryTimer = null
  // 只摘 footer 按钮:header 按钮生命周期由 ensureHeader 独占(在场条件写/
  // 消失隐藏,永不物理移除)。若在此摘 header 按钮,「摘+建」会在同一 rescan
  // 内各计一次写,形成摘建自激永动机(隔离环境实测 2001 写熔断)
  const removeAll = () => {
    let removedAny = false
    for (const stale of doc.querySelectorAll('[' + CLONE_BTN_FLAG + ']')) { stale.remove(); removedAny = true }
    return removedAny
  }
  const removeAllHeader = () => {
    let removedAny = false
    for (const stale of doc.querySelectorAll('[' + HEADER_CLONE_BTN_FLAG + ']')) { stale.remove(); removedAny = true }
    return removedAny
  }
  const ensureHeader = (now) => {
    // 探测到登录闸门(headerAllowed=false)后保持官方 3 按钮布局:按钮已物理
    // 移除,基座重渲染也不会再注入
    if (!headerAllowed) return ensureHeaderCloneButton(doc, onOpen, false)
    const floatingPresent = !!doc.querySelector('[' + HEADER_CLONE_BTN_FLAG + ']')
    if (headerInjected && !floatingPresent) {
      headerBackoffMs = Math.min(headerBackoffMs * 2, 30 * 1000)
      headerRetryAt = now + headerBackoffMs
      headerInjected = false
      return false
    }
    if (floatingPresent) {
      headerInjected = true
      headerBackoffMs = 1000
      return ensureHeaderCloneButton(doc, onOpen)
    }
    if (now < headerRetryAt) {
      if (!headerRetryTimer) headerRetryTimer = setTimeout(() => { headerRetryTimer = null; rescan() }, headerRetryAt - now + 50)
      return false
    }
    const created = ensureHeaderCloneButton(doc, onOpen)
    if (created) headerInjected = true
    return created
  }
  const rescan = () => {
    if (disposed) return
    const now = Date.now()
    if (now - windowStart > CLONE_SCAN_WINDOW_MS) {
      windowStart = now
      writes = 0
    }
    let wrote = false
    let wroteFrom = ''
    const card = enabledRef.current ? findBrowseDialog(doc) : null
    if (!card) {
      if (ensureHeader(now)) { wrote = true; wroteFrom = '+header' }
      if (!wrote) return
    } else {
      if (ensureHeader(now)) { wrote = true; wroteFrom = '+header' }
      const footerParts = findBrowseFooter(card)
      if (footerParts && ensureCloneButton(doc, footerParts, onOpen)) { wrote = true; wroteFrom += '+footer' }
      if (!wrote) return
    }
    writes += 1
    if (writes > CLONE_SCAN_LIMIT) {
      console.error('[context-manager] 克隆按钮注入触发变异风暴,已自动断开观察器', JSON.stringify({ writes, wroteFrom }))
      if (observer) observer.disconnect()
      removeAll()
      removeAllHeader()
    }
  }
  observer = new MutationObserver(rescan)
  // disabled 属性观察:空目录导航完成后无 childList 变异,打开按钮的可用态
  // 翻转只有属性事件;镜像写入是条件写(值不变不落属性),不构成变异环
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] })
  armAuthProbe()
  rescan()
  return () => {
    disposed = true
    if (headerProbeTimer) clearInterval(headerProbeTimer)
    if (headerRetryTimer) clearTimeout(headerRetryTimer)
    if (observer) observer.disconnect()
    removeAll()
    removeAllHeader()
  }
}

// 启停开关行工厂:三个开关同构(受控 checkbox + cx-switch 形态),值存宿主 settings,
// 切换经本插件路由中转,变更刷新页面生效
function switchRow(url, label, title, okText) {
  function Row() {
    const [enabled, setEnabled] = useState(null)
    useEffect(() => {
      api(url)
        .then((payload) => setEnabled(payload ? payload.enabled !== false : true))
        .catch(() => setEnabled(true))
    }, [])
    // 受控 checkbox:onChange 内同步落 state(异步确认会让 DOM 与渲染竞态,
    // 视觉慢一拍),服务端响应仅用于失败回滚
    const flip = (event) => {
      const next = event.target.checked
      setEnabled(next)
      api(url, { method: 'POST', body: JSON.stringify({ enabled: next }) })
        .then((payload) => {
          toast(okText + (payload && payload.enabled !== false ? '已启用' : '已停用') + ',刷新页面后生效')
        })
        .catch(() => {
          setEnabled(!next)
          toast('切换失败', { kind: 'error' })
        })
    }
    return h('label', { className: 'cx-switch', title },
      h('input', { type: 'checkbox', checked: enabled !== false, onChange: flip }),
      h('span', { className: 'cx-switch__track' }, h('span', { className: 'cx-switch__thumb' })),
      h('span', { className: 'cx-switch__label', onClick: (event) => event.preventDefault() }, label),
    )
  }
  return Row
}

const HistorySwitchRow = switchRow(HISTORY_ENABLED_URL, '历史输入浮层(Alt+↑)', HISTORY_SWITCH_TITLE, '历史输入浮层')
const HistoryButtonSwitchRow = switchRow(HISTORY_BUTTON_ENABLED_URL, '输入框历史按钮', HISTORY_BUTTON_SWITCH_TITLE, '输入框历史按钮')
const SteerSwitchRow = switchRow(STEER_ENABLED_URL, '插话撤回', STEER_SWITCH_TITLE, '插话撤回')
const ForkSwitchRow = switchRow(FORK_ENABLED_URL, '对话 fork', FORK_SWITCH_TITLE, '对话 fork')
const ForkAutoResendSwitchRow = switchRow(FORK_AUTO_RESEND_URL, '分叉后自动重发', FORK_AUTO_RESEND_SWITCH_TITLE, '分叉后自动重发')
const CopySidSwitchRow = switchRow(COPY_SID_ENABLED_URL, '标题栏复制 sessionId', COPY_SID_SWITCH_TITLE, '标题栏复制 sessionId')
const CloneSwitchRow = switchRow(CLONE_ENABLED_URL, '克隆仓库按钮', CLONE_SWITCH_TITLE, '克隆仓库按钮')

// 「插件」设置页卡片:与官方 PluginCard 同款折叠卡(header 展开/收起 + body),
// 视觉值取自宿主实测(见 CSS 注释),组件因缺宿主 i18n/表单状态而自绘
function ContextPanel() {
  const [open, setOpen] = useState(false)
  return h('div', { className: 'cx-card' + (open ? ' cx-card--open' : '') },
    h('button', { type: 'button', className: 'cx-card__header', 'aria-expanded': open, onClick: () => setOpen(!open) },
      h('span', { className: 'cx-card__head-text' },
        h('span', { className: 'cx-card__name' }, '对话增强'),
        h('span', { className: 'cx-card__description' }, '历史输入、插话撤回、对话分叉与克隆仓库的启停'),
      ),
      h('span', { className: 'cx-card__chevron', 'aria-hidden': 'true' },
        h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none' },
          h('path', { d: 'M3.5 5.25L7 8.75L10.5 5.25', stroke: 'currentColor', 'stroke-width': '1.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
        ),
      ),
    ),
    open && h('div', { className: 'cx-card__body' },
      h('span', { className: 'cx-panel__hint' }, '变更刷新页面生效。'),
      h(HistorySwitchRow),
      h(HistoryButtonSwitchRow),
      h(SteerSwitchRow),
      h(ForkSwitchRow),
      h(ForkAutoResendSwitchRow),
      h(CopySidSwitchRow),
      h(CloneSwitchRow),
    ),
  )
}

    return {
      // remote.session 点分声明交 cordis 门控(规约禁 apply 内同步探测该面):
      // namespace 由宿主异步 $mount,fiber 等其就绪才激活,旧宿主无此 namespace
      // 即整体未激活(干净禁用,不阻塞 web 启动)
      inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'remote', 'remote.session'],
      apply(ctx) {
        const uiWorkspace = ctx.get('uiWorkspace')
        const sessions = ctx.get('sessions')
        const workspaces = ctx.get('workspaces')
        const remoteSession = ctx.remote ? ctx.remote.session : undefined
        // 分叉动作通道:分叉本体只依赖 sessions.fork;open 仅是分叉成功后打开
        // 子会话的收尾动作(失败单独吞掉,警告日志),缺失时条件执行——两代宿主
        // client 面均无 sessions.open(FIND-020-2:双函数在场探测致 fork dock
        // 整体静默缺失),放宽探测为只要求 fork。
        const forkService = (sessions && typeof sessions.fork === 'function')
          ? (opts) => sessions.fork(opts).then((childId) => {
            if (typeof sessions.open === 'function') {
              try {
                Promise.resolve(sessions.open(childId)).catch((error) => {
                  console.warn('[context-manager] 分叉子会话已创建,但打开失败', error)
                })
              } catch (error) {
                console.warn('[context-manager] 分叉子会话已创建,但打开失败', error)
              }
            }
            return childId
          })
          : null

        // 自动重发通道:开启开关时分叉后以该轮原输入 prompt 子会话;
        // remote.session 缺失或缺 prompt(旧宿主/部分 stub)时返回 null,降级为仅回填;
        // 请求形态与官方 client face 同源:content 为 text 分段数组(宿主 hasPromptContent
        // 校验),mode=queue(无进行中轮即直接开跑),clientTimeZone 随本地时区
        const submitPrompt = (remoteSession && typeof remoteSession.prompt === 'function')
          ? ({ sessionId: targetId, text }) => remoteSession.prompt({
              requestId: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
              sessionId: targetId,
              mode: 'queue',
              content: [{ type: 'text', text }],
              clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            })
          : null

        // 样式挂载在宿主文档级:设置页未打开时面板不存在,
        // 样式若随面板注入则面板裸样式渲染
        ctx.effect(() => {
          const style = document.createElement('style')
          // 自带 data-plugin:缺失时宿主 claimStyles 会把它归属给后续材质化插件,其 HMR 重建即误删
          style.setAttribute('data-plugin', '@mzzsfy/dsh-context-manager')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'context-manager styles')

        // 设置卡片:注册进官方「插件」设置页的可配置插件区(keyed slot,
        // key = 本插件 settings namespace),不占独立设置导航项。
        // 0.1.7-rc.1+ 该槽被宿主移除,卡片换形注册进插件管理页包详情配置槽
        // (plugins.bundle.config,key = 包名,管理页 ledger.bundles 判定在场);
        // 两代槽位并存注册:inject 是声明生命周期效应,错误世代宿主永不声明
        // 该槽,回调挂起不执行,零成本
        ctx.slots.inject('settings.plugin.item', () =>
          ctx.slots.register(
            { name: 'settings.plugin.item', id: 'context', key: 'context' },
            () => React.createElement(ContextPanel),
          ))
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: PKG_ID },
            () => React.createElement(ContextPanel),
          ))

        // 历史输入回溯入口:官方 conversation.input.dock 插槽(dsh-client-ui-goal 同构)。
        // 宿主缺该插槽时 inject 挂起不注册(声明生命周期效应),本功能静默缺席
        try {
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              { name: 'conversation.input.dock', id: 'context-manager-history', order: 90 },
              HistoryDock,
            ))
        } catch (error) {
          console.warn('[context-manager] 历史输入入口未注册(宿主无 conversation.input.dock 插槽)', error)
        }

        // 插话撤回入口:未应用的插话撤回到输入框重新编辑。RPC 走会话绑定面
        // binding.session.updateQueue(RemoteResult 不抛错,与官方 conversation 服务
        // 无耦合);行集由 inbox 投影 face 订阅驱动(组件内 getSnapshot+subscribe),
        // 会话面缺失或无 updateQueue(旧宿主)返回空 props,组件不渲染
        try {
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: 'context-manager-steer',
                order: 25,
                inject: (sessionId) => {
                  const binding = sessions.binding(sessionId)
                  const session = binding && binding.session
                  const updateQueue = session && session.updateQueue
                  if (typeof updateQueue !== 'function') return {}
                  const projections = session.projections
                  return {
                    updateQueue: (itemId, action) => session.updateQueue(itemId, action),
                    inboxFace: projections && typeof projections.faceOf === 'function'
                      ? projections.faceOf(INBOX_STEER_KEY)
                      : undefined,
                  }
                },
              },
              SteerRecallDock,
            ))
        } catch (error) {
          console.warn('[context-manager] 插话撤回入口未注册(宿主无 conversation.input.dock 插槽)', error)
        }

        // 对话 fork 入口:锚点映射经 remote.session.follow 开场帧一次拉取
        // (开场帧自带回溯窗口内的全部事件与 seq,取到即断开订阅,不做 live 消费),
        // 分叉动作经 sessions 服务面;分叉服务面缺失即整体不注册(干净禁用)。
        // inputActions 由插槽宿主按会话绑定注入,子会话挂载时消费重试草稿
        if (forkService) {
          try {
            ctx.slots.inject('conversation.input.dock', () =>
              ctx.slots.register(
                {
                  name: 'conversation.input.dock',
                  id: 'context-manager-fork',
                  order: 24,
                  inject: (sessionId) => ({
                    forkSession: forkService,
                    cancelSession: (typeof remoteSession.cancel === 'function')
                      ? (opts) => remoteSession.cancel(opts)
                      : null,
                    submitPrompt,
                    loadTurnEnds: () => followOpening(remoteSession, sessionId).then((records) => {
                      // 轮号 → { 结束 seq, 该轮首问文本, open }:上个 turn/end 之后首条
                      // 携带非空文本的 user 本人消息即该轮首问(轮内纯图消息跳过,
                      // 后续文本插话可补位);turn/end 落账并重置;
                      // 流末尾文本已累积而无 turn/end 的轮是进行中轮:seq=null +
                      // open=true 登记(分叉锚点取其前一个闭合轮,分叉后可停原会话);
                      // data 缺 turn 号时按出现顺序计数
                      const map = new Map()
                      let ordered = 0
                      let turnText = null
                      for (const record of records) {
                        const event = record && record.event
                        if (!event) continue
                        if (event.type === 'user/message') {
                          if (turnText === null) turnText = forkRetryText(event.data)
                          continue
                        }
                        if (event.type !== 'turn/end') continue
                        const turn = event.data && Number.isInteger(event.data.turn) ? event.data.turn : ordered
                        map.set(turn, { seq: event.seq, text: turnText, open: false })
                        turnText = null
                        ordered += 1
                      }
                      if (turnText !== null) {
                        const turn = map.size > 0 ? Math.max(...map.keys()) + 1 : 0
                        map.set(turn, { seq: null, text: turnText, open: true })
                      }
                      return map
                    }),
                  }),
                },
                ForkDockWithBootstrap,
              ))
          } catch (error) {
            console.warn('[context-manager] 对话 fork 入口未注册(宿主无 conversation.input.dock 插槽)', error)
          }
        }

        // 标题栏复制 sessionId 入口:官方 conversation.session.header.actions 插槽
        // (list,order -9 紧随官方 agent-preset 标签 -10,即「标准模式」右侧);
        // sessionId 由该插槽 standardProps 自动下发(与官方 agent-preset 标签同源),
        // 组件缺失时自行判空不渲染。宿主缺该插槽时仅禁用本功能,不阻塞其余能力
        try {
          ctx.slots.inject('conversation.session.header.actions', () =>
            ctx.slots.register(
              { name: 'conversation.session.header.actions', id: 'context-manager-copy-sid', order: -9 },
              CopySidButton,
            ))
        } catch (error) {
          console.warn('[context-manager] 复制 sessionId 入口未注册(宿主无 conversation.session.header.actions 插槽)', error)
        }

        // 克隆仓库入口:全局 DOM 注入官方「添加工作区」浏览目录弹窗(非插槽,该洞
        // 为 single 已被目录选择 flow 占用)。开关读取失败按启用兜底(与 CopySidButton
        // 一致);uiWorkspace 走 inject 声明(services 与 slots/sessions 同代际,
        // 实测 ctx.get 懒取不可用,服务面缺声明不可达),克隆成功后 startSession
        // 直接落入新工作区空会话。workspaces.create 的 client 代理直返视图
        // ({workspaceId,...};{workspace,created} 形态只存在于宿主 RPC 层)
        const openCloneWorkspace = async (targetPath) => {
          const view = await workspaces.create({ path: targetPath })
          const workspaceId = view && view.workspaceId
          if (workspaceId && uiWorkspace && typeof uiWorkspace.startSession === 'function') {
            uiWorkspace.startSession(workspaceId)
            toast('已克隆并打开工作区')
            return
          }
          toast('已克隆到 ' + targetPath + ',但无法自动打开,请手动打开工作区', { kind: 'error', sticky: true })
        }

        // 父目录来源:点击克隆按钮时经官方「编辑路径」输入态读取弹窗当前目录
        // (读取即收起浏览弹窗,代价见 readBrowseCurrentPath 注释),回退上次克隆
        // 位置(localStorage)
        const handleCloneOpen = async () => {
          const card = findBrowseDialog(document)
          const fromDialog = card ? await readBrowseCurrentPath(card, document) : null
          const parentDir = fromDialog || readMemory(CLONE_PARENT_MEMORY_KEY) || ''
          openCloneModal(document, {
            parentDir,
            onSubmit: async (payload) => {
              // 克隆耗时以分钟计,不走带 8s 超时的 api()
              const response = await fetch(CLONE_API_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
              })
              const result = await response.json().catch(() => ({}))
              if (!response.ok) throw new Error(result && result.error ? result.error : 'HTTP ' + response.status)
              const targetPath = result && result.path
              if (typeof targetPath !== 'string' || targetPath === '') throw new Error('克隆完成但未返回路径')
              // 收起浏览弹窗(读取路径路径已收起,此处兜底读取失败仍开着的场景):
              // 注册工作区与浏览弹层互不叠影,收起失败不影响注册
              const aliveCard = findBrowseDialog(document)
              const footerParts = aliveCard ? findBrowseFooter(aliveCard) : null
              if (footerParts && footerParts.cancelButton) footerParts.cancelButton.click()
              try {
                await openCloneWorkspace(targetPath)
              } catch (error) {
                toast('已克隆,但打开工作区失败: ' + String(error && error.message || error), { kind: 'error', sticky: true })
              }
            },
          })
        }
        ctx.effect(() => {
          const enabledRef = { current: true }
          let disposeScan = () => {}
          let cancelled = false
          api(CLONE_ENABLED_URL)
            .then((payload) => {
              enabledRef.current = payload ? payload.enabled !== false : true
            })
            .catch(() => {})
            .finally(() => {
              if (cancelled) return
              disposeScan = setupCloneInjection(document, {
                enabledRef,
                onOpen: () => {
                  void handleCloneOpen()
                },
              })
            })
          return () => {
            cancelled = true
            disposeScan()
          }
        }, 'context-manager clone injection')
      },
    }
  },
})


