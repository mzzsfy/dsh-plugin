export const MAX_SCREEN_LINES = 200

function unavailable(message) {
  return Object.assign(new Error(message), { code: 'terminal/unavailable' })
}

export function resolvePrivateTerminal(controller, agent, id) {
  if (!(controller?.owners instanceof Map) || typeof controller.terminal !== 'function') {
    throw unavailable('Terminal private API unavailable')
  }
  // 由宿主执行 owner 和 closed identity 校验，插件不跨 owner 查找。
  const terminal = controller.terminal(agent, id)
  if (terminal !== controller.owners.get(agent.id)?.terminals.get(id)
    || typeof terminal?.enqueue !== 'function' || typeof terminal.operations?.then !== 'function') {
    throw unavailable('Terminal private operation queue unavailable')
  }
  return terminal
}

export async function readControllerViewport(controller, agent, id, lines) {
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > MAX_SCREEN_LINES) {
    throw new RangeError(`lines must be an integer between 1 and ${MAX_SCREEN_LINES}`)
  }
  const terminal = resolvePrivateTerminal(controller, agent, id)
  return terminal.enqueue(() => {
    if (resolvePrivateTerminal(controller, agent, id) !== terminal || terminal.closing !== undefined) {
      throw unavailable('Terminal no longer available')
    }
    const screen = terminal.screen
    const buffer = screen?.buffer?.active
    if (!Number.isSafeInteger(screen?.rows) || screen.rows < 1
      || !Number.isSafeInteger(buffer?.viewportY) || buffer.viewportY < 0
      || typeof buffer?.getLine !== 'function' || !Number.isSafeInteger(terminal.sequence)) {
      throw unavailable('Terminal private screen unavailable')
    }
    const viewportTop = buffer.viewportY
    const viewportBottom = viewportTop + screen.rows - 1
    const rowText = (row) => {
      const line = buffer.getLine(row)
      if (typeof line?.translateToString !== 'function') throw unavailable('Terminal screen row unavailable')
      return line.translateToString(true)
    }
    // normal buffer: 高窗口下内容与提示符在矩形上部,窗口以最新内容/非空光标行为界;
    // alternate buffer(TUI): 保持完整矩形坐标语义
    let end = viewportBottom
    if (buffer.type !== 'alternate') {
      if (!Number.isSafeInteger(buffer.cursorY) || buffer.cursorY < 0 || buffer.cursorY >= screen.rows
        || !Number.isSafeInteger(buffer.baseY) || buffer.baseY < 0) {
        throw unavailable('Terminal screen cursor unavailable')
      }
      let newest = viewportTop
      for (let row = viewportBottom; row >= viewportTop; row -= 1) {
        if (rowText(row) !== '') { newest = row; break }
      }
      // cursorY 相对滚底部(ybase);用户上滚后光标绝对行在 viewport 之外,不参与窗口
      const cursorRow = buffer.baseY + buffer.cursorY
      if (cursorRow >= viewportTop && cursorRow <= viewportBottom && rowText(cursorRow) !== '') {
        end = Math.max(newest, cursorRow)
      } else {
        end = newest
      }
    }
    const count = Math.min(lines, end - viewportTop + 1)
    const first = end - count + 1
    const text = Array.from({ length: count }, (_, offset) => rowText(first + offset)).join('\n')
    return { text, lines: count, truncated: end - viewportTop + 1 > count, state: terminal.info.state, sequence: terminal.sequence }
  })
}
