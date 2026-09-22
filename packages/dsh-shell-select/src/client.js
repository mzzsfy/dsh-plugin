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

    // 工具卡客户端名册缓存:GET /config 单飞拉取,shell 徽章按 id→用户命名解析。
    // 失败置 null(徽章不渲染),不重试——下次页面加载自然重取
    let clientCatalog = null
    let clientCatalogPromise = null
    // LOGIC-BEGIN ensureClientCatalog
    function ensureClientCatalog() {
      if (clientCatalogPromise === null) {
        clientCatalogPromise = api(API.config).then((section) => {
          const byId = {}
          for (const entry of section.resolved?.shells ?? []) byId[entry.id] = entry.name
          clientCatalog = { default: section.resolved?.default, byId }
        }).catch(() => { })
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
      // 命令黑名单:逐条规则编辑器(每条规则独立行,行级即时校验)
      '.sls-rules { display:flex; flex-direction:column; gap:6px; padding:10px; border:1px solid var(--sls-border, rgba(128,128,128,.35)); border-radius:8px; }',
      '.sls-rules__head { display:flex; align-items:center; gap:8px; }',
      '.sls-rules__title { font-weight:500; }',
      '.sls-rules__note { font-size:12px; opacity:.7; }',
      '.sls-rule { display:flex; align-items:center; gap:6px; }',
      '.sls-rule__no { flex:none; width:18px; text-align:right; font-size:12px; opacity:.45; user-select:none; }',
      '.sls-rule__input { flex:1; min-width:0; padding:4px 8px; border-radius:6px; border:1px solid var(--sls-border, rgba(128,128,128,.35)); background:transparent; color:inherit; font-size:12px; font-family:var(--sls-mono, monospace); }',
      '.sls-rule__input:focus { outline:none; border-color:var(--sls-accent, #4b7bcc); }',
      '.sls-rule--bad .sls-rule__input { border-color:#c44; }',
      '.sls-rule__err { flex:none; max-width:40%; font-size:11px; color:#c44; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '.sls-rule__del { flex:none; padding:2px 8px; }',
      // tool.call.toolview 卡片(key 'shell'):官方 terminal 行同构 + 复制/折行增强。
      // 色彩对齐官方 ToolRow:标题 label-secondary、icon 盒 label-tertiary(实证自
      // 官方行 computed style);token 缺失时回退 inherit 不致不可读
      '.sls-tv { font-size:13px; line-height:1.45; color:var(--dsw-alias-label-secondary, inherit); }',
      '.sls-tv__row { display:flex; align-items:center; gap:7px; padding:2px 0; cursor:default; }',
      '.sls-tv__row--exp { cursor:pointer; user-select:none; }',
      '.sls-tv__lead { display:flex; align-items:center; gap:4px; color:var(--dsw-alias-label-tertiary, inherit); }',
      '.sls-tv__chev { opacity:.45; transition:transform .15s ease; }',
      '.sls-tv__row[data-open="1"] .sls-tv__chev { transform:rotate(-90deg); }',
      '.sls-tv__sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }',
      '.sls-tv__title { font-weight:400; }',
      '.sls-tv__sep { width:2px; height:2px; border-radius:1px; background:var(--dsw-alias-label-caption, currentColor); opacity:.8; flex:none; }',
      '.sls-tv__sum { color:var(--dsw-alias-label-tertiary, inherit); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
      '.sls-tv__sum--err { color:var(--dsw-alias-state-error-primary, #d4553f); }',
      '.sls-tv__body { margin:6px 0 4px; border:1px solid rgba(128,128,128,.28); border-radius:8px; overflow:hidden; }',
      '.sls-tv__head { display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid rgba(128,128,128,.18); background:rgba(128,128,128,.05); }',
      '.sls-tv__cwd { font-family:var(--sls-mono, monospace); font-size:12px; opacity:.7; }',
      '.sls-tv__badge { font-size:11px; padding:0 7px; border-radius:999px; border:1px solid rgba(128,128,128,.35); opacity:.85; flex:none; }',
      '.sls-tv__pill { font-size:12px; color:#d4553f; flex:none; }',
      '.sls-tv__pill--bg { color:var(--dsw-alias-label-tertiary, inherit); }',
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
      // 开关:隐藏原生 checkbox,选中态 track 与 thumb 位移用过渡呈现(仓库 client 规约)
      '.sls-switch { display:inline-flex; align-items:center; cursor:pointer; }',
      '.sls-switch input[type="checkbox"] { position:absolute; opacity:0; width:0; height:0; }',
      '.sls-switch__track { position:relative; width:34px; height:19px; border-radius:999px; box-sizing:border-box;',
      '  background:var(--sls-track, rgba(128,128,128,0.35));',
      '  border:1px solid var(--sls-border, rgba(128,128,128,0.35));',
      '  transition:background 0.15s, border-color 0.15s; }',
      '.sls-switch__thumb { position:absolute; top:50%; left:2px; width:13px; height:13px; border-radius:50%;',
      '  background:var(--sls-thumb, rgba(128,128,128,0.6));',
      '  transform:translateY(-50%); transition:left 0.15s, background 0.15s; }',
      '.sls-switch:hover .sls-switch__track { border-color:var(--sls-accent, #4b7bcc); }',
      '.sls-switch input[type="checkbox"]:checked + .sls-switch__track { background:var(--sls-accent, #4b7bcc); border-color:var(--sls-accent, #4b7bcc); }',
      '.sls-switch input[type="checkbox"]:checked + .sls-switch__track .sls-switch__thumb { left:17px; background:var(--sls-bg-base, #fff); }',
      '.sls-switch input[type="checkbox"]:focus-visible + .sls-switch__track { outline:2px solid var(--sls-accent, #4b7bcc); outline-offset:1px; }',
    ].join('\n')

    // 开关的 checkbox + 轨道对,checkbox 语义保留仅视觉隐藏
    function switchToggle(props) {
      return [
        h('input', { type: 'checkbox', ...props }),
        h('span', { className: 'sls-switch__track' }, h('span', { className: 'sls-switch__thumb' })),
      ]
    }

    function h(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props || null].concat(children))
    }

    // 保存负载:仅取设置 schema 字段,剥离探测态
    function toSection(entries, defaultId, denyRules) {
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
        deny: denyRules.filter((rule) => rule.length > 0),
      }
    }

    // 逐条规则的正则校验:返回非法条目 [{index, error}](index 为规则序,供行级标错与保存拦截复用)
    // LOGIC-BEGIN denyPatternIssues
    function denyPatternIssues(rules) {
      const issues = []
      for (let index = 0; index < rules.length; index += 1) {
        if (rules[index].length === 0) continue
        try {
          new RegExp(rules[index])
        } catch (error) {
          issues.push({ index, error: String(error?.message ?? error) })
        }
      }
      return issues
    }
    // LOGIC-END denyPatternIssues

    // 环境文本(每行 K=V)→ 记录;空行与缺 = 的行忽略,值保留原样含空格与 =。
    // LOGIC-BEGIN parseEnvText
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
    // LOGIC-END parseEnvText

    // 环境文本中被忽略的行(空行以外):缺 = 的行在保存校验时报错,防静默丢数据
    // LOGIC-BEGIN invalidEnvLines
    function invalidEnvLines(text) {
      return String(text ?? '').split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line.indexOf('=') <= 0)
    }
    // LOGIC-END invalidEnvLines

    // 服务器清单 → 编辑态(argsText 汇成一串便于编辑;envText 每行 K=V;deny 为逐条规则数组)
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

    // 名单数组 → 编辑态数组(去空白行;加载侧解析)
    function patternText(list) {
      return (Array.isArray(list) ? list : []).map((rule) => String(rule).trim()).filter((rule) => rule.length > 0)
    }

    function ShellSelectApp() {
      const [entries, setEntries] = useState(null)
      const [defaultId, setDefaultId] = useState('')
      const [dirty, setDirty] = useState(false)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const [denyRules, setDenyRules] = useState([])

      useEffect(() => {
        let disposed = false
        api(API.config).then((section) => {
          if (disposed) return
          setEntries(toEntries(section))
          setDefaultId(section.default)
          setDenyRules(patternText(section.deny))
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

      const patchRule = (index, value) => {
        setDirty(true)
        setDenyRules(denyRules.map((rule, at) => (at === index ? value : rule)))
      }

      const addRule = () => {
        setDirty(true)
        setDenyRules([...denyRules, ''])
      }

      const removeRule = (index) => {
        setDirty(true)
        setDenyRules(denyRules.filter((_, at) => at !== index))
      }

      const save = async () => {
        setBusy(true)
        setNotice(null)
        try {
          const section = toSection(entries, defaultId, denyRules)
          const ids = section.shells.map((entry) => entry.id)
          if (ids.some((id) => id.length === 0)) throw new Error('存在空 id 条目')
          if (new Set(ids).size !== ids.length) throw new Error('id 重复:' + ids.join(', '))
          if (!ids.includes(section.default)) throw new Error('默认客户端不在列表中')
          const invalid = entries.map((entry) => ({ entry, lines: invalidEnvLines(entry.envText) }))
            .find(({ lines }) => lines.length > 0)
          if (invalid !== undefined) throw new Error(`环境变量行缺少 =(条目 ${invalid.entry.id || '(未命名)'}):${invalid.lines.join(' ; ')}`)
          const issue = denyPatternIssues(section.deny)[0]
          if (issue !== undefined) {
            throw new Error(`命令黑名单第 ${issue.index + 1} 条正则非法:${issue.error}`)
          }
          const payload = await api(API.config, { method: 'POST', body: JSON.stringify(section) })
          setEntries(toEntries({ shells: payload.resolved.shells }))
          setDefaultId(payload.resolved.default)
          setDenyRules(patternText(payload.resolved.deny))
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
              h('label', { className: 'sls-row sls-switch', title: '-lc 登录壳拉起 /etc/profile(只注入 /usr/bin;/mingw64/bin 需在下方的环境里配 MSYSTEM=MINGW64)' },
                ...switchToggle({
                  checked: entry.login === true,
                  onChange: (event) => patchEntry(index, { login: event.target.checked }),
                }),
                h('span', { className: 'sls-hint' }, '-lc 登录壳'),
              ),
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
        h('div', { className: 'sls-rules' },
          h('div', { className: 'sls-rules__head' },
            h('span', { className: 'sls-rules__title' }, '命令黑名单'),
            h('span', { className: 'sls-badge' + (denyRules.length > 0 ? ' sls-badge--ok' : ' sls-badge--bad') },
              denyRules.length > 0 ? denyRules.length + ' 条规则' : '未生效'),
          ),
          h('span', { className: 'sls-rules__note' },
            '每条规则为一条正则,对整条命令全文匹配(大小写不敏感),命中即拒,无豁免;精细放行写在模式内用前瞻,如 rm -rf\\s+(?!\\S*node_modules)。'),
          denyRules.length === 0
            ? h('span', { className: 'sls-rules__note' }, '未配置,命中拦截不生效,模型可执行任意命令。')
            : denyRules.map((rule, index) => {
              const issue = denyPatternIssues([rule])[0]
              return h('div', { className: 'sls-rule' + (issue !== undefined ? ' sls-rule--bad' : ''), key: index },
                h('span', { className: 'sls-rule__no' }, index + 1),
                h('input', {
                  className: 'sls-rule__input',
                  value: rule,
                  placeholder: '正则,如 ^format\\s',
                  onChange: (event) => patchRule(index, event.target.value),
                }),
                issue !== undefined ? h('span', { className: 'sls-rule__err', title: issue.error }, issue.error) : null,
                h('button', {
                  className: 'sls-btn sls-rule__del',
                  title: '删除该条规则',
                  onClick: () => removeRule(index),
                }, '删除'),
              )
            }),
          h('div', { className: 'sls-row' },
            h('button', { className: 'sls-btn', onClick: addRule }, '添加规则'),
          ),
        ),
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
      const cwdFull = displayCwd(typeof args?.workdir === 'string' ? args.workdir : undefined, sessionCwd)
      const cwdDir = cwdFull !== undefined ? lastSegment(cwdFull) : undefined
      // shell 名 = 用户在配置页起的条目名;args.shell 缺省时按 default 客户端解析(配置当前读数)
      const shellName = clientDisplayName(typeof args?.shell === 'string' ? args.shell : undefined)
      if (command === '') return { kind: 'generic', command: '', summary: undefined, output: null }

      if (!settled) {
        // running persistent(进行中无描述):回退行但状态点用进行中灰,非 warning 黄
        if (description === undefined) return { kind: 'generic', command, summary: undefined, output: null, running: true }
        return { kind: 'terminal', status: 'running', command, description, cwdDir, cwdFull, shellName, output: undefined, exitCode: undefined, signal: undefined, code: undefined }
      }

      const contentText = (block.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).filter((text) => text !== '').join('\n')
      // 后台 ack:独立卡呈现命令全文与任务号徽标,ack 原文作输出(不再落 generic 简版行)
      if (args.run_in_background === true) {
        const jobId = /started background job (\S+)/.exec(contentText)?.[1]
        return { kind: 'background', status: 'background', command, description, cwdDir, cwdFull, shellName, output: contentText, jobId }
      }
      // 空结果落 generic:官方 singleResultText 无文本即回通用卡,避免空输出伪 done 终端卡
      if (contentText === '' || block.isError === true || block.error !== undefined || description === undefined || hasSpillNotice(contentText)) {
        return { kind: 'generic', command, summary: description, output: contentText }
      }
      const tail = parseExitTail(contentText)
      const status = tail.signal !== undefined ? 'signaled' : tail.exitCode !== 0 ? 'failed' : 'done'
      return { kind: 'terminal', status, command, description, cwdDir, cwdFull, shellName, output: tail.output, exitCode: tail.exitCode, signal: tail.signal, code: undefined }
    }
    // LOGIC-END shellCardModel

    // 官方 leadingFor 同构:失败红点,回退行黄点,进行中灰点,其余工具图标
    function leadingOf(status, icons) {
      if (status === 'failed' || status === 'signaled') return icons.StateDot({ state: 'error' })
      if (status === 'generic-warn') return icons.StateDot({ state: 'warning' })
      if (status === 'running') return icons.StateDot({ state: 'ongoing' })
      return icons.IconApi({ size: 14 })
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
        // ack 块静态不反映 job 生命周期,状态点用中性工具图标,文案不带"运行中"
        case 'background': return {
          dot: 'none',
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
            leadingOf(model.running === true ? 'running' : 'generic-warn', TOOLVIEW_ICONS),
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
          model.cwdDir !== undefined ? h('span', { className: 'sls-tv__cwd', title: 'pwd: ' + (model.cwdFull ?? model.cwdDir) }, model.cwdDir) : null,
          model.shellName !== undefined ? h('span', { className: 'sls-tv__badge', title: en ? 'Shell client' : 'Shell 客户端' }, model.shellName) : null,
          h('span', { className: 'sls-tv__sp' }),
          meta.pill !== undefined ? h('span', { className: 'sls-tv__pill' + (meta.pillTone === 'bg' ? ' sls-tv__pill--bg' : '') }, meta.pill) : null,
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
      const [, setCatalogReady] = useState(false)
      useEffect(() => {
        let disposed = false
        ensureClientCatalog().then(() => { if (!disposed) setCatalogReady(true) })
        return () => { disposed = true }
      }, [])
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
