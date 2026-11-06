// 开关结构解析器:对客户端源码做字符串/注释感知的括号扫描,解析出
// (a) 每处 switch 根元素的 DOM 调用树;(b) CSS 规则表与三态选择器。
// 断言只消费解析结果,不匹配注释文本——注释删改不影响结论,实现退化(缺 track/thumb、
// checkbox 不再作为相邻兄弟、状态选择器失去 checkbox 锚定)会让结果结构缺失而失败。

const WHITESPACE = /\s/
const IDENT_PART = /[A-Za-z0-9_$]/
const REGEX_PREFIX_CHARS = '([{,;:=!&|?+-*%<>~^'
const REGEX_KEYWORDS = new Set([
  'return', 'case', 'throw', 'typeof', 'instanceof', 'in', 'of',
  'delete', 'void', 'new', 'do', 'else', 'yield', 'await',
])

// 正则字面量内可出现引号/括号(如 /[...']/),不跳过会把后续字符串与括号全部错位
function regexCanStart(text, slashIndex) {
  let index = slashIndex - 1
  while (index >= 0 && WHITESPACE.test(text[index])) index -= 1
  if (index < 0) return true
  const previous = text[index]
  if (REGEX_PREFIX_CHARS.includes(previous)) return true
  if (!IDENT_PART.test(previous)) return false
  let wordStart = index
  while (wordStart >= 0 && IDENT_PART.test(text[wordStart])) wordStart -= 1
  return REGEX_KEYWORDS.has(text.slice(wordStart + 1, index + 1))
}

function skipRegex(text, start) {
  let inClass = false
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '\n') return start + 1
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    else if (char === '/' && !inClass) return index + 1
  }
  return start + 1
}

function skipString(text, start) {
  const quote = text[start]
  let index = start + 1
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2
      continue
    }
    if (text[index] === quote) return index + 1
    index += 1
  }
  return text.length
}

// 注释替换为等长空白(换行保留),行号与括号位置保持稳定
export function stripComments(source) {
  let output = ''
  let index = 0
  let state = 'code'
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line'
        output += '  '
        index += 2
        continue
      }
      if (char === '/' && next === '*') {
        state = 'block'
        output += '  '
        index += 2
        continue
      }
      if (char === '/' && regexCanStart(source, index)) {
        const end = skipRegex(source, index)
        output += source.slice(index, end)
        index = end
        continue
      }
      if (char === "'" || char === '"' || char === '`') {
        state = char
        output += char
        index += 1
        continue
      }
      output += char
      index += 1
      continue
    }
    if (state === 'line') {
      output += char === '\n' ? '\n' : ' '
      if (char === '\n') state = 'code'
      index += 1
      continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code'
        output += '  '
        index += 2
        continue
      }
      output += char === '\n' ? '\n' : ' '
      index += 1
      continue
    }
    // 字符串/模板原文保留
    output += char
    index += 1
    if (char === '\\') {
      output += next ?? ''
      index += 1
      continue
    }
    if (char === state) state = 'code'
  }
  return output
}

function stringLiterals(text) {
  const literals = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '/' && regexCanStart(text, index)) {
      index = skipRegex(text, index)
      continue
    }
    if (char !== "'" && char !== '"' && char !== '`') {
      index += 1
      continue
    }
    const start = index
    index = skipString(text, index)
    literals.push({ start, end: index, value: text.slice(start + 1, index - 1) })
  }
  return literals
}

function matchBracket(text, open) {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '/' && regexCanStart(text, index)) {
      index = skipRegex(text, index) - 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      index = skipString(text, index) - 1
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function splitArgs(text, open) {
  const close = matchBracket(text, open)
  if (close < 0) return null
  const args = []
  let depth = 0
  let start = open + 1
  for (let index = open + 1; index < close; index += 1) {
    const char = text[index]
    if (char === '/' && regexCanStart(text, index)) {
      index = skipRegex(text, index) - 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      index = skipString(text, index) - 1
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) {
      if (text.slice(start, index).trim() !== '') args.push({ start, end: index, text: text.slice(start, index) })
      start = index + 1
    }
  }
  if (text.slice(start, close).trim() !== '') args.push({ start, end: close, text: text.slice(start, close) })
  return args
}

function readStringAt(text, position) {
  let index = position
  while (WHITESPACE.test(text[index] ?? '')) index += 1
  const quote = text[index]
  if (quote !== "'" && quote !== '"' && quote !== '`') return null
  let value = ''
  index += 1
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      value += text[index + 1] ?? ''
      index += 2
      continue
    }
    if (char === quote) return { value, end: index + 1 }
    value += char
    index += 1
  }
  return null
}

function propertyString(propsText, name) {
  const pattern = new RegExp('\\b' + name + "\\s*:\\s*(['\"])([^'\"]*)\\1")
  const match = propsText.match(pattern)
  return match ? match[2] : undefined
}

function firstNonWhitespace(text, position, end) {
  let index = position
  while (index < end && WHITESPACE.test(text[index])) index += 1
  return index
}

function findCalls(text) {
  const calls = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '/' && regexCanStart(text, index)) {
      index = skipRegex(text, index) - 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      index = skipString(text, index) - 1
      continue
    }
    if (char !== 'h' && char !== 'R') continue
    const previous = text[index - 1]
    if (previous !== undefined && (IDENT_PART.test(previous) || previous === '.')) continue
    let open = -1
    let name = ''
    if (char === 'h') {
      if (IDENT_PART.test(text[index + 1] ?? '')) continue
      let cursor = index + 1
      while (WHITESPACE.test(text[cursor] ?? '')) cursor += 1
      if (text[cursor] !== '(') continue
      name = 'h'
      open = cursor
    } else {
      if (!text.startsWith('React.createElement', index)) continue
      let cursor = index + 'React.createElement'.length
      if (IDENT_PART.test(text[cursor] ?? '')) continue
      while (WHITESPACE.test(text[cursor] ?? '')) cursor += 1
      if (text[cursor] !== '(') continue
      name = 'React.createElement'
      open = cursor
    }
    const close = matchBracket(text, open)
    if (close > open) calls.push({ start: index, open, close, name })
  }
  return calls
}

function parseElementAt(text, position) {
  const head = text.slice(position)
  const call = /^(?:React\.createElement|h)\s*\(/.exec(head)
  if (!call) return null
  const open = position + call[0].length - 1
  const args = splitArgs(text, open)
  if (!args || args.length === 0) return null
  const tag = readStringAt(text, args[0].start)
  if (!tag) return { tag: undefined, propsText: '', className: undefined, type: undefined, children: [], start: position, end: matchBracket(text, open) }
  const propsText = args.length > 1 ? args[1].text : ''
  const children = []
  for (const argument of args.slice(2)) {
    const childPosition = firstNonWhitespace(text, argument.start, argument.end)
    const child = childPosition < argument.end ? parseElementAt(text, childPosition) : null
    children.push(child)
  }
  return {
    tag: tag.value,
    propsText,
    className: propertyString(propsText, 'className'),
    type: propertyString(propsText, 'type'),
    children,
    start: position,
    end: matchBracket(text, open),
  }
}

function hasClass(element, className) {
  return element !== null && element !== undefined
    && typeof element.className === 'string'
    && element.className.split(/\s+/).includes(className)
}

function lineOf(text, position) {
  let line = 1
  for (let index = 0; index < position; index += 1) if (text[index] === '\n') line += 1
  return line
}

function parseCssRules(css) {
  const rules = []
  let depth = 0
  let ruleStart = 0
  let bodyStart = -1
  let selector = ''
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]
    if (char === '{') {
      if (depth === 0) {
        selector = css.slice(ruleStart, index).trim()
        bodyStart = index + 1
      }
      depth += 1
      continue
    }
    if (char !== '}') continue
    depth -= 1
    if (depth !== 0) continue
    rules.push({
      selector,
      selectors: selector.split(',').map((item) => item.trim().replace(/\s+/g, ' ')).filter(Boolean),
      body: css.slice(bodyStart, index),
    })
    ruleStart = index + 1
  }
  return rules
}

function collectCss(text, rootSelector) {
  const assignment = /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?=[`[])/g
  for (const match of text.matchAll(assignment)) {
    const start = match.index + match[0].length
    const char = text[start]
    let css = ''
    if (char === '`' || char === "'" || char === '"') {
      const literal = readStringAt(text, start)
      css = literal ? literal.value : ''
    } else {
      const close = matchBracket(text, start)
      if (close < 0) continue
      css = stringLiterals(text.slice(start, close + 1)).map((literal) => literal.value).join('\n')
    }
    if (css.includes(rootSelector)) return css
  }
  return stringLiterals(text)
    .filter((literal) => literal.value.includes(rootSelector))
    .map((literal) => literal.value)
    .join('\n')
}

export function analyzeSwitch(source, prefix) {
  const text = stripComments(source)
  const rootClass = prefix + '-switch'
  const trackClass = rootClass + '__track'
  const thumbClass = rootClass + '__thumb'
  const rootSelector = '.' + rootClass
  const trackSelector = '.' + trackClass
  const thumbSelector = '.' + thumbClass
  const calls = findCalls(text)

  const roots = []
  for (const literal of stringLiterals(text)) {
    if (!literal.value.split(/\s+/).includes(rootClass)) continue
    const before = text.slice(Math.max(0, literal.start - 32), literal.start)
    if (!/\bclassName\s*:\s*$/.test(before)) continue
    const owner = calls
      .filter((call) => call.open < literal.start && call.close > literal.start)
      .sort((left, right) => right.open - left.open)[0]
    if (!owner) continue
    const element = parseElementAt(text, owner.start)
    if (!element || element.tag !== 'label' || !hasClass(element, rootClass)) continue
    if (roots.some((existing) => existing.start === element.start)) continue
    roots.push(element)
  }
  roots.sort((left, right) => left.start - right.start)

  const rootFacts = roots.map((root) => {
    const children = root.children ?? []
    const inputIndex = children.findIndex((child) => child && child.tag === 'input' && child.type === 'checkbox')
    const trackIndex = children.findIndex((child) => child && child.tag === 'span' && hasClass(child, trackClass))
    const track = trackIndex >= 0 ? children[trackIndex] : null
    const thumbIndex = track
      ? (track.children ?? []).findIndex((child) => child && child.tag === 'span' && hasClass(child, thumbClass))
      : -1
    return {
      line: lineOf(text, root.start),
      root,
      children,
      input: inputIndex >= 0 ? children[inputIndex] : null,
      inputIndex,
      track,
      trackIndex,
      thumbIndex,
      // label 直接子节点里 input 与 track 必须相邻(CSS 用相邻兄弟选择器 +)
      adjacent: inputIndex >= 0 && trackIndex === inputIndex + 1,
    }
  })

  const checkboxLiterals = [...text.matchAll(/\btype\s*:\s*(['"])checkbox\1/g)].map((match) => ({
    line: lineOf(text, match.index),
    insideSwitch: roots.some((root) => match.index > root.start && match.index < root.end),
  }))

  const cssText = collectCss(text, rootSelector)
  const rules = parseCssRules(cssText)
  const selectors = rules.flatMap((rule) => rule.selectors.map((selector) => ({ selector, body: rule.body })))
  const exact = (selector) => selectors.find((item) => item.selector === selector)
  const inputSelector = rootSelector + ' input[type="checkbox"]'
  const checkedSelector = inputSelector + ':checked + ' + trackSelector
  const hidden = exact(inputSelector)
  const trackRule = exact(trackSelector)
  const thumbRule = exact(thumbSelector)
  const checkedTrack = exact(checkedSelector)
  const checkedThumb = exact(checkedSelector + ' ' + thumbSelector)
  const focusTrack = exact(inputSelector + ':focus-visible + ' + trackSelector)
  const disabledTrack = exact(inputSelector + ':disabled + ' + trackSelector)
  const bareStateSelector = new RegExp('\\' + rootSelector + '\\s+input:(?!\\[type)')
  const bareStateSelectors = selectors
    .map((item) => item.selector)
    .filter((selector) => bareStateSelector.test(selector))

  const { text: cssSource, ...cssFacts } = {
    text: cssText,
    hidden,
    trackRule,
    thumbRule,
    checkedTrack,
    checkedThumb,
    focusTrack,
    disabledTrack,
    bareStateSelectors,
  }

  return {
    rootClass,
    trackClass,
    thumbClass,
    roots: rootFacts,
    checkboxLiterals,
    css: { source: cssSource, rules, ...cssFacts },
  }
}
