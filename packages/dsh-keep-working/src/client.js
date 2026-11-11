// dsh-keep-working Client 半区:设置面板(总开关、节奏、恢复项、文案)。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 由 DSH client runtime 模块表解析。
// 配置读写走宿主路由 /api/keep-working/config,写入后由宿主重建恢复引擎。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-keep-working',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useState } = React

    const API_PATH = '/api/keep-working/config'

    // 毫秒字段在面板按秒编辑,避免用户数零
    const MS_PER_SECOND = 1000

    const CSS = `
.kw-panel { display:flex; flex-direction:column; gap:16px; max-width:720px; }
.kw-group { display:flex; flex-direction:column; gap:10px; padding:14px 16px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-l1); }
.kw-group__title { font-size:13px; font-weight:600; color:var(--dsw-alias-text-l1); }
.kw-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.kw-row__label { font-size:13px; color:var(--dsw-alias-text-l1); }
.kw-row__hint { font-size:12px; color:var(--dsw-alias-text-l3); margin-top:2px; }
.kw-row__control { flex:0 0 auto; display:flex; align-items:center; gap:8px; }
.kw-number { width:96px; padding:5px 8px; font-size:13px; text-align:right; color:var(--dsw-alias-text-l1); background:var(--dsw-alias-bg-l2); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; }
.kw-textarea { width:100%; min-height:52px; padding:8px 10px; font-size:13px; line-height:1.5; color:var(--dsw-alias-text-l1); background:var(--dsw-alias-bg-l2); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; resize:vertical; font-family:inherit; }
.kw-field { display:flex; flex-direction:column; gap:6px; }
.kw-field__label { font-size:13px; color:var(--dsw-alias-text-l1); }
.kw-actions { display:flex; align-items:center; gap:10px; }
.kw-button { padding:6px 16px; font-size:13px; border-radius:6px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-l2); color:var(--dsw-alias-text-l1); cursor:pointer; }
.kw-button--primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:#fff; }
.kw-button:disabled { opacity:.55; cursor:not-allowed; }
.kw-status { font-size:12px; color:var(--dsw-alias-text-l3); }
.kw-status--error { color:var(--dsw-alias-text-danger, #d9534f); }
.kw-switch { position:relative; display:inline-flex; align-items:center; cursor:pointer; }
.kw-switch input[type="checkbox"] { position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; }
.kw-switch__track { display:inline-block; width:36px; height:20px; border-radius:10px; background:var(--dsw-alias-bg-l3); transition:background .16s ease; }
.kw-switch__thumb { display:block; width:16px; height:16px; margin:2px; border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.2); transition:transform .16s ease; }
.kw-switch input[type="checkbox"]:checked + .kw-switch__track { background:var(--dsw-alias-brand-primary); }
.kw-switch input[type="checkbox"]:checked + .kw-switch__track > .kw-switch__thumb { transform:translateX(16px); }
.kw-switch input[type="checkbox"]:focus-visible + .kw-switch__track { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.kw-switch input[type="checkbox"]:disabled + .kw-switch__track { opacity:.5; }
`

    /** 布尔项:label 包裹视觉隐藏的 checkbox 与胶囊轨道,规约要求的开关形态。 */
    const switchRow = (key, label, hint, value, onChange) =>
      React.createElement(
        'div',
        { className: 'kw-row', key },
        React.createElement(
          'div',
          null,
          React.createElement('div', { className: 'kw-row__label' }, label),
          hint === undefined ? null : React.createElement('div', { className: 'kw-row__hint' }, hint),
        ),
        React.createElement(
          'label',
          { className: 'kw-switch' },
          React.createElement('input', {
            type: 'checkbox',
            checked: value === true,
            onChange: (event) => onChange(event.target.checked),
          }),
          React.createElement(
            'span',
            { className: 'kw-switch__track' },
            React.createElement('span', { className: 'kw-switch__thumb' }),
          ),
        ),
      )

    /** 数值项:毫秒字段按秒显示,写回时换算。 */
    const numberRow = (key, label, hint, value, unitMs, onChange) =>
      React.createElement(
        'div',
        { className: 'kw-row', key },
        React.createElement(
          'div',
          null,
          React.createElement('div', { className: 'kw-row__label' }, label),
          hint === undefined ? null : React.createElement('div', { className: 'kw-row__hint' }, hint),
        ),
        React.createElement('input', {
          className: 'kw-number',
          type: 'number',
          min: 1,
          value: unitMs ? Math.round(value / MS_PER_SECOND) : value,
          onChange: (event) => {
            const next = Number(event.target.value)
            if (!Number.isFinite(next) || next <= 0) return
            onChange(unitMs ? next * MS_PER_SECOND : next)
          },
        }),
      )

    const textField = (key, label, value, onChange) =>
      React.createElement(
        'div',
        { className: 'kw-field', key },
        React.createElement('div', { className: 'kw-field__label' }, label),
        React.createElement('textarea', {
          className: 'kw-textarea',
          value,
          onChange: (event) => onChange(event.target.value),
        }),
      )

    function KeepWorkingPanel() {
      const [config, setConfig] = useState(null)
      const [defaults, setDefaults] = useState(null)
      const [status, setStatus] = useState('')
      const [failed, setFailed] = useState(false)

      const load = useCallback(async () => {
        try {
          const response = await fetch(API_PATH)
          const payload = await response.json()
          setConfig(payload.value)
          setDefaults(payload.defaults)
          setFailed(false)
        } catch (error) {
          setStatus(`读取失败:${error instanceof Error ? error.message : String(error)}`)
          setFailed(true)
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const patch = useCallback((key, value) => {
        setConfig((current) => (current === null ? current : { ...current, [key]: value }))
      }, [])

      const save = useCallback(async () => {
        if (config === null) return
        setStatus('保存中')
        try {
          const response = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(config),
          })
          const payload = await response.json()
          if (payload.ok !== true) throw new Error(payload.error ?? '保存失败')
          setConfig(payload.value)
          setStatus('已保存,立即生效')
          setFailed(false)
        } catch (error) {
          setStatus(`保存失败:${error instanceof Error ? error.message : String(error)}`)
          setFailed(true)
        }
      }, [config])

      const reset = useCallback(() => {
        if (defaults === null) return
        setConfig((current) => ({
          ...current,
          graceMs: defaults.graceMs,
          cooldownMs: defaults.cooldownMs,
          maxConsecutive: defaults.maxConsecutive,
          continueText: defaults.continueText,
          continueTextInterrupted: defaults.continueTextInterrupted,
          continueTextSilent: defaults.continueTextSilent,
          continueTextMaxTokens: defaults.continueTextMaxTokens,
          closureText: defaults.closureText,
        }))
        setStatus('已填入默认值,点保存生效')
        setFailed(false)
      }, [defaults])

      if (config === null) {
        return React.createElement('div', { className: 'kw-panel' }, '读取配置中')
      }

      return React.createElement(
        'div',
        { className: 'kw-panel' },
        React.createElement(
          'div',
          { className: 'kw-group' },
          React.createElement('div', { className: 'kw-group__title' }, '总开关'),
          switchRow(
            'enabled',
            '启用自动继续',
            '关闭后不再补发任何消息,已排队的发送一并取消',
            config.paused !== true,
            (next) => patch('paused', next !== true),
          ),
        ),
        React.createElement(
          'div',
          { className: 'kw-group' },
          React.createElement('div', { className: 'kw-group__title' }, '节奏'),
          numberRow(
            'graceMs',
            '等待时间',
            '回合结束后等多久再补发,留出用户插话的间隙(秒)',
            config.graceMs,
            true,
            (next) => patch('graceMs', next),
          ),
          numberRow(
            'cooldownMs',
            '连续补发后的冷却',
            '同一会话连续补发时,每次都按倍数拉长,这是起始值(秒)',
            config.cooldownMs,
            true,
            (next) => patch('cooldownMs', next),
          ),
          numberRow(
            'maxConsecutive',
            '最多连续补发',
            '同一回合连续补发到该次数就停手,等你回来处理',
            config.maxConsecutive,
            false,
            (next) => patch('maxConsecutive', next),
          ),
        ),
        React.createElement(
          'div',
          { className: 'kw-group' },
          React.createElement('div', { className: 'kw-group__title' }, '恢复项'),
          switchRow(
            'scanOnBoot',
            '重启后接着跑',
            '宿主启动时扫描上次没结案的会话',
            config.scanOnBoot,
            (next) => patch('scanOnBoot', next),
          ),
          switchRow(
            'resumeSilentTurns',
            '恢复空回合',
            '模型只输出了思考、没有可见回复时也补发',
            config.resumeSilentTurns,
            (next) => patch('resumeSilentTurns', next),
          ),
          switchRow(
            'pauseWhenOffline',
            '断网时暂停',
            '网络不通时不重试,联网后自动继续',
            config.pauseWhenOffline,
            (next) => patch('pauseWhenOffline', next),
          ),
          switchRow(
            'classify',
            '区分永久错误',
            '鉴权失败、余额不足、模型不存在这类重试无用的错误直接放弃',
            config.classify,
            (next) => patch('classify', next),
          ),
        ),
        React.createElement(
          'div',
          { className: 'kw-group' },
          React.createElement('div', { className: 'kw-group__title' }, '补发文案'),
          textField('continueText', '出错后', config.continueText, (next) => patch('continueText', next)),
          textField('continueTextInterrupted', '重启后', config.continueTextInterrupted, (next) =>
            patch('continueTextInterrupted', next),
          ),
          textField('continueTextSilent', '空回合', config.continueTextSilent, (next) =>
            patch('continueTextSilent', next),
          ),
          textField('continueTextMaxTokens', '输出截断', config.continueTextMaxTokens, (next) =>
            patch('continueTextMaxTokens', next),
          ),
          textField('closureText', '未结案提醒', config.closureText, (next) => patch('closureText', next)),
        ),
        React.createElement(
          'div',
          { className: 'kw-actions' },
          React.createElement(
            'button',
            { className: 'kw-button kw-button--primary', onClick: () => void save() },
            '保存',
          ),
          React.createElement('button', { className: 'kw-button', onClick: reset }, '恢复默认'),
          React.createElement(
            'span',
            { className: failed ? 'kw-status kw-status--error' : 'kw-status' },
            status,
          ),
        ),
      )
    }

    return {
      name: 'keep-working',
      // 设置分区挂载在 slots 上,缺声明时宿主拒绝服务访问
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          // 自带 data-plugin:缺失时宿主 claimStyles 会把样式归属给后续材质化插件,其重建即误删
          style.setAttribute('data-plugin', '@mzzsfy/dsh-keep-working')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'keep-working styles')
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'keep-working', order: 42, label: '持续工作' },
            () => React.createElement(KeepWorkingPanel),
          ))
      },
      __test: { KeepWorkingPanel },
    }
  },
})
