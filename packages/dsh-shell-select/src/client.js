// dsh-shell-select Client 半区:设置页卡片(shells 列表管理 + 默认客户端 + 路径探测)。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory});
// 数据经 webServer 路由 /api/shell-select/* 读写宿主 settings 节(照 dsh-maintain 双端模式)。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-shell-select',
  factory(require) {
    const React = require('react')
    const { useState, useEffect } = React

    // 官方 primitives 图标/状态点(运行时模块表解析;dsh.client.inject 声明保证在场)
    const primitives = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives')
      } catch {
        return null
      }
    })()
    const createElementOf = (name, fallback) => {
      const Component = primitives !== null ? primitives[name] : undefined
      return typeof Component === 'function' || typeof Component === 'object'
        ? (props) => React.createElement(Component, props ?? null)
        : fallback
    }
    const DOT_SVG = { done: '#2e9e5b', error: '#d4553f', warning: '#d9a13b', ongoing: '#7a7f8a' }
    // 降级自绘:模块表缺 primitives 时保持可见性(形态近似官方 StateDot/图标)
    const TOOLVIEW_ICONS = {
      StateDot: createElementOf('StateDot', ({ state }) => h('span', {
        style: {
          width: 8, height: 8, borderRadius: '50%', background: DOT_SVG[state] ?? DOT_SVG.ongoing,
          display: 'inline-block', flex: 'none',
        },
      })),
      IconApi: createElementOf('IconApiOutline14', () => h('span', {
        style: {
          width: 12, height: 12, borderRadius: 3, border: '1.5px solid currentColor',
          opacity: .7, display: 'inline-block', flex: 'none',
        },
      })),
      IconChevron: createElementOf('IconChevronDownOutline14', ({ size }) => h('span', {
        style: { fontSize: (size ?? 14) - 3, lineHeight: 1, userSelect: 'none' },
      }, '▾')),
      IconInspect: createElementOf('IconInspectOutline12', () => h('span', {
        style: { fontSize: 10, lineHeight: 1, opacity: .8 },
      }, 'ⓘ')),
    }

    const API = {
      config: '/api/shell-select/config',
      probe: '/api/shell-select/probe',
      detect: '/api/shell-select/detect',
    }
    const KINDS = ['pwsh', 'bash', 'cmd', 'wsl']
    const KIND_LABELS = {
      pwsh: 'PowerShell',
      bash: 'POSIX bash(git bash / msys2 / cygwin)',
      cmd: 'CMD',
      wsl: 'WSL bash',
    }

    async function api(path, options) {
      const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
      return payload
    }

    const CSS = [
      '.sls-card { display:flex; flex-direction:column; gap:10px; }',
      '.sls-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }',
      '.sls-entry { display:flex; flex-direction:column; gap:6px; padding:10px; border:1px solid var(--sls-border, rgba(128,128,128,.35)); border-radius:8px; }',
      '.sls-entry__head { display:flex; align-items:center; gap:8px; }',
      '.sls-grid { display:grid; grid-template-columns: 90px 1fr; gap:4px 8px; align-items:center; }',
      '.sls-grid__label { opacity:.75; font-size:12px; }',
      '.sls-input { padding:4px 8px; border-radius:6px; border:1px solid var(--sls-border, rgba(128,128,128,.35)); background:transparent; color:inherit; min-width:0; }',
      '.sls-input--wide { width:100%; }',
      '.sls-btn { padding:3px 10px; border-radius:6px; border:1px solid var(--sls-border, rgba(128,128,128,.35)); background:transparent; color:inherit; cursor:pointer; font-size:12px; }',
      '.sls-btn:disabled { opacity:.5; cursor:default; }',
      '.sls-btn--primary { border-color: transparent; background: var(--sls-accent, #4b7bcc); color:#fff; }',
      '.sls-badge { font-size:11px; padding:1px 8px; border-radius:999px; border:1px solid var(--sls-border, rgba(128,128,128,.35)); opacity:.85; }',
      '.sls-badge--ok { color:#2e9e5b; border-color:#2e9e5b; }',
      '.sls-badge--bad { color:#c44; border-color:#c44; }',
      '.sls-badge--default { color:#fff; background:var(--sls-accent, #4b7bcc); border-color:transparent; }',
      '.sls-hint { font-size:12px; opacity:.7; }',
      '.sls-error { font-size:12px; color:#c44; white-space:pre-wrap; }',
      '.sls-args { font-size:12px; font-family:var(--sls-mono, monospace); }',
      // tool.call.toolview 卡片(key 'shell'):官方 terminal 行同构 + 复制/折行增强
      '.sls-tv { font-size:13px; line-height:1.45; }',
      '.sls-tv__row { display:flex; align-items:center; gap:7px; padding:2px 0; cursor:default; }',
      '.sls-tv__row--exp { cursor:pointer; user-select:none; }',
      '.sls-tv__lead { display:flex; align-items:center; gap:4px; color:inherit; }',
      '.sls-tv__chev { opacity:.45; transition:transform .15s ease; }',
      '.sls-tv__row[data-open="1"] .sls-tv__chev { transform:rotate(-90deg); }',
      '.sls-tv__sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }',
      '.sls-tv__title { font-weight:500; }',
      '.sls-tv__sep { width:3px; height:3px; border-radius:50%; background:currentColor; opacity:.35; flex:none; }',
      '.sls-tv__sum { opacity:.6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
      '.sls-tv__sum--err { color:#d4553f; opacity:.95; }',
      '.sls-tv__body { margin:6px 0 4px; border:1px solid rgba(128,128,128,.28); border-radius:8px; overflow:hidden; }',
      '.sls-tv__head { display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid rgba(128,128,128,.18); background:rgba(128,128,128,.05); }',
      '.sls-tv__cwd { font-family:var(--sls-mono, monospace); font-size:12px; opacity:.7; }',
      '.sls-tv__badge { font-size:11px; padding:0 7px; border-radius:999px; border:1px solid rgba(128,128,128,.35); opacity:.85; flex:none; }',
      '.sls-tv__pill { font-size:12px; color:#d4553f; flex:none; }',
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

    // 保存负载:仅取设置 schema 字段,剥离探测态
    function toSection(entries, defaultId) {
      return {
        shells: entries.map((entry) => ({
          id: entry.id.trim(),
          name: entry.name.trim(),
          kind: entry.kind,
          path: entry.path.trim(),
          args: entry.argsText.split(/\s+/).filter((item) => item.length > 0),
          login: entry.kind === 'bash' ? entry.login === true : false,
          distro: entry.distro ?? '',
          env: parseEnvText(entry.envText),
        })),
        default: defaultId,
      }
    }

    // 环境文本(每行 K=V)→ 记录;空行与缺 = 的行忽略,值保留原样含空格与 =
    function parseEnvText(text) {
      const env = {}
      for (const line of String(text ?? '').split('\n')) {
        const separator = line.indexOf('=')
        if (separator <= 0) continue
        const key = line.slice(0, separator).trim()
        if (key.length === 0) continue
        env[key] = line.slice(separator + 1)
      }
      return env
    }

    // 服务器清单 → 编辑态(argsText 汇成一串便于编辑;envText 每行 K=V)
    function toEntries(section) {
      return section.shells.map((entry) => ({
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        path: entry.path,
        argsText: (entry.args ?? []).join(' '),
        login: entry.login === true,
        distro: entry.distro ?? '',
        envText: Object.entries(entry.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
        available: entry.available,
        resolved: entry.path,
      }))
    }

    function ShellSelectApp() {
      const [entries, setEntries] = useState(null)
      const [defaultId, setDefaultId] = useState('')
      const [dirty, setDirty] = useState(false)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let disposed = false
        api(API.config).then((section) => {
          if (disposed) return
          setEntries(toEntries(section))
          setDefaultId(section.default)
        }).catch((error) => {
          if (!disposed) setNotice('加载失败:' + error.message)
        })
        return () => {
          disposed = true
        }
      }, [])

      const patchEntry = (index, changes) => {
        setDirty(true)
        setEntries(entries.map((entry, at) => (at === index ? { ...entry, ...changes } : entry)))
      }

      const addEntry = () => {
        setDirty(true)
        setEntries([...entries, { id: '', name: '', kind: 'bash', path: '', argsText: '', login: false, distro: '', envText: '', available: undefined, resolved: undefined }])
      }

      const removeEntry = (index) => {
        const target = entries[index]
        setDirty(true)
        setEntries(entries.filter((_, at) => at !== index))
        if (defaultId === target.id) setDefaultId(entries.length > 1 ? entries[0].id : '')
      }

      const save = async () => {
        setBusy(true)
        setNotice(null)
        try {
          const section = toSection(entries, defaultId)
          const ids = section.shells.map((entry) => entry.id)
          if (ids.some((id) => id.length === 0)) throw new Error('存在空 id 条目')
          if (new Set(ids).size !== ids.length) throw new Error('id 重复:' + ids.join(', '))
          if (!ids.includes(section.default)) throw new Error('默认客户端不在列表中')
          const payload = await api(API.config, { method: 'POST', body: JSON.stringify(section) })
          setEntries(toEntries({ shells: payload.resolved.shells }))
          setDefaultId(payload.resolved.default)
          setDirty(false)
          setNotice('已保存,工具描述与默认客户端即时生效')
        } catch (error) {
          setNotice('保存失败:' + error.message)
        } finally {
          setBusy(false)
        }
      }

      const probe = async (index) => {
        const target = entries[index]
        setBusy(true)
        setNotice(null)
        try {
          const payload = await api(API.probe, { method: 'POST', body: JSON.stringify({ path: target.path }) })
          patchEntry(index, { available: payload.exists, resolved: target.path })
        } catch (error) {
          setNotice('探测失败:' + error.message)
        } finally {
          setBusy(false)
        }
      }

      const detect = async (kind) => {
        setBusy(true)
        setNotice(null)
        try {
          const payload = await api(API.detect, { method: 'POST', body: JSON.stringify({ kinds: [kind] }) })
          setNotice(payload.found.length > 0
            ? kind + ' 候选:' + payload.found.map((item) => item.path).join(' ; ')
            : kind + ' 未发现候选')
        } catch (error) {
          setNotice('探测失败:' + error.message)
        } finally {
          setBusy(false)
        }
      }

      if (entries === null) {
        return h('div', { className: 'sls-card' },
          h('span', { className: 'sls-hint' }, notice ?? '加载中…'))
      }

      return h('div', { className: 'sls-card' },
        h('div', { className: 'sls-row' },
          h('span', { className: 'sls-hint' }, '命令行客户端清单。路径留空自动探测;模型可通过工具的 shell 参数选择任一条目,缺省用默认。'),
        ),
        entries.map((entry, index) => h('div', { className: 'sls-entry', key: index },
          h('div', { className: 'sls-entry__head' },
            h('label', { className: 'sls-row' },
              h('input', {
                type: 'radio',
                name: 'sls-default',
                checked: defaultId === entry.id && entry.id.length > 0,
                onChange: () => {
                  setDirty(true)
                  setDefaultId(entry.id)
                },
                disabled: entry.id.trim().length === 0,
                title: '设为默认客户端(模型缺省 shell 参数时使用)',
              }),
              h('span', { className: 'sls-hint' }, '默认'),
            ),
            h('span', {
              className: 'sls-badge' + (entry.available === true ? ' sls-badge--ok' : entry.available === false ? ' sls-badge--bad' : ''),
              title: entry.resolved !== undefined && entry.resolved.length > 0 ? '解析路径:' + entry.resolved : '路径尚未解析',
            }, entry.available === true ? '可用' : entry.available === false ? '不可用' : '未知'),
            entry.id === defaultId && entry.id.length > 0 ? h('span', { className: 'sls-badge sls-badge--default' }, '默认') : null,
            h('span', { style: { flex: 1 } }),
            h('button', {
              className: 'sls-btn',
              disabled: busy || entry.path.trim().length === 0,
              title: '检查该路径是否存在',
              onClick: () => void probe(index),
            }, '探测路径'),
            h('button', {
              className: 'sls-btn',
              disabled: busy,
              title: '移除该条目',
              onClick: () => removeEntry(index),
            }, '移除'),
          ),
          h('div', { className: 'sls-grid' },
            h('span', { className: 'sls-grid__label' }, 'id'),
            h('input', {
              className: 'sls-input',
              value: entry.id,
              placeholder: 'pwsh / git-bash / …(模型看到的 shell 参数值)',
              onChange: (event) => patchEntry(index, { id: event.target.value }),
            }),
            h('span', { className: 'sls-grid__label' }, '名称'),
            h('input', {
              className: 'sls-input',
              value: entry.name,
              placeholder: '显示名,如 Git Bash',
              onChange: (event) => patchEntry(index, { name: event.target.value }),
            }),
            h('span', { className: 'sls-grid__label' }, '形态'),
            h('div', { className: 'sls-row' },
              h('select', {
                className: 'sls-input',
                value: entry.kind,
                onChange: (event) => patchEntry(index, { kind: event.target.value }),
              }, KINDS.map((kind) => h('option', { value: kind, key: kind }, KIND_LABELS[kind]))),
              h('button', {
                className: 'sls-btn',
                disabled: busy,
                title: '扫描本机常见安装位置',
                onClick: () => void detect(entry.kind),
              }, '扫描本机'),
            ),
            h('span', { className: 'sls-grid__label' }, '路径'),
            h('input', {
              className: 'sls-input sls-input--wide',
              value: entry.path,
              placeholder: '留空自动探测,如 C:\\Program Files\\Git\\bin\\bash.exe',
              onChange: (event) => patchEntry(index, { path: event.target.value }),
            }),
            h('span', { className: 'sls-grid__label' }, '参数'),
            h('input', {
              className: 'sls-input sls-input--wide sls-args',
              value: entry.argsText,
              placeholder: '留空用形态默认;自定义模板以空格分隔,{command} 为命令占位',
              onChange: (event) => patchEntry(index, { argsText: event.target.value }),
            }),
            ...(entry.kind === 'bash' ? [
              h('span', { className: 'sls-grid__label' }, '登录壳'),
              h('label', { className: 'sls-row', style: { alignItems: 'center' } },
                h('input', {
                  type: 'checkbox',
                  checked: entry.login === true,
                  onChange: (event) => patchEntry(index, { login: event.target.checked }),
                }),
                h('span', { className: 'sls-hint' }, '-lc 登录壳(msys2 需要它拉起 /etc/profile)')),
            ] : []),
            ...(entry.kind === 'wsl' ? [
              h('span', { className: 'sls-grid__label' }, '发行版'),
              h('input', {
                className: 'sls-input',
                value: entry.distro ?? '',
                placeholder: '留空用默认发行版,如 Ubuntu-22.04',
                onChange: (event) => patchEntry(index, { distro: event.target.value }),
              }),
            ] : []),
            h('span', { className: 'sls-grid__label' }, '环境'),
            h('textarea', {
              className: 'sls-input sls-args',
              rows: 2,
              value: entry.envText,
              placeholder: '每行 K=V,如 MSYSTEM=MINGW64;wsl 形自动经 WSLENV 透传',
              onChange: (event) => patchEntry(index, { envText: event.target.value }),
            }),
          ),
        )),
        h('div', { className: 'sls-row' },
          h('button', { className: 'sls-btn', disabled: busy, onClick: addEntry }, '添加客户端'),
          h('span', { style: { flex: 1 } }),
          dirty ? h('span', { className: 'sls-hint' }, '有未保存改动') : null,
          h('button', {
            className: 'sls-btn sls-btn--primary',
            disabled: busy || !dirty,
            onClick: () => void save(),
          }, '保存'),
        ),
        notice !== null ? h('div', { className: 'sls-hint' }, notice) : null,
      )
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

    // block → 卡片模型(官方 terminalCardModel 同构,数据源 argsRaw + content 文本)。
    // generic = 后台 ack / isError / 溢出预览 / persistent 形(无 description,
    // 官方 shellCall persistent→generic 同构),交回退行;terminal = 全量卡。
    // LOGIC-BEGIN shellCardModel
    function shellCardModel(block, sessionCwd) {
      const settled = 'kind' in block
      const call = settled ? block.call : block
      let args = null
      try {
        const parsed = JSON.parse(call !== null && call !== undefined ? call.argsRaw : '')
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) args = parsed
      } catch { /* 结构外形态走 generic */ }
      const command = typeof args?.command === 'string' && args.command.trim() !== '' ? args.command : ''
      const description = typeof args?.description === 'string' && args.description.trim() !== '' ? args.description : undefined
      const cwdDir = (() => {
        const dir = displayCwd(typeof args?.workdir === 'string' ? args.workdir : undefined, sessionCwd)
        return dir !== undefined ? lastSegment(dir) : undefined
      })()
      const shellName = typeof args?.shell === 'string' && args.shell !== '' ? args.shell : undefined
      if (command === '') return { kind: 'generic', command: '', summary: undefined, output: null }

      if (!settled) {
        if (description === undefined) return { kind: 'generic', command, summary: undefined, output: null }
        return { kind: 'terminal', status: 'running', command, description, cwdDir, shellName, output: undefined, exitCode: undefined, signal: undefined, code: undefined }
      }

      const contentText = (block.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).filter((text) => text !== '').join('\n')
      // 空结果落 generic:官方 singleResultText 无文本即回通用卡,避免空输出伪 done 终端卡
      if (contentText === '' || block.isError === true || block.error !== undefined || args.run_in_background === true || description === undefined || hasSpillNotice(contentText)) {
        return { kind: 'generic', command, summary: description, output: contentText }
      }
      const tail = parseExitTail(contentText)
      const status = tail.signal !== undefined ? 'signaled' : tail.exitCode !== 0 ? 'failed' : 'done'
      return { kind: 'terminal', status, command, description, cwdDir, shellName, output: tail.output, exitCode: tail.exitCode, signal: tail.signal, code: undefined }
    }
    // LOGIC-END shellCardModel

    // 官方 leadingFor 同构:失败红点,回退行黄点,其余工具图标
    function leadingOf(status, icons) {
      if (status === 'failed' || status === 'signaled') return icons.StateDot({ state: 'error' })
      if (status === 'generic-warn') return icons.StateDot({ state: 'warning' })
      return icons.IconApi({ size: 14 })
    }

    function statusTextOf(status, en) {
      switch (status) {
        case 'running': return en ? 'Running' : '运行中'
        case 'failed': case 'signaled': return en ? 'Failed' : '失败'
        default: return null
      }
    }

    function headMetaOf(model, en) {
      switch (model.status) {
        case 'running': return { dot: 'ongoing', label: en ? 'Running' : '运行中', pill: undefined }
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

    // 非终端意图回退行(后台 ack / isError / 截断):摘要 + 可展开原文
    function GenericShellRow({ model, inspect, en }) {
      const [open, setOpen] = useState(false)
      const summary = model.summary !== undefined && model.summary !== ''
        ? model.summary.split('\n')[0]
        : (model.output !== null && model.output !== '' ? model.output.split('\n')[0] : '')
      const expandable = model.output !== null && model.output !== ''
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
            leadingOf('generic-warn', TOOLVIEW_ICONS),
            expandable ? h('span', { className: 'sls-tv__chev', 'data-open': open ? '1' : '0', style: { display: 'inline-flex', transform: open ? 'rotate(-90deg)' : 'none' } }, TOOLVIEW_ICONS.IconChevron({ size: 14 })) : null,
          ),
          h('span', { className: 'sls-tv__title' }, 'Shell'),
          summary !== '' ? h('span', { className: 'sls-tv__sep', 'aria-hidden': true }) : null,
          summary !== '' ? h('span', { className: 'sls-tv__sum' }, summary) : null,
        ),
        open && expandable ? h('pre', { className: 'sls-tv__out', style: { border: '1px solid rgba(128,128,128,.28)', borderRadius: 8 } }, model.output) : null,
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
      return h('div', { className: 'sls-tv__body', 'data-status': model.status },
        h('div', { className: 'sls-tv__head' },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            TOOLVIEW_ICONS.StateDot({ state: meta.dot }),
            h('span', { className: 'sls-tv__sr' }, meta.label),
          ),
          model.cwdDir !== undefined ? h('span', { className: 'sls-tv__cwd' }, model.cwdDir) : null,
          model.shellName !== undefined ? h('span', { className: 'sls-tv__badge' }, model.shellName) : null,
          h('span', { className: 'sls-tv__sp' }),
          meta.pill !== undefined ? h('span', { className: 'sls-tv__pill' }, meta.pill) : null,
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
      const { block, cwd, inspect } = props
      const en = detectEnglish()
      const [open, setOpen] = useState(false)
      const model = shellCardModel(block, cwd)
      if (model.kind === 'generic') return h(GenericShellRow, { model, inspect, en })
      const expandable = true
      const srStatus = statusTextOf(model.status, en)
      const summary = model.description !== undefined ? model.description.split('\n')[0] : (en ? '(no description)' : '(无描述)')
      const failed = model.status === 'failed' || model.status === 'signaled'
      return h('div', { className: 'sls-tv' },
        h('div', {
          className: 'sls-tv__row sls-tv__row--exp',
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open,
          'data-open': open ? '1' : '0',
          onClick: () => setOpen((value) => !value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setOpen((value) => !value)
            }
          },
        },
          h('span', { className: 'sls-tv__lead' },
            leadingOf(model.status, TOOLVIEW_ICONS),
            h('span', { className: 'sls-tv__chev', style: { display: 'inline-flex', transform: open ? 'rotate(-90deg)' : 'none' } }, TOOLVIEW_ICONS.IconChevron({ size: 14 })),
          ),
          srStatus !== null ? h('span', { className: 'sls-tv__sr' }, srStatus) : null,
          h('span', { className: 'sls-tv__title' }, 'Shell'),
          h('span', { className: 'sls-tv__sep', 'aria-hidden': true }),
          h('span', { className: 'sls-tv__sum' + (failed ? ' sls-tv__sum--err' : '') }, summary),
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
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'shell-select', order: 82, label: 'Shell 管理' },
            () => React.createElement(ShellSelectApp),
          ))
        // 替换 shell 族工具行渲染:keyed hit 优先于 GenericToolCard 兜底;
        // priority -1 阴影官方同 key 注册(低值先渲染)。pwsh/bash 为官方工具
        // 名(死态窗口 guard 代挂官方 tool-pwsh 时,其调用行同样获得增强卡;
        // 卡片模型按官方 terminalCardModel 同构自 argsRaw+结果文本派生,数据
        // 面对两类工具一致,无需分支)。
        const TOOLVIEW_KEYS = ['shell', 'pwsh', 'bash']
        for (const toolKey of TOOLVIEW_KEYS) {
          ctx.slots.inject('tool.call.toolview', () =>
            ctx.slots.register(
              { name: 'tool.call.toolview', key: toolKey, priority: -1 },
              (props) => React.createElement(ShellToolRow, props),
            ))
        }
      },
    }
  },
})
