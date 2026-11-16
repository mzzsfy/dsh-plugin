// shell-select guard 哨兵行:死态自愈,守服务不抢权(逐项同构 dsh-llm-pi-gateway
// guard,差异仅代挂对象为官方 tool-pwsh + pwsh-sandbox 两行,且无 compat 键处理)。
// 死态 = 主行功能性停摆(市场开关即时禁用 / apply 旗标 inactive)且官方两行仍被
// 主行 runtime-disable 禁用停稳(内存残留)——无任何 shell 执行器与工具。代挂走
// ctx.plugin,随 guard fiber 卸载;主行或官方行任一复活先卸代挂。guard 行 id 含
// "/",市场行写入对其拒绝,窗口内始终存活。运行时接管后官方行默认启用,主行
// 包级损伤形态下官方自服务,guard 空闲;死窗仅剩「接管中主行被禁」。

import { MAIN_ROW_ID, OFFICIAL_ROW_IDS, detectDeadState, rowState, rowScan } from './guard-state.mjs'
import { officialRowConfig, readSettingsDocument, resolveFromHostTree } from './guard-config.mjs'
import { officialRowState } from './takeover.mjs'
import { recordTakeover, shellSelectApplyState, shellSelectExecutorFiber, shellSelectTakeoverTrace } from './apply-state.mjs'
import { withHostGate } from './route-gate.mjs'

// 官方包 npm 名(与行 id 独立:行 id 是 dsh-base 组合行,包名才是模块解析键)
const OFFICIAL_PACKAGES = {
  'tool-pwsh': '@deepseek-ai/dsh-tool-pwsh',
  'pwsh-sandbox': '@deepseek-ai/dsh-pwsh-sandbox',
}
// pwsh-sandbox 行消费官方 settings 文档的 `shell` 节;tool-pwsh 行零配置(schema 默认)。
// 文档读取的任一环失败(宿主入口解析/settings.yaml 定位/解析)不再静默成 {},
// 经 onError 回告调用方——代挂配置与官方行声明配置可能不一致,必须在排障面可见。
const OFFICIAL_ROW_CONFIG = {
  'tool-pwsh': async () => ({}),
  'pwsh-sandbox': async (onWarn) => officialRowConfig(() => readSettingsDocument(onWarn), { onError: onWarn }),
}

// 事件缺失时的轮询兜底周期(官方同构)
const SWEEP_INTERVAL_MS = 3000
// 执行器丢失判定宽限:主行 apply 的接管序列正常 1-2 秒落定,超过该窗口仍无
// 执行器句柄即视为接管链断裂(执行器 fiber 意外退役),代挂官方链保底
const EXECUTOR_LOSS_GRACE_MS = 10 * 1000
// 护栏:官方包加载/代挂上界,超时按本周期放弃(防 boot 树卡死)
const MOUNT_TIMEOUT_MS = 10 * 1000
const LOAD_TIMEOUT_MS = 10 * 1000

const delay = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

async function withTimeout(promise, timeoutMs, label) {
  let timer = null
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时(${timeoutMs}ms)`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 官方包模块归一成 ctx.plugin 可挂载形态:apply 型模块(如 tool-pwsh)直挂,
 * Service 类包(pwsh-sandbox 仅 default 导出类)挂类本身;两形态皆无返回
 * undefined(按预载失败处理)。
 */
function mountableOf(module) {
  if (typeof module?.apply === 'function') return module
  if (typeof module?.default === 'function') return module.default
  return undefined
}

/** 官方包模块加载:宿主本体树优先,失败回退裸 import;均败抛错(调用方放弃自愈)。 */
async function importOfficial(packageName) {
  const hostPath = await resolveFromHostTree(packageName)
  if (hostPath !== null) {
    const { pathToFileURL } = await import('node:url')
    return import(pathToFileURL(hostPath).href)
  }
  return import(packageName)
}

/**
 * 安装 guard:初始判定后事件跟随 + 轮询兜底双通道跟随死态/复活边沿。
 * 全部状态挂 guard 自身 fiber,随其卸载自动清理。
 */
export async function installGuard(ctx, {
  importOfficial: importOfficialOverride,
  delay: delayOverride = delay,
  sweepIntervalMs = SWEEP_INTERVAL_MS,
  executorLossGraceMs = EXECUTOR_LOSS_GRACE_MS,
  timeouts = {},
} = {}) {
  const loadTimeout = timeouts.load ?? LOAD_TIMEOUT_MS
  const mountTimeout = timeouts.mount ?? MOUNT_TIMEOUT_MS
  const importOne = importOfficialOverride ?? importOfficial

  // 官方模块按需预载并归一挂载形态:只有死态代挂才需要官方链,正常启动
  // (主行接管成功)零加载、零超时等待——apply 不再被加载预算阻塞。瞬时失败
  // 退避重试(HMR 重建风暴期 import 竞争易超时),耗尽即停用死态自愈。
  const LOAD_RETRIES = 2
  const LOAD_RETRY_DELAY_MS = 3 * 1000
  let modules = null
  let modulesLoading = null
  let modulesUnavailable = false

  async function loadModules() {
    const loaded = new Map()
    for (const id of OFFICIAL_ROW_IDS) {
      let lastError = null
      for (let attempt = 0; attempt <= LOAD_RETRIES; attempt += 1) {
        try {
          const module = mountableOf(await withTimeout(importOne(OFFICIAL_PACKAGES[id]), loadTimeout, `guard 官方包 ${OFFICIAL_PACKAGES[id]} 加载`))
          if (module === undefined) throw new Error('模块既无 apply 也无 default 导出,无法挂载')
          loaded.set(id, module)
          lastError = null
          break
        } catch (error) {
          lastError = error
          if (attempt < LOAD_RETRIES) await delayOverride(LOAD_RETRY_DELAY_MS)
        }
      }
      if (lastError !== null) {
        ctx.logger.warn(`shell-select/guard: 官方 ${OFFICIAL_PACKAGES[id]} 不可用,死态自愈停用: ${lastError?.message ?? lastError}`)
        return undefined
      }
    }
    return loaded
  }

  // 加载并发去重 + 失败定局(needs官方链才会触发,正常启动不执行)
  async function ensureModules() {
    if (modules !== null) return modules
    if (modulesUnavailable) return undefined
    modulesLoading ??= loadModules()
    const loaded = await modulesLoading
    modulesLoading = null
    if (loaded === undefined) {
      modulesUnavailable = true
      return undefined
    }
    modules = loaded
    return modules
  }

  // 代挂状态:id → fiber;mounting 去并发,卸载幂等
  let mounted = new Map()
  let mounting = null

  /** 配置来源降级告警(同一条只报一次:每次代挂都读配置会刷屏)。 */
  const warnedSources = new Set()
  const warnOnce = (message) => {
    if (warnedSources.has(message)) return
    warnedSources.add(message)
    ctx.logger.warn(`shell-select/guard: ${message}`)
  }

  // 行配置读取失败不再静默:代挂用的是 schema 默认值,与官方行声明配置
  // (settings.yaml 的 shell 节)可能不一致,排障面必须能看见这条降级。
  const readRowConfig = async (id) => {
    try {
      return await withTimeout(OFFICIAL_ROW_CONFIG[id](warnOnce), mountTimeout, `guard ${id} 行配置读取`)
    } catch (error) {
      ctx.logger.warn(`shell-select/guard: ${id} 行配置读取失败,代挂按 schema 默认: ${error?.message ?? error}`)
      return {}
    }
  }

  /** 释放一个代挂 fiber:超时兜底,失败只告警(重启收敛)。 */
  const disposeFiber = async (id, fiber, label) => {
    try {
      await withTimeout(Promise.resolve(fiber).then((target) => target.dispose()), mountTimeout, label)
    } catch (error) {
      ctx.logger.warn(`shell-select/guard: ${label}失败 ${id}: ${error?.message ?? error}`)
    }
  }

  // 同一 fiber 只处置一次:失败回收与迟到落定回收可能先后命中同一实例
  const disposedFibers = new WeakSet()
  const disposeOnce = async (id, fiber, label) => {
    if (fiber === null || typeof fiber !== 'object') return
    if (disposedFibers.has(fiber)) return
    disposedFibers.add(fiber)
    await disposeFiber(id, fiber, label)
  }

  async function mountOfficial() {
    if (mounted.size > 0 || mounting !== null) return
    // 本次尝试的落定记账:abandoned 之后落定的 fiber 由落定回调自行回收,
    // 覆盖「超出回收等待窗口的迟到落定」(旧实现只在窗口内 allSettled 回收,
    // 更晚落定的半挂 fiber 永不 dispose,长期占着 ctx.shell)
    const attempt = { abandoned: false, fibers: new Map(), promises: new Map() }
    mounting = (async () => {
      try {
        const loaded = await ensureModules()
        if (loaded === undefined) return
        // 服务依赖方(tool-pwsh inject shell)与提供者(pwsh-sandbox provide shell)
        // 都不能串行 await 激活:依赖方挂载会在等待提供者时自锁。全部先发起、
        // 发起即记账,再统一等待落定;纤维 await 等的是激活完成,窗口由
        // mountTimeout 兜底。
        for (const id of OFFICIAL_ROW_IDS) {
          const mountPromise = (async () => {
            const config = await readRowConfig(id)
            return ctx.plugin(loaded.get(id), config)
          })()
          attempt.promises.set(id, Promise.resolve(mountPromise).then(async (fiber) => {
            if (attempt.abandoned) {
              ctx.logger.warn(`shell-select/guard: 代挂 ${id} 迟到落定(超出回收窗口),已回收`)
              await disposeOnce(id, fiber, 'guard 回收迟到落定')
              return fiber
            }
            attempt.fibers.set(id, fiber)
            return fiber
          }))
        }
        for (let index = 0; index < OFFICIAL_ROW_IDS.length; index += 1) {
          const id = OFFICIAL_ROW_IDS[index]
          await withTimeout(attempt.promises.get(id), mountTimeout, `guard 代挂 ${id}`)
        }
        mounted = attempt.fibers
        ctx.logger.warn('shell-select/guard: 主行与官方 shell 链同时停用,已代挂官方工具恢复服务;重启后由宿主组合自然归位')
      } catch (error) {
        attempt.abandoned = true
        ctx.logger.error(`shell-select/guard: 代挂官方插件失败: ${error?.message ?? error}`)
        // 半挂态回收:已发起但未落定(或落定在失败点之后)的 fiber 也必须收。
        // 有界等待让「窗口内落定」的实例进入回收清单;更晚的迟到落定由上面的
        // 落定回调在 abandoned 置位后回收,不留半套官方链占 ctx.shell。
        await Promise.allSettled([...attempt.promises.entries()].map(([id, fiberPromise]) =>
          withTimeout(fiberPromise, mountTimeout, `guard 回收半挂 ${id}`)))
        for (const [id, fiber] of attempt.fibers) await disposeOnce(id, fiber, 'guard 回收半挂')
        attempt.fibers.clear()
      } finally {
        mounting = null
      }
    })()
    await mounting
  }

  async function unmountOfficial() {
    if (mounting !== null) await mounting
    const fibers = mounted
    mounted = new Map()
    for (const [id, fiber] of fibers) {
      try {
        await disposeOnce(id, fiber, 'guard 卸代挂')
      } catch (error) {
        ctx.logger.warn(`shell-select/guard: 卸代挂失败 ${id}(${error?.message ?? error});放行继续,复活方可能撞残余注册,属有意取舍`)
      }
    }
  }

  // 复活让位:受控行任一即将 init 且本方在场,先撤清本方对 ctx.shell 的占用。
  // HOST-022 分支(0.2.2 写事务重评 !!js 表达式):官方行翻回启用时,执行器
  // 与 guard 代挂是同一服务的两种占位形态,任一残留都会让官方行 provide 撞
  // 重复服务,被写入门控放大成 settings/rejected。
  // 三态:true = 已复活 / false = 未复活 / undefined = 求值不可信(!!js 表达式
  // 求值抛错,行是否复活未知)。不可信时任何自动动作(让位/卸代挂)都可能制造
  // shell 真空,调用方必须保持现状——此前把不可信折叠成 false,于是 patch 事件
  // 一路落到"卸代挂让位",代挂服务被撤而官方行并未复活(P2)。
  const officialRowRevived = (id) => {
    let state
    try {
      state = officialRowState(ctx.loader, id)
    } catch {
      return undefined
    }
    if (state?.present !== true) return false
    if (state.disabledUnreliable === true) return undefined
    return state.disabled === false
  }

  /** 任一官方行状态求值不可信(死亡判定与让位判定都无意义)。 */
  const officialStateUnreliable = () => OFFICIAL_ROW_IDS.some((id) => officialRowRevived(id) === undefined)

  // 写事务翻回(HOST-022)先重禁:让位会 dispose 执行器,连 shell 工具一起撤掉
  // (0.2.2 真机实证:半接管态模型只剩官方 pwsh)。重禁成功即保持接管。
  // 重禁失败时也不让位:写事务期间宿主正在重建行树,官方行激活与执行器抢
  // ctx.shell 必然失败,此时撤执行器会让"翻回"变成 shell 真空并只能重启;
  // 保留执行器只让本次保存失败,终端能力不丢。官方行翻回不触发任何让位;
  // 主行复活时只卸 guard 代挂(下方主行分支),执行器由主行 fiber 自然退役。
  const reDisabling = new Set()

  const reDisableOfficialRow = async (id, entry) => {
    reDisabling.add(id)
    try {
      // 宿主 Entry.update(options, create=false, force=true):create 为真会整份
      // 替换 options(丢 id/name/config),强制刷新才能穿透空 diff 形态
      await entry.update({ disabled: true }, false, true)
    } catch {
      return false
    } finally {
      reDisabling.delete(id)
    }
    return officialRowState(ctx.loader, id)?.disabled === true
  }

  const patchContextGuard = async (entry, next) => {
    const id = entry?.options?.id
    if (id !== MAIN_ROW_ID && !OFFICIAL_ROW_IDS.includes(id)) return next()
    if (id !== MAIN_ROW_ID) {
      const revived = officialRowRevived(id)
      // 状态不可信:不重禁也不卸代挂,保持现状等下一条边沿/轮询
      if (revived === undefined) {
        recordTakeover({ event: `revived=${id} unreliable, 保持现状` })
        ctx.logger.warn(`shell-select/guard: 官方行 ${id} 状态求值不可信(表达式异常),保持现状不卸代挂`)
        return next()
      }
      if (revived) {
        // 行可能在翻回时仍在运行(写事务只改表达式求值,不重启行):同样先重禁,
        // 退场由宿主写事务收尾,执行器保持;重禁失败也不让位(见下)
        if (reDisabling.has(id)) return next()
        if (await reDisableOfficialRow(id, entry)) {
          recordTakeover({ event: `revived=${id} re-disabled` })
          ctx.logger.warn(`shell-select/guard: 官方行 ${id} 被写事务翻回,已重新禁用并保持接管`)
          return next()
        }
        // 重禁失败后再读一次:不可信时保持现状(让位会 dispose 执行器,制造真空)
        if (officialRowRevived(id) === undefined) {
          recordTakeover({ event: `revived=${id} re-disable 后状态不可信, 保持现状` })
          ctx.logger.warn(`shell-select/guard: 官方行 ${id} 重禁后状态求值不可信,保持接管不卸代挂`)
          return next()
        }
        // 宿主拒绝重禁(写事务重建行树中):保留执行器,本次保存由宿主判失败。
        // 官方行激活会撞 ctx.shell 而失败,不会真的接管;撤执行器则终端真空。
        recordTakeover({ event: `revived=${id} re-disable-failed, 保持执行器` })
        ctx.logger.warn(`shell-select/guard: 官方行 ${id} 重禁失败(写事务进行中),保持执行器不卸;本次配置保存可能被宿主判失败,终端能力不丢`)
        return next()
      }
    }
    if (entry.fiber?.uid != null) return next()
    if (mounted.size === 0 && mounting === null) return next()
    ctx.logger.warn(`shell-select/guard: ${id} 行复活,卸代挂让位`)
    try {
      await unmountOfficial()
    } catch (error) {
      ctx.logger.warn(`shell-select/guard: 卸代挂交接异常(${error?.message ?? error}),仍放行复活方`)
    } finally {
      return next()
    }
  }

  // 禁用边沿:宿主在此事件时 fiber 已清(上方已按 fiber 在场早退),直接判死态;
  // 退场收尾的注册撤清由 mountOfficial 自己的退场等待与 sweep 兜底。
  const partialDisposeGuard = async (entry) => {
    const id = entry?.options?.id
    if (id !== MAIN_ROW_ID && !OFFICIAL_ROW_IDS.includes(id)) return
    if (entry.fiber?.uid != null) return
    if (detectDeadState(ctx.loader, { applyState: shellSelectApplyState }) === true) await mountOfficial()
  }

  // 轮询兜底:边沿时序因宿主版本而异,周期全量扫描保证最终一致;mount/unmount 各自幂等
  let sweeping = false
  // 执行器丢失自愈:主行 apply 已落定(active)却无执行器句柄,说明接管链断裂
  // (执行器 fiber 意外退役),官方行又处于禁用停稳——不代挂只能重启宿主。
  // 正常接管序列在 active 与挂载之间只隔 1-2 秒,按宽限窗口区分两者。
  let executorGoneSince
  const executorLost = () => shellSelectApplyState() === 'active' && shellSelectExecutorFiber.current === undefined
  const sweep = async () => {
    if (sweeping) return
    sweeping = true
    try {
      // 行状态求值不可信时死亡判定无意义:保持现状(既不代挂也不卸代挂),
      // 否则 !js 求值抛错会被读成"官方行已启用"而撤掉代挂服务(零动作安全向)
      if (officialStateUnreliable()) return
      if (executorLost()) {
        executorGoneSince ??= Date.now()
        if (Date.now() - executorGoneSince >= executorLossGraceMs && mounted.size === 0 && mounting === null) {
          recordTakeover({ event: 'executor-lost, 代挂官方链' })
          ctx.logger.warn('shell-select/guard: 主行 active 但执行器不在场,接管链断裂;代挂官方 pwsh 链恢复终端')
          await mountOfficial()
        }
        return
      }
      executorGoneSince = undefined
      const dead = detectDeadState(ctx.loader, { applyState: shellSelectApplyState })
      if (dead === true && mounted.size === 0 && mounting === null) await mountOfficial()
      else if (dead === false && (mounted.size > 0 || mounting !== null)) await unmountOfficial()
    } catch {
      // 停机竞态:fiber 已停而末次 tick 先于 effect 清理触发,loader 访问必抛;
      // rejection 逃逸会被宿主 fail-loud 判 fatal load failure 杀进程,静默放行
    } finally {
      sweeping = false
    }
  }

  // 可观测面:死态判定中间量、代挂状态与主行接管序列只读暴露(排障与巡检共用)。
  // 注册抽成函数是因为 webServer 常晚于本行就绪:apply 时刻一次性 ctx.get 取不到
  // 就永久不注册,guard-status 带 cookie 也 404(宿主 /api 闸门只挡无 cookie)。
  const status = () => ({
    dead: detectDeadState(ctx.loader, { applyState: shellSelectApplyState }),
    applyState: shellSelectApplyState(),
    takeover: shellSelectTakeoverTrace(),
    mounted: [...mounted.keys()],
    mounting: mounting !== null,
    rows: [MAIN_ROW_ID, ...OFFICIAL_ROW_IDS].map((id) => ({ id, ...rowState(ctx.loader, id) })),
    officialRaw: Object.fromEntries(OFFICIAL_ROW_IDS.map((id) => {
      const s = officialRowState(ctx.loader, id)
      return [id, { rawType: typeof s.rawDisabled, disabled: s.disabled, running: s.running }]
    })),
    rowScan: rowScan(ctx.loader),
  })
  // 每次调用都在入参 ctx 上登记 effect:路由注销随该 fiber 卸载,服务重注册时旧
  // 路由先撤再挂,不留重复项。闸门用同一个 ctx 问,晚到的 connection 同样生效。
  const registerStatusRoute = (webCtx) => {
    if (typeof webCtx?.webServer?.register !== 'function') return
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/api/shell-select/guard-status',
      handler: withHostGate(webCtx, (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(status()))
      }),
    }), 'shell-select/guard status route')
  }
  const readyWebServer = ctx.get?.('webServer')
  if (readyWebServer !== undefined) {
    // 服务已在但契约不可用(旧宿主/桩):不挂空路由,也不登记 inject(服务不会再来)
    if (typeof readyWebServer.register === 'function') registerStatusRoute(ctx)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => registerStatusRoute(webCtx))
  }

  ctx.on('loader/patch-context', patchContextGuard, { global: true })
  ctx.on('loader/partial-dispose', partialDisposeGuard, { global: true })

  const initial = detectDeadState(ctx.loader, { applyState: shellSelectApplyState })
  ctx.logger.info?.(`shell-select/guard: 初始判定 dead=${initial}`)
  if (initial === true) await mountOfficial()

  // 定时器随 fiber 清理:裸 setInterval 会在行停用后残留 tick,停机序列中
  // 访问 loader 抛错并经宿主 fail-loud 升级为进程级 fatal
  ctx.effect(() => {
    const timer = setInterval(() => {
      void sweep()
    }, sweepIntervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'shell-select/guard sweep timer')
  return undefined
}

export const name = 'shell-select/guard'

/**
 * guard 行入口:零配置,无服务依赖(loader 经 ctx 原型链可达)。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export async function apply(ctx) {
  await installGuard(ctx)
}
