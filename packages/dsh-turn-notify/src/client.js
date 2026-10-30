// dsh-turn-notify Client 半区:推送唤醒快照、事务认领与通知呈现。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 由 DSH client runtime 模块表解析。
// IndexedDB 事务协调跨窗口认领,localStorage 保存偏好与提醒标记。
// 页内通知通道经公共依赖 @mzzsfy/dsh-toast 展示,本包不自带通知 UI。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-turn-notify',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef } = React

    // 公共依赖 @mzzsfy/dsh-common-tools:总线订阅硬消费(数据刷新唯一通道,
    // dsh-common-tools 的 client 侧协议;模块表缺失即本 client factory 抛错,由装载层
    // 判定失败,无轮询回退);toast 可选消费(权威消费方 session-manager 未代挂
    // 占位时模块表缺失,干净禁用 toast 通道,其余通道不受影响)
    const tools = require('@mzzsfy/dsh-common-tools/client')
    let toast = null
    try {
      toast = tools.toast.show
    } catch {
      // 模块表无 toast → 页内通知通道置空,调用点统一走 toast 判空
    }

    // 快照拉取超时防悬挂,总线断线由共享 WS 退避重连
    const REQUEST_TIMEOUT_MS = 30 * 1000
    // 页内通知展示期,经公共依赖 holdMs 传入
    const TOAST_MS = 6 * 1000
    const BLINK_MS = 1 * 1000
    // 连环通知下标题闪烁的总时长硬顶
    const BLINK_MAX_MS = 30 * 1000
    // 系统通知测试延迟:浏览器对聚焦窗口抑制系统弹窗,倒计时供用户切出窗口
    const SYSTEM_TEST_DELAY_MS = 5 * 1000
    // 显示回执等待上限:超时未回执按环境层拦截给出诊断
    const SYSTEM_SHOW_TIMEOUT_MS = 3 * 1000

    // 导航图标声明:交给 dsh-settings-nav-icons 统一渲染;双键 = 分区 label + 市场
    // 短名(发现页收录显示形态);该插件未就绪时入队,由其启动时排空
    const NAV_ICON = { '消息通知': 'bell', 'dsh-turn-notify': 'bell' }
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

    // 数据镜像常量:与 core.mjs 的 AUDIO_EXTS/MIME_BY_EXT/CATEGORY_LABELS 同源,parity 锁定
    const AUDIO_EXTS = ['wav', 'mp3', 'ogg']
    const MIME_BY_EXT = { wav: 'audio/wav', ogg: 'audio/ogg', mp3: 'audio/mpeg' }

    const CATEGORY_LABELS = {
      completed: '任务完成',
      error: '任务出错',
      interrupted: '异常中断',
      approval: '等待审批',
      ask: 'AI 提问',
      'max-tokens': '回复被截断',
    }
    const CATEGORIES = Object.keys(CATEGORY_LABELS)

    const TONE_LABELS = {
      'up-arpeggio': '上行琶音', bell: '铃铛', duo: '清脆双音', 'alarm-square': '急促警报',
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

    let notificationWindowId
    const KEY_LOCK = 'turn-notify:lock:'
    const KEY_DONE = 'turn-notify:done:'
    const KEY_DND = 'turn-notify:dnd'
    const KEY_FOREGROUND_SYSTEM = 'turn-notify:foreground-system'
    const KEY_VOLUME = 'turn-notify:volume'
    const KEY_DEGRADE_HINT = 'turn-notify:degrade-hint'
    const KEY_TOAST = 'turn-notify:toast'
    const KEY_SOUND = 'turn-notify:sound'
    const KEY_SYSTEM = 'turn-notify:system'
    const KEY_PAGE_SOUND = 'turn-notify:page-sound'
    // 分类提示音配置:JSON 对象,缺省键=出声,显式 false=该分类静音
    const KEY_SOUND_CATEGORIES = 'turn-notify:sound-categories'
    const KEY_PAGE_SOUND_CATEGORIES = 'turn-notify:page-sound-categories'
    // 页内提示音场景映射:本机存储,缺省键沿用通知映射,UI 空值即删键
    const KEY_PAGE_MAPPING = 'turn-notify:page-mapping'
    // 映射双作用域:本地映射与开关均存本机浏览器,音效库保持 host 共享
    const KEY_MAPPING = 'turn-notify:mapping'
    const KEY_MAPPING_LOCAL = 'turn-notify:mapping-local'
    // 轮询单例令牌:HMR/插件重载重建模块闭包时防轮询线程累积
    const KEY_POLL_TOKEN = 'turn-notify:polling'
    const KEY_POLL_DISPOSE = 'turn-notify:polling:dispose'

    const storageState = { broken: false }

    // 诚实降级:轮询与存储两类降级各自提示一次;轮询恢复后复位,存储不可用不自动复位
    const degradeAnnounced = { poll: false, storage: false }
    function announceDegrade(kind, reason) {
      if (degradeAnnounced[kind]) return
      degradeAnnounced[kind] = true
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

    // 本地映射读取:JSON 解析失败或形态非对象回空对象
    function readLocalMapping() {
      try {
        const parsed = JSON.parse(localGet(KEY_MAPPING))
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      } catch {
        return {}
      }
    }

    // 本地作用域开关:仅显式开启生效,缺省为全局
    const localMappingEnabled = () => localGet(KEY_MAPPING_LOCAL) === '1'

    // JSON 对象存储读取:解析失败或形态非对象回空对象,空串值视为未配置剔除
    function readJsonObject(key) {
      try {
        const parsed = JSON.parse(localGet(key))
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
        for (const key2 of Object.keys(parsed)) {
          if (parsed[key2] === '') delete parsed[key2]
        }
        return parsed
      } catch {
        return {}
      }
    }

    // 分类提示音读取:显式 false=该分类静音,缺省键=出声
    const readSoundCategories = () => readJsonObject(KEY_SOUND_CATEGORIES)

    // 页内提示音分类读取:与 readSoundCategories 同构,独立存储互不影响
    const readPageSoundCategories = () => readJsonObject(KEY_PAGE_SOUND_CATEGORIES)

    // 页内提示音场景映射读取:缺省键沿用通知映射,UI 空值即删键,空串残留视同未配置
    const readPageMapping = () => readJsonObject(KEY_PAGE_MAPPING)

    function windowId() {
      return notificationWindowId ??= 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
    }

    // 认领读阶段决策:done 终态 / 他锁跳过 / 过期接管 / 自锁或无锁认领
    // undefined 判定与 core.mjs decideClaim 同形:镜像语义含 undefined 域,parity 锁定
    function decideClaim(stored, done, now, wid) {
      if (done !== null && done !== undefined) return 'done'
      if (stored === null || stored === undefined) return 'claim'
      let lock = null
      try { lock = JSON.parse(stored) } catch { lock = null }
      if (lock === null || typeof lock !== 'object' || typeof lock.at !== 'number' || typeof lock.wid !== 'string') {
        return 'takeover'
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
        announceDegrade('storage', 'localStorage 不可用')
        return true
      }
      const verdict = decideClaim(stored, done, now, wid)
      if (verdict === 'done' || verdict === 'skip') return false
      localSet(KEY_LOCK + id, JSON.stringify({ wid, at: now }))
      // 读回值解析防护:他窗写坏该键时按放弃处理,不中断整轮投影
      let confirmed = null
      try { confirmed = JSON.parse(localGet(KEY_LOCK + id)) } catch { confirmed = null }
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

    // 映射双作用域合并:与 core.mjs mergeMapping 行为一致,parity 测试锁定
    function mergeMapping(globalMapping, localMapping) {
      const merged = {}
      for (const key of Object.keys(globalMapping || {})) merged[key] = globalMapping[key]
      for (const key of Object.keys(localMapping || {})) merged[key] = localMapping[key]
      return merged
    }

    // 死链识别:与 core.mjs deadCustomIds 行为一致,parity 测试锁定
    function deadCustomIds(mapping, uploadedIds) {
      const uploaded = uploadedIds || []
      const dead = []
      for (const value of Object.values(mapping || {})) {
        if (typeof value !== 'string' || value.length === 0) continue
        if (Object.prototype.hasOwnProperty.call(TONE_LABELS, value)) continue
        if (uploaded.indexOf(value) >= 0) continue
        if (dead.indexOf(value) < 0) dead.push(value)
      }
      return dead
    }

    // 发声通道判定:与 core.mjs chooseChannels 行为一致,通道开关来自 localStorage,
    // 放入 LOGIC 段由 parity 测试保证双实现不漂移
    const IDLE_AWAY_MS = 5 * 60 * 1000

    // routes 为事件→通道路由放行名单(null=未配置全放行),语义与 core 同源。
    // 宿主通知去重由浏览器优先模型承载:浏览器在场时宿主让位,本窗口照常弹系统通知
    function foregroundSystemDefault(platform) {
      return platform === 'darwin'
    }

    function readForegroundSystem() {
      const value = localGet(KEY_FOREGROUND_SYSTEM)
      return value === '1' || (value !== '0' && foregroundSystemDefault(document.documentElement?.dataset?.platform))
    }

    function chooseChannels(hasFocus, permission, idleMs, soundCategories, category, routes, foregroundSystem = false) {
      const idleAway = typeof idleMs === 'number' && idleMs >= IDLE_AWAY_MS
      const quiet = hasFocus && localGet(KEY_DND) !== '0' && !idleAway
      const systemEnabled = localGet(KEY_SYSTEM) !== '0'
      const soundEnabled = localGet(KEY_SOUND) !== '0'
      const toastEnabled = localGet(KEY_TOAST) !== '0'
      const pageSoundCategories = readPageSoundCategories()
      const categoryMuted = soundCategories != null && category != null && soundCategories[category] === false
      const pageCategoryMuted = pageSoundCategories != null && category != null && pageSoundCategories[category] === false
      const routed = (channel) => routes == null || routes.indexOf(channel) >= 0
      const sound = !quiet && soundEnabled && !categoryMuted && routed('sound')
      const system = (!quiet || foregroundSystem) && systemEnabled && permission === 'granted' && routed('system')
      return {
        toast: toastEnabled && routed('toast'),
        sound,
        system,
        systemSilent: system && quiet && foregroundSystem,
        blink: !quiet && systemEnabled && permission !== 'granted' && routed('blink'),
        pageSound: localGet(KEY_PAGE_SOUND) === '1' && toastEnabled && !pageCategoryMuted && !sound && routed('toast'),
      }
    }

    // IM 投递目标列表操作:与 core.mjs 同源,parity 测试保证双实现不漂移
    // botId/targetId 字符集均不含 '/',拼接键无歧义;与 host 侧写入校验共用 dsh-im ID 规格
    const imTargetKey = (item) => item.botId + '/' + item.targetId

    // 勾选幂等:同一 botId+targetId 只保留一份;勾选追加到尾部,取消即移除
    function toggleImTargetList(list, botId, targetId, checked) {
      const wanted = { botId, targetId }
      const rest = list.filter((item) => imTargetKey(item) !== imTargetKey(wanted))
      return checked ? rest.concat([wanted]) : rest
    }

    function removeImTargetFromList(list, botId, targetId) {
      return list.filter((item) => imTargetKey(item) !== botId + '/' + targetId)
    }

    // 取消注册:移除该 bot 全部目标
    function unregisterImBotList(list, botId) {
      return list.filter((item) => item.botId !== botId)
    }

    // 已绑 bot:按首次绑定顺序去重
    function imBoundBotIds(list) {
      const botIds = []
      for (const item of list) {
        if (!botIds.includes(item.botId)) botIds.push(item.botId)
      }
      return botIds
    }
    /* LOGIC-END */

    // 同库 readwrite 事务串行，终态提交后才能呈现；不依赖 secure context。
    const CLAIM_DB = 'dsh-turn-notify'
    const CLAIM_STORE = 'claims'
    const CLAIM_RETENTION_MS = ANNOUNCED_TTL_MS + REQUEST_TIMEOUT_MS
    let claimDbPromise = null
    function closeClaimDb() {
      const pending = claimDbPromise
      claimDbPromise = null
      pending?.then(db => db.close(), () => {})
    }
    function openClaimDb() {
      if (claimDbPromise) return claimDbPromise
      const pending = new Promise((resolve, reject) => {
        const request = window.indexedDB.open(CLAIM_DB, 1)
        request.onupgradeneeded = () => { request.result.createObjectStore(CLAIM_STORE, { keyPath: 'id' }) }
        request.onerror = () => reject(request.error)
        request.onblocked = () => reject(new Error('通知认领库被阻塞'))
        request.onsuccess = () => {
          const db = request.result
          if (claimDbPromise !== pending) { db.close(); reject(new Error('通知认领代已退出')); return }
          db.onversionchange = () => { if (claimDbPromise === pending) closeClaimDb() }
          resolve(db)
        }
      })
      claimDbPromise = pending
      pending.catch(() => { if (claimDbPromise === pending) claimDbPromise = null })
      return pending
    }
    async function claimNotification(unit, signal) {
      if (signal?.aborted) return false
      const now = Date.now()
      try {
        const db = await openClaimDb()
        if (signal?.aborted) return false
        const claimed = await new Promise((resolve, reject) => {
          const transaction = db.transaction(CLAIM_STORE, 'readwrite')
          const store = transaction.objectStore(CLAIM_STORE)
          let winner = false
          const abort = () => { try { transaction.abort() } catch { /* 已提交事务不能回滚 */ } }
          const cleanup = () => signal?.removeEventListener('abort', abort)
          signal?.addEventListener('abort', abort, { once: true })
          transaction.oncomplete = () => { cleanup(); resolve(winner) }
          transaction.onabort = transaction.onerror = () => { cleanup(); reject(transaction.error) }
          const request = store.getAll()
          request.onsuccess = () => {
            const now = Date.now()
            const rows = request.result
            for (const row of rows) if (row.expiresAt <= now) store.delete(row.id)
            if (signal?.aborted) return
            if (rows.some(row => row.id === unit.id && row.expiresAt > now)) return
            store.add({ id: unit.id, expiresAt: now + CLAIM_RETENTION_MS })
            winner = localGet(KEY_DONE + unit.id) === null
          }
        })
        return !signal?.aborted && claimed
      } catch {
        if (signal?.aborted) return false
        announceDegrade('storage', 'IndexedDB 不可用，跨窗口认领已降级')
        const claimed = claimEvent(unit.id)
        return claimed && (storageState.broken || announcedOnce(unit.id, now))
      }
    }

    // ---- 声音:Web Audio,autoplay 解锁依赖首次用户交互,解锁前静默 ----

    let audioCtx = null
    let audioLease = null
    const decodedCache = new Map()
    const ACTION_EVENTS = ['pointerdown', 'keydown', 'mousemove', 'wheel']
    const assertAudioActive = (ctx2 = audioCtx) => {
      if (!audioLease?.active || ctx2 === null || ctx2 !== audioCtx) throw new Error('通知音频已停用')
    }
    function ensureAudioCtx() {
      if (!audioLease?.active) throw new Error('通知音频已停用')
      if (audioCtx === null) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
      return audioCtx
    }
    function startAudio() {
      const lease = { active: true }
      audioLease = lease
      const unlockAudio = () => {
        if (audioLease !== lease || !lease.active) return
        try { ensureAudioCtx() } catch { /* 缺少音频能力不影响其余通道 */ }
      }
      const recordAction = () => { if (lease.active) window.__tnLastActionAt = Date.now() }
      window.__tnLastActionAt = Date.now()
      window.__tnActionHandler = recordAction
      window.addEventListener('pointerdown', unlockAudio, { once: true })
      for (const type of ACTION_EVENTS) window.addEventListener(type, recordAction)
      return () => {
        lease.active = false
        window.removeEventListener('pointerdown', unlockAudio)
        for (const type of ACTION_EVENTS) window.removeEventListener(type, recordAction)
        if (window.__tnActionHandler === recordAction) delete window.__tnActionHandler
        if (audioLease !== lease) return
        audioLease = null
        const closing = audioCtx
        audioCtx = null
        decodedCache.clear()
        try { Promise.resolve(closing?.close()).catch(() => {}) } catch { /* 资源已失效也保持退役 */ }
      }
    }
    const lastActionAt = () => window.__tnLastActionAt ?? Date.now()

    function volume() { return parseVolume(localGet(KEY_VOLUME)) }

    function playTone(ctx2, spec) {
      assertAudioActive(ctx2)
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
      assertAudioActive(ctx2)
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
        const raw = await response.arrayBuffer()
        assertAudioActive(ctx2)
        buffer = await ctx2.decodeAudioData(raw)
        assertAudioActive(ctx2)
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
        let timer
        try {
          await Promise.race([
            ctx2.resume(),
            new Promise((resolve) => { timer = setTimeout(resolve, AUDIO_RESUME_WAIT_MS) }),
          ])
        } catch { } finally { clearTimeout(timer) }
      }
      assertAudioActive(ctx2)
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
        assertAudioActive(pre.ctx2)
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

    // ---- 页内通知与标题闪烁 ----

    const KEY_TOAST_APPEARANCE = 'turn-notify:toast-appearance'
    const TOAST_APPEARANCES = { toast: '标准浮条', panel: '主题卡片' }
    const readToastAppearance = () => localGet(KEY_TOAST_APPEARANCE) === 'panel' ? 'panel' : 'toast'

    // 每次呈现读取本机偏好,其他窗口更改及二次提醒同样即时生效。
    function showPageNotification(text, onClick) {
      return toast?.(text, { holdMs: TOAST_MS, appearance: readToastAppearance(), onClick })
    }

    function previewPageNotification() {
      return showPageNotification('[dsh] 页内通知样式预览\n耗时 12 秒 · 1.5k tokens · 已完成任务')
    }

    let blinkTimer = null
    let blinkStopTimer = null
    let blinkDeadline = null
    const baseTitle = () => document.title.replace(/^⏳ /, '')

    // 连环通知(并行会话批量报错)间隔小于 TOAST_MS 时,闪烁会被逐条续命;
    // 硬顶 BLINK_MAX_MS 保证任何情况下标题必停,焦点返回时由可见性同步立即清除
    function startTitleBlink() {
      const now = Date.now()
      if (blinkTimer === null) {
        blinkDeadline = now + BLINK_MAX_MS
        blinkTimer = setInterval(() => {
          if (Date.now() >= blinkDeadline) { stopTitleBlink(); return }
          document.title = document.title.startsWith('⏳ ') ? baseTitle() : '⏳ ' + baseTitle()
        }, BLINK_MS)
      }
      clearTimeout(blinkStopTimer)
      blinkStopTimer = setTimeout(stopTitleBlink, Math.max(0, Math.min(now + TOAST_MS, blinkDeadline) - now))
    }

    function stopTitleBlink() {
      blinkDeadline = null
      if (blinkStopTimer !== null) {
        clearTimeout(blinkStopTimer)
        blinkStopTimer = null
      }
      if (blinkTimer === null) return
      clearInterval(blinkTimer)
      blinkTimer = null
      document.title = baseTitle()
    }

    const notificationPermission = () => (typeof Notification === 'undefined' ? 'denied' : Notification.permission)

    // onOutcome 仅供测试路径取显示回执(onshow/onerror),真实路径吞错降级已在链路内。
    // onclick 点击直达:唤醒窗口(桌面壳在直达动作内一并唤起)并按 ID 导航后关闭弹窗;
    // summary 作 body 两级呈现;桌面前台偏好下以静默方式弹出
    function notifySystem(unit, onOutcome, silent = false) {
      try {
        const notification = new Notification(unit.text, { tag: unit.id, body: unit.summary ?? '', ...(silent ? { silent: true } : {}) })
        const activate = activateSessionFromUnit(unit)
        notification.onclick = () => {
          try { activate() } finally { notification.close() }
        }
        if (typeof onOutcome === 'function') {
          notification.onshow = () => { onOutcome(true) }
          notification.onerror = () => { onOutcome(false) }
        }
      } catch {
        if (typeof onOutcome === 'function') onOutcome(false)
      }
    }

    // ---- 投影快照与认领 ----

    let soundMapping = {}
    let uploadedIds = []
    // 同代实例各持接收租约,仅活动所有者驱动共享通知工作。
    const notificationOwners = new Set()
    let activeNotificationOwner = null
    let stopNotifications = null
    let notificationController = null
    let refreshNotifications = null
    // 已见投影版本:仅作冷启动判定(首个快照前错过窗口期的存量不回放轰炸)
    let projectionCursor = null

    // 生效映射:开关开时本地覆盖全局,关时本地整体休眠(结果即全局)
    const effectiveMapping = () => mergeMapping(soundMapping, localMappingEnabled() ? readLocalMapping() : {})

    async function pollOnce(signal) {
      let payload, requestSignal
      try {
        // 恒全量快照(变更通知走总线);组合代际中止与请求超时防悬挂
        const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
        const response = await fetch('/api/turn-notify/projection', { signal: requestSignal })
        if (!response.ok) {
          void response.body?.cancel()
          return false
        }
        payload = await response.json()
      } catch {
        return false
      }
      if (requestSignal.aborted) return false
      // 版本缺失即异常响应:按失败处理,由调用方通告降级
      if (typeof payload.version !== 'number') return false
      // 冷启动对齐:页面关闭/刷新期间错过的存量通知只补游标与完成标记,不轰炸呈现;
      // 错过即过期的投影设计下,重开逐条回放只剩连环提示与声音,信息价值为零
      const coldStart = projectionCursor === null
      projectionCursor = payload.version
      soundMapping = payload.soundMapping || {}
      sessionHighlightEnabled = readSessionHighlightEnabled()
      if (!sessionHighlightEnabled && sessionHighlights.size > 0) {
        sessionHighlights.clear()
        clearSessionHighlightClasses()
      }
      const units = payload.units || []
      const liveIds = new Set(units.map((unit) => unit.id))
      // 提醒注册仅由"已处理"事实清除(F22 决策):点击行/聚焦当前会话/会话新回合;
      // 投影 TTL 过期只清理本地锁/完成标记残留(liveIds 消费点),不撤销二次提醒——
      // 提醒是"通道没送达"的兜底,寿命独立于通知投影窗口
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
      // 聚焦静默双条件:可见且有焦点才静默(竞品对齐)。hasFocus 单独成立而页面
      // hidden 的边界(多屏/预渲染)不静默
      const engaged = isEngaged()
      for (const unit of units) {
        const claimed = await claimNotification(unit, requestSignal)
        if (requestSignal.aborted) return false
        // 冷启动对齐:错过窗口期的存量通知不回放轰炸;审批与提问例外——
        // 它们在等用户动作,静默会把待办吞掉
        if (coldStart && unit.category !== 'approval' && unit.category !== 'ask') {
          try { markDone(unit.id) } catch { /* 存储不可用:标记缺失由内存去重兜底,冷启动本就不发声 */ }
          // 静默对齐只不呈现通知,未读会话闪烁照常:高亮是本机 UI 状态,不属轰炸
          rememberSessionHighlight(unit, engaged)
          continue
        }
        if (!claimed) continue
        markDone(unit.id)
        // 桌面前台偏好只豁免system，不改变声音或路由/权限。
        const foregroundSystem = window.location?.protocol === 'dsh-app:' && readForegroundSystem()
        const channels = chooseChannels(engaged, notificationPermission(), Date.now() - lastActionAt(), readSoundCategories(), unit.category, unit.routes ?? null, foregroundSystem)
        const sound = resolveSound(unit.category, effectiveMapping(), uploadedIds)
        if (channels.toast || channels.sound || channels.system || channels.blink) {
          rememberSessionHighlight(unit, engaged)
        }
        if (channels.toast) {
          showPageNotification(unit.text + (unit.summary ? '\n' + unit.summary : ''), activateSessionFromUnit(unit))
        }
        // 页内提示音与通知声音互斥(pageSound 已含 !sound),同一通知至多一声;
        // toast 库缺失时卡片不存在,补位音随之禁用(声明与可用分离,可用性在调用点合流);
        // 页内音色按页内场景映射解析:通知生效映射为底,页内显式配置覆盖
        if (channels.pageSound && toast) {
          playSound(resolveSound(unit.category, mergeMapping(effectiveMapping(), readPageMapping()), uploadedIds)).catch(() => {})
        }
        // 声音关闭只静音自身:system 弹窗与 blink 降级通道独立判断,不因无声 continue 连坐
        if (channels.sound) playSound(sound).catch(() => {})
        if (channels.system) notifySystem(unit, undefined, channels.systemSilent)
        else if (channels.blink && localGet(KEY_DEGRADE_HINT) !== '0') startTitleBlink()
        // 等待用户动作的事件超时未处理:补发一轮提醒(审批与提问)
        scheduleActionReminder(unit, channels)
      }
      applySessionHighlights()
      return true
    }

    // 单次拉取:快照消费入口(总线 onReset/onChange 触发);失败通告降级;
    // 代际中止(HMR 换代)不算降级,不通告
    async function poll(signal) {
      const ok = await pollOnce(signal)
      if (ok) degradeAnnounced.poll = false
      else if (signal === undefined || !signal.aborted) announceDegrade('poll', '投影拉取失败')
      return ok
    }

    // 数据刷新唯一通道:订阅推送总线。首连 onReset 即首拉,消息到达重拉;
    // 断线由公共 WS 总线重连,重连成功再触发 onReset 全量对账自愈
    function startBusLoop(signal, clientBus, owner) {
      const refresh = () => { if (activeNotificationOwner === owner && !signal.aborted) refreshNotifications() }
      return clientBus.subscribe(refresh, { onReset: refresh })
    }

    async function refreshSounds() {
      try {
        const response = await fetch('/api/turn-notify/sounds')
        const payload = await response.json()
        uploadedIds = (payload.sounds || []).map((sound) => sound.id)
      } catch { uploadedIds = [] }
    }

    // ---- 会话行高亮:通知投递即脉冲闪烁侧边栏对应会话,点击该行清除 ----

    const SESSION_HL_CLASS = 'tn-sess-hl'
    // 集合上限:用户始终不点击时防无界增长,超限淘汰最旧(插入序即迭代序)
    const SESSION_HL_MAX = 20
    const sessionHighlights = new Map()
    // 会话高亮为纯本机 UI 行为:开关存 localStorage,存储不可用按默认开
    const KEY_SESSION_HL = 'turn-notify:session-hl'
    function readSessionHighlightEnabled() {
      try { return window.localStorage.getItem(KEY_SESSION_HL) !== '0' } catch { return true }
    }
    function writeSessionHighlightEnabled(on) {
      try {
        if (on) window.localStorage.removeItem(KEY_SESSION_HL)
        else window.localStorage.setItem(KEY_SESSION_HL, '0')
      } catch { /* 存储不可用时开关仍可点,本次会话生效 */ }
      sessionHighlightEnabled = on
      if (!on) {
        sessionHighlights.clear()
        clearSessionHighlightClasses()
      }
    }
    let sessionHighlightEnabled = readSessionHighlightEnabled()

    const hasSessionId = (unit) => typeof unit.sessionId === 'string' && unit.sessionId.length > 0
    const SESSION_ROW_SELECTOR = '[data-row-key]'
    const SESSION_ROW_PREFIX = 'session:'
    function currentSessionId() {
      const sessions = activeNotificationOwner?.sessions
      if (!sessions) return null
      return mainSessionId(sessions.list.getSnapshot().byId || {}) ?? null
    }
    // 官方行身份同构；固定选择器避免将会话ID解释为CSS，重复身份宁缺不误。
    function findSessionRow(sessionId) {
      if (typeof document.querySelectorAll !== 'function') return null
      const rows = [...document.querySelectorAll(SESSION_ROW_SELECTOR)].filter(row => row.getAttribute('data-row-key') === SESSION_ROW_PREFIX + sessionId)
      return rows.length === 1 ? rows[0] : null
    }

    // 行状态与 SessionStatusDots 对齐:运行中的会话由原生状态点表达注意力,
    // 闪烁只表达"状态已更新待查看"——行进入运行状态即让位,文案取官方 zh/en 两种
    const isRowRunning = (row) => {
      const text = typeof row.textContent === 'string' ? row.textContent : ''
      return text.indexOf('进行中') >= 0 || text.toLowerCase().indexOf('running') >= 0
    }

    // 聚焦静默双条件:可见且有焦点才静默(竞品对齐)。hasFocus 单独成立而页面
    // hidden 的边界(多屏/预渲染)不静默
    const isEngaged = () => document.hasFocus() && document.hidden === false

    // 高亮挂载单一入口:正常送达与冷启动静默对齐共用;
    // 门控差异:正常送达仅在通知实际投递(任一呈现通道放行)时挂,冷启动静默对齐
    // 无条件挂——高亮是未读 UI 状态,不属通知轰炸,错过窗口的存量照样强调;
    // 开关关闭不积累条目;聚焦时正在查看的会话不挂——与 dsh 原版一致,正在看即已读,
    // 失焦期间照常挂,返回页面时由可见性同步清除(回来即已读);
    // 投影字段名为 session(buildUnit 输出形态,webhook 结构化字段同名)
    function rememberSessionHighlight(unit, engaged) {
      if (!sessionHighlightEnabled || !hasSessionId(unit)) return
      if (engaged && currentSessionId() === unit.sessionId) return
      sessionHighlights.delete(unit.sessionId)
      if (sessionHighlights.size >= SESSION_HL_MAX) sessionHighlights.delete(sessionHighlights.keys().next().value)
      sessionHighlights.set(unit.sessionId, unit.category)
    }

    // 增量重应用:仅补缺失类,不产生多余 DOM 写,防 MutationObserver 回调自我触发成环;
    // 快照遍历:行进入运行状态时清理对应条目,迭代中删除不改快照
    function applySessionHighlights() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
      const current = isEngaged() ? currentSessionId() : null
      if (current !== null) markSessionHandled(current)
      if (!sessionHighlightEnabled) return
      const wanted = new Map()
      for (const [sessionId, category] of [...sessionHighlights]) {
        const row = findSessionRow(sessionId)
        if (!row) continue
        if (isRowRunning(row)) {
          sessionHighlights.delete(sessionId)
          continue
        }
        wanted.set(row, CATEGORIES.indexOf(category) >= 0 ? SESSION_HL_CLASS + '--' + category : SESSION_HL_CLASS + '--ask')
      }
      for (const row of document.querySelectorAll('.' + SESSION_HL_CLASS)) {
        const color = wanted.get(row)
        const staleColor = row.className.split(' ').some(name => name.startsWith(SESSION_HL_CLASS + '--') && name !== color)
        if (!color || staleColor) removeRowHighlight(row)
      }
      for (const [row, color] of wanted) {
        if (!row.classList.contains(SESSION_HL_CLASS) || !row.classList.contains(color)) row.classList.add(SESSION_HL_CLASS, color)
      }
    }

    // 开关关闭或点击清除后的类清理:移除本插件前缀的全部类
    function clearSessionHighlightClasses() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
      const marked = document.querySelectorAll('.' + SESSION_HL_CLASS)
      for (let index = 0; index < marked.length; index += 1) {
        marked[index].className = marked[index].className.split(' ').filter((name) => name !== SESSION_HL_CLASS && name.indexOf(SESSION_HL_CLASS + '--') !== 0).join(' ')
      }
    }

    // 宿主重渲染会重建行节点抹掉高亮类,观察器在同一帧内补齐;
    // applySessionHighlights 幂等(类齐不写 DOM),观察器链自然收敛;
    // 令牌承载 observer 与 pending 帧:HMR 重建闭包后先断开旧代 observer、
    // cancel 旧代 pending 帧(帧回调持有旧代高亮 Map,不取消会写幽灵高亮),
    // 旧闭包不滞留;rAF 合批:流式期间 DOM 变更批远高于帧率,同帧多批合并
    // 为一次重应用(同帧补齐语义不变),无高亮条目时不排帧
    const KEY_HL_OBSERVER = 'turn-notify:hl-observer'
    const KEY_HL_FRAME = 'turn-notify:hl-frame'
    function ensureHighlightObserver() {
      if (typeof document === 'undefined' || typeof document.body === 'undefined' || typeof MutationObserver === 'undefined') return
      if (window[KEY_HL_OBSERVER] !== undefined && typeof window[KEY_HL_OBSERVER].disconnect === 'function') window[KEY_HL_OBSERVER].disconnect()
      if (typeof window[KEY_HL_FRAME] === 'number') {
        cancelAnimationFrame(window[KEY_HL_FRAME])
      }
      // 哨兵 0 = 无在途帧(规范 rAF 句柄自 1 起,cancel 0 为 no-op);新代显式归零,
      // 防 undefined 初始态使在途判定恒真、帧永不排程
      window[KEY_HL_FRAME] = 0
      const observer = new MutationObserver(() => {
        if (!sessionHighlightEnabled || sessionHighlights.size === 0) return
        if (window[KEY_HL_FRAME] !== 0) return
        window[KEY_HL_FRAME] = requestAnimationFrame(() => {
          window[KEY_HL_FRAME] = 0
          if (sessionHighlightEnabled && sessionHighlights.size > 0) applySessionHighlights()
        })
      })
      observer.observe(document.body, { childList: true, subtree: true })
      window[KEY_HL_OBSERVER] = observer
    }

    // 点击清除走捕获委托;令牌承载 listener:HMR 重建闭包后先摘旧代再挂新代,
    // 旧闭包不滞留(否则点击清除永远操作旧代高亮状态)。
    // 行标题按叶文本与 Map 键前缀互含精确删除,只清该行——其他会话的进行中提示不受影响
    const KEY_HL_LISTENER = 'turn-notify:hl-listener'
    function removeRowHighlight(row) {
      if (typeof row.className !== 'string') return
      row.className = row.className.split(' ').filter((name) => name !== SESSION_HL_CLASS && name.indexOf(SESSION_HL_CLASS + '--') !== 0).join(' ')
    }

    // ---- 工作区文件夹运行标记 ----

    // 官方组容器 CSS module 类名后缀(哈希前缀随构建漂移,后缀稳定)与自家标记属性;
    // 扫描合并窗口覆盖聊天流式输出的高频 DOM mutation
    const FOLD_SECTION_SELECTOR = 'div[class$="_groupSection"]'
    const FOLD_RUNNING_FLAG = 'data-tn-folder-running'
    const FOLD_SCAN_DELAY_MS = 50

    // 官方 folderPath 同构:Host 拼写归一为正斜杠并去尾斜杠,大小写敏感
    function folderPath(path) {
      return (/^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\') ? path.replaceAll('\\', '/') : path).replace(/\/+$/, '')
    }

    // 官方 mainSessionId 同构:mainView 引用大于零的会话即浏览器当前会话
    function mainSessionId(byId) {
      for (const row of Object.values(byId)) {
        if (row.retainedBy && (row.retainedBy.mainView || 0) > 0) return row.id
      }
    }

    // 活动与侧边栏可见性分离:隐藏子会话通过 parentId 归到可见主会话,
    // 不按 cwd 猜归属。byId 含不在 ids 中的 catalog 子行(官方同构)。
    function folderActivityOwners(sessionsState, workspacesState) {
      const byId = (sessionsState && sessionsState.byId) || {}
      const archived = new Set((workspacesState && workspacesState.archivedSessionIds) || [])
      const current = mainSessionId(byId)
      const owners = new Map()
      for (const id of Object.keys(byId)) {
        let root = id
        const seen = new Set()
        while (byId[root] && !archived.has(root) && !seen.has(root)) {
          seen.add(root)
          const row = byId[root]
          if (row.origin !== 'subagent') {
            if (!row.blank || root === current) owners.set(id, root)
            break
          }
          root = row.parentId
        }
      }
      return owners
    }

    // 归属仍走 workspace 账本一级映射;游离主会话入末位未分组桶。
    // Agent 状态取 uiSession.sessionStatus 的即时值优先(官方 ui-subagent 同构),
    // Bash 等后台活动取 jobs 名册;只计该会话拥有的 running/stopping 任务,
    // 名册同时可见的无主任务不得让所有文件夹误亮。完成/失败/取消均不算运行。
    function folderRunningState(sessionsState, workspacesState, jobsState, sessionStatuses, owners = folderActivityOwners(sessionsState, workspacesState)) {
      const byId = (sessionsState && sessionsState.byId) || {}
      const ids = (sessionsState && sessionsState.ids) || []
      const workspaces = workspacesState && Array.isArray(workspacesState.items) ? workspacesState.items : []
      const active = new Set()
      for (const [id, root] of owners) {
        const row = byId[id]
        const agentRunning = sessionStatuses?.get(id)?.running ?? row.running
        const jobs = jobsState?.rows?.[id] || []
        if (agentRunning || jobs.some((job) => job.owner === id && (job.status === 'running' || job.status === 'stopping'))) active.add(root)
      }
      const running = new Set()
      const accounted = new Set()
      const workspaceIds = []
      for (const workspace of workspaces) {
        // 主键不做防御过滤,与官方 groupByWorkspace 同构:items 长度即组容器对位基准,
        // 过滤会让 ids 短于容器数,恰差一时错位成「末位未分组桶」对位
        workspaceIds.push(workspace.workspaceId)
        const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
        for (const sessionId of sessionIds) {
          if (!byId[sessionId]) continue
          accounted.add(sessionId)
          if (active.has(sessionId)) running.add(workspace.workspaceId)
        }
      }
      const ungrouped = ids.some((id) => !accounted.has(id) && active.has(id))
      return { ids: workspaceIds, running, ungrouped }
    }

    // 官方树模式组渲染序同构:子组容器渲染在父组之后、兄弟按快照序,
    // 先序展开与快照平铺序不一致时下标对位静默错序,宁缺不误,整体放弃标记
    function treeModeOrderDrifts(workspacesState) {
      const items = workspacesState && Array.isArray(workspacesState.items) ? workspacesState.items : []
      if (items.length < 2) return false
      const paths = items.map((workspace) => (typeof workspace.path === 'string' ? folderPath(workspace.path) : undefined))
      const parentOf = paths.map((child, at) => {
        let owner
        let length = -1
        for (let i = 0; i < paths.length; i++) {
          const parent = paths[i]
          if (i !== at && child && parent && child !== parent && child.startsWith(parent + '/') && parent.length > length) {
            owner = i
            length = parent.length
          }
        }
        return owner
      })
      const ordered = []
      const walk = (at) => {
        ordered.push(at)
        for (let i = 0; i < items.length; i++) if (parentOf[i] === at) walk(i)
      }
      for (let i = 0; i < items.length; i++) if (parentOf[i] === undefined) walk(i)
      return ordered.some((at, index) => at !== index)
    }

    const FOLD_SWITCH_TITLE = '侧边栏按工作区分组时，显示运行点与文件夹图标着色；包含主会话、本地子代理及其后台任务，折叠后仍显示。“未分组”同样适用，单列表不显示。所有浏览器共享，刷新页面后生效。'

    // ---- 点击直达会话:页内卡片与系统弹窗共用 ----

    // 身份走通知携带的 sessionId(uiWorkspace.openSession),标题只作展示与高亮,
    // 不按 DOM 标题猜会话。uiWorkspace 经 inject 延迟注入,缺席时仅禁用直达,
    // 不阻断通知与设置页。导航注册表挂在 factory 闭包,与实例代际无关:
    // 已显示通知的迟到闭包点击时现读 Map,由最后激活的存活实例接管。
    const sessionNavigators = new Map()
    function activateSessionFromUnit(unit) {
      const controller = notificationController
      return () => {
        try { if (typeof window.focus === 'function') window.focus() } catch { /* 唤醒失败不阻断导航 */ }
        // Electron 的 window.focus 不保证恢复隐藏/最小化窗口;固定协议交给桌面壳。
        // 普通浏览器不请求,避免远程浏览器点击时意外唤起服务端机器上的 App。
        if (window.location?.protocol === 'dsh-app:' && document.documentElement?.dataset?.platform === 'darwin') {
          void api('/api/turn-notify/focus-desktop', { method: 'POST' })
            .then((result) => { if (!result.ok) throw new Error(result.detail || '无法唤起桌面版') })
            // 无会话 ID 的通知(如测试点火)不会切换会话,文案不得声称已尝试切换
            .catch(() => toast?.(hasSessionId(unit) ? '无法唤起 DSH 桌面窗口，请从 Dock 打开；会话已尝试切换' : '无法唤起 DSH 桌面窗口，请从 Dock 打开', { holdMs: TOAST_MS }))
        }
        // 历史投影和无会话测试通知不含 ID,只唤醒,不冒险跳到同名会话。
        // toast 缺席(公共依赖未装载)时提示面缺失属合法降级,守卫链继续导航
        if (!hasSessionId(unit)) return
        const sessionNavigator = [...sessionNavigators.values()].at(-1)
        if (!sessionNavigator) {
          toast?.('会话导航尚未就绪，请稍后重试', { holdMs: TOAST_MS })
          return
        }
        try {
          sessionNavigator.openSession(unit.sessionId)
          // 已读收尾只在登记实例仍存活时执行,过期代际闭包不误清当前代高亮
          if (controller && !controller.signal.aborted && controller === notificationController) markSessionHandled(unit.sessionId)
        } catch {
          toast?.('无法打开通知对应的会话，请在会话列表中查看', { holdMs: TOAST_MS })
        }
      }
    }

    // ---- 审批/提问超时二次提醒 ----

    // 等待用户动作的事件超此时长未处理即补发一轮(一次,不连环)。
    const ACTION_REMIND_MS = 10 * 60 * 1000
    // 提醒处理独立于高亮可见性；只撤当前已登记项，后续同会话通知可重新登记。
    const pendingReminders = new Map()
    function markSessionHandled(sessionId) {
      sessionHighlights.delete(sessionId)
      const row = findSessionRow(sessionId)
      if (row) removeRowHighlight(row)
      for (const [id, reminder] of pendingReminders) {
        if (reminder.unit.sessionId !== sessionId) continue
        clearTimeout(reminder.timer)
        pendingReminders.delete(id)
      }
    }
    function actionHandled(unit) {
      return hasSessionId(unit) && isEngaged() && currentSessionId() === unit.sessionId
    }
    function scheduleActionReminder(unit, channels) {
      if (unit.category !== 'approval' && unit.category !== 'ask') return
      if (pendingReminders.has(unit.id)) return
      const timer = setTimeout(() => {
        if (!pendingReminders.has(unit.id)) return
        pendingReminders.delete(unit.id)
        if (actionHandled(unit)) return
        // 补发独立于聚焦静默与路由名单:它就是"通道没送达"的兜底
        showPageNotification('[再次提醒] ' + unit.text + (unit.summary ? '\n' + unit.summary : ''), activateSessionFromUnit(unit))
        playSound(resolveSound(unit.category, effectiveMapping(), uploadedIds)).catch(() => {})
        startTitleBlink()
      }, ACTION_REMIND_MS)
      if (typeof timer.unref === 'function') timer.unref()
      pendingReminders.set(unit.id, { unit, timer })
    }
    // 投影刷新同步:单元过期即撤登记(通知已被其他窗口处理或已出投影窗口)
    function pruneReminders(liveIds) {
      for (const [id, reminder] of pendingReminders) {
        if (liveIds.has(id)) continue
        clearTimeout(reminder.timer)
        pendingReminders.delete(id)
      }
    }
    // 页面重新可见即视为已读:清除当前会话的高亮,其他会话的提醒保留
    function clearCurrentSessionHighlights() {
      const sessionId = currentSessionId()
      if (sessionId !== null) markSessionHandled(sessionId)
    }
    function ensureHighlightListener() {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
      if (typeof window[KEY_HL_LISTENER] === 'function') document.removeEventListener('click', window[KEY_HL_LISTENER], true)
      const listener = (event) => {
        const target = event.target?.closest?.(SESSION_ROW_SELECTOR)
        const key = target?.getAttribute('data-row-key')
        if (typeof key !== 'string' || !key.startsWith(SESSION_ROW_PREFIX)) return
        const sessionId = key.slice(SESSION_ROW_PREFIX.length)
        if (sessionId && findSessionRow(sessionId) === target) markSessionHandled(sessionId)
      }
      window[KEY_HL_LISTENER] = listener
      document.addEventListener('click', listener, true)
    }

    // 返回即已读:窗口重获焦点或页面重新可见时清除当前会话高亮。
    // 单靠 visibilitychange 不够——切到别的应用窗口(不切标签、不最小化)时
    // 本标签页 hidden 恒为 false,事件永不触发,焦点通道覆盖这一场景;
    // 令牌承载 dispose,HMR 重建闭包后先摘旧代再挂新代
    const KEY_HL_VISIBLE = 'turn-notify:hl-visible'
    function ensureHighlightVisibilitySync() {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
      if (window[KEY_HL_VISIBLE] && typeof window[KEY_HL_VISIBLE].dispose === 'function') window[KEY_HL_VISIBLE].dispose()
      const onVisible = () => {
        if (document.hidden) return
        clearCurrentSessionHighlights()
        stopTitleBlink()
      }
      const onFocus = () => {
        clearCurrentSessionHighlights()
        stopTitleBlink()
      }
      const dispose = () => {
        if (typeof window.removeEventListener === 'function') window.removeEventListener('focus', onFocus)
        document.removeEventListener('visibilitychange', onVisible)
      }
      if (typeof window.addEventListener === 'function') window.addEventListener('focus', onFocus)
      document.addEventListener('visibilitychange', onVisible)
      window[KEY_HL_VISIBLE] = { dispose }
    }

    function start(clientBus, services = {}) {
      const owner = { ...services, unsubscribe: null, unsubscribeSessions: null }
      if (notificationOwners.size === 0) {
        const previousDispose = window[KEY_POLL_DISPOSE]
        if (typeof previousDispose === 'function') previousDispose()
        if (window[KEY_POLL_TOKEN] instanceof AbortController) window[KEY_POLL_TOKEN].abort()
        const controller = new AbortController()
        notificationController = controller
        const snapshot = tools.createSnapshotRefresh(() => poll(controller.signal))
        refreshNotifications = snapshot.refresh
        window[KEY_POLL_TOKEN] = controller
        ensureHighlightListener()
        ensureHighlightVisibilitySync()
        ensureHighlightObserver()
        const highlightListener = window[KEY_HL_LISTENER]
        const highlightVisibility = window[KEY_HL_VISIBLE]
        const highlightObserver = window[KEY_HL_OBSERVER]
        const disposeAudio = startAudio()
        refreshSounds()
        const dispose = () => {
          if (stopNotifications !== dispose) return
          stopNotifications = null
          snapshot.dispose()
          controller.abort()
          closeClaimDb()
          disposeAudio()
          for (const item of notificationOwners) { item.unsubscribe?.(); item.unsubscribeSessions?.() }
          notificationOwners.clear()
          activeNotificationOwner = null
          notificationController = null
          pruneReminders(new Set())
          stopTitleBlink()
          highlightVisibility?.dispose()
          highlightObserver?.disconnect()
          if (typeof highlightListener === 'function') document.removeEventListener('click', highlightListener, true)
          if (typeof window[KEY_HL_FRAME] === 'number') cancelAnimationFrame(window[KEY_HL_FRAME])
          sessionHighlights.clear()
          clearSessionHighlightClasses()
          for (const [key, value] of [[KEY_HL_LISTENER, highlightListener], [KEY_HL_VISIBLE, highlightVisibility], [KEY_HL_OBSERVER, highlightObserver], [KEY_POLL_TOKEN, controller], [KEY_POLL_DISPOSE, dispose]]) {
            if (window[key] === value) delete window[key]
          }
        }
        stopNotifications = dispose
        window[KEY_POLL_DISPOSE] = dispose
      }
      notificationOwners.add(owner)
      if (activeNotificationOwner === null) activeNotificationOwner = owner
      owner.unsubscribe = startBusLoop(notificationController.signal, clientBus, owner)
      owner.unsubscribeSessions = owner.sessions?.list.subscribe(() => {
        if (activeNotificationOwner === owner && !notificationController?.signal.aborted) applySessionHighlights()
      })
      return () => {
        if (!notificationOwners.delete(owner)) return
        owner.unsubscribe()
        owner.unsubscribeSessions?.()
        if (activeNotificationOwner === owner) activeNotificationOwner = notificationOwners.values().next().value || null
        if (notificationOwners.size === 0) stopNotifications()
      }
    }

    // 分类通知开关串行提交链:请求按点击顺序入队,host 终值恒为最后一次点击;
    // 乐观回填由调用方先行(连点取反基点恒新),失败时拉取权威配置纠偏收敛 UI 与 host
    let categoryToggleChain = Promise.resolve()
    function submitCategoryToggle(category, checked, { apiImpl, onConfig, onError }) {
      const run = categoryToggleChain.catch(() => {}).then(async () => {
        try {
          onConfig(await apiImpl('/api/turn-notify/config', {
            method: 'POST',
            body: JSON.stringify({ enabled: { [category]: checked } }),
          }))
        } catch (error) {
          onError('开关失败:' + (error && error.message ? error.message : String(error)))
          try {
            onConfig(await apiImpl('/api/turn-notify/config'))
          } catch { /* 权威配置拉取失败则保持乐观值,由后续操作收敛 */ }
        }
      })
      categoryToggleChain = run
      return run
    }

    // ---- 设置面板 ----

    // 面板头部说明与行/开关悬停说明:面板级一句话放头部,行级细节全走 title
    const HEAD_HINT = '开关与选项自动保存。悬停选项查看说明。'
    const CATEGORY_HINTS = {
      completed: 'AI 单个回合正常结束，不代表整个任务一定完成',
      error: 'AI 回合因错误结束，或被手动停止',
      interrupted: '会话关闭时，未正常结束的回合被标记为中断',
      approval: 'AI 请求工具授权，或因等待审批结束回合',
      ask: 'AI 向用户提出问题，等待回答',
      'max-tokens': 'AI 回复达到输出长度上限',
    }

    // "太快的任务"预设档位:0=不忽略,其余毫秒
    const MIN_TURN_CHOICES = [0, 2000, 5000, 10000, 30000]

    // 浏览器系统通知权限的非正常态文案:title 与可见文本同源单点消费
    const PERMISSION_ALERTS = {
      unavailable: {
        text: '系统通知不可用',
        title: '当前环境未提供浏览器通知能力；请使用支持通知的浏览器与安全地址（HTTPS 或 localhost）',
      },
      denied: {
        text: '通知权限已被拒绝',
        title: '系统通知权限被浏览器拒绝:切走窗口时不会弹通知,可在浏览器地址栏权限或系统设置中恢复',
      },
      default: {
        text: '未开启系统通知',
        title: '尚未授权系统通知:点击"申请通知权限"开启,否则切走窗口时只靠标题闪烁提醒',
      },
    }
    function permissionAlert(permission) {
      if (typeof Notification === 'undefined') return PERMISSION_ALERTS.unavailable
      return PERMISSION_ALERTS[permission] || null
    }

    // 卡片头:仅标题,详细说明一律走行内控件 title
    function fieldHead(title) {
      return h('div', { className: 'tn-card__head' }, h('span', { className: 'tn-card__title' }, title))
    }

    // 面板表单占位:GET config 返回前展示;webhookUrl 原文随响应回显,表单所见即所存;
    // imAvailable 缺省为假,加载响应后 dsh-im 在场才渲染 IM 投递卡
    const DEFAULT_CONFIG = {
      webhookUrl: '',
      minTurnDurationMs: 5 * 1000,
      rootsOnly: true,
      suppressSubagentWake: true,
      hostNotify: false,
      hostNotifyFallback: false,
      folderRunningEnabled: true,
      enabled: Object.fromEntries(CATEGORIES.map((key) => [key, true])),
      imTargets: [],
      imEnabled: true,
    }

    const CSS = [
      '.tn-panel { --tn-accent:var(--dsw-alias-brand-primary); --tn-text:var(--dsw-alias-label-primary); --tn-text-sub:var(--dsw-alias-label-secondary); --tn-border:var(--dsw-alias-border-l2); --tn-bg:var(--dsw-alias-bg-layer-1); --tn-bg-sub:var(--dsw-alias-bg-layer-2); --tn-danger:var(--dsw-alias-state-error-primary); --tn-accent-deep:var(--dsw-alias-button-primary-hover); --tn-text-dim:var(--dsw-alias-label-tertiary); --tn-accent-wash:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent); display:flex; flex-direction:column; gap:16px; color:var(--tn-text); font-size:12px; line-height:1.5; }',
      '.tn-head { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }',
      '.tn-head__title { font-weight:600; font-size:16px; line-height:1.3; }',
      '.tn-head__hint { color:var(--tn-text-sub); font-size:12px; }',
      '.tn-tabs { display:flex; gap:4px; padding:4px; border-radius:8px; background:var(--tn-bg-sub); }',
      '.tn-tab { flex:1; min-width:0; border:none; background:transparent; cursor:pointer; padding:8px; border-radius:6px; font:inherit; text-align:center; color:var(--tn-text-sub); }',
      '.tn-tab:hover { color:var(--tn-text); background:var(--dsw-alias-interactive-bg-hover); }',
      '.tn-tab--on, .tn-tab--on:hover { background:var(--tn-bg); color:var(--tn-accent); font-weight:600; }',
      '.tn-tabpanel { display:flex; flex-direction:column; gap:16px; }',
      '.tn-card { border:1px solid var(--tn-border); border-radius:8px; padding:16px; background:var(--tn-bg); display:flex; flex-direction:column; gap:12px; }',
      '.tn-card__head { display:flex; align-items:center; }',
      '.tn-card__title { font-weight:600; font-size:14px; color:var(--tn-text); }',
      '.tn-field { display:grid; grid-template-columns:100px minmax(0,1fr); gap:8px 12px; align-items:center; }',
      '.tn-field__label { color:var(--tn-text-sub); }',
      '.tn-field__control { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }',
      '.tn-field__alert { color:var(--tn-danger); font-size:12px; }',
      '.tn-meta { color:var(--tn-text-sub); font-size:12px; }',
      '.tn-btn { cursor:pointer; border:1px solid var(--tn-border); background:transparent; color:var(--tn-text); border-radius:6px; min-height:28px; padding:4px 12px; font:inherit; }',
      '.tn-btn:hover { background:var(--dsw-alias-interactive-bg-hover); }',
      '.tn-btn--ghost { border-color:transparent; color:var(--tn-text-sub); }',
      '.tn-btn--ghost:hover, .tn-btn--danger:hover { color:var(--tn-danger); }',
      '.tn-select, .tn-input { background:var(--tn-bg); color:var(--tn-text); border:1px solid var(--tn-border); border-radius:6px; padding:4px 8px; min-height:28px; box-sizing:border-box; font:inherit; max-width:100%; }',
      '.tn-fill { flex:1; min-width:160px; }',
      '.tn-field__control > .tn-btn { flex-shrink:0; }',
      '.tn-subgroup { display:flex; flex-direction:column; gap:12px; padding-left:16px; border-left:2px solid var(--tn-border); }',
      '.tn-details { border-top:1px solid var(--tn-border); padding-top:8px; }',
      '.tn-details > summary { width:fit-content; max-width:100%; cursor:pointer; color:var(--tn-text-sub); padding:4px 0; }',
      '.tn-details__body { display:flex; flex-direction:column; gap:12px; padding:12px 0 4px; }',
      '.tn-panel :is(button,select,input,summary):focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }',
      '.tn-switch:has(input[type="checkbox"]:disabled) { opacity:0.5; cursor:not-allowed; }',
      '.tn-panel :is(button,select,input):disabled { opacity:0.5; cursor:not-allowed; }',
      '.tn-pills { display:flex; gap:8px; flex-wrap:wrap; }',
      '.tn-pill { cursor:pointer; border:1px solid var(--tn-border); border-radius:999px; min-height:28px; padding:4px 12px; font:inherit; background:var(--tn-bg); color:var(--tn-text-sub); }',
      '.tn-pill:hover { border-color:var(--tn-accent); }',
      '.tn-pill--on { background:var(--tn-accent-wash); border-color:var(--tn-accent); color:var(--tn-accent); font-weight:600; }',
      '.tn-chip { display:inline-flex; align-items:center; gap:2px; border:1px solid var(--tn-border); border-radius:999px; overflow:hidden; }',
      '.tn-chip__name { cursor:pointer; border:none; background:transparent; color:var(--tn-text); padding:4px 12px; font:inherit; }',
      '.tn-chip__name:hover { background:var(--dsw-alias-interactive-bg-hover); }',
      '.tn-chip__name--active { color:var(--tn-accent); font-weight:600; }',
      '.tn-chip__x { cursor:pointer; border:none; background:transparent; color:var(--tn-text-dim); padding:4px 8px; font:inherit; border-left:1px solid var(--tn-border); }',
      '.tn-chip__x:hover { color:var(--tn-danger); background:var(--dsw-alias-interactive-bg-hover); }',
      '.tn-switch { display:inline-flex; align-items:center; gap:8px; min-height:28px; cursor:pointer; }',
      '.tn-switch input[type="checkbox"] { position:absolute; opacity:0; width:0; height:0; }',
      '.tn-switch__track { position:relative; flex-shrink:0; width:34px; height:19px; border-radius:999px; box-sizing:border-box; background:var(--tn-bg-sub); border:1px solid var(--tn-border); transition:background 0.15s,border-color 0.15s; }',
      '.tn-switch__thumb { position:absolute; top:50%; left:2px; width:13px; height:13px; border-radius:50%; background:var(--tn-text-dim); transform:translateY(-50%); transition:left 0.15s,background 0.15s; }',
      '.tn-switch:hover .tn-switch__track { border-color:var(--tn-accent); }',
      '.tn-switch input[type="checkbox"]:checked + .tn-switch__track { background:var(--tn-accent); border-color:var(--tn-accent); }',
      '.tn-switch input[type="checkbox"]:checked + .tn-switch__track .tn-switch__thumb { left:17px; background:var(--tn-bg); }',
      '.tn-switch input[type="checkbox"]:focus-visible + .tn-switch__track { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }',
      '.tn-list { display:flex; flex-direction:column; width:100%; }',
      '.tn-list__item { display:flex; align-items:center; gap:8px; padding:8px 0; border-top:1px solid var(--tn-border); flex-wrap:wrap; }',
      '.tn-list__item:first-child { border-top:none; }',
      '.tn-list__grow { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--tn-text); }',
      '.tn-list__tag { color:var(--tn-text-dim); font-size:11px; }',
      '.tn-divider { width:100%; border:none; border-top:1px solid var(--tn-border); margin:4px 0; }',
      'input[type="range"].tn-range { accent-color:var(--tn-accent); flex:1; min-width:120px; }',
      '@media (max-width:600px) { .tn-field { grid-template-columns:1fr; gap:4px; } .tn-fill { min-width:0; width:100%; } .tn-card { padding:12px; } .tn-subgroup { padding-left:12px; } }',
      // 会话行高亮:背景在透明与“背景色与分类色各半混合”间脉冲;分类色用 dsw 语义变量,缺省回退具名色
      '.tn-sess-hl--completed { --tn-sess-color:var(--dsw-alias-state-success-primary); }',
      '.tn-sess-hl--error { --tn-sess-color:var(--dsw-alias-state-error-primary); }',
      '.tn-sess-hl--interrupted { --tn-sess-color:var(--dsw-alias-state-warn-primary); }',
      '.tn-sess-hl--approval { --tn-sess-color:var(--dsw-alias-state-warn-primary); }',
      '.tn-sess-hl--ask { --tn-sess-color:var(--dsw-alias-brand-primary); }',
      '.tn-sess-hl--max-tokens { --tn-sess-color:#9a6fe0; }',
      '.tn-sess-hl { animation:tn-sess-pulse 1.6s ease-in-out infinite; border-radius:8px; }',
      '@keyframes tn-sess-pulse {',
      '  0%,100% { background-color:transparent; }',
      '  50% { background-color:color-mix(in srgb, var(--tn-sess-color) 50%, var(--dsw-alias-bg-base) 50%); }',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  .tn-sess-hl { animation:none; background-color:color-mix(in srgb, var(--tn-sess-color) 50%, var(--dsw-alias-bg-base) 50%); }',
      '}',
      // 工作区文件夹运行标记:官方组容器自带 position:relative,运行点绝对定位于
      // 组容器左缘、垂直对齐组头行中线(行高 34px 之半即 top 17px,落于组头行左内边距
      // 区),零布局位移;图标着色让位官方 folderActive(展开含当前)态;色值取官方
      // ongoing 运行点的实际色值(--dsh-state-ongoing 在官方仅定义于其状态点组件局部,
      // 组容器上下文读不到,直接引用其回退源)
      'div[class$="_groupSection"][data-tn-folder-running] { --tn-fold-running-color: var(--dsw-static-deepseek-450); }',
      'div[class$="_groupSection"][data-tn-folder-running]::before { content:""; position:absolute; left:0; top:17px; width:5px; height:5px;',
      '  margin-top:-2.5px; border-radius:999px; background:var(--tn-fold-running-color);',
      '  animation:tn-fold-running-pulse 1.2s ease-in-out infinite; }',
      'div[class$="_groupSection"][data-tn-folder-running] span[class$="_folder"]:not([class$="_folderActive"]) { color:var(--tn-fold-running-color); }',
      '@keyframes tn-fold-running-pulse { 0%, 100% { opacity:1; } 50% { opacity:.35; } }',
      '@media (prefers-reduced-motion: reduce) { div[class$="_groupSection"][data-tn-folder-running]::before { animation:none; } }',
    ].join('\n')

    function h(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props || null].concat(children))
    }

    // 开关的 checkbox + 轨道对,checkbox 语义保留仅视觉隐藏
    function switchToggle(props) {
      return [
        h('input', { type: 'checkbox', ...props }),
        h('span', { className: 'tn-switch__track' }, h('span', { className: 'tn-switch__thumb' })),
      ]
    }

    // 表单行:左标签右控件的固定两列
    function field(label, control) {
      return h('div', { className: 'tn-field' },
        h('span', { className: 'tn-field__label' }, label),
        h('div', { className: 'tn-field__control' }, control),
      )
    }

    async function api(path, options) {
      const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
      return payload
    }

    function TurnNotifyApp() {
      const [sounds, setSounds] = useState([])
      const [busy, setBusy] = useState(false)
      const [config, setConfig] = useState(DEFAULT_CONFIG)
      const [configLoaded, setConfigLoaded] = useState(false)
      const [configError, setConfigError] = useState('')
      const [urlDraft, setUrlDraft] = useState('')
      const [permission, setPermission] = useState(notificationPermission())
      // IM 投递:botId 草稿与当前加载到的目标目录(目录只在勾选时消费,不直接决定已选)
      const [imBotIdDraft, setImBotIdDraft] = useState('')
      const [imCatalog, setImCatalog] = useState(null)
      // 分类映射的全局镜像:直接由全局配置/映射响应回填,不再依赖轮询变量驱动渲染
      const [mapping, setMappingState] = useState({})
      // 本地作用域镜像:开关与映射改动即写 localStorage,仅作用域为当前域名
      const [localMode, setLocalMode] = useState(() => localMappingEnabled())
      const [localMapping, setLocalMappingState] = useState(() => readLocalMapping())
      // 分类提示音镜像:pill 点击即写 localStorage,发声链路直读不依赖本 state
      const [soundCategories, setSoundCategoriesState] = useState(() => readSoundCategories())
      const [pageSoundCategories, setPageSoundCategoriesState] = useState(() => readPageSoundCategories())
      // 页内提示音场景映射镜像:select 变更即写 localStorage,仅存本机
      const [pageMapping, setPageMappingState] = useState(() => readPageMapping())
      const [toastAppearance, setToastAppearance] = useState(readToastAppearance)
      // 待确认上传:文件选中且解码校验通过后挂起,用户试听并确认才落盘
      const [pendingUploads, setPendingUploads] = useState([])
      // 面板分区:tab 切换仅显隐,不触碰任何已装载状态
      const [tab, setTab] = useState('方式')
      const [browserPrefs, setBrowserPrefs] = useState(() => ({
        sound: localGet(KEY_SOUND) !== '0',
        toast: localGet(KEY_TOAST) !== '0',
        system: localGet(KEY_SYSTEM) !== '0',
        pageSound: localGet(KEY_PAGE_SOUND) === '1',
        dnd: localGet(KEY_DND) !== '0',
        foregroundSystem: readForegroundSystem(),
        blink: localGet(KEY_DEGRADE_HINT) !== '0',
        highlight: readSessionHighlightEnabled(),
      }))
      const [soundVolume, setSoundVolume] = useState(volume)
      const [webhookStatus, setWebhookStatus] = useState('')
      const [testing, setTesting] = useState('')

      function setBrowserPref(name, key, checked) {
        setBrowserPrefs((current) => ({ ...current, [name]: checked }))
        localSet(key, checked ? '1' : '0')
      }

      async function loadConfig() {
        setConfigError('')
        try {
          const res = await api('/api/turn-notify/config')
          setConfig({ ...DEFAULT_CONFIG, ...res })
          setMappingState(res.soundMapping || {})
          setUrlDraft(typeof res.webhookUrl === 'string' ? res.webhookUrl : '')
          setConfigLoaded(true)
        } catch (error) { setConfigError(error.message) }
      }

      useEffect(() => {
        api('/api/turn-notify/sounds').then((res) => setSounds(res.sounds || [])).catch(() => {})
        void loadConfig()
      }, [])

      useEffect(() => {
        const syncPreferences = (event) => {
          const keys = [KEY_SOUND, KEY_TOAST, KEY_SYSTEM, KEY_PAGE_SOUND, KEY_DND, KEY_FOREGROUND_SYSTEM, KEY_DEGRADE_HINT, KEY_VOLUME, KEY_TOAST_APPEARANCE, KEY_SOUND_CATEGORIES, KEY_PAGE_SOUND_CATEGORIES, KEY_MAPPING_LOCAL, KEY_MAPPING, KEY_PAGE_MAPPING, KEY_SESSION_HL]
          if (event.key !== null && !keys.includes(event.key)) return
          setToastAppearance(readToastAppearance())
          setBrowserPrefs({
            sound: localGet(KEY_SOUND) !== '0', toast: localGet(KEY_TOAST) !== '0',
            system: localGet(KEY_SYSTEM) !== '0', pageSound: localGet(KEY_PAGE_SOUND) === '1',
            dnd: localGet(KEY_DND) !== '0', blink: localGet(KEY_DEGRADE_HINT) !== '0',
            foregroundSystem: readForegroundSystem(),
            highlight: readSessionHighlightEnabled(),
          })
          setSoundVolume(volume())
          setSoundCategoriesState(readSoundCategories())
          setPageSoundCategoriesState(readPageSoundCategories())
          setLocalMode(localMappingEnabled())
          setLocalMappingState(readLocalMapping())
          setPageMappingState(readPageMapping())
        }
        window.addEventListener('storage', syncPreferences)
        return () => window.removeEventListener('storage', syncPreferences)
      }, [])

      // 操作反馈出口:统一浮出通知,成功 ok / 失败 error;toast 模块缺失降级 console
      const patch = (text, kind) => {
        if (toast) toast(text, { kind: kind === 'error' ? 'error' : 'ok' })
        else console.warn('[dsh-turn-notify] ' + text)
      }

      async function onPickFiles(files) {
        if (files.length === 0) return
        setBusy(true)
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
        setRenameDraft(sound.name || sound.id)
      }

      function cancelRename() {
        setRenamingId(null)
        setRenameDraft('')
      }

      async function renameSound(sound) {
        setBusy(true)
        try {
          const res = await api('/api/turn-notify/sound', { method: 'PUT', body: JSON.stringify({ id: sound.id, name: renameDraft }) })
          decodedCache.delete(sound.id)
          patch('已重命名为 ' + res.name)
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

      // 作用域切换:开=映射改动只写本机 localStorage,读合并;关=读写全走全局,本地数据保留但休眠
      function toggleLocalMapping(checked) {
        setLocalMode(checked)
        localSet(KEY_MAPPING_LOCAL, checked ? '1' : '0')
      }

      // 分类提示音切换:显式 false=静音,删除键=恢复出声;发声链路每次直读 localStorage
      function toggleSoundCategory(category) {
        const next = { ...soundCategories }
        if (next[category] === false) delete next[category]
        else next[category] = false
        setSoundCategoriesState(next)
        localSet(KEY_SOUND_CATEGORIES, JSON.stringify(next))
      }

      // 页内提示音分类切换:与提示音分类同构,独立存储互不影响
      function togglePageSoundCategory(category) {
        const next = { ...pageSoundCategories }
        if (next[category] === false) delete next[category]
        else next[category] = false
        setPageSoundCategoriesState(next)
        localSet(KEY_PAGE_SOUND_CATEGORIES, JSON.stringify(next))
      }

      // 页内提示音场景映射:空值删除键(沿用通知映射),非空(含内置音名/上传 id)覆盖
      function setPageMappingCategory(category, id) {
        const next = { ...pageMapping }
        if (id.length === 0) delete next[category]
        else next[category] = id
        setPageMappingState(next)
        localSet(KEY_PAGE_MAPPING, JSON.stringify(next))
      }

      async function setMapping(category, id) {
        // 本地模式:空串为显式内置默认,同样保留为键值
        if (localMode) {
          const next = { ...localMapping, [category]: id }
          setLocalMappingState(next)
          localSet(KEY_MAPPING, JSON.stringify(next))
          patch(CATEGORY_LABELS[category] + ' 音效已更新(仅存本机浏览器)')
          return
        }
        try {
          const res = await api('/api/turn-notify/mapping', { method: 'POST', body: JSON.stringify({ category, id }) })
          setMappingState(res.soundMapping || {})
          patch(CATEGORY_LABELS[category] + ' 音效已更新')
        } catch (error) {
          patch('映射失败:' + (error && error.message ? error.message : String(error)), 'error')
        }
      }

      // 按字段提交:字段值与已存配置一致时不发请求;成功静默(值未变),失败浮出错误
      async function saveConfigFields(fields) {
        if (!configLoaded) {
          patch('配置尚未加载,不能保存(刷新页面重试)', 'error')
          return
        }
        setBusy(true)
        try {
          const res = await api('/api/turn-notify/config', { method: 'POST', body: JSON.stringify(fields) })
          setConfig({ ...DEFAULT_CONFIG, ...res })
          if (res.soundMapping) setMappingState(res.soundMapping)
          if ('webhookUrl' in fields) setUrlDraft(typeof res.webhookUrl === 'string' ? res.webhookUrl : '')
        } catch (error) {
          patch('保存失败:' + (error && error.message ? error.message : String(error)), 'error')
        } finally { setBusy(false) }
      }

      async function saveWebhook() {
        if (!configLoaded || busy || testing === 'webhook') return
        setBusy(true)
        setWebhookStatus('正在保存地址…')
        try {
          const res = await api('/api/turn-notify/config', {
            method: 'POST', body: JSON.stringify({ webhookUrl: urlDraft.trim() }),
          })
          setConfig({ ...DEFAULT_CONFIG, ...res })
          setUrlDraft(res.webhookUrl || '')
          setWebhookStatus(res.webhookUrl ? '地址已保存，可以测试推送' : '地址已清除，推送已停用')
        } catch (error) {
          setWebhookStatus('保存失败：' + error.message)
        } finally { setBusy(false) }
      }

      async function runTest(channel, action) {
        if (testing) return
        setTesting(channel)
        try { await action() } finally { setTesting('') }
      }

      // 音效页"试听当前配置":播放任务完成分类实际生效的声音(与被删的测试页"测试声音"同语义)
      function previewCurrentSound() {
        const sound = resolveSound('completed', effective, soundIds)
        playAudible(sound).then((result) => {
          patch(result.ok
            ? '已播放:' + describeSound(sound) + ',没听到请检查系统音量与输出设备'
            : '未播放:' + result.reason, result.ok ? 'ok' : 'error')
        })
      }

      // 独立试听页内音效，不改变通知偏好
      function previewCurrentPageSound() {
        const sound = resolveSound('completed', mergeMapping(effective, pageMapping), soundIds)
        playAudible(sound).then((result) => {
          patch(result.ok
            ? '已试听页内提示音：' + describeSound(sound)
            : '未播放:' + result.reason, result.ok ? 'ok' : 'error')
        })
      }

      // 开关字段变更即存:乐观回填,失败由响应回滚
      function setConfigField(name, value) {
        setConfig((current) => ({ ...current, [name]: value }))
        void saveConfigFields({ [name]: value })
      }

      async function clearWebhook() {
        if (!configLoaded || busy || testing === 'webhook') return
        setBusy(true)
        setWebhookStatus('正在清除地址…')
        try {
          const res = await api('/api/turn-notify/config', { method: 'POST', body: JSON.stringify({ webhookUrl: '' }) })
          setConfig({ ...DEFAULT_CONFIG, ...res })
          if (res.soundMapping) setMappingState(res.soundMapping)
          setUrlDraft(typeof res.webhookUrl === 'string' ? res.webhookUrl : '')
          setWebhookStatus('地址已清除，推送已停用')
        } catch (error) {
          setWebhookStatus('清除失败：' + error.message)
        } finally { setBusy(false) }
      }

      // 分类通知开关:乐观回填为连点提供正确取反基点,提交交由模块级串行链收敛
      function toggleCategory(category, checked) {
        setConfig((prev) => ({ ...prev, enabled: { ...prev.enabled, [category]: checked } }))
        submitCategoryToggle(category, checked, {
          apiImpl: api,
          onConfig: (res) => {
            setConfig({ ...DEFAULT_CONFIG, ...res })
            if (res.soundMapping) setMappingState(res.soundMapping)
          },
          onError: (text) => patch(text, 'error'),
        })
      }

      async function toggleDesktopNotification(checked) {
        if (!configLoaded || busy) return
        const previous = { hostNotify: config.hostNotify, hostNotifyFallback: config.hostNotifyFallback }
        setBusy(true)
        setConfig(current => ({ ...current, hostNotify: checked, hostNotifyFallback: false }))
        try {
          const res = await api('/api/turn-notify/config', {
            method: 'POST', body: JSON.stringify({ hostNotify: checked, hostNotifyFallback: false }),
          })
          setConfig(current => ({ ...current, hostNotify: res.hostNotify, hostNotifyFallback: res.hostNotifyFallback }))
        } catch (error) {
          setConfig(current => ({ ...current, ...previous }))
          patch('桌面通知设置未保存：' + error.message, 'error')
        } finally { setBusy(false) }
      }

      // 文件夹运行标记开关:乐观回填,服务端失败回滚;变更刷新页面生效(标记
      // 注入在插件激活时按配置装配)
      async function toggleFolderRunning(checked) {
        const previous = config.folderRunningEnabled
        setConfig({ ...config, folderRunningEnabled: checked })
        try {
          const res = await api('/api/turn-notify/config', { method: 'POST', body: JSON.stringify({ folderRunningEnabled: checked }) })
          setConfig({ ...DEFAULT_CONFIG, ...res })
          patch('工作区文件夹运行标记已' + (res.folderRunningEnabled !== false ? '启用' : '停用') + ',刷新页面后生效')
        } catch (error) {
          setConfig((prev) => ({ ...prev, folderRunningEnabled: previous }))
          patch('切换失败:' + (error && error.message ? error.message : String(error)), 'error')
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

      function previewNotificationStyle() {
        if (!toast || !browserPrefs.toast) return
        previewPageNotification()
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
          patch('Notification 不可用或未授权(HTTP 非回环地址或曾被拒绝),已改为标题闪烁', 'error')
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

      // 宿主桌面通知通道单独测试:等待 spawn 结束,真实结果随响应返回
      async function testHostNotify() {
        try {
          const result = await api('/api/turn-notify/test-host', { method: 'POST' })
          patch(result.ok ? '桌面通知命令已执行，请检查运行 DSH 的电脑（' + result.detail + '）' : '桌面通知触发失败：' + result.detail, result.ok ? 'ok' : 'error')
        } catch (error) {
          patch('发送失败:' + (error && error.message ? error.message : String(error)), 'error')
        }
      }

      async function testWebhook() {
        if (!configLoaded || busy || !urlDraft.trim()) return
        // 测试只消费成功保存的配置，失败草稿不得测试旧地址
        if (urlDraft.trim() !== String(config.webhookUrl || '').trim()) {
          setWebhookStatus('请先保存地址，再测试推送')
          return
        }
        try {
          setWebhookStatus('正在发送测试请求…')
          const result = await api('/api/turn-notify/test-webhook', { method: 'POST' })
          setWebhookStatus(result.ok ? '接收端已接受测试请求（' + result.detail + '）' : '测试失败：' + result.detail)
        } catch (error) {
          setWebhookStatus('测试失败：' + (error && error.message ? error.message : String(error)))
        }
      }

      // IM 目标加载:目录来自 dsh-im 已保存目标;失败(离线/ID 复制错误)如实展示错误码
      async function loadImTargets(botIdOverride) {
        const botId = (typeof botIdOverride === 'string' ? botIdOverride : imBotIdDraft).trim()
        if (botId.length === 0) {
          patch('请先粘贴 Bot ID(设置页 IM机器人 卡片右上角齿轮)', 'error')
          return
        }
        setBusy(true)
        try {
          const res = await api('/api/turn-notify/im-targets?botId=' + encodeURIComponent(botId))
          setImCatalog({ botId, targets: res.targets || [] })
          patch('已加载 ' + (res.targets || []).length + ' 个目标,勾选即保存')
        } catch (error) {
          patch('加载失败:' + (error && error.message ? error.message : String(error)), 'error')
        } finally { setBusy(false) }
      }

      // 已绑 bot chips 由 imBoundBotIds 去重(见 LOGIC 段同源函数)
      const imBoundBots = imBoundBotIds(config.imTargets)

      // 勾选即存:与分类开关同模式,列表整体替换,连续操作以最新一次请求为准;
      // seq 守卫须跨渲染存活(useRef),组件体内 let 声明每次渲染重置使守卫失效
      const imPersistSeqRef = useRef(0)
      async function persistImTargets(next, okMessage) {
        imPersistSeqRef.current += 1
        const seq = imPersistSeqRef.current
        setConfig({ ...config, imTargets: next })
        try {
          const res = await api('/api/turn-notify/config', { method: 'POST', body: JSON.stringify({ imTargets: next }) })
          if (seq === imPersistSeqRef.current) {
            setConfig({ ...DEFAULT_CONFIG, ...res })
            if (res.soundMapping) setMappingState(res.soundMapping)
            if (okMessage !== undefined) patch(okMessage)
          }
        } catch (error) {
          patch('IM 目标保存失败:' + (error && error.message ? error.message : String(error)), 'error')
        }
      }

      function toggleImTarget(botId, target, checked) {
        void persistImTargets(toggleImTargetList(config.imTargets, botId, target.targetId, checked))
      }

      function removeImTarget(item) {
        void persistImTargets(removeImTargetFromList(config.imTargets, item.botId, item.targetId))
      }

      // IM 总开关:目标绑定保留,关闭仅停投递;乐观回填,失败回滚
      function toggleImEnabled(checked) {
        setConfig((prev) => ({ ...prev, imEnabled: checked }))
        api('/api/turn-notify/config', { method: 'POST', body: JSON.stringify({ imEnabled: checked }) })
          .then((res) => setConfig({ ...DEFAULT_CONFIG, ...res }))
          .catch((error) => {
            // 回滚到请求发出前的取值:两次异步 setConfig 闭包各自读到已更新的 prev
            setConfig((prev) => ({ ...prev, imEnabled: !prev.imEnabled }))
            patch('IM 开关切换失败:' + (error && error.message ? error.message : String(error)), 'error')
          })
      }

      // 取消注册:移除该 bot 全部目标;bot 在 dsh-im 已删除时借此清理残留绑定
      function unregisterImBot(botId) {
        void persistImTargets(
          unregisterImBotList(config.imTargets, botId),
          '已取消注册 ' + botId,
        )
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
            ? '平台已接受测试请求（' + result.results.length + ' 个对象）'
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

      // 生效映射与死链:合并全局镜像与本地镜像(开关关时本地休眠不参与)
      const soundIds = sounds.map((sound) => sound.id)
      const effective = mergeMapping(mapping, localMode ? localMapping : {})
      const deadIds = deadCustomIds(effective, soundIds)

      // 分类试听:播放该分类当前实际生效的音效(自定义 / 内置 / 失效回落),与通知真实发声同语义;
      // 命中死链时回执归因,引导重传或改选
      function previewCategory(category) {
        const sound = resolveSound(category, effective, soundIds)
        playAudible(sound).then((result) => {
          if (!result.ok) patch(CATEGORY_LABELS[category] + ' 试听未播放:' + result.reason, 'error')
          else if (deadIds.indexOf(effective[category]) >= 0) patch('映射 ' + effective[category] + ' 已失效,已播放内置默认,请重新上传音效或改选映射', 'error')
          else patch('已试听 ' + CATEGORY_LABELS[category] + ':' + describeSound(sound))
        })
      }

      // 页内场景映射:通知生效映射为底、页内显式配置覆盖,与聚焦补位音真实发声同语义;
      // 死链按合并视图计算:页内自身死链(删音效不清理本机键)与继承的通知死链都需呈现
      const effectivePageMapping = mergeMapping(effective, pageMapping)
      const pageDeadIds = deadCustomIds(effectivePageMapping, soundIds)

      function previewPageCategory(category) {
        const sound = resolveSound(category, effectivePageMapping, soundIds)
        playAudible(sound).then((result) => {
          if (!result.ok) patch(CATEGORY_LABELS[category] + ' 试听未播放:' + result.reason, 'error')
          else if (pageDeadIds.indexOf(effectivePageMapping[category]) >= 0) patch('映射 ' + effectivePageMapping[category] + ' 已失效,已播放内置默认,请重新上传音效或改选映射', 'error')
          else patch('已试听页内 ' + CATEGORY_LABELS[category] + ':' + describeSound(sound))
        })
      }

      // 两个场景映射的选项尾段同集,差异仅在首项(通知=内置默认,页内=沿用通知音效)与死链呈现
      const toneOptionTail = Object.keys(TONE_LABELS).map((name) => h('option', { key: name, value: name }, '内置 · ' + TONE_LABELS[name]))
        .concat(sounds.map((sound) => h('option', { key: sound.id, value: sound.id }, '上传 · ' + (sound.name || sound.id))))
        .concat(deadIds.map((id) => h('option', { key: id, value: id }, '失效 · ' + id)))

      const soundOptions = [h('option', { key: '', value: '' }, '内置默认')].concat(toneOptionTail)

      // 页内场景选项:首项为沿用通知音效,滤除通知死链防与页内死链尾段重复,呈现以页内合并视图为准
      const pageSoundOptions = [h('option', { key: '', value: '' }, '沿用通知音效')].concat(
        toneOptionTail.filter((option) => deadIds.indexOf(option.props.value) < 0),
      ).concat(pageDeadIds.map((id) => h('option', { key: id, value: id }, '失效 · ' + id)))

      const tabs = [
        { id: '方式', label: '提醒方式' },
        { id: '规则', label: '通知规则' },
        { id: '音效', label: '音效' },
        { id: '推送', label: '外部推送' },
      ]
      const activeTab = tabs.some((item) => item.id === tab) ? tab : tabs[0].id
      const toggle = (label, title, checked, onChange, disabled = false) => h('label', { className: 'tn-meta tn-switch', title },
        ...switchToggle({ checked, disabled, 'aria-label': label, onChange: (e) => onChange(e.target.checked) }),
        h('span', null, label))
      const testButton = (label, title, onClick, disabled = false, accessibleName = label) => h('button', {
        type: 'button', className: 'tn-btn', title, disabled, 'aria-label': accessibleName,
        onClick: () => { if (!disabled) void onClick() },
      }, label)
      const details = (label, children) => h('details', { className: 'tn-details' },
        h('summary', null, label), h('div', { className: 'tn-details__body' }, children))
      const categoryButtons = (selected, onToggle, disabled = false) => h('div', { className: 'tn-pills' },
        CATEGORIES.map((category) => h('button', {
          type: 'button', key: category, disabled,
          className: 'tn-pill' + (selected(category) ? ' tn-pill--on' : ''),
          'aria-pressed': selected(category), title: CATEGORY_HINTS[category],
          onClick: () => { if (!disabled) onToggle(category) },
        }, CATEGORY_LABELS[category])))
      const urlDirty = urlDraft.trim() !== (config.webhookUrl || '')
      const urlValid = (() => {
        try { return ['http:', 'https:'].includes(new URL(urlDraft.trim()).protocol) } catch { return false }
      })()

      return h('div', { className: 'tn-panel' },
        h('div', { className: 'tn-head' },
          h('span', { className: 'tn-head__title' }, '消息通知'),
          h('span', { className: 'tn-head__hint' }, HEAD_HINT),
        ),
        !configLoaded ? h('div', { className: 'tn-field__control', role: configError ? 'alert' : 'status' },
          h('span', { className: 'tn-meta' }, configError ? '配置加载失败：' + configError : '正在加载共享设置…'),
          configError ? testButton('重新加载', '重新获取共享设置，本浏览器偏好仍可编辑。', loadConfig) : null,
        ) : null,
        h('div', { className: 'tn-tabs', role: 'tablist' },
          tabs.map((item) => h('button', {
            key: item.id,
            type: 'button',
            role: 'tab',
            id: 'tn-tab-' + item.id,
            'aria-controls': 'tn-panel-' + item.id,
            'aria-selected': activeTab === item.id,
            tabIndex: activeTab === item.id ? 0 : -1,
            className: 'tn-tab' + (activeTab === item.id ? ' tn-tab--on' : ''),
            onClick: () => setTab(item.id),
            onKeyDown: (e) => {
              const index = tabs.indexOf(item)
              const target = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key]
              if (target === undefined) return
              e.preventDefault()
              setTab(tabs[target].id)
              e.currentTarget.parentElement.querySelectorAll('[role="tab"]')[target].focus()
            },
          }, item.label)),
        ),
        h('div', { className: 'tn-tabpanel', role: 'tabpanel', id: 'tn-panel-' + activeTab, 'aria-labelledby': 'tn-tab-' + activeTab, key: activeTab },
          activeTab === '规则' ? [
            h('section', { className: 'tn-card' },
              fieldHead('通知事件'),
              field('接收事件', categoryButtons(category => config.enabled[category], category => void toggleCategory(category, !config.enabled[category]), !configLoaded)),
              h('span', { className: 'tn-meta' }, '选中的事件用于所有提醒方式'),
              details('高级过滤', [
                field('最短执行时长', h('select', {
                  className: 'tn-select', 'aria-label': '最短执行时长', value: String(config.minTurnDurationMs), disabled: !configLoaded || busy,
                  title: '执行时长少于此值时，不发送回合结束类通知（含出错、中断和审批阻塞）；即时审批请求与 AI 提问不受影响。适用于所有提醒方式。',
                  onChange: (e) => setConfigField('minTurnDurationMs', Number(e.target.value)),
                }, [...new Set([...MIN_TURN_CHOICES, config.minTurnDurationMs])].sort((a, b) => a - b).map(ms => h('option', { key: ms, value: ms }, ms === 0 ? '不过滤' : '少于 ' + ms / 1000 + ' 秒不通知')))),
                toggle('仅通知主会话', '不发送子代理会话自身的通知，适用于前台与后台委托；不等同于过滤所有后台任务。', config.rootsOnly, value => setConfigField('rootsOnly', value), !configLoaded || busy),
                toggle('减少委托过程通知', '仅过滤任务完成事件：主会话仍等待后台子代理，或被已结束的子代理唤醒继续工作的回合。出错、审批和提问不受影响。', config.suppressSubagentWake, value => setConfigField('suppressSubagentWake', value), !configLoaded || busy),
              ]),
            ),
            h('section', { className: 'tn-card' },
              fieldHead('使用页面时'),
              toggle('专注时减少打扰', '页面可见且有焦点时，暂停通知提示音、系统通知与标题闪烁；页内通知及其提示音保留。连续 5 分钟未操作后恢复。macOS 桌面版可保留无声系统通知。外部推送不受影响。', browserPrefs.dnd, value => setBrowserPref('dnd', KEY_DND, value)),
              h('span', { className: 'tn-meta' }, '仅当前浏览器'),
              details('待处理事件的再次提醒', h('span', { className: 'tn-meta' }, '审批或 AI 提问未处理时，可能在 10 分钟后再次提醒。再次提醒独立于上述浏览器声音、页内通知与静默偏好。')),
            ),
          ] : null,
          activeTab === '方式' ? [
            h('section', { className: 'tn-card' },
              fieldHead('浏览器提醒'),
              field('通知提示音', [
                toggle('播放通知提示音', '未触发专注静默时播放；仅控制通知提示音，页内提示音独立设置。音色在“音效”中选择。', browserPrefs.sound, value => setBrowserPref('sound', KEY_SOUND, value)),
                testButton('试听提示音', '试听任务完成事件的音效；只播放声音，不启用通知。', previewCurrentSound, soundVolume === 0),
              ]),
              field('通知音量', [
                h('input', { className: 'tn-range', type: 'range', min: 0, max: 1, step: 0.05, value: soundVolume,
                  'aria-label': '通知音量', 'aria-valuetext': Math.round(soundVolume * 100) + '%',
                  title: '通知提示音与页内提示音共用此音量；仅当前浏览器。',
                  onChange: (e) => { setSoundVolume(Number(e.target.value)); localSet(KEY_VOLUME, e.target.value) },
                }),
                h('output', { className: 'tn-meta' }, soundVolume === 0 ? '已静音' : Math.round(soundVolume * 100) + '%'),
              ]),
              details('按事件设置提示音', field('发声事件', categoryButtons(category => soundCategories[category] !== false, toggleSoundCategory, !browserPrefs.sound))),
              h('hr', { className: 'tn-divider' }),
              field('页内通知', toggle('显示页内通知', '在页面内显示通知卡片，6 秒后自动消失；点击可打开对应会话。', browserPrefs.toast, value => setBrowserPref('toast', KEY_TOAST, value), !toast)),
              !toast ? h('span', { className: 'tn-meta' }, '页内通知组件不可用，请检查插件依赖') : null,
              h('div', { className: 'tn-subgroup' },
                field('通知样式', [
                  h('select', {
                    className: 'tn-select', 'aria-label': '页内提示样式', value: toastAppearance, disabled: !browserPrefs.toast || !toast,
                    title: '两种样式均跟随主题；选择后新通知立即采用。',
                    onChange: (e) => { localSet(KEY_TOAST_APPEARANCE, e.target.value); setToastAppearance(readToastAppearance()) },
                  }, Object.entries(TOAST_APPEARANCES).map(([value, label]) => h('option', { key: value, value }, label))),
                  testButton('预览样式', '显示当前样式的示例通知，不播放声音。', previewNotificationStyle, !browserPrefs.toast || !toast),
                ]),
                field('页内提示音', [
                  toggle('页内提示音', '随页内通知补充播放：通知提示音未播放时才发声，两者每条通知最多播放一种；不限于查看页面时。', browserPrefs.pageSound, value => setBrowserPref('pageSound', KEY_PAGE_SOUND, value), !browserPrefs.toast || !toast),
                  testButton('试听页内音', '试听任务完成事件的页内音效；不启用通知或更改开关。', previewCurrentPageSound, soundVolume === 0),
                ]),
                !browserPrefs.toast ? h('span', { className: 'tn-meta' }, '启用页内通知后，页内提示音才会生效') : null,
                details('按事件设置页内声音', field('发声事件', categoryButtons(category => pageSoundCategories[category] !== false, togglePageSoundCategory, !browserPrefs.toast || !browserPrefs.pageSound || !toast))),
              ),
              h('hr', { className: 'tn-divider' }),
              field('系统通知', [
                toggle('显示系统通知', '由当前浏览器发送系统通知，需要授权；专注时减少打扰会抑制通知，macOS 桌面版可保留无声通知。', browserPrefs.system, value => setBrowserPref('system', KEY_SYSTEM, value)),
                (typeof Notification === 'undefined' || permission !== 'granted')
                  ? h('span', { className: 'tn-field__alert', title: permissionAlert(permission).title }, permissionAlert(permission).text) : null,
                typeof Notification !== 'undefined' && permission === 'default'
                  ? testButton('申请通知权限', '允许当前浏览器显示系统通知。', requestPermission) : null,
                testButton('测试系统通知', '5 秒后发送，请切换到其他应用；测试直接验证浏览器能力。', testSystemNotification, !browserPrefs.system || typeof Notification === 'undefined' || permission === 'denied'),
              ]),
              toggle('专注时保留无声系统通知', '仅桌面版生效：专注静默时仍发送无声系统通知，不解除提示音静默；macOS 默认开启，其他平台默认关闭。仍须系统通知开关、授权与事件路由允许。仅当前浏览器。', browserPrefs.foregroundSystem, value => setBrowserPref('foregroundSystem', KEY_FOREGROUND_SYSTEM, value), !browserPrefs.system),
              details('系统通知备用提醒', toggle('通知不可用时闪烁标题', '系统通知未获授权或不可用时，在后台闪烁标签页标题；返回页面后停止。', browserPrefs.blink, value => setBrowserPref('blink', KEY_DEGRADE_HINT, value), !browserPrefs.system)),
              h('span', { className: 'tn-meta' }, '以上设置仅当前浏览器生效'),
            ),
            h('section', { className: 'tn-card' },
              fieldHead('浏览器关闭后的提醒'),
              field('桌面通知', [
                toggle('后台桌面通知', '由运行 DSH 的电脑显示，所有浏览器离线后接管；任意设备仍连接页面时由浏览器提醒。需要 DSH 持续运行并具有桌面环境。', config.hostNotify || config.hostNotifyFallback, toggleDesktopNotification, !configLoaded || busy),
                testButton('测试桌面通知', '立即触发运行 DSH 的电脑上的桌面通知，不模拟浏览器关闭。', () => runTest('host', testHostNotify), !configLoaded || busy || Boolean(testing) || !(config.hostNotify || config.hostNotifyFallback)),
              ]),
              h('span', { className: 'tn-meta' }, '通知显示在运行 DSH 的电脑上'),
              testButton('配置外部推送', '配置浏览器关闭后仍可使用的 webhook 或聊天推送。', () => setTab('推送')),
            ),
            h('section', { className: 'tn-card' },
              fieldHead('侧边栏状态'),
              field('通知状态', toggle('通知会话闪烁', '通知对应会话以颜色闪烁；查看会话后停止，运行中的会话不闪烁。仅当前浏览器。', browserPrefs.highlight, value => { setBrowserPrefs(current => ({ ...current, highlight: value })); writeSessionHighlightEnabled(value) })),
              field('运行状态', [
                h('label', { className: 'tn-meta tn-switch', title: FOLD_SWITCH_TITLE },
                  ...switchToggle({ checked: config.folderRunningEnabled !== false, 'aria-label': '工作区运行标记', disabled: !configLoaded || busy, onChange: (e) => void toggleFolderRunning(e.target.checked) }),
                  h('span', null, '工作区运行标记')),
                h('span', { className: 'tn-meta' }, '所有浏览器 · 刷新后生效'),
              ]),
            ),
          ] : null,
          activeTab === '音效' ? [
            h('section', { className: 'tn-card' },
              fieldHead('事件音效'),
              field('保存范围', toggle('仅此浏览器使用独立音效', '开启后，音色选择只保存在当前浏览器、当前站点；未单独选择的事件沿用共享配置。关闭后本地选择保留。', localMode, toggleLocalMapping)),
              h('span', { className: 'tn-meta' }, localMode ? '当前浏览器独立配置' : '共享音效配置（所有浏览器）'),
              CATEGORIES.map(category => field(CATEGORY_LABELS[category], [
                h('select', {
                  className: 'tn-select tn-fill', value: effective[category] || '', disabled: !configLoaded, 'aria-label': CATEGORY_LABELS[category] + '音效',
                  title: '选择该事件的通知音效，自动保存；试听不改变通知开关。',
                  onChange: (e) => void setMapping(category, e.target.value),
                }, soundOptions),
                testButton('试听', '播放此事件当前生效的音效；不可用的音效改用内置默认。', () => previewCategory(category), soundVolume === 0, '试听' + CATEGORY_LABELS[category] + '提示音'),
                config.enabled[category] === false ? h('span', { className: 'tn-meta' }, '此事件未启用通知') : null,
              ])),
              !configLoaded ? h('span', { className: 'tn-meta' }, '共享音效加载后可编辑事件音效') : null,
              details('单独设置页内提示音效', [
                h('span', { className: 'tn-meta' }, '仅当前浏览器；未单独选择时沿用事件音效'),
                CATEGORIES.map(category => field(CATEGORY_LABELS[category], [
                  h('select', {
                    className: 'tn-select tn-fill', value: pageMapping[category] || '', 'aria-label': CATEGORY_LABELS[category] + '页内音效',
                    title: '页内提示音的独立音色；留空沿用上方事件音效。',
                    onChange: (e) => setPageMappingCategory(category, e.target.value),
                  }, pageSoundOptions),
                  testButton('试听', '只试听此事件的页内音效，不启用页内通知。', () => previewPageCategory(category), soundVolume === 0, '试听' + CATEGORY_LABELS[category] + '页内提示音'),
                ])),
              ]),
            ),
            h('div', { className: 'tn-card' },
              fieldHead('音效库'),
              field('添加音效', h('input', {
                type: 'file', multiple: true, accept: AUDIO_EXTS.map((ext) => '.' + ext).join(','), disabled: busy, 'aria-label': '添加音效',
                title: '支持 WAV、MP3、OGG；单个文件上限 2 MB，音效库总计 10 MB。选择后可试听，点击上传才保存到共享音效库。',
                onChange: (e) => {
                  const files = e.target.files ? Array.from(e.target.files) : []
                  e.target.value = ''
                  void onPickFiles(files)
                },
              })),
              pendingUploads.map((item, index) => h('div', { className: 'tn-list__item', key: 'pending-' + index },
                h('span', { className: 'tn-list__grow' }, item.name),
                h('span', { className: 'tn-list__tag' }, '待上传'),
                h('button', {
                  className: 'tn-btn',
                  title: '播放该文件,确认效果后再保存',
                  onClick: () => {
                    previewPending(item.raw).then((result) => {
                      if (!result.ok) patch('试听未播放:' + result.reason, 'error')
                    })
                  },
                }, '试听'),
                h('button', { className: 'tn-btn', disabled: busy, title: '上传到共享音效库后，可在上方事件音效中选用。', onClick: () => void savePending(item) }, '上传'),
                h('button', {
                  className: 'tn-btn tn-btn--ghost', disabled: busy,
                  title: '从待保存列表移除,不产生任何存储',
                  onClick: () => setPendingUploads(pendingUploads.filter((pending) => pending !== item)),
                }, '移除'),
              )),
              sounds.length === 0 ? h('span', { className: 'tn-meta' }, '暂无上传音效') :
                h('div', { className: 'tn-list' },
                  sounds.map((sound) => renamingId === sound.id
                    ? h('div', { className: 'tn-list__item', key: sound.id },
                      h('input', {
                        className: 'tn-input tn-fill', type: 'text', autoFocus: true,
                        title: '输入新的展示名,回车确认',
                        value: renameDraft,
                        onChange: (e) => setRenameDraft(e.target.value),
                        // Enter 提交:IME 组词确认(229)不算提交,busy 期间忽略防并发提交
                        onKeyDown: (e) => {
                          if (e.key === 'Enter' && !busy && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) void renameSound(sound)
                        },
                      }),
                      h('button', { className: 'tn-btn', disabled: busy, title: '提交重命名', onClick: () => void renameSound(sound) }, '确认'),
                      h('button', { className: 'tn-btn tn-btn--ghost', disabled: busy, title: '放弃本次重命名', onClick: cancelRename }, '取消'),
                    )
                    : h('div', { className: 'tn-list__item', key: sound.id },
                      h('span', { className: 'tn-list__grow' }, (sound.name || sound.id) + '.' + sound.ext),
                      h('button', {
                        className: 'tn-btn',
                        title: '播放该音效',
                        onClick: () => {
                          playAudible({ kind: 'custom', id: sound.id }).then((result) => {
                            if (!result.ok) patch('试听未播放:' + result.reason, 'error')
                          })
                        },
                      }, '试听'),
                      h('button', { className: 'tn-btn', disabled: busy, title: '只改展示名,不影响分类映射引用;同一文件重新上传按内容自动恢复映射', onClick: () => startRename(sound) }, '重命名'),
                      h('button', { className: 'tn-btn tn-btn--ghost', disabled: busy, title: '从音效库删除;引用它的分类映射自动清空,回落内置默认', onClick: () => void removeSound(sound) }, '删除'),
                    )),
                ),
            ),

          ] : null,
          activeTab === '推送' ? [
            h('section', { className: 'tn-card' },
              fieldHead('webhook'),
              field('webhook URL', h('input', {
                className: 'tn-input tn-fill', type: 'url', 'aria-label': 'webhook URL',
                title: '向接收端发送包含 text 等字段的 JSON，接收端需支持此格式；DSH 运行时，关闭浏览器仍可发送。',
                placeholder: '输入接收通知的 URL', value: urlDraft, disabled: busy || !configLoaded || testing === 'webhook',
                onChange: (e) => { if (busy || testing === 'webhook') return; setUrlDraft(e.target.value); setWebhookStatus('') },
              })),
              field('操作', [
                testButton('保存地址', '保存当前地址后启用推送；保存空地址会停用推送。', saveWebhook, !configLoaded || busy || testing === 'webhook' || !urlDirty || (urlDraft.trim().length > 0 && !urlValid)),
                testButton('测试推送', urlDirty ? '请先保存地址' : '向已保存地址发送测试请求；响应成功仅代表接收端接受请求。', () => runTest('webhook', testWebhook), !configLoaded || busy || Boolean(testing) || urlDirty || !urlValid),
                testButton('清除', '清除已保存地址并停止推送。', clearWebhook, !configLoaded || busy || testing === 'webhook' || !config.webhookUrl),
              ]),
              h('span', { className: 'tn-meta', role: 'status', 'aria-live': 'polite' }, webhookStatus || (urlDirty ? '地址未保存，请先保存再测试' : config.webhookUrl ? '已配置' : '未配置')),
            ),
            config.imAvailable ? h('section', { className: 'tn-card' },
            fieldHead('聊天推送（IM）'),
            field('推送开关', [
              toggle('启用聊天推送', '关闭仅暂停推送，已选接收对象保留；由 DSH 后台发送，浏览器关闭后仍可使用。', config.imEnabled, toggleImEnabled, !configLoaded || busy),
              testButton('测试聊天推送', '给所有已选对象各发送一条真实测试消息；成功仅代表平台接受。', () => runTest('im', testIm), !configLoaded || busy || Boolean(testing) || !config.imEnabled || config.imTargets.length === 0),
            ]),
            field('已选接收对象', config.imTargets.length === 0
              ? h('span', { className: 'tn-meta' }, '尚未选择接收对象')
              : h('div', { className: 'tn-list' }, config.imTargets.map(item => h('div', { className: 'tn-list__item', key: imTargetKey(item) },
                h('span', { className: 'tn-list__grow' }, item.targetId),
                h('span', { className: 'tn-list__tag' }, item.botId),
                testButton('移除', '停止向此对象推送，不删除 IM 机器人中的接收对象。', () => removeImTarget(item), busy),
              )))),
            h('details', { className: 'tn-details', open: config.imTargets.length === 0 },
            h('summary', null, '添加接收对象'),
            h('div', { className: 'tn-details__body' },
            field('Bot ID', [
              h('input', {
                className: 'tn-input tn-fill', type: 'text',
                title: '先在设置页"IM机器人"卡片复制 Bot ID,粘贴到这里;需要已安装 dsh-im 且机器人在线',
                placeholder: '从设置页 IM机器人 卡片复制 Bot ID',
                value: imBotIdDraft,
                onChange: (e) => setImBotIdDraft(e.target.value),
              }),
              h('button', { className: 'tn-btn', disabled: busy, title: '列出这个机器人在聊天软件里保存的接收对象(人/群)', onClick: () => void loadImTargets() }, '获取接收对象'),
            ]),
            imBoundBots.length > 0 ? field('已使用机器人',
              imBoundBots.map((botId) => h('span', { className: 'tn-chip', key: botId },
                h('button', {
                  className: 'tn-chip__name'
                    + (imCatalog !== null && imCatalog.botId === botId ? ' tn-chip__name--active' : ''),
                  disabled: busy,
                  title: '查看这个机器人的接收对象',
                  onClick: () => { setImBotIdDraft(botId); void loadImTargets(botId) },
                }, botId),
                h('button', {
                  className: 'tn-chip__x', disabled: busy, title: '解除绑定:这个机器人的接收对象都不再推送',
                  onClick: () => unregisterImBot(botId),
                }, '×'),
              )),
            ) : null,
            imCatalog !== null
              ? imCatalog.targets.length === 0
                ? h('div', { className: 'tn-meta' }, '这个机器人还没有可选的接收对象;先到 dsh-im 设置页新建并测试')
                : h('div', { className: 'tn-list' },
                    imCatalog.targets.map((target) => {
                      const checked = config.imTargets.some((item) => item.botId === imCatalog.botId && item.targetId === target.targetId)
                      return h('label', { className: 'tn-list__item tn-switch', key: target.targetId,
                        title: '勾选即保存,通知会推给它;新建接收对象在 dsh-im 设置页完成' },
                        ...switchToggle({
                          checked,
                          onChange: (e) => toggleImTarget(imCatalog.botId, target, e.target.checked),
                        }),
                        h('span', { className: 'tn-list__grow' },
                          target.targetId + (target.name ? ' (' + target.name + ')' : '')),
                        h('span', { className: 'tn-list__tag' }, target.kind || ''),
                      )
                    }),
                  )
              : null,
            )),
            ) : h('section', { className: 'tn-card' },
              fieldHead('聊天推送（IM）'),
              h('span', { className: 'tn-meta' }, '启用 IM 机器人插件后，可在此选择聊天接收对象。'),
            ),
          ] : null,
        ),
      )
    }

    return {
      inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace'],
      apply(ctx) {
        const bus = tools.setupCommonTools(ctx)
        const sessions = ctx.get('sessions')
        const workspaces = ctx.get('workspaces')
        // 会话导航(uiWorkspace.openSession):软依赖延迟注入,服务缺席仅禁用
        // 通知点击直达,不阻断通知链路与设置页;每次注入激活独占 token,
        // 退出只删自己的登记,点击时选择最后激活且仍存活的服务(同引用也独立)。
        ctx.inject(['uiWorkspace'], (navigationCtx) => {
          navigationCtx.effect(() => {
            const token = Symbol('turn-notify session navigation')
            sessionNavigators.set(token, navigationCtx.get('uiWorkspace'))
            return () => { sessionNavigators.delete(token) }
          }, 'turn-notify session navigation')
        })
        // 样式挂载宿主文档级:通知栈在面板未打开时也要有完整样式
        ctx.effect(() => {
          const style = document.createElement('style')
          // 自带 data-plugin:缺失时宿主 claimStyles 会把它归属给后续材质化插件,其 HMR 重建即误删
          style.setAttribute('data-plugin', '@mzzsfy/dsh-turn-notify')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'turn-notify styles')
        // 激活即订阅:通知链路不依赖设置面板是否打开过
        const uiWorkspace = ctx.get('uiWorkspace')
        ctx.effect(() => start(bus, { sessions, uiWorkspace }), 'turn-notify notifications')
        // 工作区文件夹运行标记:服务快照投影 + DOM 组容器下标对位,状态变化经
        // 订阅与 DOM 变更(合并窗口)双通道驱动;开关读宿主配置,变更刷新页面生效
        // 所需服务缺席时仅运行标记不激活,不阻塞通知、音效与设置页。
        ctx.inject(['jobs', 'uiSession'], (activityCtx) => {
          const jobs = activityCtx.get('jobs')
          const sessionStatus = activityCtx.get('uiSession').sessionStatus
          let foldEnabled = null
          activityCtx.effect(() => {
            if (typeof MutationObserver === 'undefined' || typeof document.querySelectorAll !== 'function') return
            let disposed = false
            let timer = null
            const jobWatches = new Map()
            function syncJobWatches(owners) {
              for (const [id, release] of jobWatches) {
                if (owners.has(id)) continue
                jobWatches.delete(id)
                release()
              }
              for (const id of owners.keys()) {
                if (!jobWatches.has(id)) jobWatches.set(id, jobs.watchRows(id))
              }
            }
            function clearAll() {
              document.querySelectorAll('[' + FOLD_RUNNING_FLAG + ']').forEach((section) => {
                section.removeAttribute(FOLD_RUNNING_FLAG)
              })
            }
            function scan() {
              const sections = document.querySelectorAll(FOLD_SECTION_SELECTOR)
              if (sections.length === 0) {
                syncJobWatches(new Map())
                clearAll()
                return
              }
              // 开关未决时仅清除:终态正确且停用用户刷新页面不闪现标记
              if (foldEnabled === null) {
                clearAll()
                return
              }
              const sessionsState = sessions.list.getSnapshot()
              const workspacesState = workspaces.list.getSnapshot()
              // 树模式嵌套错序(官方树先序 ≠ 快照平铺序)宁缺不误,与停用同走放弃分支
              const owners = foldEnabled && !treeModeOrderDrifts(workspacesState)
                ? folderActivityOwners(sessionsState, workspacesState)
                : null
              const state = owners
                ? folderRunningState(sessionsState, workspacesState, jobs.state.getSnapshot(), sessionStatus.getSnapshot(), owners)
                : { ids: [], running: new Set(), ungrouped: false }
              const expected = state.ids.length
              // 数量不变量:组容器数 = 工作区数 或 工作区数+1(末位未分组桶);
              // 漂移(单列表模式 / 搜索态 / 官方结构变更)即清除标记,不误标
              const ungroupedLast = sections.length === expected + 1
              if (sections.length !== expected && !ungroupedLast) {
                syncJobWatches(new Map())
                clearAll()
                return
              }
              // 不依赖当前打开哪个会话:为可见主会话及其子树持有官方引用计数名册,
              // 折叠组同样实时更新;停用、漂移或离开分组模式即释放,不读取任务输出。
              syncJobWatches(owners || new Map())
              sections.forEach((section, index) => {
                const running = index < expected ? state.running.has(state.ids[index]) : ungroupedLast && state.ungrouped
                // 同值跳过:流式输出期间扫描高频,重复写属性触发无谓的 CSS 重匹配
                if (running === section.hasAttribute(FOLD_RUNNING_FLAG)) return
                if (running) section.setAttribute(FOLD_RUNNING_FLAG, '')
                else section.removeAttribute(FOLD_RUNNING_FLAG)
              })
            }
            let scheduled = false
            const schedule = () => {
              if (disposed || scheduled) return
              scheduled = true
              timer = setTimeout(() => {
                scheduled = false
                timer = null
                if (!disposed) scan()
              }, FOLD_SCAN_DELAY_MS)
            }
            api('/api/turn-notify/config')
              .then((payload) => {
                foldEnabled = payload ? payload.folderRunningEnabled !== false : true
              })
              .catch(() => {
                foldEnabled = true
              })
              .finally(schedule)
            const unsubscribeSessions = sessions.list.subscribe(schedule)
            const unsubscribeWorkspaces = workspaces.list.subscribe(schedule)
            const unsubscribeJobs = jobs.state.subscribe(schedule)
            const unsubscribeStatus = sessionStatus.subscribe(schedule)
            const observer = new MutationObserver(schedule)
            observer.observe(document.documentElement, { childList: true, subtree: true })
            schedule()
            return () => {
              disposed = true
              if (timer !== null) clearTimeout(timer)
              observer.disconnect()
              unsubscribeSessions()
              unsubscribeWorkspaces()
              unsubscribeJobs()
              unsubscribeStatus()
              syncJobWatches(new Map())
              clearAll()
            }
          }, 'turn-notify folder running mark')
        })
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'turn-notify', order: 41, label: '消息通知' },
            () => React.createElement(TurnNotifyApp),
          ))
      },
      // 测试钩子:供全链路集成测试注入 stub 后取内部函数,生产无消费方;
      // 页内通知的展示结果经 require 桩捕获,不在本包断言
      __test: { poll, pendingReminders, markSessionHandled, pollOnce, storageState, announcedIds, submitCategoryToggle, start, pruneReminders, previewPageNotification },
    }
  },
})
