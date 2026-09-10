// dsh-turn-notify Client 半区:轮询投影 + localStorage 认领 + 三通道发声。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 由 DSH client runtime 模块表解析。
// 认领锁/完成标记走 localStorage(非 secure context 也可用的唯一跨窗口原语)。
// 页内通知通道经公共依赖 @mzzsfy/dsh-toast 展示,本包不自带通知 UI。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-turn-notify',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef } = React

    // 通知出口:公共依赖 @mzzsfy/dsh-toast,可选消费——共享依赖包的模块表注入
    // 全仓收敛到唯一权威消费方(session-manager),本插件不再代挂占位条目;
    // 权威方未安装时模块表缺失,干净禁用 toast 通道(其余通道不受影响)
    let toast = null
    try {
      toast = require('@mzzsfy/dsh-toast/client').show
    } catch {
      // 模块表无 toast → 页内通知通道置空,调用点统一走 toast 判空
    }

    // 长轮询请求超时上限,须大于服务端挂起上限,保证客户端总在服务端放弃后才断开
    const REQUEST_TIMEOUT_MS = 30 * 1000
    // 失败重连退避:指数增长至上限,防网络中断期间打爆服务端
    const RETRY_MIN_MS = 2 * 1000
    const RETRY_MAX_MS = 30 * 1000
    // 页内通知展示期,经公共依赖 holdMs 传入
    const TOAST_MS = 6 * 1000
    const BLINK_MS = 1 * 1000
    // 连环通知下标题闪烁的总时长硬顶
    const BLINK_MAX_MS = 30 * 1000
    // 系统通知测试延迟:浏览器对聚焦窗口抑制系统弹窗,倒计时供用户切出窗口
    const SYSTEM_TEST_DELAY_MS = 5 * 1000
    // 显示回执等待上限:超时未回执按环境层拦截给出诊断
    const SYSTEM_SHOW_TIMEOUT_MS = 3 * 1000

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

    // 数据镜像常量:与 core.mjs 的 AUDIO_EXTS/MIME_BY_EXT/CATEGORY_LABELS 同源,parity 锁定
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
      let wid = localGet(KEY_WID)
      if (wid === null) {
        wid = 'w-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000000).toString(36)
        localSet(KEY_WID, wid)
      }
      return wid
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

    // routes 为事件→通道路由放行名单(null=未配置全放行),语义与 core 同源
    function chooseChannels(hasFocus, permission, idleMs, soundCategories, category, routes) {
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
      return {
        toast: toastEnabled && routed('toast'),
        sound,
        system: !quiet && systemEnabled && permission === 'granted' && routed('system'),
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

    // ---- 页内通知与标题闪烁 ----

    // 页内通知经公共依赖 @mzzsfy/dsh-toast 展示(栈式多条并存),
    // 本包只保留标题闪烁通道

    let blinkTimer = null
    let blinkStopTimer = null
    const baseTitle = () => document.title.replace(/^⏳ /, '')

    // 连环通知(并行会话批量报错)间隔小于 TOAST_MS 时,闪烁会被逐条续命;
    // 硬顶 BLINK_MAX_MS 保证任何情况下标题必停,焦点返回时由可见性同步立即清除
    function startTitleBlink() {
      if (blinkTimer !== null) {
        clearTimeout(blinkStopTimer)
        blinkStopTimer = setTimeout(stopTitleBlink, BLINK_MAX_MS - BLINK_MS)
        return
      }
      blinkTimer = setInterval(() => {
        document.title = document.title.startsWith('⏳ ') ? baseTitle() : '⏳ ' + baseTitle()
      }, BLINK_MS)
      blinkStopTimer = setTimeout(stopTitleBlink, TOAST_MS)
    }

    function stopTitleBlink() {
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
    // onclick 点击直达:聚焦窗口并切到对应会话后关闭弹窗;summary 作 body 两级呈现
    function notifySystem(unit, onOutcome) {
      try {
        const notification = new Notification(unit.text, { tag: unit.id, body: unit.summary ?? '' })
        notification.onclick = () => {
          try {
            if (typeof window.focus === 'function') window.focus()
            if (unit.session) {
              const row = findSessionRow(unit.session)
              if (row !== null && typeof row.click === 'function') row.click()
            }
          } catch { /* 直达失败不掩盖通知主流程 */ }
          notification.close()
        }
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
    // 已见投影版本:空即未首拉;长轮询续传游标,响应后随 payload 推进
    let projectionCursor = null

    // 生效映射:开关开时本地覆盖全局,关时本地整体休眠(结果即全局)
    const effectiveMapping = () => mergeMapping(soundMapping, localMappingEnabled() ? readLocalMapping() : {})

    async function pollOnce(signal) {
      let payload
      try {
        // cursor 为空即首拉,服务端立即返回全量;之后携带版本挂起等待增量。
        // 组合代际中止与请求超时:服务端挂起上限低于此超时,超时即故障进入退避
        const query = projectionCursor === null ? '' : '?cursor=' + projectionCursor
        const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
        const response = await fetch('/api/turn-notify/projection' + query, { signal: requestSignal })
        if (!response.ok) {
          void response.body?.cancel()
          return false
        }
        payload = await response.json()
      } catch {
        return false
      }
      // 版本缺失即异常响应:按失败退避,防游标停滞退化成紧密首拉循环
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
      pruneReminders(liveIds)
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
        // 冷启动对齐:错过窗口期的存量通知不回放轰炸;审批与提问例外——
        // 它们在等用户动作,静默会把待办吞掉
        if (coldStart && unit.category !== 'approval' && unit.category !== 'ask') {
          try { markDone(unit.id) } catch { /* 存储不可用:标记缺失由内存去重兜底,冷启动本就不发声 */ }
          // 静默对齐只不呈现通知,未读会话闪烁照常:高亮是本机 UI 状态,不属轰炸
          rememberSessionHighlight(unit, engaged)
          continue
        }
        if (!claimEvent(unit.id)) continue
        markDone(unit.id)
        const channels = chooseChannels(engaged, notificationPermission(), Date.now() - lastActionAt(), readSoundCategories(), unit.category, unit.routes ?? null)
        const sound = resolveSound(unit.category, effectiveMapping(), uploadedIds)
        if (channels.toast || channels.sound || channels.system || channels.blink) {
          rememberSessionHighlight(unit, engaged)
        }
        if (channels.toast) {
          toast?.(unit.text + (unit.summary ? '\n' + unit.summary : ''), {
            holdMs: TOAST_MS,
            onClick: activateSessionFromUnit(unit),
          })
        }
        // 页内提示音与通知声音互斥(pageSound 已含 !sound),同一通知至多一声;
        // toast 库缺失时卡片不存在,补位音随之禁用(声明与可用分离,可用性在调用点合流);
        // 页内音色按页内场景映射解析:通知生效映射为底,页内显式配置覆盖
        if (channels.pageSound && toast) {
          playSound(resolveSound(unit.category, mergeMapping(effectiveMapping(), readPageMapping()), uploadedIds)).catch(() => {})
        }
        // 声音关闭只静音自身:system 弹窗与 blink 降级通道独立判断,不因无声 continue 连坐
        if (channels.sound) playSound(sound).catch(() => {})
        if (channels.system) notifySystem(unit)
        else if (channels.blink && localGet(KEY_DEGRADE_HINT) !== '0') startTitleBlink()
        // 等待用户动作的事件超时未处理:补发一轮提醒(审批与提问)
        scheduleActionReminder(unit, channels)
      }
      applySessionHighlights()
      return true
    }

    // 单次拉取:测试入口与循环体共用;失败返回假,由调用方决定退避;
    // 代际中止(HMR 换代)不算降级,不通告
    async function poll(signal) {
      const ok = await pollOnce(signal)
      if (ok) degradeAnnounced.poll = false
      else if (signal === undefined || !signal.aborted) announceDegrade('poll', '投影拉取失败')
      return ok
    }

    function sleep(ms, signal) {
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }, ms)
        if (typeof timer.unref === 'function') timer.unref()
        const onAbort = () => {
          clearTimeout(timer)
          resolve()
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }

    // 长轮询主循环:成功即立即重连(空闲期由服务端挂起兜底),失败指数退避;
    // 处理段异常同样按失败消化,循环不静默死亡
    async function runLoop(signal) {
      let backoffMs = RETRY_MIN_MS
      while (!signal.aborted) {
        let ok = false
        try {
          ok = await poll(signal)
        } catch (error) {
          if (!signal.aborted) announceDegrade('poll', error && error.message ? error.message : String(error))
        }
        if (signal.aborted) break
        if (ok) {
          backoffMs = RETRY_MIN_MS
          // 让出一拍:防测试 stub 立即响应时循环退化成紧密空转
          await sleep(0, signal)
        } else {
          await sleep(backoffMs, signal)
          backoffMs = Math.min(backoffMs * 2, RETRY_MAX_MS)
        }
      }
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

    // document.title 首段为当前会话名(切会话即变);标题闪烁的前缀符号
    // 落在同段首部,indexOf 匹配天然免疫;投影标题可能截断故用单向前缀匹配
    function isCurrentSessionTitle(title) {
      if (typeof document === 'undefined' || typeof document.title !== 'string') return false
      const segment = document.title.split(' — ')[0]
      return segment.indexOf(title) >= 0
    }

    // 会话行探测:先定位“类名含 _list 段且子树含多个标题”的最内层列表容器,
    // 再按标题文本下钻;行级确认要求标题叶文本与 title 全等或前缀互含
    // (行标题完整而投影标题可能截断),防止同前缀会话被子串误吸;
    // 全等行优先于前缀行;本体改版探测不到即静默失效,不报错
    const TITLE_LEAF_SELECTOR = '[class*="_title"]'
    const SESSION_LIST_SUFFIX = '_list'
    const leafTextOf = (row) => {
      if (typeof row.querySelector !== 'function') return ''
      const leaf = row.querySelector(TITLE_LEAF_SELECTOR)
      return leaf && typeof leaf.textContent === 'string' ? leaf.textContent : ''
    }
    const titleMatchesRow = (title, row) => {
      const leafText = leafTextOf(row)
      return leafText === title || leafText.startsWith(title) || title.startsWith(leafText)
    }
    function findSessionRow(title) {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null
      let list = null
      let listCount = 0
      for (const el of document.querySelectorAll('[class*="' + SESSION_LIST_SUFFIX + '"]')) {
        if (typeof el.className !== 'string' || !el.className.split(' ').some((name) => name.indexOf(SESSION_LIST_SUFFIX) >= 0)) continue
        const count = el.querySelectorAll(TITLE_LEAF_SELECTOR).length
        if (count > 1 && (list === null || count < listCount)) { list = el; listCount = count }
      }
      if (list === null) return null
      const prefixMatches = []
      const walk = (node) => {
        for (const kid of node.children) {
          if (typeof kid.textContent !== 'string' || kid.textContent.indexOf(title) < 0) continue
          if (typeof kid.querySelectorAll !== 'function') continue
          if (kid.querySelectorAll(TITLE_LEAF_SELECTOR).length === 1) {
            if (leafTextOf(kid) === title) return kid
            if (titleMatchesRow(title, kid)) prefixMatches.push(kid)
          } else if (kid.children.length > 0) {
            const deeper = walk(kid)
            if (deeper !== null && deeper !== undefined) return deeper
          }
        }
        return null
      }
      return walk(list) ?? prefixMatches[0] ?? null
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
      if (!sessionHighlightEnabled || !unit.session) return
      if (engaged && isCurrentSessionTitle(unit.session)) return
      if (sessionHighlights.size >= SESSION_HL_MAX) sessionHighlights.delete(sessionHighlights.keys().next().value)
      sessionHighlights.set(unit.session, unit.category)
    }

    // 增量重应用:仅补缺失类,不产生多余 DOM 写,防 MutationObserver 回调自我触发成环;
    // 快照遍历:行进入运行状态时清理对应条目,迭代中删除不改快照
    function applySessionHighlights() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
      if (!sessionHighlightEnabled) return
      const engaged = isEngaged()
      for (const [title, category] of [...sessionHighlights]) {
        // 聚焦态复核:冷启动首拉早于标题就绪时误挂的当前会话高亮,标题就绪后的
        // 任一应用帧在此自愈(与返回即已读同语义:正在看即不强调)
        if (engaged && isCurrentSessionTitle(title)) {
          sessionHighlights.delete(title)
          const stale = findSessionRow(title)
          if (stale) removeRowHighlight(stale)
          continue
        }
        const row = findSessionRow(title)
        if (!row) continue
        if (isRowRunning(row)) {
          sessionHighlights.delete(title)
          removeRowHighlight(row)
          continue
        }
        if (row.classList.contains(SESSION_HL_CLASS)) continue
        const colorClass = CATEGORIES.indexOf(category) >= 0 ? SESSION_HL_CLASS + '--' + category : SESSION_HL_CLASS + '--ask'
        row.classList.add(SESSION_HL_CLASS, colorClass)
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

    // ---- 点击直达会话:页内卡片与系统弹窗共用 ----

    // 按通知单元激活会话:聚焦窗口并模拟点击侧边栏会话行(官方行点击即切换会话);
    // 点击事件经高亮清除委托,天然完成"查看即已读"。行未渲染(列表折叠/懒加载)
    // 或无标题时仅聚焦窗口。
    function activateSessionFromUnit(unit) {
      return () => {
        if (typeof window.focus === 'function') window.focus()
        if (!unit.session) return
        const row = findSessionRow(unit.session)
        if (row !== null && typeof row.click === 'function') row.click()
      }
    }

    // ---- 审批/提问超时二次提醒 ----

    // 等待用户动作的事件超此时长未处理即补发一轮(一次,不连环)。
    const ACTION_REMIND_MS = 10 * 60 * 1000
    // 待提醒登记:unit id → timer;处理判定与生命周期清理共用
    const pendingReminders = new Map()
    // "已处理"近似:用户切到该会话(标题匹配)或点掉了高亮行(高亮条目消失);
    // 无标题通知(审批 waterfall)无法感知处理,按未处理补发,宁可多响一次。
    function actionHandled(unit) {
      if (!unit.session) return false
      if (isCurrentSessionTitle(unit.session)) return true
      return !sessionHighlights.has(unit.session)
    }
    function scheduleActionReminder(unit, channels) {
      if (unit.category !== 'approval' && unit.category !== 'ask') return
      if (pendingReminders.has(unit.id)) return
      const timer = setTimeout(() => {
        pendingReminders.delete(unit.id)
        if (actionHandled(unit)) return
        // 补发独立于聚焦静默与路由名单:它就是"通道没送达"的兜底
        toast?.('[再次提醒] ' + unit.text + (unit.summary ? '\n' + unit.summary : ''), { holdMs: TOAST_MS, onClick: activateSessionFromUnit(unit) })
        playSound(resolveSound(unit.category, effectiveMapping(), uploadedIds)).catch(() => {})
        startTitleBlink()
      }, ACTION_REMIND_MS)
      if (typeof timer.unref === 'function') timer.unref()
      pendingReminders.set(unit.id, timer)
    }
    // 投影刷新同步:单元过期即撤登记(通知已被其他窗口处理或已出投影窗口)
    function pruneReminders(liveIds) {
      for (const [id, timer] of pendingReminders) {
        if (liveIds.has(id)) continue
        clearTimeout(timer)
        pendingReminders.delete(id)
      }
    }
    // 页面重新可见即视为已读:清除当前会话的高亮,其他会话的提醒保留
    function clearCurrentSessionHighlights() {
      for (const title of [...sessionHighlights.keys()]) {
        if (!isCurrentSessionTitle(title)) continue
        sessionHighlights.delete(title)
        const row = findSessionRow(title)
        if (row) removeRowHighlight(row)
      }
    }
    function ensureHighlightListener() {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
      if (typeof window[KEY_HL_LISTENER] === 'function') document.removeEventListener('click', window[KEY_HL_LISTENER], true)
      const listener = (event) => {
        const target = event.target && event.target.closest ? event.target.closest('.' + SESSION_HL_CLASS) : null
        if (!target) return
        const rowTitle = leafTextOf(target)
        if (!rowTitle) return
        let cleared = false
        for (const title of [...sessionHighlights.keys()]) {
          if (!titleMatchesRow(title, target)) continue
          sessionHighlights.delete(title)
          cleared = true
        }
        if (!cleared) return
        removeRowHighlight(target)
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

    function start() {
      // 代际令牌自愈:HMR 重建模块闭包后 running 归零,首启 abort 旧代长轮询,
      // 旧连接断开、旧循环退出;遗留的非 AbortController 令牌(旧版 interval 形态)
      // 无法中止,由页面刷新自然清偿
      if (running) return
      running = true
      if (window[KEY_POLL_TOKEN] instanceof AbortController) window[KEY_POLL_TOKEN].abort()
      const controller = new AbortController()
      window[KEY_POLL_TOKEN] = controller
      ensureHighlightListener()
      ensureHighlightVisibilitySync()
      ensureHighlightObserver()
      refreshSounds()
      void runLoop(controller.signal)
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

    const PERMISSION_LABELS = { granted: '已授权', denied: '已拒绝', default: '未授权' }

    // 面板表单占位:GET config 返回前展示;webhookUrl 原文随响应回显,表单所见即所存;
    // imAvailable 缺省为假,加载响应后 dsh-im 在场才渲染 IM 投递卡
    const DEFAULT_CONFIG = {
      webhookUrl: '',
      minTurnDurationMs: 5 * 1000,
      rootsOnly: true,
      suppressSubagentWake: true,
      enabled: Object.fromEntries(CATEGORIES.map((key) => [key, true])),
      imTargets: [],
    }

    const CSS = [
      // 令牌全部取宿主 --dsw-* 体系,明暗模式由宿主切换自动生效
      '.tn-panel { display:flex; flex-direction:column; gap:14px; color:inherit; font-size:13px; }',
      '.tn-head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }',
      '.tn-head__title { font-weight:650; font-size:15px; letter-spacing:0.2px; }',
      '.tn-head__hint { color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size:12px; }',
      // tab 栏:segmented 胶囊组,激活态 brand 底,面板一屏只呈现一类配置
      '.tn-tabs { display:flex; gap:2px; padding:3px; border-radius:10px;',
      '  background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12)); }',
      '.tn-tab { flex:1; min-width:0; border:none; background:transparent; cursor:pointer;',
      '  padding:6px 8px; border-radius:8px; font-size:12.5px; font-family:inherit; text-align:center;',
      '  color:var(--dsw-alias-label-secondary, inherit); transition:background 0.15s, color 0.15s; }',
      '.tn-tab:hover { color:var(--dsw-alias-label-primary);',
      '  background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.15)); }',
      '.tn-tab--on, .tn-tab--on:hover { background:var(--dsw-alias-brand-primary);',
      '  color:var(--dsw-alias-bg-base, #fff); font-weight:600; }',
      '.tn-tab:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }',
      '.tn-tabpanel { display:flex; flex-direction:column; gap:14px; }',
      '.tn-card { border:1px solid var(--dsw-alias-border-l1, var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)));',
      '  border-radius:12px; padding:14px 16px; background:var(--dsw-alias-bg-layer-1, transparent);',
      '  display:flex; flex-direction:column; gap:12px; }',
      '.tn-card__head { display:flex; flex-direction:column; gap:2px; }',
      '.tn-card__title { font-weight:600; font-size:13px; color:var(--dsw-alias-label-primary); }',
      '.tn-card__sub { color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size:12px; }',
      // 表单行:左标签右控件的 grid,说明文字折行到控件列下方,行结构不随内容换行漂移
      '.tn-field { display:grid; grid-template-columns:76px minmax(0, 1fr); gap:8px 12px; align-items:center; }',
      '.tn-field__label { color:var(--dsw-alias-label-secondary); font-size:12px; }',
      '.tn-field__control { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }',
      '.tn-field__hint { grid-column:2; color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));',
      '  font-size:11.5px; line-height:1.5; }',
      // 卡片底部动作区:主操作右对齐
      '.tn-actions { display:flex; justify-content:flex-end; gap:8px;',
      '  border-top:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); padding-top:10px; }',
      '.tn-meta { color:var(--dsw-alias-label-secondary); font-size:12px; }',
      '.tn-error { color:var(--dsw-alias-state-error-primary, #d43a3a); }',
      '.tn-btn { cursor:pointer; border:1px solid var(--dsw-alias-border-l2, var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)));',
      '  background:var(--dsw-alias-bg-layer-2, transparent); color:var(--dsw-alias-label-primary, inherit);',
      '  border-radius:8px; padding:5px 14px; font-size:12px; font-family:inherit; transition:background 0.15s, border-color 0.15s, color 0.15s; }',
      '.tn-btn:hover { background:var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2, transparent)); }',
      '.tn-btn:disabled { opacity:0.45; cursor:default; }',
      '.tn-btn--primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary);',
      '  color:var(--dsw-alias-bg-base, #fff); font-weight:600; }',
      '.tn-btn--primary:hover { background:var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); }',
      '.tn-btn--ghost { background:transparent; border-color:transparent; color:var(--dsw-alias-label-secondary); }',
      '.tn-btn--ghost:hover { color:var(--dsw-alias-state-error-primary, #d43a3a);',
      '  background:var(--dsw-alias-interactive-bg-hover, transparent); }',
      '.tn-btn--danger:hover { border-color:var(--dsw-alias-state-error-primary, #d43a3a);',
      '  color:var(--dsw-alias-state-error-primary, #d43a3a); }',
      '.tn-select, .tn-input { background:var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2, transparent)); color:var(--dsw-alias-label-primary, inherit);',
      '  border:1px solid var(--dsw-alias-border-l1, var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)));',
      '  border-radius:8px; padding:5px 9px; font-size:12px; font-family:inherit; transition:border-color 0.15s; }',
      '.tn-select:focus, .tn-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }',
      '.tn-fill { flex:1; min-width:200px; }',
      // 测试卡按钮组:横排可换行
      '.tn-btngroup { display:flex; gap:8px; flex-wrap:wrap; }',
      // pill 开关组:成组分类的快捷切换,选中态 brand 底色
      '.tn-pills { display:flex; gap:6px; flex-wrap:wrap; }',
      '.tn-pill { cursor:pointer; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35));',
      '  border-radius:999px; padding:3px 12px; font-size:12px; user-select:none;',
      '  background:var(--dsw-alias-bg-layer-2, transparent); color:var(--dsw-alias-label-secondary);',
      '  transition:all 0.15s; }',
      '.tn-pill:hover { border-color:var(--dsw-alias-brand-primary); }',
      '.tn-pill--on { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary);',
      '  color:var(--dsw-alias-bg-base, #fff); font-weight:600; }',
      // bot 标签:名称与取消注册组合为一个 chip
      '.tn-chip { display:inline-flex; align-items:center; gap:2px; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35));',
      '  border-radius:999px; overflow:hidden; font-size:12px; }',
      '.tn-chip__name { cursor:pointer; border:none; background:transparent; color:var(--dsw-alias-label-primary, inherit);',
      '  padding:3px 10px; font-size:12px; }',
      '.tn-chip__name:hover { background:var(--dsw-alias-interactive-bg-hover, transparent); }',
      '.tn-chip__name--active { color:var(--dsw-alias-brand-primary); font-weight:600; }',
      '.tn-chip__x { cursor:pointer; border:none; background:transparent; color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));',
      '  padding:3px 8px; font-size:13px; line-height:1; border-left:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); }',
      '.tn-chip__x:hover { color:var(--dsw-alias-state-error-primary, #d43a3a); background:var(--dsw-alias-interactive-bg-hover, transparent); }',
      // 开关:隐藏原生 checkbox,选中态 track 与 thumb 位移用过渡呈现
      '.tn-switch { display:inline-flex; align-items:center; cursor:pointer; }',
      '.tn-switch input[type="checkbox"] { position:absolute; opacity:0; width:0; height:0; }',
      '.tn-switch__track { position:relative; width:34px; height:19px; border-radius:999px; box-sizing:border-box;',
      '  background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.35));',
      '  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35));',
      '  transition:background 0.15s, border-color 0.15s; }',
      '.tn-switch__thumb { position:absolute; top:50%; left:2px; width:13px; height:13px; border-radius:50%;',
      '  background:var(--dsw-alias-label-tertiary, rgba(128,128,128,0.6));',
      '  transform:translateY(-50%); transition:left 0.15s, background 0.15s; }',
      '.tn-switch:hover .tn-switch__track { border-color:var(--dsw-alias-brand-primary); }',
      '.tn-switch input[type="checkbox"]:checked + .tn-switch__track { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }',
      '.tn-switch input[type="checkbox"]:checked + .tn-switch__track .tn-switch__thumb { left:17px; background:var(--dsw-alias-bg-base, #fff); }',
      '.tn-switch input[type="checkbox"]:focus-visible + .tn-switch__track { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }',
      // 目标列表:按行呈现,勾选/名称/移除右对齐
      '.tn-list { display:flex; flex-direction:column; }',
      '.tn-list__item { display:flex; align-items:center; gap:10px; padding:6px 2px; font-size:12px;',
      '  border-top:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); }',
      '.tn-list__item:first-child { border-top:none; }',
      '.tn-list__grow { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;',
      '  color:var(--dsw-alias-label-primary, inherit); }',
      '.tn-list__tag { color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size:11px; }',
      '.tn-divider { border:none; border-top:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); margin:2px 0; }',
      'input[type="range"].tn-range { accent-color:var(--dsw-alias-brand-primary); flex:1; min-width:120px; }',
      // 会话行高亮:背景在透明与“背景色与分类色各半混合”间脉冲;分类色用 dsw 语义变量,缺省回退具名色
      '.tn-sess-hl--completed { --tn-sess-color:var(--dsw-alias-state-success-primary, #34a853); }',
      '.tn-sess-hl--error { --tn-sess-color:var(--dsw-alias-state-error-primary, #d43a3a); }',
      '.tn-sess-hl--interrupted { --tn-sess-color:#e08c2e; }',
      '.tn-sess-hl--approval { --tn-sess-color:#c9a227; }',
      '.tn-sess-hl--ask { --tn-sess-color:var(--dsw-alias-brand-primary, #4c8dff); }',
      '.tn-sess-hl--max-tokens { --tn-sess-color:#9a6fe0; }',
      '.tn-sess-hl { animation:tn-sess-pulse 1.6s ease-in-out infinite; border-radius:8px; }',
      '@keyframes tn-sess-pulse {',
      '  0%,100% { background-color:transparent; }',
      '  50% { background-color:color-mix(in srgb, var(--tn-sess-color, #4c8dff) 50%, var(--dsw-alias-bg-base, #202020) 50%); }',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  .tn-sess-hl { animation:none; background-color:color-mix(in srgb, var(--tn-sess-color, #4c8dff) 50%, var(--dsw-alias-bg-base, #202020) 50%); }',
      '}',
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

    // 表单行:左标签右控件的固定两列,说明文字折行到控件列下方
    function field(label, control, hint) {
      return h('div', { className: 'tn-field' },
        h('span', { className: 'tn-field__label' }, label),
        h('div', { className: 'tn-field__control' }, control),
        hint !== undefined ? h('div', { className: 'tn-field__hint' }, hint) : null,
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
      // 待确认上传:文件选中且解码校验通过后挂起,用户试听并确认才落盘
      const [pendingUploads, setPendingUploads] = useState([])
      // 面板分区:tab 切换仅显隐,不触碰任何已装载状态
      const [tab, setTab] = useState('通知')

      useEffect(() => {
        start()
        api('/api/turn-notify/sounds').then((res) => setSounds(res.sounds || [])).catch(() => {})
        api('/api/turn-notify/config')
          .then((res) => {
            setConfig({ ...DEFAULT_CONFIG, ...res })
            setMappingState(res.soundMapping || {})
            setUrlDraft(typeof res.webhookUrl === 'string' ? res.webhookUrl : '')
            setConfigLoaded(true)
          })
          .catch(() => {})
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

      async function saveConfig() {
        if (!configLoaded) {
          patch('配置尚未加载,不能保存(刷新页面重试)', 'error')
          return
        }
        setBusy(true)
        try {
          const raw = typeof config.minTurnDurationMs === 'string'
            ? config.minTurnDurationMs.trim()
            : String(config.minTurnDurationMs)
          if (raw.length === 0) throw new Error('最短回合时长不能为空')
          const trimmedUrl = urlDraft.trim()
          // 所见即所存:输入框即配置值,清空并保存即禁用 webhook 通道
          const patchBody = { webhookUrl: trimmedUrl, minTurnDurationMs: Number(raw), rootsOnly: config.rootsOnly, suppressSubagentWake: config.suppressSubagentWake }
          const res = await api('/api/turn-notify/config', { method: 'POST', body: JSON.stringify(patchBody) })
          setConfig({ ...DEFAULT_CONFIG, ...res })
          if (res.soundMapping) setMappingState(res.soundMapping)
          setUrlDraft(typeof res.webhookUrl === 'string' ? res.webhookUrl : '')
          patch('配置已保存,立即生效')
        } catch (error) {
          patch('保存失败:' + (error && error.message ? error.message : String(error)), 'error')
        } finally { setBusy(false) }
      }

      async function clearWebhook() {
        setBusy(true)
        try {
          const res = await api('/api/turn-notify/config', { method: 'POST', body: JSON.stringify({ webhookUrl: '' }) })
          setConfig({ ...DEFAULT_CONFIG, ...res })
          if (res.soundMapping) setMappingState(res.soundMapping)
          setUrlDraft(typeof res.webhookUrl === 'string' ? res.webhookUrl : '')
          patch('webhook 已清除')
        } catch (error) {
          patch('清除失败:' + (error && error.message ? error.message : String(error)), 'error')
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

      async function requestPermission() {
        try {
          const next = await Notification.requestPermission()
          setPermission(next)
          patch(next === 'granted' ? '弹窗授权成功,失焦时将走系统弹窗' : '弹窗被拒,可在浏览器地址栏权限或系统设置中恢复', next === 'granted' ? 'ok' : 'error')
        } catch (error) {
          patch('授权失败:' + (error && error.message ? error.message : String(error)), 'error')
        }
      }

      // 页内通知通道单独测试:弹页内提示,不涉及系统通知;页内提示音开关开启时随卡片补一声
      function testPageNotification() {
        if (!toast) {
          patch('toast 库未装载(权威消费方未安装),页内通知通道不可用', 'error')
          return
        }
        toast('[dsh] 页内通知测试', { holdMs: TOAST_MS })
        // 复用页内提示音开关,点火即播,音色按页内场景映射解析;播放结果回执可见
        if (localGet(KEY_PAGE_SOUND) === '1') {
          const sound = resolveSound('completed', effectivePageMapping, soundIds)
          playAudible(sound).then((result) => {
            if (!result.ok) patch('页内提示音未播放:' + result.reason, 'error')
          })
        }
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

      async function testWebhook() {
        // 草稿与已保存值不同即存在未保存改动,测试的只能是已保存配置
        if (urlDraft.trim() !== String(config.webhookUrl || '').trim()) {
          patch('表单中的 webhook URL 尚未保存,本次测试的是已保存配置;请先保存再测试', 'error')
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

      // 分区定义:IM 卡随 dsh-im 在场与否出现;activeTab 兜底防 imAvailable 回落时落空
      const tabs = [
        { id: '通知', label: '通知' },
        { id: '偏好', label: '偏好' },
        { id: '音效', label: '音效' },
        ...(config.imAvailable ? [{ id: 'IM', label: 'IM' }] : []),
        { id: '测试', label: '测试' },
      ]
      const activeTab = tabs.some((item) => item.id === tab) ? tab : tabs[0].id

      return h('div', { className: 'tn-panel' },
        h('div', { className: 'tn-head' },
          h('span', { className: 'tn-head__title' }, '消息通知'),
          h('span', { className: 'tn-head__hint' }, '保存即生效;标签页全关时仅 webhook 与 IM 送达'),
        ),
        h('div', { className: 'tn-tabs', role: 'tablist' },
          tabs.map((item) => h('button', {
            key: item.id,
            type: 'button',
            role: 'tab',
            'aria-selected': activeTab === item.id,
            className: 'tn-tab' + (activeTab === item.id ? ' tn-tab--on' : ''),
            onClick: () => setTab(item.id),
          }, item.label)),
        ),
        h('div', { className: 'tn-tabpanel', role: 'tabpanel' },
          activeTab === '通知' ? h('div', { className: 'tn-card' },
            h('div', { className: 'tn-card__head' },
              h('span', { className: 'tn-card__title' }, '通知配置'),
              h('span', { className: 'tn-card__sub' }, '六类事件的触发与过滤;开关即时生效,数值改动需点保存'),
            ),
            field('webhook', [
              h('input', {
                className: 'tn-input tn-fill', type: 'text',
                title: '通知由 host 直接 POST 到该地址,标签页全关也送达;Slack 兼容 JSON 格式,超时 10 秒不重试',
                placeholder: 'Slack-compatible URL,留空禁用',
                value: urlDraft,
                onChange: (e) => setUrlDraft(e.target.value),
              }),
              String(config.webhookUrl || '').trim().length > 0
                ? h('button', { className: 'tn-btn tn-btn--danger', disabled: busy, title: '清除已配置的 webhook,清除后该通道禁用', onClick: () => void clearWebhook() }, '清除')
                : null,
            ], '保存即提交输入框内容,清空并保存即禁用;改动后先保存,测试按钮只测已保存配置'),
            field('最短回合时长', [
              h('input', {
                className: 'tn-input', type: 'number', min: 0, step: 500, style: { width: '90px' },
                title: '过滤连续快速的小回合(如自动压缩、状态刷新);默认 5000 毫秒,设为 0 关闭过滤',
                value: config.minTurnDurationMs,
                onChange: (e) => setConfig({ ...config, minTurnDurationMs: e.target.value }),
              }),
              h('span', { className: 'tn-meta' }, '毫秒,回合结束类通知短于此时长不送达;提问与审批请求即时送达'),
            ]),
            field('子代理过滤', [
              h('label', { className: 'tn-meta tn-switch', title: '子代理是主会话委托出去的独立会话;开启后子代理自身的完成/出错不通知,只有主会话通知' },
                ...switchToggle({
                  checked: config.rootsOnly,
                  onChange: (e) => setConfig({ ...config, rootsOnly: e.target.checked }),
                }),
                ' 子代理会话不通知'),
              h('label', { className: 'tn-meta tn-switch', title: '发起后台委托后主回合先结束的等待期,以及子代理完成后唤醒父会话继续工作的回合,任务完成通知均静默;整条委托链只在最终回合响一次' },
                ...switchToggle({
                  checked: config.suppressSubagentWake,
                  onChange: (e) => setConfig({ ...config, suppressSubagentWake: e.target.checked }),
                }),
                ' 后台委托未收尾或收尾唤醒的回合不通知(仅完成类)'),
            ]),
            field('事件分类', h('div', { className: 'tn-pills' },
              CATEGORIES.map((category) => h('span', {
                className: 'tn-pill' + (config.enabled[category] ? ' tn-pill--on' : ''),
                key: category,
                title: CATEGORY_LABELS[category] + ':当前' + (config.enabled[category] ? '触发通知,点击停用' : '不触发,点击启用'),
                onClick: () => void toggleCategory(category, !config.enabled[category]),
              }, CATEGORY_LABELS[category])),
            ), '亮=触发通知,暗=不触发,点击即存即时生效'),
            h('div', { className: 'tn-actions' },
              h('button', { className: 'tn-btn tn-btn--primary', disabled: busy, title: '保存 webhook、时长与子代理过滤的改动;六类事件开关点击时已即时保存', onClick: () => void saveConfig() }, '保存'),
            ),
          ) : null,
          activeTab === '偏好' ? h('div', { className: 'tn-card' },
            h('div', { className: 'tn-card__head' },
              h('span', { className: 'tn-card__title' }, '本机偏好'),
              h('span', { className: 'tn-card__sub' }, '仅存当前浏览器(同浏览器各窗口共用),不影响其他浏览器与设备'),
            ),
            field('会话高亮', [
              h('label', { className: 'tn-meta tn-switch', title: '通知触发时脉冲闪烁侧边栏对应会话行(完成绿/出错红/提问蓝等六类各一色),点击该会话行即停止闪烁;仅本机开关,各浏览器独立' },
                ...switchToggle({
                  defaultChecked: readSessionHighlightEnabled(),
                  onChange: (e) => writeSessionHighlightEnabled(e.target.checked),
                }),
                ' 通知高亮侧边栏会话行'),
            ], '通知送达时对应会话行整行脉冲闪烁,一眼定位刚有动静的会话;点击闪烁的行或切走后自然停止。'),
            field('提示音', [
              h('label', { className: 'tn-meta tn-switch', title: '通知声音总开关,失焦时播报;关闭后通知声音静默,已开启的页内提示音会在无声时补位' },
                ...switchToggle({
                  defaultChecked: localGet(KEY_SOUND) !== '0',
                  onChange: (e) => localSet(KEY_SOUND, e.target.checked ? '1' : '0'),
                }),
                ' 开启'),
              h('div', { className: 'tn-pills' },
                CATEGORIES.map((category) => h('span', {
                  className: 'tn-pill' + (soundCategories[category] !== false ? ' tn-pill--on' : ''),
                  key: category,
                  title: soundCategories[category] !== false
                    ? CATEGORY_LABELS[category] + ':当前出声,点击静音'
                    : CATEGORY_LABELS[category] + ':当前静音,点击恢复出声',
                  onClick: () => toggleSoundCategory(category),
                }, CATEGORY_LABELS[category])),
              ),
            ], '点分类单独控制该类事件是否出声:亮=出声,暗=静音;总开关关闭时全部静音。页内提示卡片与会话高亮不受影响;被静音分类的系统弹窗与标题闪烁随之静默;页内提示音有独立的开关、分类与音色映射,不随此处变化。'),
            field('系统弹窗', [
              h('label', { className: 'tn-meta tn-switch', title: '窗口失焦时弹系统级通知,聚焦时静默(见聚焦静默);未授权且声音开启时降级为标题闪烁' },
                ...switchToggle({
                  defaultChecked: localGet(KEY_SYSTEM) !== '0',
                  onChange: (e) => localSet(KEY_SYSTEM, e.target.checked ? '1' : '0'),
                }),
                ' 开启'),
              h('span', { className: 'tn-meta' }, '权限:'
                + (typeof Notification === 'undefined' ? '不可用(非安全上下文)' : (PERMISSION_LABELS[permission] || permission))),
              typeof Notification !== 'undefined' && permission === 'default'
                ? h('button', { className: 'tn-btn', title: '向浏览器申请通知权限,授权后系统弹窗生效', onClick: () => void requestPermission() }, '授权')
                : null,
            ]),
            field('页内提示', [
              h('label', { className: 'tn-meta tn-switch', title: '页面角落浮出卡片提示,6 秒自动消失;聚焦窗口内唯一常开的提醒形态' },
                ...switchToggle({
                  defaultChecked: localGet(KEY_TOAST) !== '0',
                  onChange: (e) => localSet(KEY_TOAST, e.target.checked ? '1' : '0'),
                }),
                ' 开启'),
            ], '页面角落浮出卡片提示;聚焦时通知声音静默,提示音的听觉提醒由页内提示音场景独立承担。'),
            field('页内提示音', [
              h('label', { className: 'tn-meta tn-switch', title: '页内提示音总开关:页内提示弹出且未播放通知声音时补一声提示(聚焦时通知声音静默,靠它保留听觉提醒);与通知声音互斥,同一通知至多一声,音量与本页音量滑块共用' },
                ...switchToggle({
                  defaultChecked: localGet(KEY_PAGE_SOUND) === '1',
                  onChange: (e) => localSet(KEY_PAGE_SOUND, e.target.checked ? '1' : '0'),
                }),
                ' 开启'),
              h('div', { className: 'tn-pills' },
                CATEGORIES.map((category) => h('span', {
                  className: 'tn-pill' + (pageSoundCategories[category] !== false ? ' tn-pill--on' : ''),
                  key: category,
                  title: pageSoundCategories[category] !== false
                    ? CATEGORY_LABELS[category] + ':当前补位出声,点击静音'
                    : CATEGORY_LABELS[category] + ':当前静音,点击恢复',
                  onClick: () => togglePageSoundCategory(category),
                }, CATEGORY_LABELS[category])),
              ),
            ], '聚焦场景的独立声音:总开关与分类静音在此,音色在音效页的页内提示音映射卡单独指定(未配置的分类沿用通知音效);失焦场景的通知声音不受本行影响。'),
            field('音量', h('input', {
              className: 'tn-range', type: 'range', min: 0, max: 1, step: 0.05,
              title: '通知声音与页内提示音共用,按 5% 步进调节,本机记忆',
              defaultValue: volume(),
              onChange: (e) => localSet(KEY_VOLUME, e.target.value),
            })),
            field('行为', [
              h('label', { className: 'tn-meta tn-switch', title: '窗口聚焦时只保留页内提示,声音、系统弹窗与标题闪烁全部静默;离开键盘满 5 分钟视为不在电脑前,聚焦也全通道提醒' },
                ...switchToggle({
                  defaultChecked: localGet(KEY_DND) !== '0',
                  onChange: (e) => localSet(KEY_DND, e.target.checked ? '1' : '0'),
                }),
                ' 聚焦静默'),
              h('label', { className: 'tn-meta tn-switch', title: '系统弹窗未授权或不可用(HTTP 非回环地址、曾被拒绝)且声音通道开启时,标签页标题以 ⏳ 前缀闪烁替代弹窗' },
                ...switchToggle({
                  defaultChecked: localGet(KEY_DEGRADE_HINT) !== '0',
                  onChange: (e) => localSet(KEY_DEGRADE_HINT, e.target.checked ? '1' : '0'),
                }),
                ' 弹窗不可用时以标题闪烁替代'),
            ]),
          ) : null,
          activeTab === '音效' ? [
            h('div', { className: 'tn-card' },
              h('div', { className: 'tn-card__head' },
                h('span', { className: 'tn-card__title' }, '音效管理'),
                h('span', { className: 'tn-card__sub' }, 'wav / mp3 / ogg,可多选,单文件上限 2MB'),
              ),
              field('上传音效', h('input', {
                type: 'file', multiple: true, accept: AUDIO_EXTS.map((ext) => '.' + ext).join(','), disabled: busy,
                title: '可一次多选;上传前进待保存列表逐个试听,点保存才落盘;同一文件重复上传自动识别不产生重复;总库上限 10MB',
                onChange: (e) => {
                  const files = e.target.files ? Array.from(e.target.files) : []
                  e.target.value = ''
                  void onPickFiles(files)
                },
              })),
              pendingUploads.map((item, index) => h('div', { className: 'tn-list__item', key: 'pending-' + index },
                h('span', { className: 'tn-list__grow' }, item.name),
                h('span', { className: 'tn-list__tag' }, '待保存'),
                h('button', {
                  className: 'tn-btn',
                  title: '播放该文件,确认效果后再保存',
                  onClick: () => {
                    previewPending(item.raw).then((result) => {
                      if (!result.ok) patch('试听未播放:' + result.reason, 'error')
                    })
                  },
                }, '试听'),
                h('button', { className: 'tn-btn', disabled: busy, title: '上传到 host 音效库,保存后才可在分类映射中选用', onClick: () => void savePending(item) }, '保存'),
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
            h('div', { className: 'tn-card' },
              h('div', { className: 'tn-card__head' },
                h('span', { className: 'tn-card__title' }, '分类音效映射'),
                h('span', { className: 'tn-card__sub' }, '每类事件可指定上传音效或内置音,失效自动回落内置默认'),
              ),
              field('作用域', [
                h('label', { className: 'tn-switch', title: '开启后音效映射仅对本浏览器(域名)生效' },
                  ...switchToggle({
                    checked: localMode,
                    onChange: (e) => toggleLocalMapping(e.target.checked),
                  })),
                h('span', { className: 'tn-meta' }, localMode ? '当前域名独立' : '全部域名共用'),
              ], '开启:映射改动只保存在本浏览器(按访问域名隔离),本地优先于全局,公司/家里的配置互不影响。关闭:全域名共用 host 全局配置(settings.yaml)。'),
              !localMode && Object.keys(localMapping).length > 0
                ? h('div', { className: 'tn-field' },
                  h('span', { className: 'tn-field__label' }),
                  h('div', { className: 'tn-field__control' },
                    h('span', { className: 'tn-meta' },
                      '已保存 ' + Object.keys(localMapping).length + ' 项本地映射,当前休眠,重新开启即恢复生效。'),
                  ))
                : null,
              CATEGORIES.map((category) => field(CATEGORY_LABELS[category], [
                h('select', {
                  className: 'tn-select tn-fill', value: effective[category] || '',
                  title: '该类事件触发时播放的音效,选择即保存;空为内置默认',
                  onChange: (e) => void setMapping(category, e.target.value),
                }, soundOptions),
                h('button', { className: 'tn-btn', title: '播放该分类当前生效的音效;映射失效时回落内置默认', onClick: () => previewCategory(category) }, '试听'),
              ])),
            ),
            h('div', { className: 'tn-card' },
              h('div', { className: 'tn-card__head' },
                h('span', { className: 'tn-card__title' }, '页内提示音映射'),
                h('span', { className: 'tn-card__sub' }, '聚焦补位音场景,独立于上方通知音效;仅存本机浏览器,未配置的分类沿用通知音效'),
              ),
              CATEGORIES.map((category) => field(CATEGORY_LABELS[category], [
                h('select', {
                  className: 'tn-select tn-fill', value: pageMapping[category] || '',
                  title: '聚焦时页内提示音播放的音效,选择即保存;空为沿用通知音效',
                  onChange: (e) => setPageMappingCategory(category, e.target.value),
                }, pageSoundOptions),
                h('button', { className: 'tn-btn', title: '按页内场景解析播放该分类音效(页内配置覆盖,缺省沿用通知映射)', onClick: () => previewPageCategory(category) }, '试听'),
              ])),
            ),
          ] : null,
          activeTab === 'IM' ? h('div', { className: 'tn-card' },
            h('div', { className: 'tn-card__head' },
              h('span', { className: 'tn-card__title' }, 'IM 投递(dsh-im)'),
              h('span', { className: 'tn-card__sub' }, '勾选目标即自动保存;支持绑定多个 bot,点 bot 名加载其目录,× 取消注册'),
            ),
            field('Bot ID', [
              h('input', {
                className: 'tn-input tn-fill', type: 'text',
                title: '在设置页 IM机器人 卡片复制 Bot ID 粘贴到这里;需先安装 dsh-im 并保持 bot 在线',
                placeholder: '从设置页 IM机器人 卡片复制 Bot ID',
                value: imBotIdDraft,
                onChange: (e) => setImBotIdDraft(e.target.value),
              }),
              h('button', { className: 'tn-btn', disabled: busy, title: '拉取该 bot 已保存的投递目标列表', onClick: () => void loadImTargets() }, '加载目标'),
            ]),
            imBoundBots.length > 0 ? field('已绑 bot',
              imBoundBots.map((botId) => h('span', { className: 'tn-chip', key: botId },
                h('button', {
                  className: 'tn-chip__name'
                    + (imCatalog !== null && imCatalog.botId === botId ? ' tn-chip__name--active' : ''),
                  disabled: busy,
                  title: '点击加载该 bot 的目标目录',
                  onClick: () => { setImBotIdDraft(botId); void loadImTargets(botId) },
                }, botId),
                h('button', {
                  className: 'tn-chip__x', disabled: busy, title: '取消注册(移除该 bot 全部目标)',
                  onClick: () => unregisterImBot(botId),
                }, '×'),
              )),
            ) : null,
            imCatalog !== null
              ? imCatalog.targets.length === 0
                ? h('div', { className: 'tn-meta' }, '该 bot 尚无已保存投递目标,先在 dsh-im 设置页新建并测试')
                : h('div', { className: 'tn-list' },
                    imCatalog.targets.map((target) => {
                      const checked = config.imTargets.some((item) => item.botId === imCatalog.botId && item.targetId === target.targetId)
                      return h('label', { className: 'tn-list__item tn-switch', key: target.targetId,
                        title: '勾选即保存,通知将推送到该目标;目标的新建与平台侧测试在 dsh-im 设置页完成' },
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
            config.imTargets.length > 0 ? h('hr', { className: 'tn-divider' }) : null,
            config.imTargets.length === 0
              ? h('div', { className: 'tn-meta' }, '尚未绑定投递目标,通知不会推送 IM')
              : h('div', { className: 'tn-list' },
                  config.imTargets.map((item) => h('div', { className: 'tn-list__item', key: imTargetKey(item) },
                    h('span', { className: 'tn-list__grow' }, item.targetId),
                    h('span', { className: 'tn-list__tag' }, item.botId),
                    h('button', {
                      className: 'tn-btn tn-btn--ghost', disabled: busy,
                      title: '从通知目标中移除,不影响 dsh-im 侧已保存的目标本身',
                      onClick: () => removeImTarget(item),
                    }, '移除'),
                  )),
                ),
          ) : null,
          activeTab === '测试' ? h('div', { className: 'tn-card' },
            h('div', { className: 'tn-card__head' },
              h('span', { className: 'tn-card__title' }, '测试'),
              h('span', { className: 'tn-card__sub' }, '各通道逐一点火,回执即真实结果'),
            ),
            h('div', { className: 'tn-btngroup' },
              h('button', {
                className: 'tn-btn',
                title: '按任务完成分类当前生效的音效播放;测其他分类请到音效页对该分类试听',
                // 测试声音读当前生效映射:播放任务完成分类实际生效的音效,而非固定参考音
                onClick: () => {
                  const sound = resolveSound('completed', effective, soundIds)
                  playAudible(sound).then((result) => {
                    patch(result.ok
                      ? '测试声音已触发:' + describeSound(sound) + ',若未听到请检查系统音量与输出设备'
                      : '测试声音未播放:' + result.reason, result.ok ? 'ok' : 'error')
                  })
                },
              }, '测试声音'),
              h('button', { className: 'tn-btn', title: '弹出一条页内卡片;页内提示音已开启时随卡片补一声(点火测试,不经分类静音约束)', onClick: testPageNotification }, '测试页内通知'),
              h('button', { className: 'tn-btn', title: '弹一条系统通知验证授权与送达;未授权会先引导授权', onClick: testSystemNotification }, '测试系统通知'),
              h('button', { className: 'tn-btn', title: '向已配置的 webhook 发送真实测试事件,回执显示投递结果;未配置时提示失败', onClick: () => void testWebhook() }, '测试 webhook'),
              config.imAvailable ? h('button', { className: 'tn-btn', disabled: busy, title: '向全部已配置目标发送真实测试事件,逐目标显示结果', onClick: () => void testIm() }, '测试 IM 通知') : null,
            ),
          ) : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 样式挂载宿主文档级:通知栈在面板未打开时也要有完整样式
        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'turn-notify styles')
        // 激活即轮询:通知链路不依赖设置面板是否打开过
        start()
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'turn-notify', order: 41, label: '消息通知' },
            () => React.createElement(TurnNotifyApp),
          ))
      },
      // 测试钩子:供全链路集成测试注入 stub 后取内部函数,生产无消费方;
      // 页内通知的展示结果经 require 桩捕获,不在本包断言
      __test: { poll, pollOnce, storageState, announcedIds, submitCategoryToggle, start, pruneReminders },
    }
  },
})
