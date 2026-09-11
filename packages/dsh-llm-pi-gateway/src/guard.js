// llm-pi-gateway guard 哨兵行:死态自愈,守服务不抢权。
// 死态 = gateway 行功能性停摆(行被禁并停稳,或行活着但 apply 因宿主能力
// 缺失干净早退)且官方行仍被 bundle patch 禁用并停稳——无任何插件服务
// provider 路由,所有模型不可用。触发路径:dsh-market 对本包(禁用承载
// 官方行的 disable-carrier)的 UI 开关写入即时生效的 user patch 行禁用,
// 而其恢复机制(整包移出 bundles)只在下次 boot 生效,窗口内 composed
// 自相矛盾;旧宿主(rc.2)则恒为假活形态。
// 自愈手段:动态挂载官方插件模块(ctx.plugin),settings 节与模型注册全
// 原生语义,挂 guard 子 context 随 guard fiber 卸载。gateway 行或官方行
// 任一复活时先卸代挂再放行。guard 行 id 含 "/",dsh-market 的行写入对其
// 拒绝,窗口内始终存活,是死态唯一的自愈执行者。
//
// 版本兼容(0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-alpha.1 实测):
// - 行 id 解析:dsh 宿主把 profile 行树经 cordis:include 行挂载,嵌套
//   分隔符是 ":",受控行的实际解析 id 带前缀(裸 id resolve 抛错)。
// - guard 的 apply 与兄弟行同处一个 update 事务,首判可能早于兄弟行入树,
//   PENDING 时必须延迟重试,不能当真/假值使用。
// - 边沿事件时序因宿主版本而异(toggle 后的 in-process 重启、live 重载
//   事务都会吞掉或推迟边沿),以低频轮询兜底,mount/unmount 均幂等,
//   事件与轮询并发安全。

import {
  OFFICIAL_ENTRY_ID,
  EXIT_POLL_INTERVAL_MS,
  EXIT_POLL_ROUNDS,
  ROW_ID_PREFIXES,
} from './takeover.mjs'
import { gatewayApplyState } from './apply-state.mjs'

// 本包主行 id(cordis.patch.yml 的 insert 声明)
const GATEWAY_ENTRY_ID = 'llm-pi-gateway'
// guard 行 id:带 "/" 使 market 的 ROW_ID_RE 拒绝写入 user patch 层
export const GUARD_FOR_GATEWAY_ID = 'llm-pi-gateway/guard'
// 官方插件 settings 命名空间(官方源码常量同构)
const OFFICIAL_SETTINGS_NS = 'llm-pi-ai'

// 轮询兜底周期:边沿事件缺失/丢失时的状态跟随精度,幂等不抖动
const SWEEP_INTERVAL_MS = 3000
// boot 树就绪等待:兄弟行 update 事务完成的上限(超时按当前状态判定)
const BOOT_SETTLE_ROUNDS = 50
const BOOT_SETTLE_INTERVAL_MS = 100

// 无法解析该 id:boot 早期兄弟行未入树,或行确实不存在;两者对"是否
// 死态"都不可判定,调用方应稍后重试
const PENDING = null

// 解析按 ROW_ID_PREFIXES 候选顺序兜底;全部解析失败报 PENDING
function resolveEntry(loader, id) {
  for (const prefix of ROW_ID_PREFIXES) {
    try {
      const entry = loader?.resolve(prefix + id)
      if (entry) return entry
    } catch {
      // 该候选空间无此 id,试下一候选
    }
  }
  return PENDING
}

// 行有效禁用读宿主 Entry.disabled getter(!!js 求值 + 父链 + 宽化)。
// 调用方保证 entry 非 undefined/PENDING;求值抛错按未禁用处理(保守向:
// 少代挂,不多抢)
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
 * 死态判定:gateway 行功能性停摆(禁用停稳,或 apply 声明未接管),且官方
 * 行禁用并已停稳。官方行未禁 = 官方自行服务。gateway apply 中途崩溃
 * (旗标 undefined)不在判定内:自愈执行者不越权重启他人。
 * 返回 PENDING 表示行尚无法解析(树未就绪或行不存在),调用方应稍后
 * 重试——PENDING 不能当真值也不能当假值。
 * @param {object|undefined} loader
 * @returns {boolean|PENDING}
 */
export function detectDeadState(loader) {
  const gateway = resolveEntry(loader, GATEWAY_ENTRY_ID)
  const official = resolveEntry(loader, OFFICIAL_ENTRY_ID)
  if (gateway === PENDING || official === PENDING) return PENDING
  const gatewayOff = (effectiveDisabled(gateway) && settled(gateway))
    || gatewayApplyState() === 'inactive'
  if (!gatewayOff) return false
  return effectiveDisabled(official) && settled(official)
}

// 树就绪判定:两个受控行都可解析(apply 跑在兄弟行 update 事务内时,
// 解析会失败,此时不能做初始判定)
function treeReady(loader) {
  return detectDeadState(loader) !== PENDING
}

// 等待树就绪:guard apply 与兄弟行同事务,首判前必须等 gateway/official
// 行完成创建。上限 BOOT_SETTLE_ROUNDS 次,超时按当前状态判定(树长期
// 不就绪属宿主异常,持续轮询自会在就绪后接管)
async function waitTreeReady(loader, delay) {
  for (let round = 0; round < BOOT_SETTLE_ROUNDS; round += 1) {
    if (treeReady(loader)) return true
    await delay(BOOT_SETTLE_INTERVAL_MS)
  }
  return treeReady(loader)
}

// 官方包必须取自运行宿主本体树:guard 所在包经解析链裸 import 官方名会
// 命中与本宿主版本脱钩的副本(如仓库根 symlink 指向最新版本体),其
// apply 在旧宿主服务面上静默失能(注册空目录),代挂形同虚设。宿主入口
// (process.argv[1] = bin.js)所在 node_modules 树与本宿主 llm/settings
// 服务同源,经 createRequire 定位物理文件再动态 import。定位失败回退
// 裸 import(单一本体安装的常规形态下两者一致)
async function importOfficialFromHost() {
  const resolved = await resolveFromHostTree('@deepseek-ai/dsh-llm-pi-ai')
  if (resolved) {
    const { pathToFileURL } = await import('node:url')
    return import(pathToFileURL(resolved).href)
  }
  return import('@deepseek-ai/dsh-llm-pi-ai')
}

// 在宿主入口的依赖树内解析包的物理路径;宿主入口不可定位返回 null。
// realpath 穿透 junction/pnpm 软链,落到宿主本体 .pnpm 实体,解析才能
// 命中同宿主依赖树的包,而非外层链上的他版本副本
async function resolveFromHostTree(packageName) {
  try {
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const { realpath } = await import('node:fs/promises')
    const entry = process.argv[1]
    if (!entry) return null
    const realEntry = await realpath(entry)
    const require = createRequire(pathToFileURL(realEntry))
    return await realpath(require.resolve(packageName))
  } catch {
    return null
  }
}

/**
 * 安装 guard:树就绪后判定初始死态,此后事件跟随 + 轮询兜底双通道跟随
 * 死态/复活边沿——死态时代挂官方,任一行复活先卸代挂。全部状态挂 guard
 * 自身 fiber,随其卸载自动清理。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{importOfficial?: () => Promise<object>, rowConfig?: () => Promise<object>, delay?: (ms: number) => Promise<void>}} hooks
 *   测试注入桩;官方包默认取自宿主本体树,行配置默认读宿主 settings 文件,
 *   缺失即干净禁用
 */
export async function installGuard(ctx, {
  importOfficial = importOfficialFromHost,
  rowConfig,
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

  // settings 服务可达性经注入 API 探测:guard 未声明 inject,直接读
  // ctx.settings 在注入门控宿主上会抛错拖垮插件树。回调到达即服务就绪,
  // 同时留下服务面供行配置读取
  let settingsCtx = null
  try {
    ctx.inject(['settings'], (sctx) => { settingsCtx = sctx })
  } catch {
    // 注入 API 缺失,行配置退化为空,服务可达性视为未就绪
  }

  // 官方 ns 行内配置:官方 apply 的目录首注册先于其 settings 接线,行
  // 配置为空会让部分宿主版本以空目录注册失败,且失败后再无补齐通道。
  // settings 服务面读不到该节(官方行禁用时无人 register),只能读宿主
  // 落盘文件;接线完成后仍由 settings 面接管(setSource 覆盖行配置)
  async function officialRowConfig() {
    try {
      const settingsFile = await resolveFromHostTree('@deepseek-ai/dsh-home-paths')
      const resolvedYaml = await resolveFromHostTree('yaml')
      if (!resolvedYaml) return {}
      const { readFile } = await import('node:fs/promises')
      const { dirname, join } = await import('node:path')
      const { pathToFileURL } = await import('node:url')
      const { parse } = await import(pathToFileURL(resolvedYaml).href)
      let home = null
      if (settingsFile) {
        try {
          ;({ resolveDshHome: home } = await import(pathToFileURL(settingsFile).href))
        } catch {
          home = null
        }
      }
      const filename = typeof home === 'function' ? join(home(), 'settings.yaml') : join(dirname(process.execPath), 'settings.yaml')
      const document = parse(await readFile(filename, 'utf8'))
      return document?.[OFFICIAL_SETTINGS_NS] ?? {}
    } catch {
      return {}
    }
  }

  // 跨版本 compat 键差异:旧宿主的 wire protocol 不声明新键即拒整节,
  // 行配置随之失效。拒绝信息机器可读,记录被拒键并在后续构造时剥离,
  // 收敛后行配置即通过本宿主校验;仅影响代挂首注册,settings 接线后
  // 以 settings 面为准
  const refusedCompatKeys = new Set()
  const REFUSED_COMPAT_RE = /sets compat "([^"]+)", which no wire protocol declares/g
  function recordRefusedCompatKeys(message) {
    for (const match of String(message ?? '').matchAll(REFUSED_COMPAT_RE)) {
      refusedCompatKeys.add(match[1])
    }
  }
  function stripRefusedCompatKeys(section) {
    if (refusedCompatKeys.size === 0) return section
    const providers = section?.providers
    if (typeof providers !== 'object' || providers === null) return section
    const cleaned = structuredClone(section)
    for (const provider of Object.values(cleaned.providers)) {
      for (const model of provider?.models ?? []) {
        if (typeof model?.compat === 'object' && model.compat !== null) {
          for (const key of refusedCompatKeys) delete model.compat[key]
        }
      }
    }
    return cleaned
  }

  const settingsReady = () => settingsCtx !== null

  // 代挂官方插件:挂 guard 子 context,Config 校验与 settings 节全原生
  // 语义;同一时刻至多一个代挂(mounting 去并发,mounted 去重入)
  async function mountOfficial() {
    if (mounted !== null || mounting !== null) return
    mounting = (async () => {
      try {
        const section = await (rowConfig?.() ?? officialRowConfig())
        const fiber = ctx.plugin(officialModule, stripRefusedCompatKeys(section))
        await fiber
        mounted = fiber
        ctx.logger.warn('llm-pi-gateway/guard: 检测到 gateway 与官方行同时停用,已代挂官方插件恢复服务;重启后由宿主组合自然归位')
      } catch (error) {
        recordRefusedCompatKeys(error?.message)
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
    if (detectDeadState(ctx.loader) === true && settingsReady()) await mountOfficial()
  }

  // 轮询兜底:边沿事件的时序因宿主版本而异(toggle 后的 in-process 重启、
  // live 重载事务等都会吞掉或推迟边沿),周期性全量扫描保证死态→代挂、
  // 复活→卸代挂的最终一致。与事件通道幂等并发:mount/unmount 各自去重,
  // 双通道同时触发不会叠加。PENDING 轮跳过,下轮再扫。mount 前置条件:
  // settings 服务已 provide——官方目录首注册需要 settings 现值作行配置,
  // 且 boot 事务内 mount 会让官方插件的 settings 接线时序劣化
  let sweeping = false
  const sweep = async () => {
    if (sweeping) return
    sweeping = true
    try {
      const dead = detectDeadState(ctx.loader)
      if (dead === true && settingsReady() && mounted === null && mounting === null) await mountOfficial()
      else if (dead === false && (mounted !== null || mounting !== null)) await unmountOfficial()
    } finally {
      sweeping = false
    }
  }

  ctx.on('loader/patch-context', patchContextGuard, { global: true })
  ctx.on('loader/partial-dispose', partialDisposeGuard, { global: true })

  // 初始判定前必须等树就绪:apply 与兄弟行同事务,首判早了会全部
  // PENDING 而空转。settings 服务已注入即就地自愈;否则交由事件通道与
  // sweep(同一门槛)兜底,官方目录首注册需要其现值
  await waitTreeReady(ctx.loader, delay)
  if (detectDeadState(ctx.loader) === true && settingsReady()) await mountOfficial()

  // 兜底轮询:guard 行 fiber 存续期间持续扫描。guard entry 被宿主移除
  // (随 bundle patch 退场)即整体退场;fiber dispose 后 sweep 空转无害
  // (mounted 状态已无从变更)。unref 防定时器独占进程存活权;不能
  // await ctx.fiber:apply 内 await 自身 fiber 会死锁
  const timer = setInterval(() => { void sweep() }, SWEEP_INTERVAL_MS)
  timer.unref?.()
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
