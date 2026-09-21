// dsh-shell-select Client 半区:设置页卡片(shells 列表管理 + 默认客户端 + 路径探测)。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory});
// 数据经 webServer 路由 /api/shell-select/* 读写宿主 settings 节(照 dsh-maintain 双端模式)。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-shell-select',
  factory(require) {
    const React = require('react')
    const { useState, useEffect } = React

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
        })),
        default: defaultId,
      }
    }

    // 服务器清单 → 编辑态(argsText 汇成一串便于编辑)
    function toEntries(section) {
      return section.shells.map((entry) => ({
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        path: entry.path,
        argsText: (entry.args ?? []).join(' '),
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
        setEntries([...entries, { id: '', name: '', kind: 'bash', path: '', argsText: '', available: undefined, resolved: undefined }])
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
      },
    }
  },
})
