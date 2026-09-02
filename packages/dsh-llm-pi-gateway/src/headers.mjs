// 请求头装配:合并部署静态头与官方 attribution 头(dsh-llm 公共导出),
// 大小写不敏感剥除用户误配的撞名头——attribution 不可被覆盖也不可被抑制。

import { attributionHeaders } from '@deepseek-ai/dsh-llm'

/**
 * @param {object} [headers] 部署配置的静态头
 * @returns 合并后的请求头,attribution 头恒在
 */
export function requestHeaders(headers) {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()))
  return {
    ...Object.fromEntries(
      Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase())),
    ),
    ...attribution,
  }
}
