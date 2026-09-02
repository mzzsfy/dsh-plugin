// 热更新状态机(官方 apply 骨架同构):注册捕获事实(provider/displayName/
// retryPolicy)经深比较决定是否原地 replace;目录条目为配置面提供 settings
// 寻址;解析失败原样抛出,由接线方捕获保旧。纯逻辑,注册动作经依赖注入。

import { deepEqualJson } from '@deepseek-ai/dsh-settings'

export const SETTINGS_NS = 'llm-pi-gateway'

/** 注册捕获事实:排序消除纯重排误判(官方 registrationFacts 同构)。 */
export function registrationFacts(routes) {
  return [...routes.entries()]
    .map(([provider, route]) => ({
      provider,
      displayName: route.displayName,
      retryPolicy: route.retryPolicy,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/** 配置面目录条目:每个声明路由按来源节寻址(官方节路由指向官方节)。 */
export function directoryEntries(routes) {
  return [...routes.entries()].map(([provider, route]) => ({
    provider,
    displayName: route.displayName,
    settingsNs: route.source ?? SETTINGS_NS,
    settingsPath: ['providers', provider],
    declared: true,
  }))
}

/**
 * @param {object} hooks
 * @param {() => Map<string, object>} routes 当前配置解析出的路由表(可抛)
 * @param {(providers: string[], adapter: object) => {replace: (next: string[]) => void}} registerAdapter
 * @param {(entries: object[]) => {replace: (next: object[]) => void}} registerDirectory
 * @param {object} adapter 注册到 llm 的 adapter 实例
 */
export function createRouteManager({ routes, registerAdapter, registerDirectory, adapter }) {
  let registration
  let registeredFacts
  let directory
  let directoryFacts
  const ensureRegistration = () => {
    const facts = registrationFacts(routes())
    if (deepEqualJson(facts, registeredFacts)) return
    const providers = [...routes().keys()]
    if (registration === undefined) {
      if (providers.length === 0) {
        registeredFacts = facts
        return
      }
      registration = registerAdapter(providers, adapter)
    } else {
      registration.replace(providers)
    }
    registeredFacts = facts
  }
  const ensureDirectory = () => {
    const entries = directoryEntries(routes())
    if (deepEqualJson(entries, directoryFacts)) return
    if (directory === undefined) {
      if (entries.length === 0) {
        directoryFacts = entries
        return
      }
      directory = registerDirectory(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
  }
  return { ensureRegistration, ensureDirectory }
}
