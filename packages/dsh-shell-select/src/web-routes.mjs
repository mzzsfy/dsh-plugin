// shell-select web 路由行:设置页数据通道(inject 声明式门控,webServer/settings
// 就绪才激活——主行一次性同步探测的时序竞态即 0.1.7 设置页 404 事故根因)。
// faces 不依赖执行器实例:配置事实源 = 行 Config(0.1.7 settings 面以 profile
// 条目 id 为 ns,行 Config 即设置存储,变更经 cordis 行重载活生效),读经
// settings.describe,写经 settings.replace;探测/扫描用 resolve 纯函数。
// HTTP 形态(具名 exact 路由 + 跨源守卫 + 业务异常归一 400)照 dsh-maintain。

import { KINDS, resolveConfig, coerceServiceable, assertServiceableConfig, normalizeConfigPaths, normalizeWin32Path } from './config.mjs'
import { candidateExists, detectCandidates, resolveEntryPath } from './resolve.mjs'
import { requestShellRefresh } from './executor.mjs'
import { mountRoutes } from './api.mjs'

export const name = 'shell-select/web'

export const inject = ['webServer', 'settings']

// 设置节命名空间 = 本包主行在组合树中的条目 id(cordis.patch.yml insert id)
export const SECTION_NS = 'shell-select'

/** 会话可见清单:条目 + 解析后的真实路径与可用性(与主行 listShells 同构)。 */
function listShellsOf(section) {
  return {
    default: section.default,
    shells: section.shells.map((entry) => {
      const resolved = normalizeWin32Path(resolveEntryPath(entry, candidateExists))
      return {
        id: entry.id,
        kind: entry.kind,
        args: entry.args,
        path: resolved,
        available: resolved !== undefined,
        login: entry.login === true,
        distro: entry.distro ?? '',
        env: entry.env ?? {},
      }
    }),
  }
}

/**
 * 从 settings describe 投影当前节:目标 ns 缺失(主行未挂/旧宿主形态)时
 * 回落出厂默认并告警,读路径不崩。
 */
function readSection(ctx, settings) {
  const found = (typeof settings.describe === 'function' ? settings.describe() : [])
    .find((descriptor) => descriptor.ns === SECTION_NS)
  if (found === undefined) {
    ctx.logger?.warn?.(`shell-select: settings 面无 "${SECTION_NS}" 节,设置页回落出厂默认`)
    return resolveConfig({})
  }
  // 读出面同走 coercing:落盘坏值(悬空 default/空 shells)投影为可服务配置,
  // 设置页显示与执行面一致,不再暴露不可服务的中间态
  return resolveConfig(coerceServiceable(found.value ?? {}).config)
}

/**
 * 设置页 faces:HTTP 层(api.mjs)与配置事实源(settings 行条目)的适配。
 * @param {{logger?: {warn?: Function}}} ctx 行上下文(告警通道)
 * @param settings 宿主 settings 服务(describe/replace)
 */
export function buildFaces(ctx, settings) {
  const readCurrent = () => readSection(ctx, settings)
  return {
    readConfig: () => readCurrent(),
    listShells: () => listShellsOf(readCurrent()),
    // replace 落盘后经模块级桥刷新执行面:执行器 provide 的 ctx.shell 作用域
    // 在主行子树,本行是兄弟行够不着(cordis 服务不横向查找,getter 直接
    // throw);cordis 对 volatile-only diff 换 ref 不重挂行,执行器手里的
    // 挂载快照就此陈旧——replace 成功即权威信号,桥调活跃实例换源并重建
    // 工具注册(原生设置页对本行被 auto:false 抑制,本 API 是唯一写口)
    async updateConfig(patch) {
      const current = readCurrent()
      const section = normalizeConfigPaths({
        ...current,
        shells: patch.shells ?? current.shells,
        default: patch.default ?? current.default,
        deny: Array.isArray(patch.deny) ? patch.deny : current.deny,
      })
      const validated = resolveConfig(section)
      assertServiceableConfig(validated)
      await settings.replace(SECTION_NS, section)
      requestShellRefresh(validated)
      return listShellsOf(validated)
    },
    detect: (kinds) => detectCandidates(kinds ?? [...KINDS], process.env, candidateExists),
    probe: (candidatePath) => candidateExists(candidatePath),
  }
}

/** 行入口:webServer/settings 已由 inject 门控就绪。 */
export function apply(ctx) {
  mountRoutes(ctx, buildFaces(ctx, ctx.get('settings')))
}
