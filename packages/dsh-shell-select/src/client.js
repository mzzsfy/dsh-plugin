// dsh-shell-select Client 半区:tool.call.toolview shell 族卡片(官方 BashRow/
// terminalCardModel 同构 + 复制/折行/客户端徽章增强)。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory});
// 客户端名册经 webServer 路由 /api/shell-select/config 读取(配置写入走宿主
// settings JSON,浏览器侧无设置页)。

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
    const DOT_SVG = { done: '#2e9e5b', error: '#d4553f', warning: '#d9a13b', ongoing: '#7a7f8a' }
    // 降级自绘:模块表缺 primitives 时保持可见性(形态近似官方 StateDot/图标)
    const TOOLVIEW_ICONS = {
      StateDot: createElementOf(['StateDot'], ({ state }) => h('span', {
        style: {
          width: 8, height: 8, borderRadius: '50%', background: DOT_SVG[state] ?? DOT_SVG.ongoing,
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

    const CSS = [
      // tool.call.toolview 卡片(key 'shell'):官方 terminal 行同构 + 复制/折行增强。
      // 色彩对齐官方 ToolRow:标题 label-secondary、icon 盒 label-tertiary(实证自
      // 官方行 computed style);token 缺失时回退 inherit 不致不可读
      '.sls-tv { font-size:13px; line-height:1.45; color:var(--dsw-alias-label-secondary, inherit); }',
      '.sls-tv__row { display:flex; align-items:center; gap:7px; padding:2px 0; cursor:default; }',
      '.sls-tv__row--exp { cursor:pointer; user-select:none; }',
      '.sls-tv__lead { display:flex; align-items:center; gap:4px; color:var(--dsw-alias-label-tertiary, inherit); }',
      // 官方 ToolRow 同构:行首仅 icon,无展开箭头(可展开性由指针与整行点击承载);
      // 错误/进行中状态点绝对定位覆盖 icon(红点掩盖 icon)
      '.sls-tv__leadStack { position:relative; width:16px; height:16px; display:inline-flex; align-items:center; justify-content:center; flex:none; }',
      '.sls-tv__iconIdle { display:inline-flex; }',
      '.sls-tv__stateCover { position:absolute; inset:0; margin:auto; display:inline-flex; align-items:center; justify-content:center; background:transparent; }',
      '.sls-tv__stateCover::before { content:""; position:absolute; inset:-2px; border-radius:50%; background:var(--dsw-alias-bg-primary, #fff); }',
      '.sls-tv__stateCover > span { position:relative; }',
      '.sls-tv__sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }',
      '.sls-tv__title { font-weight:400; }',
      '.sls-tv__sep { width:2px; height:2px; border-radius:1px; background:var(--dsw-alias-label-caption, currentColor); opacity:.8; flex:none; }',
      '.sls-tv__sum { color:var(--dsw-alias-label-tertiary, inherit); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
      '.sls-tv__sum--err { color:var(--dsw-alias-state-error-primary, #d4553f); }',
      '.sls-tv__body { margin:6px 0 4px; border:1px solid rgba(128,128,128,.28); border-radius:8px; overflow:hidden; }',
      '.sls-tv__head { display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid rgba(128,128,128,.18); background:rgba(128,128,128,.05); }',
      // 头部单行片段禁折行:cwd 行宽不足时收缩出省略号,徽章不收缩不折行
      '.sls-tv__cwd { font-family:var(--sls-mono, monospace); font-size:12px; opacity:.7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
      '.sls-tv__badge { font-size:11px; padding:0 7px; border-radius:999px; border:1px solid rgba(128,128,128,.35); opacity:.85; flex:none; white-space:nowrap; }',
      '.sls-tv__pill { font-size:12px; color:#d4553f; flex:none; white-space:nowrap; }',
      '.sls-tv__pill--bg { color:var(--dsw-alias-label-tertiary, inherit); }',
      '.sls-tv__duration { font-family:var(--sls-mono, monospace); font-size:12px; color:var(--dsw-alias-label-tertiary, inherit); flex:none; white-space:nowrap; font-variant-numeric:tabular-nums; }',
      // 运行中脉冲文字:零信息窗口(参数未到)的活体反馈
      '.sls-tv__pulse { font-size:12px; color:var(--dsw-alias-label-tertiary, inherit); flex:none; white-space:nowrap; animation:sls-pulse 1.5s ease-in-out infinite; }',
      '@keyframes sls-pulse { 0%,100% { opacity:.35; } 50% { opacity:1; } }',
      '.sls-tv__sp { flex:1; }',
      '.sls-tv__copy { display:flex; align-items:center; gap:2px; flex:none; }',
      '.sls-tv__copyBtn { padding:2px 8px; border:1px solid rgba(128,128,128,.35); border-radius:6px; background:transparent; color:inherit; cursor:pointer; font-size:12px; }',
      '.sls-tv__copyBtn:disabled { opacity:.4; cursor:default; }',
      '.sls-tv__copyBtn:not(:disabled):hover { background:rgba(128,128,128,.12); }',
      '.sls-tv__cmd { padding:8px 10px; font-family:var(--sls-mono, monospace); font-size:12.5px; white-space:pre-wrap; word-break:break-all; display:flex; }',
      '.sls-tv__cmdNo { flex:none; text-align:right; margin-right:10px; opacity:.4; user-select:none; }',
      '.sls-tv__cmdText { flex:1; min-width:0; }',
      '.sls-tv__out { margin:0; padding:8px 10px; border-top:1px solid rgba(128,128,128,.18); font-family:var(--sls-mono, monospace); font-size:12.5px; white-space:pre; overflow-x:auto; max-height:320px; overflow-y:auto; }',
      '.sls-tv__inspect { display:flex; align-items:center; gap:4px; padding:4px 10px; border:none; border-top:1px solid rgba(128,128,128,.18); background:transparent; color:inherit; opacity:.6; cursor:pointer; font-size:12px; }',
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
      const shellName = shellNameOf(parseShellMark(contentText))
      const outputText = stripShellMark(contentText)
      // 后台 ack:独立卡呈现命令全文与任务号徽标,ack 原文作输出(不再落 generic 简版行)
      if (args.run_in_background === true) {
        const jobId = /started background job (\S+)/.exec(contentText)?.[1]
        return { kind: 'background', status: 'background', command, description, cwdDir, cwdFull, shellName, output: outputText, jobId }
      }
      // 空结果落 generic:官方 singleResultText 无文本即回通用卡,避免空输出伪 done 终端卡;
      // isError/error 块带 alert(错误红点语义),其余(空输出/无描述/截断)中性无状态点
      if (outputText === '' || block.isError === true || block.error !== undefined || description === undefined || hasSpillNotice(contentText)) {
        const alert = block.isError === true || block.error !== undefined ? 'error' : undefined
        return { kind: 'generic', command, summary: description, output: outputText, running: false, alert }
      }
      const tail = parseExitTail(outputText)
      const status = tail.signal !== undefined ? 'signaled' : tail.exitCode !== 0 ? 'failed' : 'done'
      return { kind: 'terminal', status, command, description, cwdDir, cwdFull, shellName, output: tail.output, exitCode: tail.exitCode, signal: tail.signal, code: undefined }
    }
    // LOGIC-END shellCardModel

    // 官方 ToolRow leading 同构:行首仅 icon;错误/进行中状态红点叠 icon 之上
    // (掩盖 icon,官方状态点语义)
    function leadingStack({ status, icons }) {
      const failed = status === 'failed' || status === 'signaled' || status === 'generic-error'
      const dot = failed ? icons.StateDot({ state: 'error' }) : status === 'generic-warn' ? icons.StateDot({ state: 'warning' }) : status === 'running' ? icons.StateDot({ state: 'ongoing' }) : null
      if (dot !== null) {
        return h('span', { className: 'sls-tv__leadStack' },
          h('span', { className: 'sls-tv__iconIdle' }, icons.IconApi({ size: 14 })),
          h('span', { className: 'sls-tv__stateCover' }, dot),
        )
      }
      return icons.IconApi({ size: 14 })
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
            leadingStack({ status, icons: TOOLVIEW_ICONS }),
          ),
          h('span', { className: 'sls-tv__title' }, 'Shell'),
          summary !== '' ? h('span', { className: 'sls-tv__sep', 'aria-hidden': true }) : null,
          summary !== '' ? h('span', { className: 'sls-tv__sum' + (status === 'generic-error' ? ' sls-tv__sum--err' : '') }, summary) : null,
          status === 'running' ? h('span', { className: 'sls-tv__pulse' }, en ? 'running…' : '运行中…') : null,
        ),
        open && expandable ? h('pre', { className: 'sls-tv__out', style: { border: '1px solid rgba(128,128,128,.28)', borderRadius: 8 } }, model.command + (model.output !== null && model.output !== '' ? `\n${model.output}` : '')) : null,
        inspect !== undefined ? h('button', { className: 'sls-tv__inspect', onClick: inspect }, TOOLVIEW_ICONS.IconInspect({}), en ? 'Inspect' : '检查') : null,
      )
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
            leadingStack({ status: model.status, icons: TOOLVIEW_ICONS }),
          ),
          srStatus !== null ? h('span', { className: 'sls-tv__sr' }, srStatus) : null,
          h('span', { className: 'sls-tv__title' }, 'Shell'),
          h('span', { className: 'sls-tv__sep', 'aria-hidden': true }),
          h('span', { className: 'sls-tv__sum' + (failed ? ' sls-tv__sum--err' : '') }, summary),
          model.status === 'running' ? h(RunningDuration, { startedAt: model.startedAt, en }) : null,
          model.status === 'background' && model.jobId !== undefined
            ? h('span', { className: 'sls-tv__badge', title: en ? 'Background job' : '后台任务' }, en ? `bg ${model.jobId}` : `后台 ${model.jobId}`)
            : null,
        ),
        open ? h(ShellCard, { model, inspect, en }) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
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
