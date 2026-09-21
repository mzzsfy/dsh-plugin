// 命令黑名单:deny 绝对——命中任一模式即拒,无豁免语义(精细放行在模式内
// 用正则前瞻表达,如 rm -rf\s+(?!\S*node_modules))。
// 护栏定位:启发式防误触,非安全边界(真边界是沙箱模式与访问模式)。

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
 * 黑名单匹配:命令命中任一 deny 条目即拒。
 * @param {string} command 模型提交的整条命令文本
 * @param {string[]|undefined} deny 拒绝正则列表
 * @throws {DenyError} 命中 deny
 */
export function matchDeny(command, deny) {
  const text = String(command ?? '')
  for (const pattern of deny ?? []) {
    const re = compile(pattern)
    if (re !== undefined && re.test(text)) throw new DenyError(pattern, text)
  }
}
