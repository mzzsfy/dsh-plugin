/**
 * 断网判定:断网时续跑必然再失败一次,先挂起等联网可省掉一轮额度。
 *
 * 只做 DNS 解析,不建连接、不发请求。走 fake-ip / TUN 代理时解析总会成功,
 * 结果是放行,与关闭本功能等价,不会误挂起。
 */

import dns from 'node:dns'
import os from 'node:os'

export const PROBE_HOSTS = ['api.deepseek.com', 'www.baidu.com', 'one.one.one.one']
export const PROBE_TIMEOUT_MS = 3_000

/** 任一非内部接口即视为有网卡;读不到网卡信息时放行。 */
export function hasExternalInterface(read = () => os.networkInterfaces()) {
  try {
    const interfaces = read() ?? {}
    return Object.values(interfaces).some(
      (entries) => Array.isArray(entries) && entries.some((entry) => entry?.internal === false),
    )
  } catch {
    return true
  }
}

/** 显式代理下本地 DNS 可能本就不可用,只看网卡,避免永久误判。 */
export function usesExplicitProxy(env = process.env) {
  return [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy]
    .some((value) => typeof value === 'string' && value.trim() !== '')
}

function lookupWithin(host, timeoutMs, lookup) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dns lookup timed out: ${host}`)), timeoutMs)
    timer.unref?.()
    lookup(host).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** 构造探针;依赖可注入,便于测试。结果只可能是 true / false,永不 reject。 */
export function createConnectivityProbe({
  lookup = dns.promises.lookup,
  interfaces = os.networkInterfaces,
  env = process.env,
  hosts = PROBE_HOSTS,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  return async () => {
    if (!hasExternalInterface(interfaces)) return false
    if (usesExplicitProxy(env)) return true
    try {
      await Promise.any(hosts.map((host) => lookupWithin(host, timeoutMs, lookup)))
      return true
    } catch {
      return false
    }
  }
}

export const probeConnectivity = createConnectivityProbe()
