// llm-pi-gateway guard 哨兵行:死态自愈,守服务不抢权。
// 死态 = gateway 行被禁(或不存在)且官方行仍被 bundle patch 禁用,两行
// 均停稳——无插件服务 provider 路由,所有模型不可用。触发路径:dsh-market
// 对本包(禁用承载官方行的 disable-carrier)的 UI 开关写入即时生效的
// user patch 行禁用,而其恢复机制(整包移出 bundles)只在下次 boot 生效,
// 窗口内 composed 自相矛盾。
// 自愈手段:动态挂载官方插件模块(ctx.plugin),settings 节与模型注册全
// 原生语义,挂 guard 子 context 随 guard fiber 卸载。gateway 行或官方行
// 任一复活时经 waterfall 先卸代挂再放行,apply 零冲突接管。guard 行 id 含
// "/",dsh-market 的行写入对其拒绝,窗口内始终存活,是死态唯一的自愈执行者。

import {
  OFFICIAL_ENTRY_ID,
  EXIT_POLL_INTERVAL_MS,
  EXIT_POLL_ROUNDS,
} from './takeover.mjs'

// 本包主行 id(cordis.patch.yml 的 insert 声明)
const GATEWAY_ENTRY_ID = 'llm-pi-gateway'
// guard 行 id:带 "/" 使 market 的 ROW_ID_RE 拒绝写入 user patch 层
export const GUARD_FOR_GATEWAY_ID = 'llm-pi-gateway/guard'

const GATEWAY_ABSENT = undefined
const OFFICIAL_ABSENT = undefined

function resolveEntry(loader, id) {
  try {
    return loader?.resolve(id) ?? GATEWAY_ABSENT
  } catch {
    return GATEWAY_ABSENT
  }
}

// 行有效禁用读宿主 Entry.disabled getter(!!js 求值 + 父链 + 宽化)。
// 调用方保证 entry 非 undefined;求值抛错按未禁用处理(保守向:少代挂,
// 不多抢)
function effectiveDisabled(entry) {
  try {
    return entry.disabled === true
  } catch {
    return false
  }
}

// 行停稳 = fiber 已撤清(uid null 即 dispose 完成,注册已全部释放)
function settled(entry) {
  return entry.fiber?.uid == null
}

/**
 * 死态判定:gateway 行缺席或禁用并已停稳,且官方行禁用并已停稳。
 * 任一行 fiber 未撤清(退场中)= 服务交接未完成,不为退场中的插件叠加
 * 第二个服务方;官方行未禁 = 官方自行服务。gateway 行启用但 fiber 已死
 * (apply 崩溃)的病态不在判定内:自愈执行者不越权重启他人。
 * @param {object|undefined} loader
 * @returns {boolean}
 */
export function detectDeadState(loader) {
  const gateway = resolveEntry(loader, GATEWAY_ENTRY_ID)
  const official = resolveEntry(loader, OFFICIAL_ENTRY_ID)
  const gatewayOff = gateway === GATEWAY_ABSENT || (effectiveDisabled(gateway) && settled(gateway))
  if (!gatewayOff) return false
  if (official === OFFICIAL_ABSENT) return false
  return effectiveDisabled(official) && settled(official)
}

/**
 * 安装 guard:apply 时判定初始死态,此后经 global 事件跟随死态边沿——
 * gateway 行退场(partial-dispose)且成死态时代挂,任一行复活
 * (patch-context)先卸代挂再放行。全部监听挂 guard 自身 fiber,随其卸载
 * 自动清理。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{importOfficial?: () => Promise<object>, delay?: (ms: number) => Promise<void>}} hooks
 *   测试注入桩;默认动态 import 官方包,缺失即干净禁用
 */
export async function installGuard(ctx, {
  importOfficial = () => import('@deepseek-ai/dsh-llm-pi-ai'),
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let officialModule
  try {
    officialModule = await importOfficial()
  } catch (error) {
    ctx.logger.warn(`llm-pi-gateway/guard: 官方 dsh-llm-pi-ai 不可用,死态自愈停用: ${error?.message ?? error}`)
    return undefined
  }
  let mounted = null
  let mounting = null

  // 代挂官方插件:挂 guard 子 context,Config 校验与 settings 节全原生
  // 语义;同一时刻至多一个代挂(mounting 去并发,mounted 去重入)
  async function mountOfficial() {
    if (mounted !== null || mounting !== null) return
    mounting = (async () => {
      try {
        const fiber = ctx.plugin(officialModule, {})
        await fiber
        mounted = fiber
        ctx.logger.warn('llm-pi-gateway/guard: 检测到 gateway 与官方行同时停用,已代挂官方插件恢复服务;重启后由宿主组合自然归位')
      } catch (error) {
        ctx.logger.error(`llm-pi-gateway/guard: 代挂官方插件失败: ${error?.message ?? error}`)
      } finally {
        mounting = null
      }
    })()
    await mounting
  }

  // 卸代挂:行复活的前置交接,必须完成后才放行其 apply。等待在途代挂
  // 完成,防复活放行与代挂激活交错抢注册
  async function unmountOfficial() {
    if (mounting !== null) await mounting
    if (mounted === null) return
    const fiber = mounted
    mounted = null
    try {
      await fiber.dispose()
    } catch (error) {
      ctx.logger.warn(`llm-pi-gateway/guard: 卸代挂失败(放行继续,接管方遇注册冲突会降级): ${error?.message ?? error}`)
    }
  }

  const patchContextGuard = async (entry, next) => {
    const id = entry?.options?.id
    if (id !== GATEWAY_ENTRY_ID && id !== OFFICIAL_ENTRY_ID) return next()
    if (entry.fiber?.uid != null) return next()
    if (mounted === null && mounting === null) return next()
    ctx.logger.warn(`llm-pi-gateway/guard: ${id} 行复活,卸代挂让位`)
    try {
      await unmountOfficial()
    } finally {
      return next()
    }
  }

  // 禁用边沿:行退场事件后,等其注册撤清(fiber 消失)再判死态,防与
  // 退场序列并发抢占官方注册。官方行退场(手动禁官方行)同样可能铸成
  // 死态。fiber 在场的事件是配置更新/重启路径(非退场),快速返回:
  // 宿主全部禁用/移除发射点都在 dispose 完成后
  const partialDisposeGuard = async (entry) => {
    const id = entry?.options?.id
    if (id !== GATEWAY_ENTRY_ID && id !== OFFICIAL_ENTRY_ID) return
    if (entry.fiber?.uid != null) return
    for (let round = 0; round < EXIT_POLL_ROUNDS; round += 1) {
      if (entry.fiber?.uid == null) break
      await delay(EXIT_POLL_INTERVAL_MS)
    }
    if (detectDeadState(ctx.loader)) await mountOfficial()
  }

  ctx.on('loader/patch-context', patchContextGuard, { global: true })
  ctx.on('loader/partial-dispose', partialDisposeGuard, { global: true })

  if (detectDeadState(ctx.loader)) await mountOfficial()
  return undefined
}

export const name = 'llm-pi-gateway/guard'

/**
 * guard 行入口:零配置,无服务依赖(loader 经 ctx 原型链可达)。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export async function apply(ctx) {
  await installGuard(ctx)
}
