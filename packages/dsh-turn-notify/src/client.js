// dsh-turn-notify Client 半区:轮询投影 + localStorage 认领 + 三通道发声。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 由 DSH client runtime 模块表解析。
// 认领锁/完成标记走 localStorage(非 secure context 也可用的唯一跨窗口原语)。

window.__ModuleLoader__.load({
  id: 'dsh-turn-notify',
  factory(require) {
    const React = require('react')
    const { useState, useEffect } = React

    const POLL_MS = 2 * 1000
    const TOAST_MS = 6 * 1000
    const BLINK_MS = 1 * 1000
    const AUDIO_EXTS = ['wav', 'mp3', 'ogg']
    const MIME_BY_EXT = { wav: 'audio/wav', ogg: 'audio/ogg', mp3: 'audio/mpeg' }

    const CATEGORY_LABELS = {
      completed: '任务完成',
      error: '任务出错',
      interrupted: '被中断',
      approval: '等待审批',
      ask: 'AI 提问',
      'max-tokens': '达到上限',
    }
    const CATEGORIES = Object.keys(CATEGORY_LABELS)

    // 内置合成音音色表:波形 + 音符序列(频率 Hz / 时长),零音频文件。
    const TONES = {
      'up-arpeggio': { type: 'sine', notes: [[523.25, 0.12], [659.25, 0.12], [783.99, 0.2]] },
      bell: { type: 'sine', notes: [[880, 0.5], [1174.66, 0.7]] },
      duo: { type: 'triangle', notes: [[659.25, 0.12], [987.77, 0.2]] },
      'alarm-square': { type: 'square', notes: [[440, 0.15], [329.63, 0.15], [440, 0.15], [329.63, 0.15]] },
      'low-hum': { type: 'sine', notes: [[110, 0.6]] },
      'double-ping': { type: 'sine', notes: [[987.77, 0.1], [1318.51, 0.25]] },
      tick: { type: 'square', notes: [[1567.98, 0.04], [1567.98, 0.04]] },
      'down-slide': { type: 'sawtooth', notes: [[392, 0.15], [311.13, 0.15], [233.08, 0.3]] },
    }
    const TONE_LABELS = {
      'up-arpeggio': '上行琶音', bell: '铃铛', duo: '清脆双音', 'alarm-square': '警报方波',
      'low-hum': '低鸣', 'double-ping': '双音提示', tick: '嘀嗒', 'down-slide': '低音下滑',
    }
    /* LOGIC-BEGIN */
    // 纯逻辑段:与 src/core.mjs 保持行为一致,由 parity 测试保证。
    // localStorage 不可用时认领退化为"本窗口直接发声",状态记录在 storageState。

    const DEFAULT_TONES = {
      completed: 'up-arpeggio', error: 'alarm-square', interrupted: 'alarm-square',
      approval: 'double-ping', ask: 'double-ping', 'max-tokens': 'down-slide',
    }

    const CLAIM_LOCK_TTL_MS = 30 * 1000

    const KEY_WID = 'turn-notify:wid'
    const KEY_LOCK = 'turn-notify:lock:'
    const KEY_DONE = 'turn-notify:done:'
    const KEY_DND = 'turn-notify:dnd'
    const KEY_VOLUME = 'turn-notify:volume'
    const KEY_DEGRADE_HINT = 'turn-notify:degrade-hint'

    const storageState = { broken: false }

    // 诚实降级:降级路径至少提示一次,后续静默
    let degradeAnnounced = false
    function announceDegrade(reason) {
      if (degradeAnnounced) return
      degradeAnnounced = true
      console.warn('[dsh-turn-notify] 通知降级,本窗口直接发声: ' + reason)
    }

    // 降级发声去重:同一事件只发一次;过期按投影窗口清理,防 Map 无界增长
    const ANNOUNCED_TTL_MS = 60 * 1000
    const announcedIds = new Map()
    function announcedOnce(id, now) {
      for (const [key, at] of announcedIds) {
        if (now - at >= ANNOUNCED_TTL_MS) announcedIds.delete(key)
      }
      if (announcedIds.has(id)) return false
      announcedIds.set(id, now)
      return true
    }

    const localGet = (key) => {
      try {
        return window.localStorage.getItem(key)
      } catch {
        storageState.broken = true
        return null
      }
    }
    const localSet = (key, value) => {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        storageState.broken = true
      }
    }
    const localDel = (key) => {
      try {
        window.localStorage.removeItem(key)
      } catch {
        storageState.broken = true
      }
    }

    function windowId() {
      let wid = localGet(KEY_WID)
      if (wid === null) {
        wid = 'w-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000000).toString(36)
        localSet(KEY_WID, wid)
      }
      return wid
    }

    // 认领读阶段决策:done 终态 / 他锁跳过 / 过期接管 / 自锁或无锁认领
    function decideClaim(stored, done, now, wid) {
      if (done !== null) return 'done'
      let lock = null
      try { lock = stored === null ? null : JSON.parse(stored) } catch { lock = null }
      if (lock === null || typeof lock !== 'object' || typeof lock.at !== 'number' || typeof lock.wid !== 'string') {
        return stored === null ? 'claim' : 'takeover'
      }
      if (now - lock.at >= CLAIM_LOCK_TTL_MS) return 'takeover'
      return lock.wid === wid ? 'claim' : 'skip'
    }

    // 写后读回确认,非自己则放弃,通过者为唯一发声窗口
    function claimEvent(id) {
      const wid = windowId()
      const now = Date.now()
      const stored = localGet(KEY_LOCK + id)
      const done = localGet(KEY_DONE + id)
      // 存储不可用:无锁可依,退化为本窗口直接发声(诚实降级,可能多窗口重复);
      // 投影窗口内同一事件只发一次
      if (storageState.broken) {
        if (!announcedOnce(id, now)) return false
        announceDegrade('localStorage 不可用')
        return true
      }
      const verdict = decideClaim(stored, done, now, wid)
      if (verdict === 'done' || verdict === 'skip') return false
      localSet(KEY_LOCK + id, JSON.stringify({ wid, at: now }))
      const confirmed = JSON.parse(localGet(KEY_LOCK + id))
      return confirmed !== null && confirmed.wid === wid
    }

    function markDone(id) { localSet(KEY_DONE + id, '1') }

    // 分类音效解析:映射命中已上传 id 用自定义,否则回落内置默认
    function resolveSound(category, mapping, uploadedIds) {
      const wanted = (mapping || {})[category]
      if (typeof wanted === 'string' && wanted.length > 0 && uploadedIds.indexOf(wanted) >= 0) return { kind: 'custom', id: wanted }
      return { kind: 'builtin', name: DEFAULT_TONES[category] }
    }
    /* LOGIC-END */

    function choosePresentation(hasFocus, permission) {
      // 聚焦静默可关(免打扰规则),关闭后聚焦窗口照常发声弹窗
      if (hasFocus && localGet(KEY_DND) !== '0') return 'toast'
      return permission === 'granted' ? 'full' : 'fallback'
    }

    // ---- 声音:Web Audio,autoplay 解锁依赖首次用户交互,解锁前静默 ----

    let audioCtx = null
    const decodedCache = new Map()

    function ensureAudioCtx() {
      if (audioCtx === null) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
      return audioCtx
    }
    // 首次交互解锁:解锁前静默不视为故障
    window.addEventListener('pointerdown', () => { ensureAudioCtx() }, { once: true })

    function volume() {
      const stored = Number(localGet(KEY_VOLUME))
      return stored >= 0 && stored <= 1 ? stored : 0.6
    }

    function playTone(ctx2, spec) {
      const master = ctx2.createGain()
      master.gain.value = volume()
      master.connect(ctx2.destination)
      let at = ctx2.currentTime
      for (const [freq, dur] of spec.notes) {
        const osc = ctx2.createOscillator()
        const gain = ctx2.createGain()
        osc.type = spec.type
        osc.frequency.value = freq
        gain.gain.setValueAtTime(1, at)
        gain.gain.exponentialRampToValueAtTime(0.001, at + dur)
        osc.connect(gain)
        gain.connect(master)
        osc.start(at)
        osc.stop(at + dur)
        at += dur
      }
    }

    async function playSound(sound) {
      if (sound.kind === 'builtin') {
        const spec = TONES[sound.name]
        if (spec) playTone(ensureAudioCtx(), spec)
        return
      }
      const ctx2 = ensureAudioCtx()
      let buffer = decodedCache.get(sound.id)
      if (buffer === undefined) {
        const response = await fetch('/api/turn-notify/sound?id=' + encodeURIComponent(sound.id))
        if (!response.ok) return
        buffer = await ctx2.decodeAudioData(await response.arrayBuffer())
        decodedCache.set(sound.id, buffer)
      }
      const source = ctx2.createBufferSource()
      const master = ctx2.createGain()
      master.gain.value = volume()
      source.buffer = buffer
      source.connect(master)
      master.connect(ctx2.destination)
      source.start()
    }

    function previewBuiltin(name) { playTone(ensureAudioCtx(), TONES[name]) }

    // ---- toast 与标题闪烁 ----

    function showToast(unit) {
      const node = document.createElement('div')
      node.textContent = unit.text
      Object.assign(node.style, {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: 9999,
        background: 'rgba(22,24,28,0.94)', color: '#f0f1f3', fontSize: '13px',
        padding: '10px 14px', borderRadius: '10px', boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
      })
      document.body.appendChild(node)
      setTimeout(() => { node.remove() }, TOAST_MS)
    }

    let blinkTimer = null
    const baseTitle = () => document.title.replace(/^⏳ /, '')

    function startTitleBlink() {
      if (blinkTimer !== null) return
      blinkTimer = setInterval(() => {
        document.title = document.title.startsWith('⏳ ') ? baseTitle() : '⏳ ' + baseTitle()
      }, BLINK_MS)
      setTimeout(stopTitleBlink, TOAST_MS)
    }

    function stopTitleBlink() {
      if (blinkTimer === null) return
      clearInterval(blinkTimer)
      blinkTimer = null
      document.title = baseTitle()
    }

    const notificationPermission = () => (typeof Notification === 'undefined' ? 'denied' : Notification.permission)

    function notifySystem(unit) {
      try {
        new Notification(unit.text, { tag: unit.id })
      } catch { /* 弹窗失败降级 toast,已在链路内 */ }
    }

    // ---- 投影轮询与认领 ----

    let soundMapping = {}
    let uploadedIds = []
    let running = false

    async function poll() {
      try {
        await pollOnce()
        degradeAnnounced = false
      } catch (error) {
        announceDegrade(error && error.message ? error.message : String(error))
      }
    }

    async function pollOnce() {
      let payload
      try {
        const response = await fetch('/api/turn-notify/projection')
        payload = await response.json()
      } catch { return }
      soundMapping = payload.soundMapping || {}
      const units = payload.units || []
      const liveIds = new Set(units.map((unit) => unit.id))
      // 投影中已过期的本地残留清理,防旧锁与完成标记滞留;
      // 访问失败即标记 broken 并整段跳过,防抛出被外层吞掉、发声链路失效
      try {
        for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
          const key = window.localStorage.key(index)
          if (key === null || (key.indexOf(KEY_LOCK) !== 0 && key.indexOf(KEY_DONE) !== 0)) continue
          const id = key.indexOf(KEY_LOCK) === 0 ? key.slice(KEY_LOCK.length) : key.slice(KEY_DONE.length)
          if (!liveIds.has(id)) localDel(key)
        }
      } catch {
        storageState.broken = true
      }
      for (const unit of units) {
        if (!claimEvent(unit.id)) continue
        markDone(unit.id)
        const mode = choosePresentation(document.hasFocus(), notificationPermission())
        const sound = resolveSound(unit.category, soundMapping, uploadedIds)
        showToast(unit)
        if (mode === 'toast') continue
        playSound(sound).catch(() => {})
        if (mode === 'full') notifySystem(unit)
        else if (localGet(KEY_DEGRADE_HINT) !== '0') startTitleBlink()
      }
    }

    async function refreshSounds() {
      try {
        const response = await fetch('/api/turn-notify/sounds')
        const payload = await response.json()
        uploadedIds = (payload.sounds || []).map((sound) => sound.id)
      } catch { uploadedIds = [] }
    }

    function start() {
      if (running) return
      running = true
      refreshSounds()
      setInterval(() => { void poll() }, POLL_MS)
    }

    // ---- 设置面板 ----

    const CSS = [
      '.tn-panel { display:flex; flex-direction:column; gap:12px; color:inherit; font-size:13px; }',
      '.tn-head { display:flex; align-items:center; gap:8px; }',
      '.tn-head__title { font-weight:600; font-size:14px; }',
      '.tn-head__hint { color:var(--dsw-alias-label-secondary); font-size:12px; }',
      '.tn-btn { cursor:pointer; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); background:transparent;',
      '  color:inherit; border-radius:6px; padding:3px 10px; font-size:12px; }',
      '.tn-btn:hover { opacity:0.8; }',
      '.tn-card { border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); border-radius:10px; padding:10px 12px;',
      '  display:flex; flex-direction:column; gap:6px; }',
      '.tn-card__title { font-weight:600; font-size:12px; color:var(--dsw-alias-label-secondary); }',
      '.tn-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }',
      '.tn-spacer { flex:1; }',
      '.tn-meta { color:var(--dsw-alias-label-secondary); font-size:12px; }',
      '.tn-error { color:var(--dsw-alias-state-error-primary, #d43a3a); font-size:12px; }',
      '.tn-select, .tn-input { background:transparent; color:inherit; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35));',
      '  border-radius:6px; padding:2px 6px; font-size:12px; font-family:inherit; }',
      '.tn-notice { font-size:12px; padding:4px 8px; border-radius:6px; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); }',
    ].join('\n')

    function h(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props || null].concat(children))
    }

    async function api(path, options) {
      const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
      return payload
    }

    function TurnNotifyApp() {
      const [sounds, setSounds] = useState([])
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        start()
        api('/api/turn-notify/sounds').then((res) => setSounds(res.sounds || [])).catch(() => {})
      }, [])

      const patch = (text, kind) => setNotice({ text, kind: kind || 'ok' })

      async function upload(file) {
        setBusy(true)
        setNotice(null)
        try {
          // 入库前双重校验的浏览器半区:decodeAudioData 解码失败即拒绝
          const raw = await file.arrayBuffer()
          await ensureAudioCtx().decodeAudioData(raw.slice(0))
          const ext = (/\.([^.]+)$/.exec(file.name) || [])[1]?.toLowerCase() || ''
          if (AUDIO_EXTS.indexOf(ext) < 0) throw new Error('仅支持 ' + AUDIO_EXTS.join(' / '))
          await api('/api/turn-notify/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: raw })
          const res = await api('/api/turn-notify/sounds')
          setSounds(res.sounds || [])
          await refreshSounds()
          patch('已上传')
        } catch (error) {
          patch('上传被拒绝:' + (error && error.message ? error.message : String(error)), 'error')
        } finally { setBusy(false) }
      }

      async function removeSound(sound) {
        setBusy(true)
        try {
          await api('/api/turn-notify/sound?id=' + encodeURIComponent(sound.id), { method: 'DELETE' })
          const res = await api('/api/turn-notify/sounds')
          setSounds(res.sounds || [])
          await refreshSounds()
          decodedCache.delete(sound.id)
          patch('已删除,引用该音效的分类已回落内置默认')
        } catch (error) {
          patch('删除失败:' + (error && error.message ? error.message : String(error)), 'error')
        } finally { setBusy(false) }
      }

      async function setMapping(category, id) {
        try {
          await api('/api/turn-notify/mapping', { method: 'POST', body: JSON.stringify({ category, id }) })
          patch(CATEGORY_LABELS[category] + ' 音效已更新')
        } catch (error) {
          patch('映射失败:' + (error && error.message ? error.message : String(error)), 'error')
        }
      }

      function testNotification() {
        const permission = notificationPermission()
        if (permission === 'default') {
          Notification.requestPermission().then((next) => {
            patch(next === 'granted' ? '弹窗授权成功' : '弹窗被拒,失焦时将以 toast + 标题闪烁降级', next === 'granted' ? 'ok' : 'error')
          })
          return
        }
        if (permission === 'granted') {
          notifySystem({ id: 'ui-test', text: '[dsh] 测试系统弹窗', category: 'completed' })
          patch('测试弹窗已发送')
          return
        }
        patch('Notification 不可用(HTTP 非回环),已自动降级', 'error')
      }

      async function testWebhook() {
        try {
          await api('/api/turn-notify/test-webhook', { method: 'POST' })
          patch('测试 webhook 已代发,请查收端点')
        } catch (error) {
          patch('发送失败:' + (error && error.message ? error.message : String(error)), 'error')
        }
      }

      const mapping = soundMapping
      const soundOptions = [h('option', { key: '', value: '' }, '内置默认')].concat(
        Object.keys(TONE_LABELS).map((name) => h('option', { key: name, value: name }, '内置 · ' + TONE_LABELS[name])),
      ).concat(sounds.map((sound) => h('option', { key: sound.id, value: sound.id }, '上传 · ' + sound.id)))

      return h('div', { className: 'tn-panel' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'tn-head' },
          h('span', { className: 'tn-head__title' }, '回合通知'),
          h('span', { className: 'tn-head__hint' }, 'webhook / 分类开关在 settings.yaml;此处管理音效与测试'),
        ),
        notice !== null ? h('div', { className: 'tn-notice' + (notice.kind === 'error' ? ' tn-error' : '') }, notice.text) : null,
        h('div', { className: 'tn-card' },
          h('span', { className: 'tn-card__title' }, '测试'),
          h('div', { className: 'tn-row' },
            h('button', { className: 'tn-btn', onClick: () => previewBuiltin(DEFAULT_TONES.completed) }, '测试声音'),
            h('button', { className: 'tn-btn', onClick: testNotification }, '测试弹窗'),
            h('button', { className: 'tn-btn', onClick: testWebhook }, '测试 webhook'),
          ),
        ),
        h('div', { className: 'tn-card' },
          h('span', { className: 'tn-card__title' }, '本机偏好(存浏览器)'),
          h('div', { className: 'tn-row' },
            h('span', { className: 'tn-meta' }, '音量'),
            h('input', {
              type: 'range', min: 0, max: 1, step: 0.05, defaultValue: volume(),
              onChange: (e) => localSet(KEY_VOLUME, e.target.value),
            }),
            h('label', { className: 'tn-meta' },
              h('input', {
                type: 'checkbox', defaultChecked: localGet(KEY_DND) !== '0',
                onChange: (e) => localSet(KEY_DND, e.target.checked ? '1' : '0'),
              }),
              ' 聚焦静默'),
            h('label', { className: 'tn-meta' },
              h('input', {
                type: 'checkbox', defaultChecked: localGet(KEY_DEGRADE_HINT) !== '0',
                onChange: (e) => localSet(KEY_DEGRADE_HINT, e.target.checked ? '1' : '0'),
              }),
              ' 降级时标题闪烁'),
          ),
        ),
        h('div', { className: 'tn-card' },
          h('span', { className: 'tn-card__title' }, '音效管理(wav / mp3 / ogg,单文件上限 2MB)'),
          h('div', { className: 'tn-row' },
            h('input', {
              type: 'file', accept: AUDIO_EXTS.map((ext) => '.' + ext).join(','), disabled: busy,
              onChange: (e) => { const file = e.target.files && e.target.files[0]; if (file) void upload(file) },
            }),
          ),
          sounds.length === 0 ? h('span', { className: 'tn-meta' }, '暂无上传音效') :
            sounds.map((sound) => h('div', { className: 'tn-row', key: sound.id },
              h('span', { className: 'tn-meta' }, sound.id + '.' + sound.ext),
              h('button', {
                className: 'tn-btn',
                onClick: () => { playSound({ kind: 'custom', id: sound.id }).catch(() => {}) },
              }, '试听'),
              h('button', { className: 'tn-btn', disabled: busy, onClick: () => void removeSound(sound) }, '删除'),
            )),
        ),
        h('div', { className: 'tn-card' },
          h('span', { className: 'tn-card__title' }, '分类音效映射'),
          CATEGORIES.map((category) => h('div', { className: 'tn-row', key: category },
            h('span', { className: 'tn-meta' }, CATEGORY_LABELS[category]),
            h('select', {
              className: 'tn-select', value: mapping[category] || '',
              onChange: (e) => void setMapping(category, e.target.value),
            }, soundOptions),
          )),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'turn-notify', order: 41, label: '回合通知' },
            () => React.createElement(TurnNotifyApp),
          ))
      },
      // 测试钩子:供全链路集成测试注入 stub 后取内部函数,生产无消费方
      __test: { poll, pollOnce, storageState, announcedIds },
    }
  },
})
