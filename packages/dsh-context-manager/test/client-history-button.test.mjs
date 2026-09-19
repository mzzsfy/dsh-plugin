// 输入框历史按钮 BDD:寻行/注入纯函数切片(桩 DOM)+ 注入接线源码契约。
// client.js 单文件自包含无法 import,切片经 new Function 实例化后对桩 DOM 断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SRC = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

// 切片:按钮标记常量起点到历史浮层组件声明终点,范围内仅常量与纯函数
// (findToolsRow / ensureHistoryButton / histButtonSvg 全部经 doc 参数注入)
const PURE_START = CLIENT_SRC.indexOf('const HISTORY_BTN_FLAG = ')
const PURE_END = CLIENT_SRC.indexOf('function HistoryDock(')
assert.ok(PURE_START >= 0 && PURE_END > PURE_START, 'client.js 历史按钮切片定位失败')
const pure = new Function(
  CLIENT_SRC.slice(PURE_START, PURE_END)
  + '; return { findToolsRow: findToolsRow, ensureHistoryButton: ensureHistoryButton, HISTORY_BTN_FLAG: HISTORY_BTN_FLAG }',
)()

// ── DOM 桩:最小实现,行为断言所需。
// 建模局限(显式注明):stubButton 以 onclick 属性模拟 addEventListener(未建
// EventTarget 语义),插入位置仅覆盖行尾分支(stub 节点无 nextSibling)——
// 「插到最后一个 _add 之后但行尾尚有其他节点」的 ref 非空分支由源码契约
// (insertBefore 锚点)与 L3 人工回归兜底,桩不重复建模。 ──

function stubButton(className) {
  return {
    className,
    type: undefined,
    title: undefined,
    appended: null,
    addEventListener(type, fn) { this['on' + type] = fn },
    appendChild(node) { this.appended = node },
    setAttribute(name, value) { this['attr_' + name] = value },
    remove() {},
  }
}

function stubRow(buttons) {
  return {
    children: [...buttons],
    inserted: null,
    insertBefore(node, ref) { this.inserted = { node, ref }; this.children.push(node) },
    querySelector(selector) {
      // 注入标记选择器与生产同源:按导出常量拼锚,常量改名时桩同步失真暴露
      if (selector.includes(pure.HISTORY_BTN_FLAG)) return this.children.find((child) => child['attr_' + pure.HISTORY_BTN_FLAG] !== undefined) || null
      if (selector.includes('_add')) return this.children.find((child) => child.className.endsWith('_add')) || null
      return null
    },
    querySelectorAll(selector) {
      if (selector.includes('_add')) return this.children.filter((child) => child.className.endsWith('_add'))
      return []
    },
  }
}

// createElement 与 createElementNS 分开计数,svg 与按钮各自可断言;
// createElementNS 真实返回 tag 形态的节点(svg 内嵌 path)
function stubDoc(createdButtons, createdSvg) {
  return {
    createElement: (tag) => { const node = stubButton(''); node.tagName = tag; createdButtons.push(node); return node },
    createElementNS: (_ns, tag) => {
      const node = stubButton('')
      node.tagName = tag
      if (tag === 'svg') createdSvg.push(node)
      return node
    },
  }
}

// ── 场景6:寻行纯函数 ──

test('findToolsRow:行后缀 _tools 且直含 _add 按钮返回行,任一锚点漂移返回 null', () => {
  const toolsRow = { className: 'uV2eYG_tools' }
  const addInTools = { className: 'uV2eYG_add', parentElement: toolsRow }
  const otherRow = { className: 'uV2eYG_toolbar' }
  const addInOther = { className: 'uV2eYG_add', parentElement: otherRow }
  const doc = (buttons) => ({ querySelectorAll: () => buttons })
  assert.equal(pure.findToolsRow(doc([addInTools])), toolsRow, '双锚点一致应返回工具排行')
  assert.equal(pure.findToolsRow(doc([addInOther])), null, '行类后缀漂移必须拒绝注入')
  assert.equal(pure.findToolsRow(doc([])), null, '无 _add 按钮必须返回 null')
})

// ── 场景2:幂等注入 ──

test('ensureHistoryButton:克隆官方 _add 类名,插到最后一个 _add 之后,重复调用幂等', () => {
  const addA = stubButton('uV2eYG_add')
  const addB = stubButton('uV2eYG_add')
  const row = stubRow([addA, addB])
  const createdButtons = []
  const createdSvg = []
  const doc = stubDoc(createdButtons, createdSvg)
  const toggles = []
  const first = pure.ensureHistoryButton(doc, row, () => toggles.push(1))
  assert.notEqual(first, null, '工具排齐备时应注入成功')
  assert.equal(createdButtons.length, 1, '应创建恰好一个按钮')
  const button = createdButtons[0]
  assert.equal(button.className, 'uV2eYG_add', '必须克隆官方按钮类名获得原生视觉')
  assert.equal(button['attr_' + pure.HISTORY_BTN_FLAG], '', '必须携带注入标记防重复')
  assert.equal(button.type, 'button')
  assert.equal(typeof button.onclick, 'function', '点击必须接线 toggle')
  assert.deepEqual(row.inserted, { node: button, ref: null }, '应插到最后一个 _add 之后')
  assert.equal(createdSvg.length, 1, '应创建历史图标 svg')
  assert.equal(button.appended && button.appended.tagName, 'svg', '图标必须挂到按钮上')
  const again = pure.ensureHistoryButton(doc, row, () => toggles.push(2))
  assert.equal(again, first, '已注入时重复调用必须幂等返回既有按钮')
  assert.equal(createdButtons.length, 1, '幂等调用不得重复创建')
  button.onclick()
  assert.equal(toggles.length, 1, '点击应触发 toggle')
})

test('ensureHistoryButton:工具排缺官方 _add 按钮时返回 null(干净禁用)', () => {
  const row = stubRow([stubButton('uV2eYG_primary')])
  const createdButtons = []
  const createdSvg = []
  const result = pure.ensureHistoryButton(stubDoc(createdButtons, createdSvg), row, () => {})
  assert.equal(result, null, '无克隆源不得注入')
  assert.equal(createdButtons.length, 0)
})

// ── 场景3/4 接线契约:源码断言(观察器主体无法离线实例化)──

test('源码契约:HistoryDock 注入 effect 具备扫描守卫/卸载清理/外点守卫/toggle 接线', () => {
  assert.ok(CLIENT_SRC.includes("'button[class$=\"_add\"]'"), '扫描必须按官方 _add 按钮定位工具排')
  const scopeStart = CLIENT_SRC.indexOf('const HISTORY_BTN_FLAG = ')
  const scopeEnd = CLIENT_SRC.indexOf('function SteerRecallDock(')
  const scope = CLIENT_SRC.slice(scopeStart, scopeEnd)
  assert.ok(scope.includes("'[' + HISTORY_BTN_FLAG + ']'"), '移除与查询必须走注入标记选择器')
  // 外点关闭守卫:点击注入按钮不得触发浮层外点关闭(mousedown 先关后开竞态)
  assert.ok(scope.includes(".closest('[' + HISTORY_BTN_FLAG + ']')"), '外点关闭必须跳过注入按钮')
  // toggle:开→关,关→openPopup;经 ref 接线供挂载一次的监听器读到最新状态
  assert.ok(scope.includes('function toggleFromButton()'), '缺 toggle 接线函数')
  assert.ok(scope.includes('= toggleFromButton') && scope.includes('openPopup()'), 'toggle 必须经 ref 接线并闭合 openPopup')
})

// ── 场景3(按钮开关)/场景5(设置卡行):开关读取与停用接线契约 ──

test('源码契约:按钮开关挂载拉取,停用即移除已注入且不再注入,状态到达触发重扫', () => {
  assert.ok(CLIENT_SRC.includes("const HISTORY_BUTTON_ENABLED_URL = '/api/context/history-button-enabled'"), '缺按钮开关路由常量')
  const scopeStart = CLIENT_SRC.indexOf('function HistoryDock(')
  const scopeEnd = CLIENT_SRC.indexOf('function SteerRecallDock(')
  const scope = CLIENT_SRC.slice(scopeStart, scopeEnd)
  // 挂载拉取 + ref 双写(停用路径在观察器外也要即时生效)
  assert.ok(scope.includes('api(HISTORY_BUTTON_ENABLED_URL)'), '开关值必须挂载拉取')
  assert.ok(scope.includes('buttonEnabledRef.current = buttonEnabled'), '开关值必须双写 ref')
  // 扫描守卫必须同时受总开关与按钮开关约束,停用移除已注入
  assert.ok(/if \(enabledRef\.current === false \|\| buttonEnabledRef\.current === false\) \{\s*\n\s*removeAll\(\)/.test(scope), '扫描守卫缺按钮开关分支')
  // 开关值异步到达(不触发 DOM 变更)时需主动重扫
  assert.ok(/\[historyEnabled, buttonEnabled\]/.test(scope), '开关状态到达必须触发重扫')
})

test('源码契约:设置卡第六开关行走 switchRow 工厂,挂按钮开关路由与说明常量', () => {
  assert.ok(CLIENT_SRC.includes("switchRow(HISTORY_BUTTON_ENABLED_URL, '输入框历史按钮'"), '设置卡缺输入框历史按钮开关行')
  assert.ok(CLIENT_SRC.includes('h(HistoryButtonSwitchRow)'), 'ContextPanel 未挂载第六开关行')
  assert.ok(CLIENT_SRC.includes('const HISTORY_BUTTON_SWITCH_TITLE ='), '缺按钮开关说明常量')
})
