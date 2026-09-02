// dsh-turn-notify Client 半区:轮询投影 + localStorage 认领 + 三通道发声。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 由 DSH client runtime 模块表解析。
// 认领锁/完成标记走 localStorage(非 secure context 也可用的唯一跨窗口原语)。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-turn-notify',
  factory(require) {
    const React = require('react')
    const { useState, useEffect } = React

    const POLL_MS = 2 * 1000
    const TOAST_MS = 6 * 1000
    const BLINK_MS = 1 * 1000
    // 系统通知测试延迟:浏览器对聚焦窗口抑制系统弹窗,倒计时供用户切出窗口
    const SYSTEM_TEST_DELAY_MS = 5 * 1000
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

    // 导航图标声明:交给 dsh-settings-nav-icons 统一渲染(本插件分区 → bell);
    // 该插件未就绪时入队,由其启动时排空
    const NAV_ICON = { '消息通知': 'bell' }
    if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
    else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
    else window.__navicIconQueue = [NAV_ICON]

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
    const KEY_TOAST = 'turn-notify:toast'
    const KEY_SYSTEM = 'turn-notify:system'
    // 轮询单例令牌:HMR/插件重载重建模块闭包时防轮询线程累积
    const KEY_POLL_TOKEN = 'turn-notify:polling'

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

    // 发声通道判定:与 core.mjs chooseChannels 行为一致,通道开关来自 localStorage,
    // 放入 LOGIC 段由 parity 测试保证双实现不漂移
    function chooseChannels(hasFocus, permission) {
      const quiet = hasFocus && localGet(KEY_DND) !== '0'
      const systemEnabled = localGet(KEY_SYSTEM) !== '0'
      return {
        toast: localGet(KEY_TOAST) !== '0',
        sound: !quiet,
        system: !quiet && systemEnabled && permission === 'granted',
        blink: !quiet && systemEnabled && permission !== 'granted',
      }
    }
    /* LOGIC-END */

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
        const channels = chooseChannels(document.hasFocus(), notificationPermission())
        const sound = resolveSound(unit.category, soundMapping, uploadedIds)
        if (channels.toast) showToast(unit)
        if (!channels.sound) continue
        playSound(sound).catch(() => {})
        if (channels.system) notifySystem(unit)
        else if (channels.blink && localGet(KEY_DEGRADE_HINT) !== '0') startTitleBlink()
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
      // window 级令牌:HMR 重建模块闭包后 running 归零,仅靠它无法防重复轮询
      if (running || window[KEY_POLL_TOKEN]) return
      running = true
      window[KEY_POLL_TOKEN] = true
      refreshSounds()
      // 定时器不阻止进程退出(浏览器无感,测试进程可自然收尾)
      const timer = setInterval(() => { void poll() }, POLL_MS)
      if (typeof timer.unref === 'function') timer.unref()
    }

    // ---- 设置面板 ----

    const PERMISSION_LABELS = { granted: '已授权', denied: '已拒绝', default: '未授权' }

    // 面板表单占位:GET config 返回前展示;webhookUrl 凭据不出主机,面板只见是否已配置
    const DEFAULT_CONFIG = {
      webhookConfigured: false,
      minTurnDurationMs: 5 * 1000,
      rootsOnly: true,
      enabled: Object.fromEntries(CATEGORIES.map((key) => [key, true])),
    }

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
      '.tn-fill { flex:1; min-width:200px; }',
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
      const [config, setConfig] = useState(DEFAULT_CONFIG)
      const [configLoaded, setConfigLoaded] = useState(false)
      const [urlDraft, setUrlDraft] = useState('')
      const [permission, setPermission] = useState(notificationPermission())

      useEffect(() => {
        start()
        api('/api/turn-notify/sounds').then((res) => setSounds(res.sounds || [])).catch(() => {})
        api('/api/turn-notify/config')
          .then((res) => { setConfig({ ...DEFAULT_CONFIG, ...res }); setConfigLoaded(true) })
          .catch(() => {})
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

      async function saveConfig() {
        if (!configLoaded) {
          patch('配置尚未加载,不能保存(刷新页面重试)', 'error')
          return
        }
        setBusy(true)
        setNotice(null)
        try {
          const raw = typeof config.minTurnDurationMs === 'string'
            ? config.minTurnDurationMs.trim()
            : String(config.minTurnDurationMs)
          if (raw.length === 0) throw new Error('碎轮过滤毫秒数不能为空')
          const trimmedUrl = urlDraft.trim()
          const patchBody = { minTurnDurationMs: Number(raw), rootsOnly: config.rootsOnly }
          // 只写语义:输入留空即保持现有 webhook 不变
          if (trimmedUrl.length > 0) patchBody.webhookUrl = trimmedUrl
          const res = await api('/api/turn-notify/config', { method: 'POST', body: JSON.stringify(patchBody) })
          setConfig({ ...DEFAULT_CONFIG, ...res })
          setUrlDraft('')
          patch('配置已保存,立即生效')
        } catch (error) {
          patch('保存失败:' + (error && error.message ? error.message : String(error)), 'error')
        } finally { setBusy(false) }
      }

      async function clearWebhook() {
        setBusy(true)
        setNotice(null)
        try {
          const res = await api('/api/turn-notify/config', { method: 'POST', body: JSON.stringify({ webhookUrl: '' }) })
          setConfig({ ...DEFAULT_CONFIG, ...res })
          setUrlDraft('')
          patch('webhook 已清除')
        } catch (error) {
          patch('清除失败:' + (error && error.message ? error.message : String(error)), 'error')
        } finally { setBusy(false) }
      }

      async function toggleCategory(category, checked) {
        try {
          const res = await api('/api/turn-notify/config', {
            method: 'POST',
            body: JSON.stringify({ enabled: { [category]: checked } }),
          })
          setConfig({ ...DEFAULT_CONFIG, ...res })
        } catch (error) {
          patch('开关失败:' + (error && error.message ? error.message : String(error)), 'error')
        }
      }

      async function requestPermission() {
        try {
          const next = await Notification.requestPermission()
          setPermission(next)
          patch(next === 'granted' ? '弹窗授权成功,失焦时将走系统弹窗' : '弹窗被拒,可在浏览器地址栏权限或系统设置中恢复', next === 'granted' ? 'ok' : 'error')
        } catch (error) {
          patch('授权失败:' + (error && error.message ? error.message : String(error)), 'error')
        }
      }

      // 页内通知通道单独测试:仅弹页内提示,不涉及声音与系统通知
      function testPageNotification() {
        showToast({ id: 'ui-test', text: '[dsh] 页内通知测试' })
        patch('页内通知已发送')
      }

      // 系统通知通道单独测试:浏览器对聚焦窗口抑制系统弹窗,延迟发送模拟真实场景
      // (真实链路里系统通知只在用户切出窗口后触发),到点按窗口状态如实报告
      function testSystemNotification() {
        const current = notificationPermission()
        if (current === 'default') {
          void requestPermission()
          return
        }
        if (current !== 'granted') {
          patch('Notification 不可用或已被拒(HTTP 非回环或曾拒绝),已自动降级', 'error')
          return
        }
        patch('请在 ' + Math.round(SYSTEM_TEST_DELAY_MS / 1000) + ' 秒内切出本窗口,随后到达的才是系统通知')
        setTimeout(() => {
          notifySystem({ id: 'ui-test', text: '[dsh] 测试系统通知', category: 'completed' })
          if (document.hasFocus()) {
            patch('已发送,但窗口仍聚焦,浏览器会抑制弹窗;请切出窗口后重新测试', 'error')
          } else {
            patch('系统通知已送达,请查看屏幕右下角 / Windows 通知中心')
          }
        }, SYSTEM_TEST_DELAY_MS)
      }

      async function testWebhook() {
        if (urlDraft.trim().length > 0) {
          patch('表单中的新 webhook URL 尚未保存,本次测试的是已保存配置;请先保存再测试', 'error')
          return
        }
        try {
          const result = await api('/api/turn-notify/test-webhook', { method: 'POST' })
          patch(result.ok ? 'webhook 已送达(' + result.detail + ')' : 'webhook 发送失败:' + result.detail, result.ok ? 'ok' : 'error')
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
          h('span', { className: 'tn-head__title' }, '消息通知'),
          h('span', { className: 'tn-head__hint' }, 'webhook 与分类开关在此配置,存 host 热生效;此处同时管理音效与测试'),
        ),
        notice !== null ? h('div', { className: 'tn-notice' + (notice.kind === 'error' ? ' tn-error' : '') }, notice.text) : null,
        h('div', { className: 'tn-card' },
          h('span', { className: 'tn-card__title' }, '通知配置(标签页全关时仅 webhook 送达)'),
          h('div', { className: 'tn-row' },
            h('span', { className: 'tn-meta' }, 'webhook'),
            h('input', {
              className: 'tn-input tn-fill', type: 'text',
              placeholder: config.webhookConfigured ? '已配置(输入新 URL 替换,留空保持不变)' : 'Slack-compatible URL,留空禁用',
              value: urlDraft,
              onChange: (e) => setUrlDraft(e.target.value),
            }),
            config.webhookConfigured
              ? h('button', { className: 'tn-btn', disabled: busy, onClick: () => void clearWebhook() }, '清除')
              : null,
          ),
          h('div', { className: 'tn-row' },
            h('span', { className: 'tn-meta' }, '碎轮过滤'),
            h('input', {
              className: 'tn-input', type: 'number', min: 0, step: 500,
              value: config.minTurnDurationMs,
              onChange: (e) => setConfig({ ...config, minTurnDurationMs: e.target.value }),
            }),
            h('span', { className: 'tn-meta' }, '毫秒(仅 turn/end 类)'),
            h('label', { className: 'tn-meta' },
              h('input', {
                type: 'checkbox', checked: config.rootsOnly,
                onChange: (e) => setConfig({ ...config, rootsOnly: e.target.checked }),
              }),
              ' 子代理会话不通知'),
            h('span', { className: 'tn-spacer' }),
            h('button', { className: 'tn-btn', disabled: busy, onClick: () => void saveConfig() }, '保存'),
          ),
          h('div', { className: 'tn-row' },
            CATEGORIES.map((category) => h('label', { className: 'tn-meta', key: category },
              h('input', {
                type: 'checkbox', checked: config.enabled[category],
                onChange: (e) => void toggleCategory(category, e.target.checked),
              }),
              ' ' + CATEGORY_LABELS[category],
            ))),
        ),
        h('div', { className: 'tn-card' },
          h('span', { className: 'tn-card__title' }, '测试'),
          h('div', { className: 'tn-row' },
            h('button', { className: 'tn-btn', onClick: () => previewBuiltin(DEFAULT_TONES.completed) }, '测试声音'),
            h('button', { className: 'tn-btn', onClick: testPageNotification }, '测试页内通知'),
            h('button', { className: 'tn-btn', onClick: testSystemNotification }, '测试系统通知'),
            h('button', { className: 'tn-btn', onClick: () => void testWebhook() }, '测试 webhook'),
          ),
        ),
        h('div', { className: 'tn-card' },
          h('span', { className: 'tn-card__title' }, '本机偏好(存浏览器)'),
          h('div', { className: 'tn-row' },
            h('span', { className: 'tn-meta' }, '系统弹窗'),
            h('label', { className: 'tn-meta' },
              h('input', {
                type: 'checkbox', defaultChecked: localGet(KEY_SYSTEM) !== '0',
                onChange: (e) => localSet(KEY_SYSTEM, e.target.checked ? '1' : '0'),
              }),
              ' 开启'),
            h('span', { className: 'tn-meta' }, '权限: '
              + (typeof Notification === 'undefined' ? '不可用(非安全上下文)' : PERMISSION_LABELS[permission] || permission)),
            typeof Notification !== 'undefined' && permission === 'default'
              ? h('button', { className: 'tn-btn', onClick: () => void requestPermission() }, '授权')
              : null,
          ),
          h('div', { className: 'tn-row' },
            h('span', { className: 'tn-meta' }, '页内提示'),
            h('label', { className: 'tn-meta' },
              h('input', {
                type: 'checkbox', defaultChecked: localGet(KEY_TOAST) !== '0',
                onChange: (e) => localSet(KEY_TOAST, e.target.checked ? '1' : '0'),
              }),
              ' 开启'),
          ),
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
        // 激活即轮询:通知链路不依赖设置面板是否打开过
        start()
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'turn-notify', order: 41, label: '消息通知' },
            () => React.createElement(TurnNotifyApp),
          ))
      },
      // 测试钩子:供全链路集成测试注入 stub 后取内部函数,生产无消费方
      __test: { poll, pollOnce, storageState, announcedIds },
    }
  },
})
