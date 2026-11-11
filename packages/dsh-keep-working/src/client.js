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

    const HEAD_HINT = '开关与数字在点保存后才生效;恢复默认只把默认值填回输入框,仍需保存。'

    // 色彩槽位:根作用域声明包局部 token,直接引用宿主语义别名,不写 fallback
    // (规范见 DEVELOPMENT/plugin-ui-design.md,字面量在暗色主题与主题切换时漏色)
    const CSS = `
.kw-panel { --kw-accent: var(--dsw-alias-brand-primary); --kw-accent-deep: var(--dsw-alias-button-primary-hover); --kw-accent-wash: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); --kw-ok: var(--dsw-alias-state-success-primary); --kw-warn: var(--dsw-alias-state-warn-primary); --kw-danger: var(--dsw-alias-state-error-primary); --kw-danger-wash: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); --kw-text: var(--dsw-alias-label-primary); --kw-text-sub: var(--dsw-alias-label-secondary); --kw-text-dim: var(--dsw-alias-label-tertiary); --kw-bg: var(--dsw-alias-bg-layer-1); --kw-bg-sub: var(--dsw-alias-bg-layer-2); --kw-bg-muted: var(--dsw-alias-bg-module-platform); --kw-card: var(--dsw-alias-bg-layer-1); --kw-card-border: var(--dsw-alias-border-l2); --kw-border: var(--dsw-alias-border-l2); --kw-border-strong: var(--dsw-alias-border-l3); --kw-hover: var(--dsw-alias-interactive-bg-hover); --kw-hover-danger: var(--dsw-alias-interactive-bg-hover-danger); --kw-skeleton: var(--dsw-alias-bg-skeleton); --kw-radius-sm: var(--dsw-radius-sm); --kw-radius-md: var(--dsw-radius-md); --kw-radius-lg: var(--dsw-radius-lg);
  display: flex; flex-direction: column; gap: 16px; max-width: 720px; color: var(--kw-text); font-size: 14px; line-height: 22px; }
.kw-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.kw-head__hint { color: var(--kw-text-sub); font-size: 13px; line-height: 20px; }
.kw-card { display: flex; flex-direction: column; padding: 20px; background: var(--kw-card); border: .5px solid var(--kw-card-border); border-radius: var(--kw-radius-md); }
.kw-card__head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; padding-bottom: 8px; }
.kw-card__title { font-weight: 600; font-size: 14px; line-height: 22px; color: var(--kw-text); }
.kw-card__meta { margin-left: auto; color: var(--kw-text-dim); font-size: 12px; line-height: 18px; }
.kw-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 16px; align-items: center; padding: 12px 0; border-top: .5px solid var(--kw-border); }
.kw-row__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.kw-row__label { color: var(--kw-text); font-size: 14px; line-height: 22px; }
.kw-row__hint { color: var(--kw-text-sub); font-size: 13px; line-height: 20px; }
.kw-row__control { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; min-width: 0; }
.kw-unit { color: var(--kw-text-dim); font-size: 11px; line-height: 18px; }
.kw-number { width: 96px; height: 36px; box-sizing: border-box; padding: 0 10px; font: inherit; font-size: 14px; line-height: 22px; text-align: right; color: var(--kw-text); background: var(--kw-bg); border: 1px solid var(--kw-border-strong); border-radius: var(--kw-radius-sm); }
.kw-number:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.kw-number:disabled { opacity: .5; cursor: not-allowed; }
.kw-field { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; border-top: .5px solid var(--kw-border); }
.kw-field__label { color: var(--kw-text); font-size: 14px; line-height: 22px; }
.kw-textarea { width: 100%; box-sizing: border-box; min-height: 64px; padding: 10px 12px; font: inherit; font-size: 14px; line-height: 22px; color: var(--kw-text); background: var(--kw-bg); border: 1px solid var(--kw-border-strong); border-radius: var(--kw-radius-sm); resize: vertical; }
.kw-textarea:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.kw-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 4px; }
.kw-btn { height: 36px; padding: 0 14px; font: inherit; font-size: 14px; line-height: 22px; border-radius: var(--kw-radius-sm); border: 1px solid var(--kw-border-strong); background: transparent; color: var(--kw-text); cursor: pointer; transition: background .15s, border-color .15s; }
.kw-btn:hover { background: var(--kw-hover); }
.kw-btn--primary { background: var(--kw-accent); border-color: var(--kw-accent); color: var(--dsw-alias-bg-base); }
.kw-btn--primary:hover { background: var(--kw-accent-deep); border-color: var(--kw-accent-deep); }
.kw-btn:disabled { opacity: .5; cursor: not-allowed; }
.kw-status { font-size: 12px; line-height: 18px; color: var(--kw-text-dim); }
.kw-status--error { color: var(--kw-danger); }
.kw-skeleton { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; }
.kw-skeleton__row { height: 16px; border-radius: var(--kw-radius-sm); background: var(--kw-skeleton); }
.kw-switch { position: relative; display: inline-flex; align-items: center; cursor: pointer; }
.kw-switch input[type="checkbox"] { position: absolute; opacity: 0; width: 0; height: 0; }
.kw-switch__track { position: relative; flex: none; width: 34px; height: 19px; box-sizing: border-box; border-radius: 999px; background: var(--kw-bg-muted); border: 1px solid var(--kw-border); transition: background .15s, border-color .15s; }
.kw-switch__thumb { position: absolute; top: 50%; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: var(--kw-text-dim); transform: translateY(-50%); transition: left .15s, background .15s; }
.kw-switch:hover .kw-switch__track { background: color-mix(in srgb, var(--kw-bg-muted) 88%, var(--kw-text)); }
.kw-switch input[type="checkbox"]:checked + .kw-switch__track { background: var(--kw-accent); border-color: var(--kw-accent); }
.kw-switch input[type="checkbox"]:checked + .kw-switch__track .kw-switch__thumb { left: 17px; background: var(--kw-bg); }
.kw-switch input[type="checkbox"]:focus-visible + .kw-switch__track { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.kw-switch input[type="checkbox"]:disabled + .kw-switch__track { opacity: .5; cursor: not-allowed; }
@media (max-width: 640px) {
  .kw-card { padding: 16px; }
  .kw-row { grid-template-columns: 1fr; gap: 8px; }
  .kw-row__control { justify-content: flex-start; }
}
`

    /** 布尔项:label 包裹视觉隐藏的 checkbox 与胶囊轨道,规约要求的开关形态。 */
    const switchRow = (key, label, hint, value, onChange) =>
      React.createElement(
        'div',
        { className: 'kw-row', key },
        React.createElement(
          'div',
          { className: 'kw-row__text' },
          React.createElement('div', { className: 'kw-row__label' }, label),
          hint === undefined ? null : React.createElement('div', { className: 'kw-row__hint' }, hint),
        ),
        React.createElement(
          'div',
          { className: 'kw-row__control' },
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
        ),
      )

    /** 数值项:毫秒字段按秒显示,写回时换算;单位随字段类型固定展示。 */
    const numberRow = (key, label, hint, value, unitMs, onChange) =>
      React.createElement(
        'div',
        { className: 'kw-row', key },
        React.createElement(
          'div',
          { className: 'kw-row__text' },
          React.createElement('div', { className: 'kw-row__label' }, label),
          hint === undefined ? null : React.createElement('div', { className: 'kw-row__hint' }, hint),
        ),
        React.createElement(
          'div',
          { className: 'kw-row__control' },
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
          React.createElement('span', { className: 'kw-unit' }, unitMs ? '秒' : '次'),
        ),
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
        return React.createElement(
          'div',
          { className: 'kw-panel' },
          React.createElement(
            'div',
            { className: 'kw-head' },
            React.createElement('span', { className: 'kw-head__hint' }, status === '' ? '正在读取配置…' : status),
          ),
          React.createElement(
            'div',
            { className: 'kw-card' },
            React.createElement(
              'div',
              { className: 'kw-skeleton', 'aria-busy': 'true' },
              [0, 1, 2].map((index) => React.createElement('div', { className: 'kw-skeleton__row', key: index })),
            ),
          ),
        )
      }

      return React.createElement(
        'div',
        { className: 'kw-panel' },
        React.createElement(
          'div',
          { className: 'kw-head' },
          React.createElement('span', { className: 'kw-head__hint' }, HEAD_HINT),
        ),
        React.createElement(
          'div',
          { className: 'kw-card' },
          React.createElement('div', { className: 'kw-card__head' }, React.createElement('span', { className: 'kw-card__title' }, '总开关')),
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
          { className: 'kw-card' },
          React.createElement('div', { className: 'kw-card__head' }, React.createElement('span', { className: 'kw-card__title' }, '节奏')),
          numberRow(
            'graceMs',
            '等待时间',
            '回合结束后等多久再补发,留出用户插话的间隙',
            config.graceMs,
            true,
            (next) => patch('graceMs', next),
          ),
          numberRow(
            'cooldownMs',
            '连续补发后的冷却',
            '同一会话连续补发时,每次都按倍数拉长,这是起始值',
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
          { className: 'kw-card' },
          React.createElement('div', { className: 'kw-card__head' }, React.createElement('span', { className: 'kw-card__title' }, '恢复项')),
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
          { className: 'kw-card' },
          React.createElement(
            'div',
            { className: 'kw-card__head' },
            React.createElement('span', { className: 'kw-card__title' }, '补发文案'),
            React.createElement('span', { className: 'kw-card__meta' }, '按触发原因分别配置'),
          ),
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
            { className: 'kw-btn kw-btn--primary', onClick: () => void save() },
            '保存',
          ),
          React.createElement('button', { className: 'kw-btn', onClick: reset }, '恢复默认'),
          React.createElement(
            'span',
            { className: failed ? 'kw-status kw-status--error' : 'kw-status', role: failed ? 'alert' : 'status' },
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
