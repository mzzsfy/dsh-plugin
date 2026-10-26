// dsh-shell-select Client 半区:tool.call.toolview shell 族卡片(官方 BashRow/
// terminalCardModel 同构 + 复制/折行/客户端徽章增强)。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory});
// 客户端名册与 Shell 管理设置页经 /api/shell-select/* 读写宿主配置。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-shell-select',
  factory(require) {
    const React = require('react')
    const { useState, useEffect } = React

    // 官方 primitives 图标/状态点(运行时模块表解析;dsh.client.inject 声明保证在场)。
    // 0.1.7 起图标名带字重后缀(Regular/Medium),尺寸是 prop 不在名字里
    const primitives = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives')
      } catch {
        return null
      }
    })()
    const createElementOf = (names, fallback) => {
      for (const name of names) {
        const Component = primitives !== null ? primitives[name] : undefined
        if (typeof Component === 'function' || typeof Component === 'object') {
          return (props) => React.createElement(Component, props ?? null)
        }
      }
      return fallback
    }
    // 降级自绘状态点:色相经 CSS 类消费包令牌(禁 JS 侧字面色,主题切换跟随)
    const DOT_CLASS = { done: 'sls-dot--ok', error: 'sls-dot--err', warning: 'sls-dot--warn', ongoing: 'sls-dot--idle' }
    // 降级自绘:模块表缺 primitives 时保持可见性(形态近似官方 StateDot/图标)
    const TOOLVIEW_ICONS = {
      StateDot: createElementOf(['StateDot'], ({ state }) => h('span', {
        className: 'sls-dot ' + (DOT_CLASS[state] ?? DOT_CLASS.ongoing),
        style: {
          width: 8, height: 8, borderRadius: '50%',
          display: 'inline-block', flex: 'none',
        },
      })),
      IconApi: createElementOf(['IconApiOutlineRegular', 'IconApiOutlineMedium', 'IconApiOutline14'], () => h('span', {
        style: {
          width: 12, height: 12, borderRadius: 3, border: '1.5px solid currentColor',
          opacity: .7, display: 'inline-block', flex: 'none',
        },
      })),
      IconInspect: createElementOf(['IconInspectOutlineRegular', 'IconInspectOutlineMedium', 'IconInspectOutline12'], () => h('span', {
        style: { fontSize: 10, lineHeight: 1, opacity: .8 },
      }, 'ⓘ')),
    }

    const API = {
      config: '/api/shell-select/config',
      probe: '/api/shell-select/probe',
      detect: '/api/shell-select/detect',
    }

    async function api(path, options) {
      const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
      return payload
    }

    // 工具卡客户端名册缓存:GET /config 单飞拉取,shell 徽章按 id→用户命名解析。
    // 失败复位单飞(宿主启动窗口路由未就绪的 404 在下次卡渲染自然重试)
    let clientCatalog = null
    let clientCatalogPromise = null
    // LOGIC-BEGIN ensureClientCatalog
    function ensureClientCatalog() {
      if (clientCatalogPromise === null) {
        clientCatalogPromise = api(API.config).then((section) => {
          const byId = {}
          for (const entry of section.resolved?.shells ?? []) byId[entry.id] = entry.id
          clientCatalog = { default: section.resolved?.default, byId }
        }).catch(() => {
          clientCatalogPromise = null
        })
      }
      return clientCatalogPromise
    }
    // LOGIC-END ensureClientCatalog
    // 显式 shell 参数按 id 取用户命名;缺省落 default 客户端的用户命名(配置即当前解析事实)
    // LOGIC-BEGIN clientDisplayName
    function clientDisplayName(requested) {
      if (clientCatalog === null) return undefined
      const id = requested !== undefined && requested !== '' ? requested : clientCatalog.default
      return id !== undefined ? clientCatalog.byId[id] : undefined
    }
    // LOGIC-END clientDisplayName

    // 仅在宿主明确报告 Windows 后,把可识别的 MSYS 路径映射回宿主文件路径。
    // 文件地址本身不经 URL round-trip,避免改写未识别的编码与后缀。
    // LOGIC-BEGIN msysToHostPath
    function msysToHostPath(value, facts) {
      if (typeof value !== 'string' || value === '') return value
      const env = facts ?? {}
      if (env.home && (value === '~' || value.startsWith('~/'))) {
        return value === '~' ? env.home : `${env.home}/${value.slice(2)}`
      }
      const drive = /^\/([a-z])\/(.*)$/i.exec(value)
      if (drive !== null) return `${drive[1].toUpperCase()}:/${drive[2]}`
      const bareDrive = /^\/([a-z])$/i.exec(value)
      if (bareDrive !== null) return `${bareDrive[1].toUpperCase()}:/`
      if (env.tmpDir && (value === '/tmp' || value.startsWith('/tmp/'))) {
        return value === '/tmp' ? env.tmpDir : env.tmpDir + value.slice(4)
      }
      return value
    }
    // LOGIC-END msysToHostPath

    // LOGIC-BEGIN rescueFileAddress
    function rescueFileAddress(address, msysToHostPath, facts) {
      const prefix = 'dsh-resource://file/'
      if (typeof address !== 'string' || !address.startsWith(prefix)) return address
      const tail = address.slice(prefix.length)
      const cut = tail.search(/[?#]/)
      const suffix = cut === -1 ? '' : tail.slice(cut)
      const parts = (cut === -1 ? tail : tail.slice(0, cut)).split('/')
      const scope = parts.shift()
      if (scope !== 'session' && scope !== 'absolute') return address
      const sessionId = scope === 'session' ? parts.shift() : undefined
      if (scope === 'session' && (!sessionId || parts.length === 0)) return address
      let decodedSessionId = sessionId
      if (scope === 'session') {
        try {
          decodedSessionId = decodeURIComponent(sessionId)
        } catch {
          return address
        }
      }
      let segments
      try {
        segments = parts.map(decodeURIComponent)
      } catch {
        return address
      }
      if (scope === 'absolute' && segments[0] === '' && segments.length > 1) return address
      const path = scope === 'absolute' ? `/${segments.join('/')}` : segments.join('/')
      const translated = msysToHostPath(path, facts)
      if (translated === path) return address
      const encoded = translated.split('/').map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')).join('/')
      const rebuilt = scope === 'session'
        ? `${prefix}session/${encodeURIComponent(decodedSessionId)}/${encoded}`
        : `${prefix}absolute/${encoded.replace(/^\/+/, '')}`
      return rebuilt + suffix
    }
    // LOGIC-END rescueFileAddress

    const PATHMAP_URL = '/api/shell-select/pathmap'
    let pathMap = null
    let pathMapRequested = false
    function loadPathMap() {
      if (pathMapRequested) return
      pathMapRequested = true
      fetch(PATHMAP_URL, { headers: { accept: 'application/json' } })
        .then((response) => response.ok ? response.json() : null)
        .then((facts) => {
          if (facts && typeof facts.platform === 'string') pathMap = facts
          else pathMapRequested = false
        })
        .catch((error) => {
          pathMapRequested = false
          console.warn('shell-select: pathmap fetch failed: ' + (error instanceof Error ? error.message : String(error)))
        })
    }
    // LOGIC-END loadPathMap

    function installPathRescue(ctx) {
      if (typeof ctx.inject !== 'function') return
      loadPathMap()
      ctx.inject(['sidebarRight'], (sctx) => {
        const controller = sctx?.sidebarRight
        if (!controller || controller.shellSelectPathRescue === true || typeof controller.openResource !== 'function') return
        if (typeof sctx.effect !== 'function') return
        const openResource = controller.openResource
        const openResourceIn = controller.openResourceIn
        let active = true
        const rescue = (address) => {
          if (!active) return address
          if (pathMap === null) loadPathMap()
          return pathMap?.platform === 'win32'
            ? rescueFileAddress(address, msysToHostPath, pathMap)
            : address
        }
        controller.openResource = function openResourceWithPathRescue(address, options) {
          return openResource.call(this, rescue(address), options)
        }
        const wrappedOpenResource = controller.openResource
        if (typeof openResourceIn === 'function') {
          controller.openResourceIn = function openResourceInWithPathRescue(sessionId, address, options) {
            return openResourceIn.call(this, sessionId, rescue(address), options)
          }
        }
        const wrappedOpenResourceIn = controller.openResourceIn
        controller.shellSelectPathRescue = true
        const restore = () => {
          active = false
          if (controller.openResource === wrappedOpenResource) controller.openResource = openResource
          if (typeof openResourceIn === 'function' && controller.openResourceIn === wrappedOpenResourceIn) controller.openResourceIn = openResourceIn
          if (controller.shellSelectPathRescue === true) delete controller.shellSelectPathRescue
        }
        sctx.effect(() => restore, 'shell-select sidebar path rescue')
      })
    }

    const CSS = [
      // 色彩令牌:直接引用宿主语义别名,禁止字面 fallback(DEVELOPMENT/plugin-ui-design.md)
      '.sls-card { --sls-border:var(--dsw-alias-border-l1); --sls-accent:var(--dsw-alias-brand-primary); --sls-track:var(--dsw-alias-border-l1); --sls-thumb:var(--dsw-alias-label-tertiary); --sls-bg-base:var(--dsw-alias-bg-base); --sls-mono:var(--ds-font-family-code);',
      '  display:flex; flex-direction:column; gap:10px; }',
      '.sls-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }',
      '.sls-entry { display:flex; flex-direction:column; gap:6px; padding:10px; border:1px solid var(--sls-border); border-radius:8px; }',
      '.sls-entry__head { display:flex; align-items:center; gap:8px; }',
      '.sls-grid { display:grid; grid-template-columns: 90px 1fr; gap:4px 8px; align-items:center; }',
      '.sls-grid__label { opacity:.75; font-size:12px; }',
      '.sls-input { padding:4px 8px; border-radius:6px; border:1px solid var(--sls-border); background:transparent; color:inherit; min-width:0; }',
      '.sls-input--wide { width:100%; box-sizing:border-box; }',
      '.sls-btn { padding:3px 10px; border-radius:6px; border:1px solid var(--sls-border); background:transparent; color:inherit; cursor:pointer; font-size:12px; }',
      '.sls-btn:disabled { opacity:.5; cursor:default; }',
      '.sls-btn--primary { border-color: transparent; background: var(--sls-accent); color:var(--sls-bg-base); }',
      '.sls-badge { font-size:11px; padding:1px 8px; border-radius:999px; border:1px solid var(--sls-border); opacity:.85; }',
      '.sls-badge--ok { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }',
      '.sls-badge--bad { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }',
      '.sls-badge--default { color:var(--sls-bg-base); background:var(--sls-accent); border-color:transparent; }',
      '.sls-hint { font-size:12px; opacity:.7; white-space:pre-wrap; overflow-wrap:anywhere; }',
      '.sls-error { font-size:12px; color:var(--dsw-alias-state-error-primary); white-space:pre-wrap; }',
      '.sls-args { font-size:12px; font-family:var(--sls-mono); }',
      '.sls-rules { display:flex; flex-direction:column; gap:6px; padding:10px; border:1px solid var(--sls-border); border-radius:8px; }',
      '.sls-rules__head { display:flex; align-items:center; gap:8px; }',
      '.sls-rules__title { font-weight:500; }',
      '.sls-rules__note { font-size:12px; opacity:.7; }',
      '.sls-rule { display:flex; align-items:center; gap:6px; }',
      '.sls-rule__no { flex:none; width:18px; text-align:right; font-size:12px; opacity:.45; user-select:none; }',
      '.sls-rule__input { flex:1; min-width:0; padding:4px 8px; border-radius:6px; border:1px solid var(--sls-border); background:transparent; color:inherit; font-size:12px; font-family:var(--sls-mono); resize:vertical; }',
      '.sls-rule__input:focus-visible { outline:2px solid var(--sls-accent); outline-offset:1px; }',
      '.sls-rule--bad .sls-rule__input { border-color:var(--dsw-alias-state-error-primary); }',
      '.sls-rule__err { flex:none; max-width:40%; font-size:11px; color:var(--dsw-alias-state-error-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      // 降级状态点:色相消费状态语义令牌
      '.sls-dot--ok { background:var(--dsw-alias-state-success-primary); }',
      '.sls-dot--err { background:var(--dsw-alias-state-error-primary); }',
      '.sls-dot--warn { background:var(--dsw-alias-state-warn-primary); }',
      '.sls-dot--idle { background:var(--dsw-alias-label-tertiary); }',
      '.sls-rule__del { flex:none; padding:2px 8px; }',
      '.sls-switch { display:inline-flex; align-items:center; cursor:pointer; }',
      '.sls-switch input[type="checkbox"] { position:absolute; opacity:0; width:1px; height:1px; }',
      '.sls-switch__track { position:relative; width:34px; height:19px; border-radius:999px; box-sizing:border-box; background:var(--sls-track); border:1px solid var(--sls-border); transition:background .15s, border-color .15s; }',
      '.sls-switch__thumb { position:absolute; top:50%; left:2px; width:13px; height:13px; border-radius:50%; background:var(--sls-thumb); transform:translateY(-50%); transition:left .15s, background .15s; }',
      '.sls-switch:hover .sls-switch__track { border-color:var(--sls-accent); }',
      '.sls-switch input[type="checkbox"]:checked + .sls-switch__track { background:var(--sls-accent); border-color:var(--sls-accent); }',
      '.sls-switch input[type="checkbox"]:checked + .sls-switch__track .sls-switch__thumb { left:17px; background:var(--sls-bg-base); }',
      '.sls-switch input[type="checkbox"]:focus-visible + .sls-switch__track { outline:2px solid var(--sls-accent); outline-offset:1px; }',
      '.sls-switch input[type="checkbox"]:disabled + .sls-switch__track { opacity:.5; }',
      // tool.call.toolview 卡片(key 'shell'):官方 terminal 行同构 + 复制/折行增强。
      // 色彩对齐官方 ToolRow:标题 label-secondary、icon 盒 label-tertiary(实证自
      // 官方行 computed style);token 缺失时回退 inherit 不致不可读
      '.sls-tv { font-size:13px; line-height:1.45; color:var(--dsw-alias-label-secondary, inherit); }',
      '.sls-tv__row { display:flex; align-items:center; gap:7px; padding:2px 0; cursor:default; }',
      '.sls-tv__row--exp { cursor:pointer; user-select:none; }',
      '.sls-tv__lead { display:flex; align-items:center; gap:4px; color:var(--dsw-alias-label-tertiary, inherit); }',
      // 官方 ToolRow 同构:行首仅 icon,无展开箭头(可展开性由指针与整行点击承载);
      // 错误/进行中状态点原位替换 icon(官方 icon 槽 StateDot 同型先例,无背景依赖)
      '.sls-tv__sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }',
      '.sls-tv__title { font-weight:400; }',
      '.sls-tv__sep { width:2px; height:2px; border-radius:1px; background:var(--dsw-alias-label-caption, currentColor); opacity:.8; flex:none; }',
      '.sls-tv__sum { color:var(--dsw-alias-label-tertiary, inherit); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
      '.sls-tv__sum--err { color:var(--dsw-alias-state-error-primary); }',
      '.sls-tv__body { margin:6px 0 4px; border:1px solid var(--sls-border); border-radius:8px; overflow:hidden; }',
      '.sls-tv__head { display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid var(--sls-border); background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 5%, transparent); }',
      // 头部单行片段禁折行:cwd 行宽不足时收缩出省略号,徽章不收缩不折行
      '.sls-tv__cwd { font-family:var(--sls-mono); font-size:12px; opacity:.7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
      '.sls-tv__takeover { font-size:11px; padding:0 7px; border-radius:999px; border:1px solid currentColor; opacity:.75; flex:none; white-space:nowrap; }',
      '.sls-tv__badge { font-size:11px; padding:0 7px; border-radius:999px; border:1px solid var(--sls-border); opacity:.85; flex:none; white-space:nowrap; }',
      '.sls-tv__pill { font-size:12px; color:var(--dsw-alias-state-error-primary); flex:none; white-space:nowrap; }',
      '.sls-tv__pill--bg { color:var(--dsw-alias-label-tertiary, inherit); }',
      '.sls-tv__duration { font-family:var(--sls-mono); font-size:12px; color:var(--dsw-alias-label-tertiary, inherit); flex:none; white-space:nowrap; font-variant-numeric:tabular-nums; }',
      // 运行中脉冲文字:零信息窗口(参数未到)的活体反馈
      '.sls-tv__pulse { font-size:12px; color:var(--dsw-alias-label-tertiary, inherit); flex:none; white-space:nowrap; animation:sls-pulse 1.5s ease-in-out infinite; }',
      '@keyframes sls-pulse { 0%,100% { opacity:.35; } 50% { opacity:1; } }',
      '.sls-tv__sp { flex:1; }',
      '.sls-tv__copy { display:flex; align-items:center; gap:2px; flex:none; }',
      '.sls-tv__copyBtn { padding:2px 8px; border:1px solid var(--sls-border); border-radius:6px; background:transparent; color:inherit; cursor:pointer; font-size:12px; }',
      '.sls-tv__copyBtn:disabled { opacity:.4; cursor:default; }',
      '.sls-tv__copyBtn:not(:disabled):hover { background:var(--dsw-alias-interactive-bg-hover); }',
      '.sls-tv__cmd { padding:8px 10px; font-family:var(--sls-mono); font-size:12.5px; white-space:pre-wrap; word-break:break-all; display:flex; }',
      '.sls-tv__cmdNo { flex:none; text-align:right; margin-right:10px; opacity:.4; user-select:none; }',
      '.sls-tv__cmdText { flex:1; min-width:0; }',
      '.sls-tv__out { margin:0; padding:8px 10px; border-top:1px solid var(--sls-border); font-family:var(--sls-mono); font-size:12.5px; white-space:pre; overflow-x:auto; max-height:320px; overflow-y:auto; }',
      '.sls-tv__out--inline { border:1px solid var(--sls-border); border-radius:8px; }',
      '.sls-tv__inspect { display:flex; align-items:center; gap:4px; padding:4px 10px; border:none; border-top:1px solid var(--sls-border); background:transparent; color:inherit; opacity:.6; cursor:pointer; font-size:12px; }',
      '.sls-tv__inspect:hover { opacity:1; }',
    ].join('\n')

    function h(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props || null].concat(children))
    }

    // ── tool.call.toolview 卡片(key 'shell')──────────────────────────────
    // 官方 BashRow/terminalCardModel 的 shellCall 白名单只认 bash|pwsh,无法复用,
    // 模型派生自带:数据自 argsRaw + 结果文本尾部退出标记派生(官方 block 无
    // callView/resultView 结构化字段),非终端意图(后台 ack/isError/截断)回退简版原文行。
    // 增强面(shell-card-plus 同款):复制命令/复制输出、命令折行+行号、客户端名标注。

    function detectEnglish() {
      return typeof document !== 'undefined' && (document.documentElement.lang || '').toLowerCase().indexOf('en') === 0
    }

    async function writeClipboard(text) {
      if (!text) return false
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch { /* fall through */ }
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return ok
      } catch { return false }
    }

    // LOGIC-BEGIN lastSegment
    function lastSegment(path) {
      const trimmed = String(path).replace(/[/\\]+$/, '')
      const segment = trimmed.split(/[/\\]/).pop()
      return segment === undefined || segment === '' ? String(path) : segment
    }
    // LOGIC-END lastSegment

    // 相对 workdir 拼会话工作区(分隔符按会话根形态),返回展示用目录
    // LOGIC-BEGIN displayCwd
    function displayCwd(workdir, sessionCwd) {
      const base = workdir !== undefined && workdir !== '' ? workdir : sessionCwd
      if (base === undefined || base === '') return undefined
      if (workdir !== undefined && workdir !== '' && sessionCwd !== undefined && sessionCwd !== ''
        && !/^[/\\]/.test(workdir) && !/^[A-Za-z]:/.test(workdir)) {
        const separator = sessionCwd.includes('\\') ? '\\' : '/'
        return `${sessionCwd.replace(/[/\\]+$/, '')}${separator}${workdir}`
      }
      return base
    }
    // LOGIC-END displayCwd

    // 结果文本尾部退出标记(官方 parseExitStatus 逐字同构:无尾标 = exit 0)
    // LOGIC-BEGIN parseExitTail
    function parseExitTail(text) {
      const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
      if (signal !== null && signal[1] !== undefined) return { output: text.slice(0, signal.index), signal: signal[1], exitCode: 0 }
      const exit = /\n\[exit code: (\d+)\]$/.exec(text)
      if (exit !== null && exit[1] !== undefined) return { output: text.slice(0, exit.index), signal: undefined, exitCode: Number(exit[1]) }
      return { output: text, signal: undefined, exitCode: 0 }
    }
    // LOGIC-END parseExitTail

    // 官方 hasSpillNotice 同构:截断提示会遮蔽尾部退出标记,退回 generic
    // LOGIC-BEGIN hasSpillNotice
    function hasSpillNotice(text) {
      return text.includes('[output truncated; full output:') || text.includes('[some output was dropped from memory; full output:')
    }
    // LOGIC-END hasSpillNotice

    // 执行事实标记(host renderResult 落,格式见 render.mjs):卡片徽章第一优先级,
    // 配置事后变更/跨宿主查看不溯往改写历史调用
    // LOGIC-BEGIN parseShellMark
    function parseShellMark(text) {
      return /\[shell: ([^\]\n]+)\]/.exec(text)?.[1]
    }
    // LOGIC-END parseShellMark

    // LOGIC-BEGIN stripShellMark
    function stripShellMark(text) {
      return text.split('\n').filter((line) => !/^\[shell: [^\]]+\]$/.test(line)).join('\n')
    }
    // LOGIC-END stripShellMark

    // block → 卡片模型(官方 terminalCardModel 同构,数据源 argsRaw + content 文本)。
    // generic = 后台 ack / isError / 溢出预览 / persistent 形(无 description,
    // 官方 shellCall persistent→generic 同构),交回退行;terminal = 全量卡。
    // LOGIC-BEGIN shellCardModel
    function shellCardModel(block, sessionCwd, toolKey) {
      const settled = 'kind' in block
      const call = settled ? block.call : block
      let args = null
      try {
        const parsed = JSON.parse(call !== null && call !== undefined ? call.argsRaw : '')
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) args = parsed
      } catch { /* 结构外形态走 generic */ }
      const command = typeof args?.command === 'string' && args.command.trim() !== '' ? args.command : ''
      const description = typeof args?.description === 'string' && args.description.trim() !== '' ? args.description : undefined
      const cwdFull = displayCwd(typeof args?.workdir === 'string' ? args.workdir : undefined, sessionCwd)
      const cwdDir = cwdFull !== undefined ? lastSegment(cwdFull) : undefined
      // 官方钉死客户端工具(bash/pwsh)徽章即工具名:其输出无标记、参数无 shell
      // 字段,落默认读数会误标(官方 pwsh 调用显示当前默认客户端的事故根因)
      const PINNED_CLIENT = { pwsh: 'pwsh', bash: 'bash' }
      // shell 工具徽章优先级:结果标记(执行事实)→ 显式参数 → default 读数(旧块兜底,
      // 配置即当前解析事实);读数推导仅兜无标记历史块,不覆盖事实
      const requested = typeof args?.shell === 'string' ? args.shell : undefined
      const shellNameOf = (mark) => PINNED_CLIENT[toolKey] ?? mark ?? clientDisplayName(requested)
      if (command === '') return { kind: 'generic', command: '', summary: undefined, output: null, running: !settled, alert: undefined }

      if (!settled) {
        const startedAt = typeof block.time === 'number' ? block.time : undefined
        // 运行中一律全量卡:阻塞时展开即可见命令与时长,不落无命令的 generic 回退行;
        // 无结果文本,徽章按读数推导,落定后由标记校正
        return { kind: 'terminal', status: 'running', command, description, cwdDir, cwdFull, shellName: shellNameOf(undefined), output: undefined, exitCode: undefined, signal: undefined, code: undefined, startedAt }
      }

      const contentText = (block.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).filter((text) => text !== '').join('\n')
      const intercepted = toolKey === 'pwsh' && (block.content ?? []).some((part) => part.type === 'shell-select-takeover' && part.tool === 'pwsh')
      const shellName = shellNameOf(parseShellMark(contentText))
      const outputText = stripShellMark(contentText)
      // 后台 ack:独立卡呈现命令全文与任务号徽标,ack 原文作输出(不再落 generic 简版行)
      if (args.run_in_background === true) {
        const jobId = /started background job (\S+)/.exec(contentText)?.[1]
        return { kind: 'background', status: 'background', command, description, cwdDir, cwdFull, shellName, intercepted, output: outputText, jobId }
      }
      // 空结果落 generic:官方 singleResultText 无文本即回通用卡,避免空输出伪 done 终端卡;
      // isError/error 块带 alert(错误红点语义),其余(空输出/无描述/截断)中性无状态点
      if (outputText === '' || block.isError === true || block.error !== undefined || description === undefined || hasSpillNotice(contentText)) {
        const alert = block.isError === true || block.error !== undefined ? 'error' : undefined
        return { kind: 'generic', command, summary: description, output: outputText, running: false, alert, intercepted }
      }
      const tail = parseExitTail(outputText)
      const status = tail.signal !== undefined ? 'signaled' : tail.exitCode !== 0 ? 'failed' : 'done'
      return { kind: 'terminal', status, command, description, cwdDir, cwdFull, shellName, intercepted, output: tail.output, exitCode: tail.exitCode, signal: tail.signal, code: undefined }
    }
    // LOGIC-END shellCardModel

    // 行首状态节点:错误/进行中原位替换 icon(官方 icon 槽 running→StateDot 同型
    // 先例;不叠白片遮罩——宿主无 bg-primary token,遮罩恒落 #fff 白圆,暗色刺眼)
    function leadingNode({ status, icons }) {
      const failed = status === 'failed' || status === 'signaled' || status === 'generic-error'
      const dot = failed ? icons.StateDot({ state: 'error' }) : status === 'generic-warn' ? icons.StateDot({ state: 'warning' }) : status === 'running' ? icons.StateDot({ state: 'ongoing' }) : null
      return dot !== null ? dot : icons.IconApi({ size: 14 })
    }

    // 时长格式:秒 → m:ss;超一小时 → h:mm:ss
    // LOGIC-BEGIN formatDuration
    function formatDuration(elapsedMs) {
      const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
      const seconds = totalSeconds % 60
      const minutes = Math.floor(totalSeconds / 60) % 60
      const hours = Math.floor(totalSeconds / 3600)
      const two = (value) => (value < 10 ? '0' + value : String(value))
      return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`
    }
    // LOGIC-END formatDuration

    // 运行中实时时长:每秒 tick;秒级粒度对"阻塞了多久"足够
    function RunningDuration({ startedAt, en }) {
      const [, setTick] = useState(0)
      useEffect(() => {
        const timer = setInterval(() => setTick((value) => value + 1), 1000)
        return () => clearInterval(timer)
      }, [])
      const elapsed = startedAt !== undefined ? Date.now() - startedAt : undefined
      const text = elapsed !== undefined && elapsed >= 0 ? formatDuration(elapsed) : en ? 'running' : '运行中'
      return h('span', { className: 'sls-tv__duration', title: en ? 'Elapsed' : '已运行' }, text)
    }

    function statusTextOf(status, en) {
      switch (status) {
        case 'running': return en ? 'Running' : '运行中'
        case 'background': return en ? 'Background' : '后台'
        case 'failed': case 'signaled': return en ? 'Failed' : '失败'
        default: return null
      }
    }

    function headMetaOf(model, en) {
      switch (model.status) {
        case 'running': return { dot: 'ongoing', label: en ? 'Running' : '运行中', pill: undefined }
        // ack 块静态不反映 job 生命周期,状态点缺省(后台任务由 bg pill 标识)
        case 'background': return {
          dot: undefined,
          label: en ? 'Background' : '后台',
          pill: model.jobId !== undefined ? (en ? `bg ${model.jobId}` : `后台 ${model.jobId}`) : undefined,
          pillTone: 'bg',
        }
        case 'done': return { dot: 'done', label: en ? 'Done' : '已完成', pill: undefined }
        case 'failed': return { dot: 'error', label: en ? 'Failed' : '失败', pill: en ? `exit ${model.exitCode}` : `退出码 ${model.exitCode}` }
        case 'signaled': return { dot: 'error', label: en ? 'Failed' : '失败', pill: en ? `signal ${model.signal}` : `信号 ${model.signal}` }
        default: return { dot: 'done', label: '', pill: undefined }
      }
    }

    function CopyButton({ label, disabled, onClick }) {
      const [done, setDone] = useState(false)
      return h('button', {
        className: 'sls-tv__copyBtn',
        title: label,
        'aria-label': label,
        disabled: disabled === true,
        onClick: () => {
          if (done) return
          void onClick().then((ok) => {
            if (ok !== true) return
            setDone(true)
            window.setTimeout(() => setDone(false), 1200)
          })
        },
      }, done ? (detectEnglish() ? 'Copied' : '已复制') : label)
    }

    // 非终端意图回退行(后台 ack / isError / 截断 / 参数未到):摘要 + 可展开原文。
    // 状态语义对齐官方:运行中灰 spinner,settled 错误红点,其余中性 icon——
    // 黄点(warning)仅真实告警,禁止挪用作"进行中"(用户把黄点当卡死)。
    // 运行中且零信息(参数未到)显示脉冲「运行中…」,给用户活着的感觉。
    function GenericShellRow({ model, inspect, en }) {
      const [open, setOpen] = useState(false)
      const status = model.running === true ? 'running' : model.alert === 'error' ? 'generic-error' : undefined
      const summary = model.summary !== undefined && model.summary !== ''
        ? model.summary.split('\n')[0]
        : (model.output !== null && model.output !== '' ? model.output.split('\n')[0] : '')
      const expandable = (model.output !== null && model.output !== '') || model.command !== ''
      return h('div', { className: 'sls-tv' },
        h('div', {
          className: 'sls-tv__row' + (expandable ? ' sls-tv__row--exp' : ''),
          role: expandable ? 'button' : undefined,
          tabIndex: expandable ? 0 : undefined,
          'aria-expanded': expandable ? open : undefined,
          onClick: expandable ? () => setOpen((value) => !value) : undefined,
          onKeyDown: expandable ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setOpen((value) => !value)
            }
          } : undefined,
        },
          h('span', { className: 'sls-tv__lead' },
            leadingNode({ status, icons: TOOLVIEW_ICONS }),
          ),
          h('span', { className: 'sls-tv__title' }, 'Shell'),
          summary !== '' ? h('span', { className: 'sls-tv__sep', 'aria-hidden': true }) : null,
          summary !== '' ? h('span', { className: 'sls-tv__sum' + (status === 'generic-error' ? ' sls-tv__sum--err' : '') }, summary) : null,
          model.intercepted ? h(TakeoverBadge, { en }) : null,
          status === 'running' ? h('span', { className: 'sls-tv__pulse' }, en ? 'running…' : '运行中…') : null,
        ),
        open && expandable ? h('pre', { className: 'sls-tv__out sls-tv__out--inline' }, model.command + (model.output !== null && model.output !== '' ? `\n${model.output}` : '')) : null,
        inspect !== undefined ? h('button', { className: 'sls-tv__inspect', onClick: inspect }, TOOLVIEW_ICONS.IconInspect({}), en ? 'Inspect' : '检查') : null,
      )
    }

    function TakeoverBadge({ en }) {
      return h('span', { className: 'sls-tv__takeover', title: en ? 'Direct pwsh call handled by shell-select' : '直接 pwsh 调用由 shell-select 接管' }, en ? 'Intercepted' : '插件接管')
    }

    function CommandBody({ command }) {
      const lines = command === '' ? [''] : command.split('\n')
      const width = String(lines.length).length
      return h('div', { className: 'sls-tv__cmd' },
        h('span', { className: 'sls-tv__cmdNo', style: { width: `${width}ch` } },
          lines.map((_, index) => h('div', { key: index }, index + 1))),
        h('span', { className: 'sls-tv__cmdText' },
          lines.map((line, index) => h('div', { key: index }, line === '' ? ' ' : line))),
      )
    }

    function ShellCard({ model, inspect, en }) {
      const meta = headMetaOf(model, en)
      const copyCommandLabel = en ? 'Copy command' : '复制命令'
      const copyOutputLabel = en ? 'Copy output' : '复制输出'
      // 运行中头部 pill = 实时时长(组件,hook 内每秒自刷新)
      const pill = model.status === 'running'
        ? h(RunningDuration, { startedAt: model.startedAt, en })
        : meta.pill
      return h('div', { className: 'sls-tv__body', 'data-status': model.status },
        h('div', { className: 'sls-tv__head' },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            meta.dot !== undefined ? TOOLVIEW_ICONS.StateDot({ state: meta.dot }) : null,
            h('span', { className: 'sls-tv__sr' }, meta.label),
          ),
          model.cwdDir !== undefined ? h('span', { className: 'sls-tv__cwd', title: 'pwd: ' + (model.cwdFull ?? model.cwdDir) }, model.cwdDir) : null,
          model.shellName !== undefined ? h('span', { className: 'sls-tv__badge', title: en ? 'Shell client' : 'Shell 客户端' }, model.shellName) : null,
          model.intercepted ? h(TakeoverBadge, { en }) : null,
          h('span', { className: 'sls-tv__sp' }),
          pill !== undefined ? h('span', { className: 'sls-tv__pill' + (meta.pillTone === 'bg' ? ' sls-tv__pill--bg' : '') }, pill) : null,
          h('span', { className: 'sls-tv__copy' },
            h(CopyButton, {
              label: copyCommandLabel,
              disabled: model.command === '',
              onClick: () => writeClipboard(model.command),
            }),
            h(CopyButton, {
              label: copyOutputLabel,
              disabled: model.output === undefined || model.output === '',
              onClick: () => writeClipboard(model.output ?? ''),
            }),
          ),
        ),
        h(CommandBody, { command: model.command }),
        model.output !== undefined && model.output !== ''
          ? h('pre', { className: 'sls-tv__out' }, model.output)
          : null,
        inspect !== undefined ? h('button', { className: 'sls-tv__inspect', onClick: inspect }, TOOLVIEW_ICONS.IconInspect({}), en ? 'Inspect' : '检查') : null,
      )
    }

    function ShellToolRow(props) {
      const { block, cwd, inspect, toolKey } = props
      const en = detectEnglish()
      const model = shellCardModel(block, cwd, toolKey)
      // hooks 恒序:必须在任何提前 return 之前完整执行(真实 React 的 hooks
      // 链表按调用序对位,generic 行与 terminal 行的提前 return 分叉会让
      // 后续 hook 错位,行组件树被整棵卸载——卡片全消失事故根因)
      const [open, setOpen] = useState(false)
      const [, setCatalogReady] = useState(false)
      useEffect(() => {
        let disposed = false
        ensureClientCatalog().then(() => { if (!disposed) setCatalogReady(true) })
        return () => { disposed = true }
      }, [])
      if (model.kind === 'generic') return h(GenericShellRow, { model, inspect, en })
      const srStatus = statusTextOf(model.status, en)
      const summary = model.description !== undefined ? model.description.split('\n')[0] : (en ? '(no description)' : '(无描述)')
      const failed = model.status === 'failed' || model.status === 'signaled'
      return h('div', { className: 'sls-tv' },
        h('div', {
          className: 'sls-tv__row sls-tv__row--exp',
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setOpen((value) => !value)
            }
          },
        },
          h('span', { className: 'sls-tv__lead' },
            leadingNode({ status: model.status, icons: TOOLVIEW_ICONS }),
          ),
          srStatus !== null ? h('span', { className: 'sls-tv__sr' }, srStatus) : null,
          h('span', { className: 'sls-tv__title' }, 'Shell'),
          h('span', { className: 'sls-tv__sep', 'aria-hidden': true }),
          h('span', { className: 'sls-tv__sum' + (failed ? ' sls-tv__sum--err' : '') }, summary),
          model.intercepted ? h(TakeoverBadge, { en }) : null,
          model.status === 'running' ? h(RunningDuration, { startedAt: model.startedAt, en }) : null,
          model.status === 'background' && model.jobId !== undefined
            ? h('span', { className: 'sls-tv__badge', title: en ? 'Background job' : '后台任务' }, en ? `bg ${model.jobId}` : `后台 ${model.jobId}`)
            : null,
        ),
        open ? h(ShellCard, { model, inspect, en }) : null,
      )
    }

    const SHELL_KINDS = { pwsh: 'PowerShell', bash: 'POSIX bash(git bash / msys2 / cygwin)', cmd: 'CMD', wsl: 'WSL bash' }

    function argsTextOf(args) {
      return args.map((arg) => {
        if (/[\u0000-\u001f\u007f]/.test(arg)) {
          const body = arg.replace(/[\u0000-\u001f\u007f'\\]/g, (char) => {
            if (char === "'" || char === '\\') return '\\' + char
            return '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')
          })
          return "$'" + body + "'"
        }
        return arg !== '' && !/[\s'"\\]/.test(arg) ? arg : '"' + arg.replace(/["\\]/g, (char) => '\\' + char) + '"'
      }).join(' ')
    }

    // 普通引号只转义当前引号与反斜线；控制字符仅在显式 ANSI-C 引号内解码，不执行 shell。
    function parseArgsText(text) {
      const args = []
      const controls = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' }
      let token = '', started = false
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        if (/\s/.test(char)) {
          if (started) args.push(token)
          token = ''
          started = false
          continue
        }
        started = true
        const ansi = char === '$' && text[index + 1] === "'"
        if (!ansi && char !== '"' && char !== "'") {
          token += char
          continue
        }
        if (ansi) index += 1
        const quote = text[index]
        index += 1
        for (; index < text.length && text[index] !== quote; index += 1) {
          const current = text[index]
          const next = text[index + 1]
          if (current === '\\' && (next === quote || next === '\\')) {
            token += next
            index += 1
          } else if (ansi && current === '\\' && Object.hasOwn(controls, next)) {
            token += controls[next]
            index += 1
          } else if (ansi && current === '\\' && next === 'u' && /^[\da-f]{4}$/i.test(text.slice(index + 2, index + 6))) {
            token += String.fromCharCode(parseInt(text.slice(index + 2, index + 6), 16))
            index += 5
          } else {
            token += current
          }
        }
        if (index >= text.length) throw new Error('参数引号未闭合')
      }
      if (started) args.push(token)
      return args
    }

    function envTextOf(env) {
      return Object.entries(env).map(([key, value]) => `${key}=${/[\r\n]|^"/.test(value) ? JSON.stringify(value) : value}`).join('\n')
    }

    function parseEnvText(text) {
      const pairs = []
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        const separator = line.indexOf('=')
        const key = separator < 0 ? '' : line.slice(0, separator).trim()
        if (key === '') throw new Error('环境变量每行必须为 K=V')
        const value = line.slice(separator + 1)
        const parsed = value.startsWith('"') ? JSON.parse(value) : value
        if (typeof parsed !== 'string') throw new Error('环境变量双引号值必须是字符串')
        pairs.push([key, parsed])
      }
      return Object.fromEntries(pairs)
    }

    function denyPatternIssue(rule) {
      if (rule === '') return undefined
      try { new RegExp(rule, 'i') } catch (error) { return error.message }
      return undefined
    }

    function editableSection(section) {
      const { resolved, ...config } = section
      return {
        config,
        entries: config.shells.map((entry, index) => {
          const argsText = argsTextOf(entry.args ?? [])
          const envText = envTextOf(entry.env ?? {})
          const fact = resolved?.shells.find((item) => item.id === entry.id)
          return { ...entry, key: `loaded-${index}`, argsText, originalArgsText: argsText,
            envText, originalEnvText: envText, available: fact?.available, resolved: fact?.path }
        }),
        nextKey: config.shells.length,
        defaultId: config.default,
        rules: (config.deny ?? []).map((value, index) => ({ key: `rule-${index}`, value })),
        nextRuleKey: (config.deny ?? []).length,
        dirty: false,
      }
    }

    function ShellSelectApp() {
      const [form, setForm] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [revision, setRevision] = useState(0)

      useEffect(() => {
        let disposed = false
        setNotice('')
        api(API.config).then((section) => {
          if (!disposed) setForm(editableSection(section))
        }).catch((error) => { if (!disposed) setNotice('加载失败：' + error.message) })
        return () => { disposed = true }
      }, [revision])

      const editForm = (update) => {
        if (busy) return
        setForm((current) => ({ ...update(current), dirty: true }))
      }
      const patchEntry = (key, changes) => editForm((current) => ({
        ...current,
        defaultId: changes.id !== undefined && current.entries.find((entry) => entry.key === key)?.id === current.defaultId
          ? changes.id : current.defaultId,
        entries: current.entries.map((entry) => entry.key === key ? { ...entry, ...changes, available: undefined, resolved: undefined } : entry),
      }))
      const removeEntry = (key) => editForm((current) => {
        const entries = current.entries.filter((entry) => entry.key !== key)
        return { ...current, entries, defaultId: entries.some((entry) => entry.id === current.defaultId) ? current.defaultId : entries[0]?.id ?? '' }
      })
      const addEntry = () => editForm((current) => ({
        ...current, nextKey: current.nextKey + 1,
        entries: [...current.entries, { key: `added-${current.nextKey}`, id: '', kind: 'bash', path: '', argsText: '', envText: '', login: false, distro: '' }],
      }))
      const patchRule = (key, value) => editForm((current) => ({ ...current,
        rules: current.rules.map((rule) => rule.key === key ? { ...rule, value } : rule),
      }))
      const addRule = () => editForm((current) => ({ ...current, nextRuleKey: current.nextRuleKey + 1,
        rules: [...current.rules, { key: `rule-${current.nextRuleKey}`, value: '' }],
      }))
      const removeRule = (key) => editForm((current) => ({ ...current, rules: current.rules.filter((rule) => rule.key !== key) }))
      const save = async () => {
        if (busy || !form.dirty) return
        setBusy(true)
        setNotice('')
        try {
          const shells = form.entries.map((entry) => {
            // 显示未变时直接复用原值，避免表单控件归一换行等行为改写已有配置。
            const args = entry.argsText === entry.originalArgsText ? entry.args ?? [] : parseArgsText(entry.argsText)
            const env = entry.envText === entry.originalEnvText ? entry.env ?? {} : parseEnvText(entry.envText)
            return { id: entry.id.trim(), kind: entry.kind, path: entry.path.trim(), args, login: entry.login === true, distro: entry.distro ?? '', env }
          })
          const ids = shells.map((entry) => entry.id)
          if (ids.length === 0 || ids.some((id) => id === '')) throw new Error('至少保留一个客户端，id 不能为空')
          if (new Set(ids).size !== ids.length) throw new Error('客户端 id 重复')
          const defaultId = form.defaultId.trim()
          if (!ids.includes(defaultId)) throw new Error('默认客户端不在列表中')
          for (const [index, rule] of form.rules.entries()) {
            const issue = denyPatternIssue(rule.value)
            if (issue !== undefined) throw new Error(`第 ${index + 1} 条正则非法：${issue}`)
          }
          const deny = form.rules.map((rule) => rule.value).filter((rule) => rule !== '')
          const result = await api(API.config, { method: 'POST', body: JSON.stringify({ ...form.config, shells, default: defaultId, deny }) })
          clientCatalog = { default: result.resolved.default, byId: Object.fromEntries(result.resolved.shells.map((entry) => [entry.id, entry.id])) }
          setForm((current) => ({ ...current, dirty: false }))
          setNotice('已保存，默认客户端与工具描述即时生效')
          try {
            const section = await api(API.config)
            setForm(editableSection(section))
          } catch (error) { setNotice('已保存，但刷新失败：' + error.message + '；请重新加载') }
        } catch (error) {
          setNotice('保存失败：' + error.message)
        } finally { setBusy(false) }
      }
      const probe = async (entry) => {
        if (busy) return
        setBusy(true)
        setNotice('')
        try {
          const result = await api(API.probe, { method: 'POST', body: JSON.stringify({ path: entry.path }) })
          setForm((current) => ({ ...current, entries: current.entries.map((item) => item.key === entry.key
            ? { ...item, available: result.exists, resolved: entry.path } : item) }))
          setNotice(result.exists ? '路径存在' : '路径不存在')
        } catch (error) { setNotice('探测失败：' + error.message) }
        finally { setBusy(false) }
      }
      const detect = async (kind) => {
        if (busy) return
        setBusy(true)
        setNotice('')
        try {
          const result = await api(API.detect, { method: 'POST', body: JSON.stringify({ kinds: [kind] }) })
          setNotice(result.found.length > 0 ? kind + ' 候选:' + result.found.map((item) => item.path).join(' ; ') : kind + ' 未发现候选')
        } catch (error) { setNotice('探测失败：' + error.message) }
        finally { setBusy(false) }
      }
      const reload = h('button', { type: 'button', className: 'sls-btn', disabled: busy, onClick: () => {
        if (busy) return
        setForm(null)
        setNotice('')
        setRevision((value) => value + 1)
      } }, '重新加载')
      if (form === null) return h('div', { className: 'sls-card', 'aria-busy': !notice },
        h('div', { role: notice ? 'alert' : 'status', className: 'sls-hint' }, notice || '加载中…'), notice ? reload : null)

      const activeRules = form.rules.filter((rule) => rule.value !== '').length
      return h('div', { className: 'sls-card', 'aria-busy': busy },
        h('div', { className: 'sls-row' }, h('span', { className: 'sls-hint' },
          '命令行客户端清单。路径留空自动探测;模型可通过工具的 shell 参数选择任一条目,缺省用默认。')),
        form.entries.map((entry, index) => {
          const input = (label, name, placeholder, type = 'input') => h(type, {
            className: 'sls-input sls-input--wide' + (name === 'argsText' || name === 'envText' ? ' sls-args' : ''),
            'aria-label': `客户端 ${index + 1} ${label}`, value: entry[name] ?? '', disabled: busy,
            rows: type === 'textarea' ? 2 : undefined, placeholder,
            onChange: (event) => patchEntry(entry.key, { [name]: event.target.value }),
          })
          return h('div', { className: 'sls-entry', key: entry.key },
            h('div', { className: 'sls-entry__head' },
              h('label', { className: 'sls-row' },
                h('input', { type: 'radio', name: 'sls-default', 'aria-label': `客户端 ${index + 1} 默认`,
                  checked: form.defaultId === entry.id && entry.id.length > 0, disabled: busy || entry.id.trim() === '',
                  title: '设为默认客户端(模型缺省 shell 参数时使用)',
                  onChange: () => editForm((current) => ({ ...current, defaultId: entry.id })),
                }), h('span', { className: 'sls-hint' }, '默认')),
              h('span', { className: 'sls-badge' + (entry.available === true ? ' sls-badge--ok' : entry.available === false ? ' sls-badge--bad' : ''),
                title: entry.resolved ? '解析路径:' + entry.resolved : '路径尚未解析',
              }, entry.available === true ? '可用' : entry.available === false ? '不可用' : '未知'),
              entry.id === form.defaultId && entry.id !== '' ? h('span', { className: 'sls-badge sls-badge--default' }, '默认') : null,
              h('span', { style: { flex: 1 } }),
              h('button', { type: 'button', className: 'sls-btn', disabled: busy || entry.path.trim() === '', title: '检查该路径是否存在', onClick: () => probe(entry) }, '探测路径'),
              h('button', { type: 'button', className: 'sls-btn', disabled: busy, 'aria-label': `移除客户端 ${index + 1}`, title: '移除该条目', onClick: () => removeEntry(entry.key) }, '移除')),
            h('div', { className: 'sls-grid' },
              h('span', { className: 'sls-grid__label' }, 'id'),
              input('id', 'id', 'pwsh / git-bash / …(模型看到的 shell 参数值,亦作显示名)'),
              h('span', { className: 'sls-grid__label' }, '形态'),
              h('div', { className: 'sls-row' },
                h('select', { className: 'sls-input', 'aria-label': `客户端 ${index + 1} 形态`, value: entry.kind, disabled: busy,
                  onChange: (event) => patchEntry(entry.key, { kind: event.target.value }),
                }, Object.entries(SHELL_KINDS).map(([kind, label]) => h('option', { key: kind, value: kind }, label))),
                h('button', { type: 'button', className: 'sls-btn', disabled: busy, title: '扫描本机常见安装位置', onClick: () => detect(entry.kind) }, '扫描本机')),
              h('span', { className: 'sls-grid__label' }, '路径'),
              input('路径', 'path', '留空自动探测,如 C:\\Program Files\\Git\\bin\\bash.exe'),
              h('span', { className: 'sls-grid__label' }, '参数'),
              input('参数', 'argsText', '留空用形态默认;空格分隔,引号包住含空格参数,{command} 为命令占位'),
              h('span', { className: 'sls-hint', style: { gridColumn: '2' } }, "空格参数加引号；控制字符用 $'…' 转义，仅解析不执行。"),
              ...(entry.kind === 'bash' ? [
                h('span', { className: 'sls-grid__label' }, '登录壳'),
                h('label', { className: 'sls-row sls-switch', title: '-lc 登录壳拉起 /etc/profile(只注入 /usr/bin;/mingw64/bin 需在下方的环境里配 MSYSTEM=MINGW64)' },
                  h('input', { type: 'checkbox', 'aria-label': `客户端 ${index + 1} 登录壳`, checked: entry.login === true, disabled: busy,
                    onChange: (event) => patchEntry(entry.key, { login: event.target.checked }),
                  }), h('span', { className: 'sls-switch__track' }, h('span', { className: 'sls-switch__thumb' })),
                  h('span', { className: 'sls-hint' }, '-lc 登录壳')),
              ] : []),
              ...(entry.kind === 'wsl' ? [h('span', { className: 'sls-grid__label' }, '发行版'), input('发行版', 'distro', '留空用默认发行版,如 Ubuntu-22.04')] : []),
              h('span', { className: 'sls-grid__label' }, '环境'),
              input('环境', 'envText', '每行 K=V,如 MSYSTEM=MINGW64;wsl 形自动经 WSLENV 透传', 'textarea'),
              h('span', { className: 'sls-hint', style: { gridColumn: '2' } }, '每行 K=V；换行值用双引号及 \\n，双引号内反斜线写 \\\\。')))
        }),
        h('div', { className: 'sls-rules' },
          h('div', { className: 'sls-rules__head' }, h('span', { className: 'sls-rules__title' }, '命令黑名单'),
            h('span', { className: 'sls-badge' + (activeRules > 0 ? ' sls-badge--ok' : ' sls-badge--bad') }, activeRules > 0 ? activeRules + ' 条规则' : '未生效')),
          h('span', { className: 'sls-rules__note' }, '每条规则为一条正则,对整条命令全文匹配(大小写不敏感),命中即拒,无豁免;精细放行写在模式内用前瞻,如 rm -rf\\s+(?!\\S*node_modules)。'),
          form.rules.length === 0 ? h('span', { className: 'sls-rules__note' }, '未配置,命中拦截不生效,模型可执行任意命令。') : form.rules.map((rule, index) => {
            const issue = denyPatternIssue(rule.value)
            const errorId = `sls-${rule.key}-error`
            return h('div', { className: 'sls-rule' + (issue !== undefined ? ' sls-rule--bad' : ''), key: rule.key },
              h('span', { className: 'sls-rule__no' }, index + 1),
              h('textarea', { className: 'sls-rule__input', rows: Math.max(1, rule.value.split('\n').length), 'aria-label': `黑名单第 ${index + 1} 条`,
                'aria-invalid': issue !== undefined, 'aria-describedby': issue !== undefined ? errorId : undefined,
                value: rule.value, disabled: busy, placeholder: '正则,如 ^format\\s', onChange: (event) => patchRule(rule.key, event.target.value),
              }),
              issue !== undefined ? h('span', { id: errorId, className: 'sls-rule__err', title: issue }, issue) : null,
              h('button', { type: 'button', className: 'sls-btn sls-rule__del', disabled: busy, 'aria-label': `删除规则 ${index + 1}`, title: '删除该条规则', onClick: () => removeRule(rule.key) }, '删除'))
          }),
          h('div', { className: 'sls-row' }, h('button', { type: 'button', className: 'sls-btn', disabled: busy, onClick: addRule }, '添加规则'))),
        h('div', { className: 'sls-row' },
          h('button', { type: 'button', className: 'sls-btn', disabled: busy, onClick: addEntry }, '添加客户端'),
          h('span', { style: { flex: 1 } }),
          form.dirty ? h('span', { className: 'sls-hint' }, '有未保存改动') : null,
          reload,
          h('button', { type: 'button', className: 'sls-btn sls-btn--primary', disabled: busy || !form.dirty, onClick: save }, '保存')),
        notice ? h('div', { role: notice.includes('失败') ? 'alert' : 'status', className: 'sls-hint' }, notice) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const NAV_ICON = { 'Shell 管理': 'terminal' }
        if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
        else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
        else window.__navicIconQueue = [NAV_ICON]
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'shell-select', order: 82, label: 'Shell 管理' },
          () => React.createElement(ShellSelectApp),
        ))
        installPathRescue(ctx)
        ctx.effect(() => {
          const style = document.createElement('style')
          // 自带 data-plugin:缺失时宿主 claimStyles 会误收,插件 HMR 重建即误删
          style.setAttribute('data-plugin', '@mzzsfy/dsh-shell-select')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'shell-select styles')
        // 替换 shell 族工具行渲染:keyed hit 优先于 GenericToolCard 兜底;
        // priority -1 阴影官方同 key 注册(低值先渲染)。pwsh/bash 为官方工具
        // 名(死态窗口 guard 代挂官方 tool-pwsh 时,其调用行同样获得增强卡);
        // key 以 toolKey 注入卡片,官方钉死客户端工具的徽章按工具名钉死,
        // 不落默认客户端读数。
        const TOOLVIEW_KEYS = ['shell', 'pwsh', 'bash']
        for (const toolKey of TOOLVIEW_KEYS) {
          ctx.slots.inject('tool.call.toolview', () =>
            ctx.slots.register(
              { name: 'tool.call.toolview', key: toolKey, priority: -1 },
              (props) => React.createElement(ShellToolRow, { ...props, toolKey }),
            ))
        }
      },
    }
  },
})
