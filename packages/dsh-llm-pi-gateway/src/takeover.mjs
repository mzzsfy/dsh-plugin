// 官方 llm-pi-ai entry 生命周期探测与复活守卫。
// 宿主 llm 三类注册(adapter/directory/discovery)与 settings 命名空间全部
// 排他(DUPLICATE_* / namespace 已注册即抛),官方插件与本包无法共存:接管态
// 下官方行复活会撞本包在场注册,官方 init 失败并拖垮整批 patch 应用(loader
// EntryGroup.update 任一失败即整批回滚)。守卫经 cordis waterfall 事件
// (global 监听 loader/patch-context)在官方 apply 前自停让位,是两插件间
// 唯一的原子交接点。

// 官方 bundle 行 id(dsh-base cordis.patch.yml 声明),与官方 settings
// 命名空间同值但概念独立:此为 loader 行 id,彼为 settings ns
export const OFFICIAL_ENTRY_ID = 'llm-pi-ai'

// 退场轮询步长与轮数上限,乘积为等待上界
export const EXIT_POLL_INTERVAL_MS = 20
export const EXIT_POLL_ROUNDS = 50

// 行 id 解析候选前缀:宿主把 profile 行树经 cordis:include 行挂载(嵌套
// 分隔符 EntryTree.sep = ":"),受控行的实际解析 id 带前缀;空串覆盖裸树
// 形态。resolve 对缺失 id 抛错,调用方逐候选试解
export const ROW_ID_PREFIXES = ['include:', '']

const ABSENT = Object.freeze({ present: false, disabled: false, running: false, entry: undefined })

// 宿主 Entry.disabled getter 语义:!!js 表达式求值 + 父链回溯 + 布尔宽化,
// 裸读 options.disabled 会漏掉表达式与非布尔真值两类禁用形态;求值抛错按
// 未禁用处理(让位安全向:不占官方资源,不会制造注册冲突)
function effectiveDisabled(entry) {
  try {
    return entry.disabled === true
  } catch {
    return false
  }
}

/**
 * 探测官方 entry 生命周期状态。loader 缺失或官方行不存在(官方包未装)按
 * 缺席处理,与「官方包缺失时照常接管」的既有降级语义一致。
 * @param {object|undefined} loader 宿主 loader 服务(cordis Loader/EntryTree)
 * @returns {{present: boolean, disabled: boolean, running: boolean, entry: object|undefined}}
 */
export function officialEntryState(loader) {
  if (loader?.resolve === undefined) return ABSENT
  let entry
  for (const prefix of ROW_ID_PREFIXES) {
    try {
      const candidate = loader.resolve(prefix + OFFICIAL_ENTRY_ID)
      if (candidate) {
        entry = candidate
        break
      }
    } catch {
      // 该命名空间无此行,试下一前缀
    }
  }
  if (!entry) return ABSENT
  return {
    present: true,
    disabled: effectiveDisabled(entry),
    running: entry.fiber?.uid != null,
    entry,
  }
}

/**
 * 接管决策:官方行缺席或已禁用停稳 → 接管;禁用但插件仍在退场 → 等待退场;
 * 行未被禁(用户层启用官方)→ 让位,官方节归官方插件。
 * @returns {'takeover'|'await-exit'|'yield'}
 */
export function takeoverDecision(state) {
  if (!state.present) return 'takeover'
  if (!state.disabled) return 'yield'
  return state.running ? 'await-exit' : 'takeover'
}

const defaultDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 有界等待官方插件退场(fiber 消失)。dispose 为纯内存操作毫秒级完成,
 * 轮询上界仅防御异常宿主状态。fiber 清空后官方注册的撤销还在卸载收尾
 * (微任务批)中完成,返回前补一轮间隔让收尾落定,避免接管首笔注册与
 * 官方未撤完的注册交错。
 * @returns {Promise<boolean>} true = 已退场;false = 轮询耗尽仍在场
 */
export async function awaitOfficialExit(entry, {
  intervalMs = EXIT_POLL_INTERVAL_MS,
  rounds = EXIT_POLL_ROUNDS,
  delay = defaultDelay,
} = {}) {
  for (let round = 0; round < rounds; round += 1) {
    if (entry.fiber?.uid == null) break
    await delay(intervalMs)
  }
  if (entry.fiber?.uid != null) return false
  await delay(intervalMs)
  return true
}

/**
 * 安装官方复活守卫:官方行即将 init(无 fiber 的 patch-context 事件)且本包
 * 正服务官方节时,await 自停完全卸载本包全部注册后放行,官方 apply 无冲突。
 * waterfall 保证放行发生在官方 apply 之前;监听器挂本包 fiber,随其卸载自动
 * 清理。dispose 后放行不得中断——不调 next 会否决整条 waterfall 链,令官方
 * init 永久挂起。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {() => boolean} isActive 本包当前是否正服务官方节
 */
export function installOfficialRevivalGuard(ctx, isActive) {
  ctx.on('loader/patch-context', async (entry, next) => {
    if (entry?.options?.id !== OFFICIAL_ENTRY_ID) return next()
    if (entry.fiber?.uid != null) return next()
    if (!isActive()) return next()
    ctx.logger.warn('llm-pi-gateway: 官方 llm-pi-ai 行即将启用,本包自停让位,避免注册冲突拖垮 patch 应用')
    try {
      await ctx.fiber.dispose()
    } catch (error) {
      ctx.logger.warn(`llm-pi-gateway: 让位自停失败: ${error?.message ?? error}`)
    }
    return next()
  }, { global: true })
}
