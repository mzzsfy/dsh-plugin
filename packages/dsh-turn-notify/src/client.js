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
    // 显示回执等待上限:超时未回执按环境层拦截给出诊断
    const SYSTEM_SHOW_TIMEOUT_MS = 3 * 1000
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
    /* LOGIC-BEGIN */
    // 纯逻辑段:与 src/core.mjs 保持行为一致,由 parity 测试保证。
    // localStorage 不可用时认领退化为"本窗口直接发声",状态记录在 storageState。

    const TONE_LABELS = {
      'up-arpeggio': '上行琶音', bell: '铃铛', duo: '清脆双音', 'alarm-square': '警报方波',
      'low-hum': '低鸣', 'double-ping': '双音提示', tick: '嘀嗒', 'down-slide': '低音下滑',
    }

    const DEFAULT_TONES = {
      completed: 'up-arpeggio', error: 'alarm-square', interrupted: 'alarm-square',
      approval: 'double-ping', ask: 'double-ping', 'max-tokens': 'down-slide',
    }

    const CLAIM_LOCK_TTL_MS = 30 * 1000

    // 未显式设置音量时的默认值。
    const DEFAULT_VOLUME = 0.6

    // 音量解析:未设置或非法回落默认,显式零(静音)保留。
    function parseVolume(raw) {
      if (raw === null || raw === undefined) return DEFAULT_VOLUME
      const value = Number(raw)
      return value >= 0 && value <= 1 ? value : DEFAULT_VOLUME
    }

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

    // 分类音效解析:映射命中已上传 id 用自定义,指向内置音名用该内置,否则回落内置默认
    function resolveSound(category, mapping, uploadedIds) {
      const wanted = (mapping || {})[category]
      if (typeof wanted === 'string' && wanted.length > 0) {
        if (uploadedIds.indexOf(wanted) >= 0) return { kind: 'custom', id: wanted }
        if (Object.prototype.hasOwnProperty.call(TONE_LABELS, wanted)) return { kind: 'builtin', name: wanted }
      }
      return { kind: 'builtin', name: DEFAULT_TONES[category] }
    }

    // 发声通道判定:与 core.mjs chooseChannels 行为一致,通道开关来自 localStorage,
    // 放入 LOGIC 段由 parity 测试保证双实现不漂移
    const IDLE_AWAY_MS = 5 * 60 * 1000

    function chooseChannels(hasFocus, permission, idleMs) {
      const idleAway = typeof idleMs === 'number' && idleMs >= IDLE_AWAY_MS
      const quiet = hasFocus && localGet(KEY_DND) !== '0' && !idleAway
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
      // resume 仅触发不等待(通知链路 fire-and-forget);手动播放由 ensureRunnableCtx 等待并给可见反馈
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
      return audioCtx
    }
    // 首次交互解锁:解锁前静默不视为故障
    window.addEventListener('pointerdown', () => { ensureAudioCtx() }, { once: true })

    // 用户行动时刻:空闲满阈值视为离开,聚焦静默不再适用;
    // handler 挂 window 共享并按标记幂等注册,防模块重载后监听累积
    if (!window.__tnActionHandler) {
      window.__tnLastActionAt = Date.now()
      window.__tnActionHandler = () => { window.__tnLastActionAt = Date.now() }
      for (const type of ['pointerdown', 'keydown', 'mousemove', 'wheel']) {
        window.addEventListener(type, window.__tnActionHandler)
      }
    }
    const lastActionAt = () => window.__tnLastActionAt ?? Date.now()

    function volume() { return parseVolume(localGet(KEY_VOLUME)) }

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

    function playBuffer(ctx2, buffer) {
      const source = ctx2.createBufferSource()
      const master = ctx2.createGain()
      master.gain.value = volume()
      source.buffer = buffer
      source.connect(master)
      master.connect(ctx2.destination)
      source.start()
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
        if (!response.ok) throw new Error('读取音效失败: HTTP ' + response.status)
        buffer = await ctx2.decodeAudioData(await response.arrayBuffer())
        decodedCache.set(sound.id, buffer)
      }
      playBuffer(ctx2, buffer)
    }

    // resume 等待上限:部分环境挂起态的 resume 永不 resolve,超时后按不可播报告
    const AUDIO_RESUME_WAIT_MS = 300

    // 手动播放前置检查:等待浏览器放行,音量为零或通道仍挂起时给出可见原因
    async function ensureRunnableCtx() {
      const ctx2 = ensureAudioCtx()
      if (ctx2.state === 'suspended') {
        try {
          await Promise.race([
            ctx2.resume(),
            new Promise((resolve) => { setTimeout(resolve, AUDIO_RESUME_WAIT_MS) }),
          ])
        } catch { }
      }
      return ctx2
    }

    function playbackBlockReason(ctx2) {
      if (ctx2.state !== 'running') return '浏览器未放行音频播放,请重试或检查浏览器自动播放设置'
      if (volume() === 0) return '当前音量为 0,请在本机偏好中调高'
      return null
    }

    // 手动播放前置:等待浏览器放行;任何异常转为可见的受阻原因,调用方无需兜 catch
    async function playableCtx() {
      try {
        const ctx2 = await ensureRunnableCtx()
        return { blocked: playbackBlockReason(ctx2), ctx2 }
      } catch (error) {
        return { blocked: error && error.message ? error.message : String(error) }
      }
    }

    // 手动播放统一出口:失败原因可见,不再无声无息
    async function playAudible(sound) {
      const pre = await playableCtx()
      if (pre.blocked) return { ok: false, reason: pre.blocked }
      try {
        await playSound(sound)
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: error && error.message ? error.message : String(error) }
      }
    }

    // 待确认音效试听:直接解码内存 buffer,不经服务器;失败带原因返回
    async function previewPending(raw) {
      const pre = await playableCtx()
      if (pre.blocked) return { ok: false, reason: pre.blocked }
      try {
        const buffer = await pre.ctx2.decodeAudioData(raw.slice(0))
        playBuffer(pre.ctx2, buffer)
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: '音频解码失败: ' + (error && error.message ? error.message : String(error)) }
      }
    }

    async function previewBuiltin(name) {
      const pre = await playableCtx()
      if (pre.blocked) return { ok: false, reason: pre.blocked }
      const spec = TONES[name]
      if (!spec) return { ok: false, reason: '未知内置音: ' + name }
      try {
        playTone(pre.ctx2, spec)
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: error && error.message ? error.message : String(error) }
      }
    }

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

    // onOutcome 仅供测试路径取显示回执(onshow/onerror),真实路径吞错降级已在链路内
    function notifySystem(unit, onOutcome) {
      try {
        const notification = new Notification(unit.text, { tag: unit.id })
        if (typeof onOutcome === 'function') {
          notification.onshow = () => { onOutcome(true) }
          notification.onerror = () => { onOutcome(false) }
        }
      } catch {
        if (typeof onOutcome === 'function') onOutcome(false)
      }
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
        const channels = chooseChannels(document.hasFocus(), notificationPermission(), Date.now() - lastActionAt())
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

    // 面板表单占位:GET config 返回前展示;webhookUrl 凭据不出主机,面板只见是否已配置;
    // imAvailable 缺省为假,加载响应后 dsh-im 在场才渲染 IM 投递卡
    const DEFAULT_CONFIG = {
      webhookConfigured: false,
      minTurnDurationMs: 5 * 1000,
      rootsOnly: true,
      suppressSubagentWake: true,
      enabled: Object.fromEntries(CATEGORIES.map((key) => [key, true])),
      imTargets: [],
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
      // IM 投递:botId 草稿与当前加载到的目标目录(目录只在勾选时消费,不直接决定已选)
      const [imBotIdDraft, setImBotIdDraft] = useState('')
      const [imCatalog, setImCatalog] = useState(null)
      // 分类映射的受控 state:直接由写响应回填,不再依赖轮询变量驱动渲染
      const [mapping, setMappingState] = useState({})
      // 待确认上传:文件选中且解码校验通过后挂起,用户试听并确认才落盘
      const [pendingUploads, setPendingUploads] = useState([])

      useEffect(() => {
        start()
        api('/api/turn-notify/sounds').then((res) => setSounds(res.sounds || [])).catch(() => {})
        api('/api/turn-notify/config')
          .then((res) => {
            setConfig({ ...DEFAULT_CONFIG, ...res })
            setMappingState(res.soundMapping || {})
            setConfigLoaded(true)
          })
          .catch(() => {})
      }, [])

      const patch = (text, kind) => setNotice({ text, kind: kind || 'ok' })

      async function onPickFiles(files) {
        if (files.length === 0) return
        setBusy(true)
        setNotice(null)
        const accepted = []
        let rejected = 0
        let rejectReason = ''
        try {
          for (const file of files) {
            try {
              const ext = (/\.([^.]+)$/.exec(file.name) || [])[1]?.toLowerCase() || ''
              if (AUDIO_EXTS.indexOf(ext) < 0) throw new Error('仅支持 ' + AUDIO_EXTS.join(' / '))
              const raw = await file.arrayBuffer()
              // 入库前双重校验的浏览器半区:解码失败即拒绝;
              // 解码吃副本,原始 buffer 留给确认后的上传与试听
              await ensureAudioCtx().decodeAudioData(raw.slice(0))
              accepted.push({ name: file.name, raw })
            } catch (error) {
              rejected += 1
              rejectReason = error && error.message ? error.message : String(error)
            }
          }
        } finally { setBusy(false) }
        if (accepted.length > 0) setPendingUploads(pendingUploads.concat(accepted))
        if (rejected > 0) {
          patch(accepted.length + ' 个通过校验待确认,' + rejected + ' 个被拒(' + rejectReason + ')', accepted.length > 0 ? 'ok' : 'error')
        } else {
          patch(accepted.length + ' 个通过校验,试听后确认保存')
        }
      }

      async function savePending(item) {
        setBusy(true)
        setNotice(null)
        try {
          await api('/api/turn-notify/upload?name=' + encodeURIComponent(item.name), {
            method: 'POST',
            body: item.raw,
          })
          setPendingUploads(pendingUploads.filter((pending) => pending !== item))
          patch('已保存 ' + item.name)
        } catch (error) {
          patch('保存失败:' + (error && error.message ? error.message : String(error)), 'error')
        } finally { setBusy(false) }
        // 落盘成功的回执不因列表刷新失败而翻转为失败;列表暂旧由后续操作收敛
        try {
          const res = await api('/api/turn-notify/sounds')
          setSounds(res.sounds || [])
          await refreshSounds()
        } catch { }
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

      // 重命名编辑态:同一时刻至多一行处于编辑;提交成功后缓存按旧 id 失效
      const [renamingId, setRenamingId] = useState(null)
      const [renameDraft, setRenameDraft] = useState('')

      function startRename(sound) {
        setRenamingId(sound.id)
        setRenameDraft(sound.id)
      }

      function cancelRename() {
        setRenamingId(null)
        setRenameDraft('')
      }

      async function renameSound(sound) {
        setBusy(true)
        setNotice(null)
        try {
          const res = await api('/api/turn-notify/sound', { method: 'PUT', body: JSON.stringify({ id: sound.id, name: renameDraft }) })
          decodedCache.delete(sound.id)
          if (res.soundMapping) setMappingState(res.soundMapping)
          patch('已重命名为 ' + res.id)
          cancelRename()
        } catch (error) {
          patch('重命名失败:' + (error && error.message ? error.message : String(error)), 'error')
        } finally { setBusy(false) }
        // 改名成功的回执不因列表刷新失败而翻转为失败;列表暂旧由后续操作收敛
        try {
          const soundsRes = await api('/api/turn-notify/sounds')
          setSounds(soundsRes.sounds || [])
          await refreshSounds()
        } catch { }
      }

      async function setMapping(category, id) {
        try {
          const res = await api('/api/turn-notify/mapping', { method: 'POST', body: JSON.stringify({ category, id }) })
          setMappingState(res.soundMapping || {})
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
          // imTargets 由勾选单独即时保存,不随此入口提交
          const patchBody = { minTurnDurationMs: Number(raw), rootsOnly: config.rootsOnly, suppressSubagentWake: config.suppressSubagentWake }
          // 只写语义:输入留空即保持现有 webhook 不变
          if (trimmedUrl.length > 0) patchBody.webhookUrl = trimmedUrl
          const res = await api('/api/turn-notify/config', { method: 'POST', body: JSON.stringify(patchBody) })
          setConfig({ ...DEFAULT_CONFIG, ...res })
          if (res.soundMapping) setMappingState(res.soundMapping)
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
          if (res.soundMapping) setMappingState(res.soundMapping)
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
          if (res.soundMapping) setMappingState(res.soundMapping)
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
      // (真实链路里系统通知只在用户切出窗口后触发);依据浏览器显示回执与
      // 超时兜底给出诊断,环境层拦截(系统通知设置/专注助手)在此显性化
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
          const focused = document.hasFocus()
          let reported = false
          notifySystem({ id: 'ui-test', text: '[dsh] 测试系统通知', category: 'completed' }, (shown) => {
            reported = true
            if (focused) return
            patch(shown ? '系统通知已显示,浏览器确认送达' : '系统通知显示失败(浏览器报告错误)', shown ? 'ok' : 'error')
          })
          if (focused) {
            patch('已发送,但窗口仍聚焦,浏览器会抑制弹窗;请切出窗口后重新测试', 'error')
            return
          }
          setTimeout(() => {
            if (reported) return
            patch('未收到浏览器显示回执:请检查 Windows 设置 > 通知 中浏览器的通知权限,以及专注助手 / 勿扰是否拦截', 'error')
          }, SYSTEM_SHOW_TIMEOUT_MS)
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

      // IM 目标加载:目录来自 dsh-im 已保存目标;失败(离线/ID 复制错误)如实展示错误码
      async function loadImTargets() {
        const botId = imBotIdDraft.trim()
        if (botId.length === 0) {
          patch('请先粘贴 Bot ID(设置页 IM机器人 卡片右上角齿轮)', 'error')
          return
        }
        setBusy(true)
        setNotice(null)
        try {
          const res = await api('/api/turn-notify/im-targets?botId=' + encodeURIComponent(botId))
          setImCatalog({ botId, targets: res.targets || [] })
          patch('已加载 ' + (res.targets || []).length + ' 个目标,勾选即保存')
        } catch (error) {
          patch('加载失败:' + (error && error.message ? error.message : String(error)), 'error')
        } finally { setBusy(false) }
      }

      // botId/targetId 字符集均不含 '/',拼接键无歧义;与 host 侧写入校验共用 dsh-im ID 规格
      const imTargetKey = (item) => item.botId + '/' + item.targetId

      // 勾选即存:与分类开关同模式,列表整体替换,连续操作以最新一次请求为准
      let imPersistSeq = 0
      async function persistImTargets(next) {
        const seq = ++imPersistSeq
        setConfig({ ...config, imTargets: next })
        try {
          const res = await api('/api/turn-notify/config', { method: 'POST', body: JSON.stringify({ imTargets: next }) })
          if (seq === imPersistSeq) {
            setConfig({ ...DEFAULT_CONFIG, ...res })
            if (res.soundMapping) setMappingState(res.soundMapping)
          }
        } catch (error) {
          patch('IM 目标保存失败:' + (error && error.message ? error.message : String(error)), 'error')
        }
      }

      // 勾选幂等:同一 botId+targetId 只保留一份,取消勾选即移除
      function toggleImTarget(botId, target, checked) {
        const wanted = { botId, targetId: target.targetId }
        const rest = config.imTargets.filter((item) => imTargetKey(item) !== imTargetKey(wanted))
        void persistImTargets(checked ? rest.concat([wanted]) : rest)
      }

      function removeImTarget(item) {
        void persistImTargets(config.imTargets.filter((existing) => imTargetKey(existing) !== imTargetKey(item)))
      }

      async function testIm() {
        try {
          const result = await api('/api/turn-notify/test-im', { method: 'POST' })
          if (!result.results) {
            patch('IM 测试失败:' + result.detail, 'error')
            return
          }
          const failed = result.results.filter((item) => !item.ok)
          patch(failed.length === 0
            ? 'IM 通知已全部送达(' + result.results.length + ' 个目标)'
            : '部分失败:' + failed.map((item) => item.botId + '/' + item.targetId + ' ' + item.detail).join('; '),
          failed.length === 0 ? 'ok' : 'error')
        } catch (error) {
          patch('发送失败:' + (error && error.message ? error.message : String(error)), 'error')
        }
      }

      // 音效描述:试听回执指明实际播放对象,映射失效回落内置时可见
      function describeSound(sound) {
        return sound.kind === 'custom' ? '上传音效 ' + sound.id : '内置 ' + (TONE_LABELS[sound.name] || sound.name)
      }

      // 分类试听:播放该分类当前实际生效的音效(自定义 / 内置 / 失效回落),与通知真实发声同语义
      function previewCategory(category) {
        const sound = resolveSound(category, mapping, uploadedIds)
        playAudible(sound).then((result) => {
          if (!result.ok) patch(CATEGORY_LABELS[category] + ' 试听未播放:' + result.reason, 'error')
          else patch('已试听 ' + CATEGORY_LABELS[category] + ':' + describeSound(sound))
        })
      }

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
              ' 子代理会话不通知',
              h('input', {
                type: 'checkbox', checked: config.suppressSubagentWake,
                onChange: (e) => setConfig({ ...config, suppressSubagentWake: e.target.checked }),
              }),
              ' 子代理回执静默'),
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
        config.imAvailable ? h('div', { className: 'tn-card' },
          h('span', { className: 'tn-card__title' }, 'IM 投递(dsh-im)'),
          h('div', { className: 'tn-meta' }, '勾选目标即自动保存,任务完成等待审批等通知将同步推送 IM'),
          h('div', { className: 'tn-row' },
            h('span', { className: 'tn-meta' }, 'Bot ID'),
            h('input', {
              className: 'tn-input tn-fill', type: 'text',
              placeholder: '从设置页 IM机器人 卡片复制 Bot ID',
              value: imBotIdDraft,
              onChange: (e) => setImBotIdDraft(e.target.value),
            }),
            h('button', { className: 'tn-btn', disabled: busy, onClick: () => void loadImTargets() }, '加载目标'),
          ),
          imCatalog !== null
            ? imCatalog.targets.length === 0
              ? h('div', { className: 'tn-meta' }, '该 bot 尚无已保存投递目标,先在 dsh-im 设置页新建并测试')
              : imCatalog.targets.map((target) => {
                const checked = config.imTargets.some((item) => item.botId === imCatalog.botId && item.targetId === target.targetId)
                return h('label', { className: 'tn-meta', key: target.targetId },
                  h('input', {
                    type: 'checkbox', checked,
                    onChange: (e) => toggleImTarget(imCatalog.botId, target, e.target.checked),
                  }),
                  ' ' + target.targetId + (target.name ? '(' + target.name + ')' : '') + ' · ' + (target.kind || ''),
                )
              })
            : null,
          h('div', { className: 'tn-row' },
            h('span', { className: 'tn-meta' }, '已选目标'),
            config.imTargets.length === 0
              ? h('span', { className: 'tn-meta' }, '无')
              : config.imTargets.map((item) => h('span', { className: 'tn-meta', key: imTargetKey(item) },
                  item.botId + '/' + item.targetId + ' ',
                  h('button', { className: 'tn-btn', disabled: busy, onClick: () => removeImTarget(item) }, '删除'),
                )),
          ),
        ) : null,
        h('div', { className: 'tn-card' },
          h('span', { className: 'tn-card__title' }, '测试'),
          h('div', { className: 'tn-row' },
            h('button', {
              className: 'tn-btn',
              // 测试声音读当前映射:播放任务完成分类实际生效的音效,而非固定参考音
              onClick: () => {
                const sound = resolveSound('completed', mapping, uploadedIds)
                playAudible(sound).then((result) => {
                  patch(result.ok
                    ? '测试声音已触发:' + describeSound(sound) + ',若未听到请检查系统音量与输出设备'
                    : '测试声音未播放:' + result.reason, result.ok ? 'ok' : 'error')
                })
              },
            }, '测试声音'),
            h('button', { className: 'tn-btn', onClick: testPageNotification }, '测试页内通知'),
            h('button', { className: 'tn-btn', onClick: testSystemNotification }, '测试系统通知'),
            h('button', { className: 'tn-btn', onClick: () => void testWebhook() }, '测试 webhook'),
            config.imAvailable ? h('button', { className: 'tn-btn', disabled: busy, onClick: () => void testIm() }, '测试 IM 通知') : null,
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
          h('span', { className: 'tn-card__title' }, '音效管理(wav / mp3 / ogg,可多选,单文件上限 2MB)'),
          h('div', { className: 'tn-row' },
            h('input', {
              type: 'file', multiple: true, accept: AUDIO_EXTS.map((ext) => '.' + ext).join(','), disabled: busy,
              onChange: (e) => {
                const files = e.target.files ? Array.from(e.target.files) : []
                e.target.value = ''
                void onPickFiles(files)
              },
            }),
          ),
          pendingUploads.map((item, index) => h('div', { className: 'tn-row', key: index },
            h('span', { className: 'tn-meta' }, '待保存: ' + item.name),
            h('button', {
              className: 'tn-btn',
              onClick: () => {
                previewPending(item.raw).then((result) => {
                  if (!result.ok) patch('试听未播放:' + result.reason, 'error')
                })
              },
            }, '试听'),
            h('button', { className: 'tn-btn', disabled: busy, onClick: () => void savePending(item) }, '保存'),
            h('button', {
              className: 'tn-btn', disabled: busy,
              onClick: () => setPendingUploads(pendingUploads.filter((pending) => pending !== item)),
            }, '移除'),
          )),
          sounds.length === 0 ? h('span', { className: 'tn-meta' }, '暂无上传音效') :
            sounds.map((sound) => renamingId === sound.id
              ? h('div', { className: 'tn-row', key: sound.id },
                h('input', {
                  className: 'tn-input tn-fill', type: 'text', autoFocus: true,
                  value: renameDraft,
                  onChange: (e) => setRenameDraft(e.target.value),
                  // Enter 提交:IME 组词确认(229)不算提交,busy 期间忽略防并发提交
                  onKeyDown: (e) => {
                    if (e.key === 'Enter' && !busy && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) void renameSound(sound)
                  },
                }),
                h('button', { className: 'tn-btn', disabled: busy, onClick: () => void renameSound(sound) }, '确认'),
                h('button', { className: 'tn-btn', disabled: busy, onClick: cancelRename }, '取消'),
              )
              : h('div', { className: 'tn-row', key: sound.id },
                h('span', { className: 'tn-meta' }, sound.id + '.' + sound.ext),
                h('button', {
                  className: 'tn-btn',
                  onClick: () => {
                    playAudible({ kind: 'custom', id: sound.id }).then((result) => {
                      if (!result.ok) patch('试听未播放:' + result.reason, 'error')
                    })
                  },
                }, '试听'),
                h('button', { className: 'tn-btn', disabled: busy, onClick: () => startRename(sound) }, '重命名'),
                h('button', { className: 'tn-btn', disabled: busy, onClick: () => void removeSound(sound) }, '删除'),
              )),
        ),
        h('div', { className: 'tn-card' },
          h('span', { className: 'tn-card__title' }, '分类音效映射'),
          CATEGORIES.map((category) => h('div', { className: 'tn-row', key: category },
            h('span', { className: 'tn-meta' }, CATEGORY_LABELS[category]),
            h('select', {
              className: 'tn-select tn-fill', value: mapping[category] || '',
              onChange: (e) => void setMapping(category, e.target.value),
            }, soundOptions),
            h('button', { className: 'tn-btn', onClick: () => previewCategory(category) }, '试听'),
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
