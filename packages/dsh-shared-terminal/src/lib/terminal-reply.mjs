// ConPTY 在终端尺寸变化后发 DSR 查询并阻塞等待应答;宿主把查询当普通输出广播,
// 远端 xterm 的自动应答经用户输入通道回写,延迟或重复时被 ConPTY 当键盘输入。
// 本模块在服务端摘出查询并按 headless 光标即时应答,远端既看不到查询也不产生应答。
const PATCHED = Symbol.for('@mzzsfy/dsh-shared-terminal/terminal-reply')

// 同一批内每种查询只应答一次:ConPTY 500ms 未收到应答会重发,累积出的重复请求
// 若逐条应答,除第一条外都会被它当成键盘输入塞给 shell。
const QUERY_PATTERN = /\x1b\[(?:\?6n|6n|c)/g
const RESPONSES = new Map([
  ['\x1b[6n', (row, col) => `\x1b[${row};${col}R`],
  ['\x1b[?6n', (row, col) => `\x1b[?${row};${col}R`],
  ['\x1b[c', () => '\x1b[?1;2c'],
])

const hasReplyShape = (terminal) => typeof terminal?.output === 'function'
  && typeof terminal?.handle?.write === 'function'
  && Number.isSafeInteger(terminal?.screen?.buffer?.active?.cursorX)
  && Number.isSafeInteger(terminal.screen.buffer.active.cursorY)

async function respond(terminal, query) {
  const build = RESPONSES.get(query)
  const buffer = terminal.screen?.buffer?.active
  if (build === undefined || typeof terminal.handle?.write !== 'function' || !Number.isSafeInteger(buffer?.cursorX)) return
  try {
    await terminal.handle.write(build(buffer.cursorY + 1, buffer.cursorX + 1))
  } catch {
    // 终端已退出:应答无人消费,不打断输出消费循环。
  }
}

// 按查询出现位置分段:先写查询之前的内容,再取当时的光标应答,位置与查询发生的时刻一致。
// matchAll 复制正则,多终端并发消费输出时不会共享 lastIndex。
async function dispatch(original, terminal, data) {
  if (typeof data !== 'string' || !data.includes('\x1b[')) return original.call(terminal, data)
  const answered = new Set()
  let cursor = 0
  for (const match of data.matchAll(QUERY_PATTERN)) {
    const chunk = data.slice(cursor, match.index)
    if (chunk !== '') await original.call(terminal, chunk)
    cursor = match.index + match[0].length
    if (answered.has(match[0])) continue
    answered.add(match[0])
    await respond(terminal, match[0])
  }
  if (cursor < data.length) await original.call(terminal, data.slice(cursor))
}

export function createTerminalReply(logger) {
  let prototype
  let original
  let patched
  let warned = false

  const install = (terminal) => {
    if (prototype?.[PATCHED] === true) return true
    if (!hasReplyShape(terminal)) return false
    const proto = Object.getPrototypeOf(terminal)
    if (typeof proto?.output !== 'function') return false
    prototype = proto
    if (proto[PATCHED] === true) return true
    original = proto.output
    patched = function output(data) { return dispatch(original, this, data) }
    proto[PATCHED] = true
    proto.output = patched
    return true
  }

  return {
    install,
    // 惰性安装:宿主可能尚未创建终端,拿到任意实例即可 patch 原型覆盖全部终端
    ensure(controller) {
      if (prototype?.[PATCHED] === true) return true
      let seen = false
      for (const owner of controller?.owners?.values?.() ?? []) {
        for (const terminal of owner?.terminals?.values?.() ?? []) {
          seen = true
          if (install(terminal)) return true
        }
      }
      // 没有实例只是尚未创建终端,不算形状漂移
      if (seen && !warned) {
        warned = true
        logger?.warn?.('[dsh-shared-terminal] 终端查询应答结构不匹配,跳过接管(工具仍可用,ConPTY 查询回落到宿主原通路)')
      }
      return false
    },
    get installed() { return prototype?.[PATCHED] === true },
    // 只有当前原型仍指向本实例安装的包装时才还原,避免多实例/HMR 交错卸掉别人的补丁
    dispose() {
      const owned = patched !== undefined && prototype?.output === patched
      if (owned) {
        prototype.output = original
        delete prototype[PATCHED]
      }
      prototype = undefined
      original = undefined
      patched = undefined
    },
  }
}
