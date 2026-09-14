// 开关样式守卫 BDD:裸 checkbox/裸 input 状态选择器会静默损坏 UI 或误伤同 label 的文本输入,
// 属无报错的 UI 退化,静态断言锁死 cb-switch 结构(参照 mce-switch 同款守卫)。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

test('switch 隐藏规则以 input[type="checkbox"] 精确匹配', () => {
  assert.match(source, /\.cb-switch input\[type="checkbox"\] \{ position:absolute/)
})

test('switch 状态选择器禁止裸 input 锚定(防误伤同 label 的文本输入)', () => {
  const bare = source.match(/\.cb-switch input:(?!\[type)[a-z-]+/g)
  assert.equal(bare, null, `裸 input 状态选择器: ${bare}`)
})

test('checkbox 仅允许出现在 switchToggle 工厂内,禁止裸 checkbox 直出', () => {
  const occurrences = [...source.matchAll(/type: 'checkbox'/g)].map((match) => match.index)
  assert.equal(occurrences.length, 1, `checkbox 字面量出现 ${occurrences.length} 次`)
  const factoryStart = source.indexOf('function switchToggle')
  const factoryEnd = source.indexOf('}', source.indexOf('__thumb', factoryStart))
  assert.ok(occurrences[0] > factoryStart && occurrences[0] < factoryEnd, 'checkbox 字面量不在 switchToggle 工厂内')
})

test('switchToggle 产出顺序为 input 在前 track 在后', () => {
  const factory = source.slice(source.indexOf('function switchToggle'))
  assert.ok(factory.indexOf("h('input'") < factory.indexOf('cb-switch__track'), '工厂内 input 必须先于 track')
})

test('disabled 态 hover 高亮被 :has 守卫排除', () => {
  assert.match(source, /\.cb-switch:not\(:has\(input\[type="checkbox"\]:disabled\)\):hover/)
})

test('checked/focus-visible/disabled 三态均以 checkbox 锚定', () => {
  assert.match(source, /\.cb-switch input\[type="checkbox"\]:checked \+/)
  assert.match(source, /\.cb-switch input\[type="checkbox"\]:focus-visible \+/)
  assert.match(source, /\.cb-switch input\[type="checkbox"\]:disabled \+/)
})

test('插件页卡片为官方 PluginCard 形制:li 卡壳 + 头部折叠 + 令牌同源', () => {
  // Given 官方插件卡片 = ul.cards > li.PluginCard(边框卡壳 + 名称/描述头部 + chevron 折叠)
  // When 本插件卡片注册进同一列表(slot 契约:外观归插件自持,官方壳未导出)
  // Then 静态锁定 cb-pc 镜像形制,防止退化回裸 div 平铺
  assert.match(source, /h\('li', \{ className: 'cb-pc/, '卡片根元素必须是 li(官方列表 ul.cards 的合法子元素)')
  assert.match(source, /\.cb-pc\{border:\.5px solid var\(--dsw-alias-border-l4\)/, '卡壳边框/底色令牌必须与官方 PluginCard 同源')
  assert.match(source, /h\('button', \{ type: 'button', className: 'cb-pc__head'/, '缺少官方形制的头部按钮')
  assert.match(source, /aria-expanded/, '头部必须可折叠并暴露 aria-expanded')
  assert.match(source, /\.cb-pc__hint\{[^}]*var\(--dsw-alias-label-tertiary\)/, '提示文本令牌必须与官方 hint 同源')
  assert.doesNotMatch(source, /'cb-settings'/, '旧裸 div 平铺形态已移除')
})

test('client.js 无顶层词法声明(经典 script 书挡内安全)', () => {
  // IIFE 书挡内允许任意声明;守卫确认整文件被书挡包裹
  const trimmed = source.trim()
  assert.ok(trimmed.startsWith('(() => {'), '必须以 IIFE 书挡开头')
  assert.ok(trimmed.endsWith('})()'), '必须以 IIFE 书挡结尾')
})

test('启停开关乐观更新契约:即时翻转 + 失败回滚提示,禁止等待往返才反馈', () => {
  // Given 受控 switch(checked 锁定 props)点击后无本地 state 变化不产生视觉反馈
  // When toggleJob/toggleEnv 发起 PATCH
  // Then 先乐观翻转,失败回滚并 notice,最后 reload 对账权威态(顺序锁定)
  for (const fn of ['toggleJob', 'toggleEnv']) {
    const start = source.indexOf('const ' + fn + ' = async')
    assert.ok(start > 0, `缺少 ${fn}`)
    const body = source.slice(start, source.indexOf('reload()', start))
    assert.match(body, /apply(Job|Env)Patch\([^)]*, \{ enabled: !/m, `${fn} 必须先乐观翻转`)
    assert.match(body, /if \(!outcome\.ok\)/m, `${fn} 必须检查 PATCH 结果`)
    assert.match(body, /apply(Job|Env)Patch\([^)]*, \{ enabled: (job|row)\.enabled \}\)/m, `${fn} 失败必须回滚`)
    assert.match(body, /切换失败:/m, `${fn} 失败必须提示,禁止静默`)
  }
  // 两个 Tab 均接收乐观更新通道(Board 下传)
  assert.match(source, /applyJobPatch, wsModel/)
  assert.match(source, /envs, reload, applyEnvPatch/)
})

test('client.js 主页面双形态挂载契约(默认宿主全局面板;设置开关手动移入侧边栏;无自动回退)', () => {
  // Given 定时任务是全局工具,入口必须不依赖会话:main 为 keyed 全局中央面板插槽,
  //        sidebar.panellist 为侧栏面板行,点击切换由宿主 layout.selectPanel 承载
  // When 插件以同 id 注册 main 条目 + panellist 条目;sidebarTab 偏好开启且服务在场时改注册 better-sidebar 扩展槽 tab
  // Then 静态锁定:双条目注册形态、服务软探测、tab 单实例、偏好驱动仲裁、设置卡片;
  //        DOM 刮取挂载与会话内页签形态(conversation.view)禁止回流
  assert.match(source, /window\.__ModuleLoader__\.load\(\{ id: '@mzzsfy\/dsh-cron-board', factory \}\)/)
  assert.match(source, /ctx\.slots\.inject\('main'/)
  assert.match(source, /name: 'main'/)
  assert.match(source, /key: PANEL_ID/)
  assert.match(source, /const PANEL_ID = 'cron-board'/)
  assert.match(source, /const PANEL_LABEL = '定时任务'/)
  assert.match(source, /ctx\.slots\.inject\('sidebar\.panellist'/)
  assert.match(source, /name: 'sidebar\.panellist'/)
  assert.match(source, /id: PANEL_ID/)
  assert.match(source, /function registerMainPanel/)
  assert.match(source, /cb-main/)
  // 面板贡献必须可拆除:effect 工厂收集 inject disposer 并交付组合清理,
  // 否则互斥仲裁拆不掉 main/panellist 条目,开关往返累积注册(审查阻断项)
  assert.match(source, /injectDisposers\.push\(ctx\.slots\.inject\('main'/)
  assert.match(source, /injectDisposers\.push\(ctx\.slots\.inject\('sidebar\.panellist'/)
  assert.match(source, /return \(\) => \{ for \(const dispose of injectDisposers\) dispose\(\) \}/)
  assert.match(source, /ctx\.get\('betterSidebar'\)/)
  assert.match(source, /single: true/)
  assert.match(source, /ctx\.inject\(\['betterSidebar'\]/)
  // 设置>插件页卡片(settings.plugin.item,key 配对 ns);better-sidebar 服务在场可切换,否则禁用仅展示
  assert.match(source, /ctx\.slots\.inject\('settings\.plugin\.item'/)
  assert.match(source, /key: PANEL_ID, label: PANEL_LABEL/)
  assert.match(source, /function CronBoardPluginCard/)
  assert.match(source, /'ui-settings'/)
  assert.match(source, /sidebarReady/)
  // 挂载仲裁:偏好(status.ui.sidebarTab)驱动全局面板/扩展槽互斥
  assert.match(source, /applyPref\(\)/)
  assert.match(source, /ui\.sidebarTab/)
  // 不再自动回退:attach 后不订阅页签状态,无 openTabs/subscribeState 联动
  assert.doesNotMatch(source, /subscribeState/)
  assert.doesNotMatch(source, /openTabs/)
  assert.doesNotMatch(source, /mountStandaloneBoard/)
  assert.doesNotMatch(source, /data-cb-board-active/)
  assert.doesNotMatch(source, /dsh-panel-activate/)
  assert.doesNotMatch(source, /data-pane="conversation"/)
  assert.doesNotMatch(source, /centerCol/)
  assert.doesNotMatch(source, /dshDesktop/)
  assert.doesNotMatch(source, /MutationObserver/)
  assert.doesNotMatch(source, /conversation\.view/)
})
