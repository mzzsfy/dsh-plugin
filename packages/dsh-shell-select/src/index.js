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
} from './apply-state.mjs'
import {
  awaitOfficialExit,
  officialChainState,
  rollbackDisabledRows,
  runtimeDisableRows,
  takeoverDecision,
} from './takeover.mjs'

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
  beginShellSelectApply()
  // 平台早退:行级平台门控在本前已停用本行,此为纵深防御——行被显式启用到
  // POSIX 时本行自身不得碰官方 bash/pwsh 链
  if (process.platform !== 'win32') {
    endShellSelectApplyInactive()
    return
  }
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
    endShellSelectApplyActive()
    return
  }
  if (decision === 'runtime-disable') {
    endShellSelectApplyActive()
    void runtimeTakeover(ctx, config, targets).catch((error) => {
      recordTakeover({ error: String(error?.message ?? error) })
    })
    return
  }
  // takeover / await-exit:官方行已禁(或缺席),直接接管
  if (decision === 'await-exit') {
    const entries = Object.values(states).filter((row) => row.present).map((row) => row.entry)
    const exited = await awaitOfficialExit(entries)
    if (!exited) {
      ctx.logger.warn('shell-select: 官方行退场超时,放弃接管(官方仍在服务);重启后由行树声明态收敛')
      recordTakeover({ event: 'await-exit 退场超时,放弃挂载' })
      endShellSelectApplyActive()
      return
    }
  }
  await mountExecutor(ctx, config)
  recordTakeover({ event: 'executed=mounted' })
  endShellSelectApplyActive()
}

/**
 * 挂载执行器(注册 ctx.shell 服务、shell 工具与 systemPrompt 段,均随本行
 * fiber 卸载自动清理)。行 config 的 volatile 字段(0.1.7 settings 面节值)
 * 是响应式 ref(get() 协议,官方 plainOptions 同构),挂载前动态解包,legacy
 * 普通对象原样透传——直接透传 ref 会令执行器 schema 校验撞对象形状炸。
 */
async function mountExecutor(ctx, config) {
  const unwrapVolatile = (value) => (typeof value?.get === 'function' ? value.get() : value)
  const section = { ...unwrapVolatile(config) }
  for (const key of Object.keys(section)) section[key] = unwrapVolatile(section[key])
  const fiber = await ctx.plugin(ShellSelectExecutor, section)
  // await 返回 ≠ 激活:executor inject 的宿主服务缺失时 fiber 静默 pending
  // (不 provide 不报错),ctx.shell 空缺会被官方复活行补位——挂载必须核实
  // 激活态,未激活按失败处理(触发回滚,官方接管)
  if (fiber?.state !== 2) {
    const waiting = fiber?.inject ? Object.keys(fiber.inject).join(',') : '?'
    throw new Error(`执行器 fiber 未激活(state=${fiber?.state},inject=${waiting})`)
  }
}

/**
 * runtime-disable 接管序列(apply 落定后的异步链,不阻塞 apply 生命周期):
 * 禁用启用中的官方行 → 等双行退场 → 挂执行器。任何失败都把系统带回官方
 * 自服务形态:禁一半(update 失败)回滚已禁行;挂载失败(官方已退场,
 * ctx.shell 真空)回滚启用官方两行令其复活。
 */
async function runtimeTakeover(ctx, config, targets) {
  const { disabled, failed } = await runtimeDisableRows(targets)
  recordTakeover({ event: `disabled=${disabled.length} updateFailed=${failed.length}` })
  if (failed.length > 0) {
    ctx.logger.warn(`shell-select: 官方行运行时禁用失败(${failed.length} 行),回滚并保持官方服务`)
    await rollbackDisabledRows(disabled)
    recordTakeover({ event: `rolledBack=${disabled.length}, 不挂载` })
    return
  }
  const exited = await awaitOfficialExit(targets)
  if (!exited) {
    ctx.logger.warn('shell-select: 官方行退场超时,放弃接管(官方 fiber 仍在服务);重启后由行树声明态收敛')
    recordTakeover({ event: 'runtime 退场超时,放弃挂载' })
    return
  }
  try {
    await mountExecutor(ctx, config)
    recordTakeover({ event: 'executed=mounted' })
    ctx.logger.warn('shell-select: 官方 pwsh 链已运行时禁用,本包执行器接管 ctx.shell 与 shell 工具')
  } catch (error) {
    recordTakeover({ event: `挂载失败,回滚: ${error?.message ?? error}` })
    ctx.logger.error(`shell-select: 执行器挂载失败,回滚启用官方 pwsh 链: ${error?.message ?? error}`)
    await rollbackDisabledRows(targets)
  }
}
