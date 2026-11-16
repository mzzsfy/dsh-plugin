// shell-select 主行入口(apply 型):官方 pwsh 链的运行时接管编排。
//
// 为什么是 apply 型而不是 Service 类:本包执行器与官方 pwsh-sandbox 抢同一个
// cordis 服务(ctx.shell,cordis 重复 provide 抛错)。Service 类在构造期同步
// provide,无法等待官方退场;apply 型行把「占服务」的动作变成可编排的挂载
// 时序——apply 落定后禁官方行 → 等退场 → ctx.plugin 挂执行器,与 guard 的
// mountOfficial(主行死时挂官方)互为镜像。
//
// 流程:POSIX 早退(官方 bash 链不碰,Linux 行为与无本包一致)→ 决策 →
// yield(宿主状态异常,零动作)/ takeover(官方已禁,直挂)/
// await-exit(等官方退场再挂)/ runtime-disable(官方启用中,apply 落定后
// 运行时禁用再接管)。接管序列任何失败都回滚或降级:官方行恢复启用或保持
// 在场服务,系统不出现 shell 真空。序列全程经 recordTakeover 留可观测面
// (guard-status 暴露,0.1.7 运行期日志不落盘,排障以该探口为准)。
//
// 配置事实源 = 行 Config(Config 声明随主行模块导出供宿主 settings 面注册节,
// apply 经 ctx.plugin 第二参传给执行器;设置页写经 settings 面行条目重载本行,
// apply 重跑换挂执行器)。

import { ShellSelectExecutor } from './executor.mjs'
import {
  beginShellSelectApply,
  endShellSelectApplyActive,
  endShellSelectApplyInactive,
  recordTakeover,
  setShellRequestSeam,
  shellRequestSeamActive,
  shellSelectApplyGeneration,
} from './apply-state.mjs'
import {
  awaitOfficialExit,
  officialChainState,
  restoreRowStates,
  rollbackDisabledRows,
  runtimeDisableRows,
  snapshotRowStates,
  takeoverDecision,
} from './takeover.mjs'
import { coerceServiceable } from './config.mjs'
import { attachRequestHiding } from './request-hide.mjs'
import { describePwshDirective } from './agent-hints.mjs'
import { retireShellSelectExecutorFiber, shellSelectExecutorFiber } from './apply-state.mjs'

export const name = 'shell-select'

// settings 节注册面:宿主按行模块的 Config 导出注册 shell-select 节(与执行器
// 同一 schema 单一事实源)
export { Config } from './config.mjs'

/**
 * 主行 apply。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object|undefined} config 行 Config(shell 客户端清单等)
 */
export async function apply(ctx, config) {
  // 本代 token:apply 的异步接管链可能在新一代 apply 之后才落定,跨 await 的
  // 模块级旗标写入必须核对代际,旧链不得改写新代的 active/seam(S6)
  const generation = beginShellSelectApply()
  const isCurrentApply = () => shellSelectApplyGeneration() === generation
  // 平台早退:行级平台门控在本前已停用本行,此为纵深防御——行被显式启用到
  // POSIX 时本行自身不得碰官方 bash/pwsh 链
  if (process.platform !== 'win32') {
    endShellSelectApplyInactive(generation)
    return
  }
  // 原生 schemastery 设置节抑制:宿主 describe 按 loader 行 fiber 查 autoGenerate,
  // 策略必须登记在主行 fiber 上——挂在执行器子 fiber 上键永不命中,原生节照旧
  // 出现且其写口不经本包 refresh 桥,执行面不换源(保存成功但行为不变)。
  // 与 dsh-tool-gate 的抑制形态同构;服务缺失只影响抑制,不影响接管本体。
  void ctx.inject(['settings'], (sctx) => {
    try {
      sctx.settings?.configure?.({ auto: false }, ctx.fiber)
    } catch (error) {
      ctx.logger?.warn?.(`shell-select: 原生设置节抑制失败(原生节与 Shell 管理页并存): ${error?.message ?? error}`)
    }
  })
  // pwsh 请求缝隐藏:preset 的官方工具在会话作用域注册,工具层的可见性规则遮蔽
  // 不了它;剔除只发生在模型请求上,前提是执行器已挂载且本次请求 tools 里确有
  // `shell`(见 request-hide),否则原样透传——只保留 pwsh 的子代理不该被剥掉
  // 唯一终端。行卸载即透传。llm 缺失只损失隐藏,终端能力不受影响。
  ctx.inject(['llm'], (lctx) => {
    let disposed = false
    ctx.effect(() => () => { disposed = true }, 'shell-select request hiding lifetime')
    const sweep = () => {
      const attached = attachRequestHiding(lctx.llm, () => disposed === false && shellRequestSeamActive())
      if (attached === 0) return
      recordTakeover({ event: `request-hide attached=${attached}` })
      ctx.logger?.info?.(`shell-select: 请求缝隐藏 pwsh(adapter ${attached})`)
    }
    sweep()
    lctx.on('llm/adapters-updated', sweep, { global: true })
  })
  // 会话作用域的官方 pwsh(own 优先)覆盖本包全局注册的同名工具,描述提示只能
  // 在 agent 创建后改写其定义;只改 description,不影响执行与注册。执行器未接管
  // 或该 agent 作用域看不到 shell 时原描述保持不变(见 agent-hints)。
  // agent/created 是 serial 事件:监听器抛错会打断会话创建,而描述改写只是展示
  // 增强,任何异常都必须收敛成一条告警。
  ctx.on('agent/created', ({ agent }) => {
    if (!shellRequestSeamActive()) return
    try {
      if (describePwshDirective(agent)) recordTakeover({ event: 'pwsh 描述已改为改用 shell 提示' })
    } catch (error) {
      ctx.logger?.warn?.(`shell-select: pwsh 描述改写失败(会话创建不受影响): ${error?.message ?? error}`)
    }
  }, { global: true })
  const states = officialChainState(ctx.loader)
  const { decision, targets } = takeoverDecision(states)
  recordTakeover({
    event: `decision=${decision} targets=${targets.length}`,
    rows: Object.fromEntries(Object.entries(states).map(([id, row]) => [id, {
      present: row.present,
      rawType: typeof row.rawDisabled,
      unreliable: row.disabledUnreliable,
      running: row.running,
    }])),
  })
  ctx.logger.info?.(`shell-select: 官方 pwsh 链接管决策 ${decision}(targets=${targets.length})`)
  if (decision === 'yield') {
    // 让位:官方链全量服务,本包无 shell——请求缝与描述改写一并关掉
    setShellRequestSeam(false, generation)
    endShellSelectApplyActive(generation)
    return
  }
  if (decision === 'runtime-disable') {
    endShellSelectApplyActive(generation)
    void runtimeTakeover(ctx, config, targets, generation).catch((error) => {
      recordTakeover({ error: String(error?.message ?? error) })
    })
    return
  }
  // takeover / await-exit:官方行已禁(或缺席),直接接管
  if (decision === 'await-exit') {
    const entries = Object.values(states).filter((row) => row.present).map((row) => row.entry)
    const exited = await awaitOfficialExit(entries)
    if (!isCurrentApply()) return
    if (!exited) {
      // 放弃接管必须落 inactive:落 active 等于宣称本包在服务,guard 的死态判定
      // (mainStalled)恒 false——官方行的禁用只是内存残留,它稍后真退场后既无
      // 官方执行器也无本包执行器,无人代挂,shell 全灭。
      // 这里不回滚官方行(与 runtime 超时分支的差异是有意的):那批行不是本代
      // 禁的,回滚会把它们翻成启用;若宿主在退场途中不重启,行树留下「启用但
      // 无 fiber」,guard 的 G-2 判据(任一行启用即非死态)反而挡住代挂。保持
      // 禁用态 + inactive 让 guard 在官方真退场后按死态代挂,声明态由重启收敛。
      ctx.logger.warn('shell-select: 官方行退场超时,放弃接管(官方仍在服务);重启后由行树声明态收敛')
      recordTakeover({ event: 'await-exit 退场超时,放弃挂载(落 inactive,官方退场后由 guard 代挂)' })
      setShellRequestSeam(false, generation)
      endShellSelectApplyInactive(generation)
      return
    }
  }
  if (!isCurrentApply()) return
  let fiber
  try {
    fiber = await mountExecutor(ctx, config, generation)
  } catch (error) {
    if (!isCurrentApply()) return
    recordTakeover({ event: `挂载失败: ${error?.message ?? error}` })
    ctx.logger.error(`shell-select: 执行器挂载失败(官方双行已禁用),回滚官方 pwsh 链: ${error?.message ?? error}`)
    setShellRequestSeam(false, generation)
    // 已禁/已退场的官方行必须复活;回滚失败也要落 inactive——主行功能性停摆
    // 且官方行仍禁用时,guard 的死态代挂是最后一道 shell 服务保障(P1)
    const entries = Object.values(states).filter((row) => row.present).map((row) => row.entry)
    try {
      const rollbackFailed = await rollbackDisabledRows(entries, { logger: ctx.logger })
      if (rollbackFailed.length > 0) {
        recordTakeover({ event: `rollback-failed=${rollbackFailed.length}, 官方链未复原,guard 代挂` })
      }
    } finally {
      endShellSelectApplyInactive(generation)
    }
    return
  }
  if (fiber === undefined) return
  recordTakeover({ event: 'executed=mounted' })
  endShellSelectApplyActive(generation)
}

/** volatile ref 解包成挂载/刷新快照(深拷切断冻结产物,见 mountExecutor 注释)。 */
function unwrapConfigSnapshot(config) {
  const unwrap = (value) => {
    const raw = typeof value?.get === 'function' ? value.get() : value
    return raw !== null && typeof raw === 'object' ? structuredClone(raw) : raw
  }
  const section = { ...config }
  for (const key of Object.keys(section)) section[key] = unwrap(section[key])
  return section
}

/**
 * 挂载执行器(注册 ctx.shell 服务、shell 工具与 systemPrompt 段,均随本行
 * fiber 卸载自动清理)。行 config 的 volatile 字段是响应式 ref(get() 协议):
 * 挂载前解包成快照——子行管线(ShellSelectExecutor static Config)是纯
 * schemastery,不认 ref,透传 ref 容器直接撞 "expected array but got
 * [object Object]" 拒挂(真机实证);解包产物必须 structuredClone:ref
 * .get() 返回 cosmokit snapshot 深冻结对象,cordis 挂载管线对 section 原地
 * resolve,冻结 env 直接炸 "Cannot assign to read only property" 并触发
 * 接管回滚。快照的陈旧由设置页写路径收口补偿(F18:宿主对 volatile-only
 * 变更换 ref 而不重挂行,本包不依赖 loader 事件——原生设置节已在主行 apply
 * 抑制,设置页写成功后直接经写路径的 refresh 桥换源,见 web-routes)。
 */
async function mountExecutor(ctx, config, generation) {
  // 用户声明值挂载前 coercing:任意配置(坏类型/空 shells/悬空 default/坏
  // deny 正则)降级为可服务配置 + 逐条告警,行永不因配置死(官方链兜底之外
  // 的第一道本体防线)
  const { config: coerced, warnings } = coerceServiceable(unwrapConfigSnapshot(config))
  for (const warning of warnings) ctx.logger?.warn?.(`shell-select: ${warning}`)
  const fiber = await ctx.plugin(ShellSelectExecutor, coerced)
  // await 返回 ≠ 激活:executor inject 的宿主服务缺失时 fiber 静默 pending
  // (不 provide 不报错),ctx.shell 空缺会被官方复活行补位——挂载必须核实
  // 激活态,未激活按失败处理(触发回滚,官方接管)。pending fiber 必须先回收
  // 再抛:留着它,宿主服务稍后就绪时它仍会激活并抢 ctx.shell(S1)。
  if (fiber?.state !== 2) {
    const waiting = fiber?.inject ? Object.keys(fiber.inject).join(',') : '?'
    try {
      await fiber?.dispose?.()
    } catch (error) {
      ctx.logger?.warn?.(`shell-select: 未激活执行器 fiber 回收失败: ${error?.message ?? error}`)
    }
    throw new Error(`执行器 fiber 未激活(state=${fiber?.state},inject=${waiting})`)
  }
  // 代际已翻:旧链挂出来的执行器立即回收,不抢新代的 ctx.shell 与请求缝(S6)
  if (shellSelectApplyGeneration() !== generation) {
    try {
      await fiber?.dispose?.()
    } catch (error) {
      ctx.logger?.warn?.(`shell-select: 旧代执行器 fiber 回收失败: ${error?.message ?? error}`)
    }
    recordTakeover({ event: 'stale-generation 执行器已回收' })
    return undefined
  }
  // 执行器句柄回填:0.2.2 写事务重评官方行 disabled 表达式可翻回启用,官方行
  // 复活与本方执行器撞 ctx.shell;guard 只重发 disabled 保持接管,句柄仅用于
  // 识别执行器丢失(guard 丢失自愈代挂)。
  shellSelectExecutorFiber.current = fiber
  // 请求缝/描述改写的活性前提 = 执行器真接管了终端(见 apply-state)
  setShellRequestSeam(true, generation)
  // 句柄与请求缝随执行器 fiber 退役自清:主行被禁/卸载后残留的已退役句柄会让
  // guard 误判"执行器在场",吞掉丢失自愈的代挂;残留的活性旗标会让官方链独立
  // 服务时仍剔除请求里的 pwsh。代际 token 让旧代执行器的退役不清新代的活性旗标。
  fiber.effect?.(() => () => {
    setShellRequestSeam(false, generation)
    if (shellSelectExecutorFiber.current === fiber) retireShellSelectExecutorFiber()
  }, 'shell-select executor handle retirement')
  return fiber
}

/**
 * runtime-disable 接管序列(apply 落定后的异步链,不阻塞 apply 生命周期):
 * 禁用启用中的官方行 → 等双行退场 → 挂执行器。任何失败都把系统带回官方
 * 自服务形态:禁一半(update 失败)、退场超时、挂载失败(官方已退场,
 * ctx.shell 真空)都按禁用前快照恢复全部目标行。快照而非"回滚成功禁用清单":
 * 宿主 update 可能已写入 disabled 再抛错,失败行同样停在禁用侧,只回滚成功
 * 清单会让它永久缺席(G3-3)。恢复失败的行单独留排障面。
 */
async function runtimeTakeover(ctx, config, targets, generation) {
  const isCurrentApply = () => shellSelectApplyGeneration() === generation
  // 快照必须先于任何 update:失败行也可能已被写入禁用态
  const snapshot = snapshotRowStates(targets)
  const { disabled, failed } = await runtimeDisableRows(targets)
  recordTakeover({ event: `disabled=${disabled.length} updateFailed=${failed.length}` })
  // 代际已翻:本代结论作废,后续收敛属于新一代(不再回滚/挂载,避免两代互拆)
  if (!isCurrentApply()) return
  if (failed.length > 0) {
    ctx.logger.warn(`shell-select: 官方行运行时禁用失败(${failed.length} 行),按快照恢复并保持官方服务`)
    setShellRequestSeam(false, generation)
    try {
      const rollbackFailed = await restoreRowStates(snapshot, { logger: ctx.logger })
      recordTakeover({ event: `restored=${snapshot.length - rollbackFailed.length} rollbackFailed=${rollbackFailed.length}, 不挂载` })
      if (rollbackFailed.length > 0) recordTakeover({ event: 'rollback-failed, 官方链未复原,guard 代挂' })
    } finally {
      endShellSelectApplyInactive(generation)
    }
    return
  }
  const exited = await awaitOfficialExit(targets)
  if (!isCurrentApply()) return
  if (!exited) {
    // 退场超时回滚已禁行(F18):本包不挂载,官方链必须复活自服务,
    // 不留"官方已禁+本包未挂"的 shell 真空窗口
    ctx.logger.warn('shell-select: 官方行退场超时,按快照恢复并放弃接管')
    recordTakeover({ event: 'runtime 退场超时,按快照恢复,放弃挂载' })
    setShellRequestSeam(false, generation)
    try {
      const rollbackFailed = await restoreRowStates(snapshot, { logger: ctx.logger })
      recordTakeover({ event: `restored=${snapshot.length - rollbackFailed.length} rollbackFailed=${rollbackFailed.length}, 退场超时` })
    } finally {
      endShellSelectApplyInactive(generation)
    }
    return
  }
  try {
    const fiber = await mountExecutor(ctx, config, generation)
    if (fiber === undefined) return
    recordTakeover({ event: 'executed=mounted' })
    ctx.logger.warn('shell-select: 官方 pwsh 链已运行时禁用,本包执行器接管 ctx.shell 与 shell 工具')
  } catch (error) {
    recordTakeover({ event: `挂载失败,回滚: ${error?.message ?? error}` })
    ctx.logger.error(`shell-select: 执行器挂载失败,回滚启用官方 pwsh 链: ${error?.message ?? error}`)
    setShellRequestSeam(false, generation)
    if (!isCurrentApply()) return
    try {
      const rollbackFailed = await restoreRowStates(snapshot, { logger: ctx.logger })
      if (rollbackFailed.length > 0) recordTakeover({ event: `rollback-failed=${rollbackFailed.length}, 官方链未复原,重启收敛` })
    } finally {
      endShellSelectApplyInactive(generation)
    }
  }
}
