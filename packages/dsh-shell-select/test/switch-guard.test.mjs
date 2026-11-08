// 开关结构守卫 BDD(DEVELOPMENT/plugin-client-conventions.md 强制项):
// 布尔控件必须是 switch = label.<prefix>-switch > input[type="checkbox"] + track > thumb,
// 裸 checkbox / 缺 track / 缺 thumb / checkbox 不再是 track 相邻兄弟都属无报错 UI 退化。
// 本守卫解析客户端源码中的 CSS 规则与 DOM 调用树(非 includes 类名),注释文本不参与断言。
// 本包按执行者约束只新增本文件,解析器内联于此,不引入 test/ 辅助模块。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
function stripComments(source) {
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
    if (char === 'h') {
      if (IDENT_PART.test(text[index + 1] ?? '')) continue
      let cursor = index + 1
      while (WHITESPACE.test(text[cursor] ?? '')) cursor += 1
      if (text[cursor] !== '(') continue
      open = cursor
    } else {
      if (!text.startsWith('React.createElement', index)) continue
      let cursor = index + 'React.createElement'.length
      if (IDENT_PART.test(text[cursor] ?? '')) continue
      while (WHITESPACE.test(text[cursor] ?? '')) cursor += 1
      if (text[cursor] !== '(') continue
      open = cursor
    }
    const close = matchBracket(text, open)
    if (close > open) calls.push({ start: index, open, close })
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

function analyzeSwitch(source, prefix) {
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

  return {
    roots: rootFacts,
    checkboxLiterals,
    css: {
      source: cssText,
      rules,
      hidden,
      trackRule,
      thumbRule,
      checkedTrack,
      checkedThumb,
      focusTrack,
      disabledTrack,
      bareStateSelectors,
    },
  }
}

const PREFIX = 'sls'
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
const facts = analyzeSwitch(source, PREFIX)

test('Given 注入的开关 CSS When 解析规则 Then 隐藏 checkbox + track 胶囊 + thumb 圆点齐备', () => {
  const { css } = facts
  assert.ok(css.source.length > 0, `未解析到 .${PREFIX}-switch CSS`)
  assert.ok(css.hidden, `缺少 .${PREFIX}-switch input[type="checkbox"] 隐藏规则`)
  assert.match(css.hidden.body, /position\s*:\s*absolute/, 'checkbox 未绝对定位(视觉隐藏前提)')
  assert.match(css.hidden.body, /opacity\s*:\s*0/, 'checkbox 未视觉隐藏')
  assert.ok(css.trackRule, `缺少 .${PREFIX}-switch__track 规则`)
  assert.equal(css.trackRule.selector, `.${PREFIX}-switch__track`)
  assert.match(css.trackRule.body, /width\s*:/)
  assert.match(css.trackRule.body, /height\s*:/)
  assert.match(css.trackRule.body, /border-radius\s*:\s*(?:999px|50%)/, 'track 不是胶囊形')
  assert.ok(css.thumbRule, `缺少 .${PREFIX}-switch__thumb 规则`)
  assert.match(css.thumbRule.body, /border-radius\s*:\s*(?:999px|50%)/, 'thumb 不是圆点')
})

test('Given 开关状态选择器 When 解析 Then checked/focus/disabled 均以 input[type="checkbox"] 锚定', () => {
  const { css } = facts
  assert.ok(css.checkedTrack, '缺少 :checked + track 选中态规则')
  assert.ok(css.checkedThumb, '缺少 :checked 下 track > thumb 后裔规则(选中位移)')
  assert.match(css.checkedThumb.body, /(?:transform|left)\s*:/, 'thumb 选中态无位移')
  assert.ok(css.focusTrack, '缺少 :focus-visible + track 焦点态规则')
  assert.match(css.focusTrack.body, /outline\s*:/, '焦点态无可见轮廓')
  assert.ok(css.disabledTrack, '缺少 :disabled + track 禁用态规则')
  assert.deepEqual(css.bareStateSelectors, [], '状态选择器不得裸 input 锚定(会误伤同 label 其他 input)')
})

test('Given 开关渲染调用 When 解析 DOM 树 Then 根为 label 且 input/track/thumb 三件套顺序正确', () => {
  assert.ok(facts.roots.length >= 1, '未解析到 switch 根元素(根类名缺失或不在 label 上)')
  for (const fact of facts.roots) {
    const where = `第 ${fact.line} 行 switch`
    assert.equal(fact.root.tag, 'label', `${where} 根元素必须是 label`)
    assert.ok(fact.input, `${where} 缺少直接子节点 input[type="checkbox"]`)
    assert.equal(fact.input.tag, 'input')
    assert.equal(fact.input.type, 'checkbox', `${where} 控件语义不是 checkbox`)
    assert.match(fact.input.propsText, /\bchecked\b/, `${where} checkbox 未受控`)
    assert.ok(fact.track, `${where} 缺少 track 后裔`)
    assert.equal(fact.track.tag, 'span', `${where} track 必须是 span`)
    assert.ok(fact.thumbIndex >= 0, `${where} track 内缺少 thumb 后裔`)
    assert.equal(fact.track.children[fact.thumbIndex].tag, 'span', `${where} thumb 必须是 span`)
    assert.ok(fact.adjacent, `${where} input 与 track 必须相邻兄弟(CSS + 选择器依赖)`)
  }
})

test('Given 源码全部 checkbox 字面量 When 逐一定位 Then 每个都位于 switch 结构内(无裸 checkbox)', () => {
  assert.ok(facts.checkboxLiterals.length >= facts.roots.length, 'checkbox 数量少于 switch 根数量')
  const naked = facts.checkboxLiterals.filter((item) => !item.insideSwitch)
  assert.deepEqual(naked, [], `存在开关结构外的裸 checkbox: ${naked.map((item) => item.line).join(', ')}`)
})

test('Given 注释中写入退化开关文本 When 重新解析 Then 结构与 CSS 结论不变(断言不依赖注释)', () => {
  const decoy = [
    `// .${PREFIX}-switch input:checked + .${PREFIX}-switch__track { background: red; }`,
    '/* 本行若被当作 CSS,会伪造裸 input 状态选择器;若被当作 DOM,会伪造 switch 根 */',
    source,
  ].join('\n')
  const parsed = analyzeSwitch(decoy, PREFIX)
  assert.equal(parsed.roots.length, facts.roots.length)
  assert.equal(parsed.checkboxLiterals.length, facts.checkboxLiterals.length)
  assert.deepEqual(parsed.css.bareStateSelectors, [])
  assert.equal(Boolean(parsed.css.hidden), Boolean(facts.css.hidden))
})
