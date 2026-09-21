// 命令黑白名单:防火墙语义——allow 豁免优先于 deny 拒绝。
// 护栏定位:启发式防误触,非安全边界(整文本正则挡不住间接包装,
// 真边界是沙箱模式与访问模式)。

/** 拒绝错误:工具层 catch 转模型可见标记。 */
export class DenyError extends Error {
  constructor(pattern, command) {
    super(`command blocked by shell-select deny pattern ${JSON.stringify(pattern)}: ${command.slice(0, 120)}`)
    this.name = 'DenyError'
    this.code = 'SHELL_COMMAND_BLOCKED'
    this.pattern = pattern
  }
}

/** 编译单条正则:大小写不敏感;坏条目返回 undefined(容错,不瘫执行链)。 */
function compile(pattern) {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return undefined
  }
}

/**
 * 黑白名单匹配:命令命中 allow 任一条目则放行,否则命中 deny 任一条目即拒。
 * @param {string} command 模型提交的整条命令文本
 * @param {string[]|undefined} deny 拒绝正则列表
 * @param {string[]|undefined} allow 豁免正则列表
 * @throws {DenyError} 命中 deny 且未被 allow 豁免
 */
export function matchDeny(command, deny, allow) {
  const exemptions = (allow ?? []).map(compile).filter((re) => re !== undefined)
  const text = String(command ?? '')
  if (exemptions.some((re) => re.test(text))) return
  for (const pattern of deny ?? []) {
    const re = compile(pattern)
    if (re !== undefined && re.test(text)) throw new DenyError(pattern, text)
  }
}
