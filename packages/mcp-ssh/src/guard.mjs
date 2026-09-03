// 命令护栏:黑白名单匹配 + 审批状态机。
// 命中黑名单(或 whitelist 模式下未命中白名单)不直接执行,而是按 approvalMode:
// 'ui' → 创建 pending 审批,await 批准;超时或 'deny' → 拒绝。

import { createConfigWatcher, configPathOf } from './config.mjs'

export function createGuard(env = process.env) {
  const watcher = createConfigWatcher(configPathOf(env))
  let approvalSeq = 0

  // pending 审批: id → {resolve}
  const pending = new Map()

  function compileAll(config) {
    if (!config._blacklist) config._blacklist = config.compile('blacklist')
    if (!config._whitelist) config._whitelist = config.compile('whitelist')
    return config
  }

  // 判定: { verdict: 'allow' } | { verdict: 'review', reason } ;whitelist 永远豁免黑名单
  async function judge(command) {
    const config = compileAll(await watcher.refresh())
    for (const rule of config._whitelist) {
      if (rule.test(command)) return { verdict: 'allow', by: 'whitelist' }
    }
    const inWhitelistMode = config.mode === 'whitelist'
    if (inWhitelistMode) return { verdict: 'review', reason: `mode=whitelist 且命令未命中白名单` }
    for (const rule of config._blacklist) {
      if (rule.test(command)) return { verdict: 'review', reason: `命中黑名单规则 ${rule.source}` }
    }
    return { verdict: 'allow', by: 'pass' }
  }

  // 审批等待:approve(id,true/false) resolve;超时视为拒绝
  function requestApproval(command, host) {
    const id = `ap-${++approvalSeq}-${Date.now().toString(36)}`
    const promise = new Promise((resolve) => {
      pending.set(id, resolve)
    })
    return { id, promise }
  }

  function resolveApproval(id, approved) {
    const resolve = pending.get(id)
    if (resolve === undefined) return false
    pending.delete(id)
    resolve(Boolean(approved))
    return true
  }

  return {
    judge,
    requestApproval,
    resolveApproval,
    config: () => watcher.current(),
    refresh: () => watcher.refresh(true),
    brokenRules: () => watcher.brokenRules(),
  }
}
