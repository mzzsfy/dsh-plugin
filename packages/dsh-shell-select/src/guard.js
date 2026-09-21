// shell-select guard 哨兵行:死态自愈,守服务不抢权(逐项同构 dsh-llm-pi-gateway
// guard,差异仅代挂对象为官方 tool-pwsh + pwsh-sandbox 两行,且无 compat 键处理)。
// 死态 = 主行功能性停摆(市场开关即时禁用 / apply 旗标 inactive)且官方两行仍被
// bundle patch 禁用停稳——无任何 shell 执行器与工具。代挂走 ctx.plugin,随 guard
// fiber 卸载;主行或官方行任一复活先卸代挂。guard 行 id 含 "/",市场行写入对其
// 拒绝,窗口内始终存活。

import { MAIN_ROW_ID, OFFICIAL_ROW_IDS, detectDeadState, rowState } from './guard-state.mjs'
import { officialRowConfig, readSettingsDocument, resolveFromHostTree } from './guard-config.mjs'
import { shellSelectApplyState } from './apply-state.mjs'

// 官方包 npm 名(与行 id 独立:行 id 是 dsh-base 组合行,包名才是模块解析键)
const OFFICIAL_PACKAGES = {
  'tool-pwsh': '@deepseek-ai/dsh-tool-pwsh',
  'pwsh-sandbox': '@deepseek-ai/dsh-pwsh-sandbox',
}
// pwsh-sandbox 行消费官方 settings 文档的 `shell` 节;tool-pwsh 行零配置(schema 默认)
const OFFICIAL_ROW_CONFIG = {
  'tool-pwsh': async () => ({}),
  'pwsh-sandbox': async () => officialRowConfig(readSettingsDocument),
}

// 事件缺失时的轮询兜底周期与退场等待上界(官方同构)
const SWEEP_INTERVAL_MS = 3000
const EXIT_POLL_INTERVAL_MS = 20
const EXIT_POLL_ROUNDS = 50
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
  timeouts = {},
} = {}) {
  const loadTimeout = timeouts.load ?? LOAD_TIMEOUT_MS
  const mountTimeout = timeouts.mount ?? MOUNT_TIMEOUT_MS
  const importOne = importOfficialOverride ?? importOfficial

  // 官方模块预载并归一挂载形态:瞬时失败退避重试,耗尽才停用自愈
  // (HMR 重建风暴期 import 竞争易超时,单次放弃会让死态窗口无自愈)
  const modules = new Map()
  const LOAD_RETRIES = 2
  const LOAD_RETRY_DELAY_MS = 3 * 1000
  for (const id of OFFICIAL_ROW_IDS) {
    let lastError = null
    for (let attempt = 0; attempt <= LOAD_RETRIES; attempt++) {
      try {
        const loaded = mountableOf(await withTimeout(importOne(OFFICIAL_PACKAGES[id]), loadTimeout, `guard 官方包 ${OFFICIAL_PACKAGES[id]} 加载`))
        if (loaded === undefined) throw new Error('模块既无 apply 也无 default 导出,无法挂载')
        modules.set(id, loaded)
        lastError = null
        break
      } catch (error) {
        lastError = error
        if (attempt < LOAD_RETRIES) {
          await delayOverride(LOAD_RETRY_DELAY_MS)
        }
      }
    }
    if (lastError !== null) {
      ctx.logger.warn(`shell-select/guard: 官方 ${OFFICIAL_PACKAGES[id]} 不可用,死态自愈停用: ${lastError?.message ?? lastError}`)
      return undefined
    }
  }

  // 代挂状态:id → fiber;mounting 去并发,卸载幂等
  let mounted = new Map()
  let mounting = null

  const readRowConfig = async (id) => {
    try {
      return await withTimeout(OFFICIAL_ROW_CONFIG[id](), mountTimeout, `guard ${id} 行配置读取`)
    } catch {
      return {}
    }
  }

  async function mountOfficial() {
    if (mounted.size > 0 || mounting !== null) return
    mounting = (async () => {
      const fibers = new Map()
      try {
        // 服务依赖方(tool-pwsh inject shell)与提供者(pwsh-sandbox provide shell)
        // 都不能串行 await 激活:依赖方挂载会在等待提供者时自锁。全部先发起,
        // 再统一等待落定;纤维 await 等的是激活完成,窗口由 mountTimeout 兜底。
        const created = OFFICIAL_ROW_IDS.map(async (id) => {
          const config = await readRowConfig(id)
          return [id, Promise.resolve(ctx.plugin(modules.get(id), config))]
        })
        for (const pair of await Promise.all(created)) {
          const [id, fiberPromise] = pair
          fibers.set(id, await withTimeout(fiberPromise, mountTimeout, `guard 代挂 ${id}`))
        }
        mounted = fibers
        ctx.logger.warn('shell-select/guard: 主行与官方 shell 链同时停用,已代挂官方工具恢复服务;重启后由宿主组合自然归位')
      } catch (error) {
        ctx.logger.error(`shell-select/guard: 代挂官方插件失败: ${error?.message ?? error}`)
        // 半挂态回收:已挂成的部分先卸,不留半套官方链
        for (const [id, fiber] of fibers) {
          try {
            await withTimeout(Promise.resolve(fiber).then((f) => f.dispose()), mountTimeout, `guard 回收半挂 ${id}`)
          } catch (disposeError) {
            ctx.logger.warn(`shell-select/guard: 半挂回收失败 ${id}: ${disposeError?.message ?? disposeError}`)
          }
        }
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
        await withTimeout(Promise.resolve(fiber).then((f) => f.dispose()), mountTimeout, `guard 卸代挂 ${id}`)
      } catch (error) {
        ctx.logger.warn(`shell-select/guard: 卸代挂失败 ${id}(${error?.message ?? error});放行继续,复活方可能撞残余注册,属有意取舍`)
      }
    }
  }

  // 复活让位:受控行任一即将 init 且本方在场,先卸代挂(waterfall 保证先于其 apply)
  const patchContextGuard = async (entry, next) => {
    const id = entry?.options?.id
    if (id !== MAIN_ROW_ID && !OFFICIAL_ROW_IDS.includes(id)) return next()
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

  // 禁用边沿:行退场后等注册撤清再判死态,防与退场序列并发
  const partialDisposeGuard = async (entry) => {
    const id = entry?.options?.id
    if (id !== MAIN_ROW_ID && !OFFICIAL_ROW_IDS.includes(id)) return
    if (entry.fiber?.uid != null) return
    for (let round = 0; round < EXIT_POLL_ROUNDS; round += 1) {
      if (entry.fiber?.uid == null) break
      await delayOverride(EXIT_POLL_INTERVAL_MS)
    }
    if (detectDeadState(ctx.loader, { applyState: shellSelectApplyState }) === true) await mountOfficial()
  }

  // 轮询兜底:边沿时序因宿主版本而异,周期全量扫描保证最终一致;mount/unmount 各自幂等
  let sweeping = false
  const sweep = async () => {
    if (sweeping) return
    sweeping = true
    try {
      const dead = detectDeadState(ctx.loader, { applyState: shellSelectApplyState })
      if (dead === true && mounted.size === 0 && mounting === null) await mountOfficial()
      else if (dead === false && (mounted.size > 0 || mounting !== null)) await unmountOfficial()
    } finally {
      sweeping = false
    }
  }

  // 可观测面:死态判定中间量与代挂状态只读暴露(排障与巡检共用)
  const webServer = ctx.get?.('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    const status = () => ({
      dead: detectDeadState(ctx.loader, { applyState: shellSelectApplyState }),
      applyState: shellSelectApplyState(),
      mounted: [...mounted.keys()],
      mounting: mounting !== null,
      rows: [MAIN_ROW_ID, ...OFFICIAL_ROW_IDS].map((id) => ({ id, ...rowState(ctx.loader, id) })),
    })
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/shell-select/guard-status',
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(status()))
      },
    }), 'shell-select/guard status route')
  }

  ctx.on('loader/patch-context', patchContextGuard, { global: true })
  ctx.on('loader/partial-dispose', partialDisposeGuard, { global: true })

  const initial = detectDeadState(ctx.loader, { applyState: shellSelectApplyState })
  ctx.logger.info?.(`shell-select/guard: 初始判定 dead=${initial}`)
  if (initial === true) await mountOfficial()

  const timer = setInterval(() => {
    void sweep()
  }, sweepIntervalMs)
  timer.unref?.()
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
