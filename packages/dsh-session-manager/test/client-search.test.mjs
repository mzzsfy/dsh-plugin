// 归档搜索契约:搜索框位于 L1 标题/说明之下的搜索行,计数与视图操作归次级信息行;
// 放大镜按钮内嵌于输入框右侧;命中集恒为全部归档会话而非当前视图已展开的行,命中
// 平铺单独分页。通用性守卫:搜索退回二级视图内或改为过滤可见页,主列表首页之外的
// 归档就搜不到。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

// 搜索与计数定义段:searching 定义到主列表构造之前(不含视图分派)
const SEARCH_START = CLIENT_SRC.indexOf('const searching = query.trim()')
const SEARCH_END = CLIENT_SRC.indexOf('// 主列表(最近归档)')
assert.ok(SEARCH_START >= 0 && SEARCH_END > SEARCH_START, 'client.js 搜索框段定位失败')
const SEARCH_SRC = CLIENT_SRC.slice(SEARCH_START, SEARCH_END)

// 工具区段:toolbar 容器内的渲染子树(标题/说明 + 搜索行 + 次级信息行 + 提示)
const TOOLBAR_START = CLIENT_SRC.indexOf("h('div', { className: 'sm-toolbar' }")
const TOOLBAR_SRC = CLIENT_SRC.slice(TOOLBAR_START, CLIENT_SRC.indexOf('archiveRegion,', TOOLBAR_START))
assert.ok(TOOLBAR_START >= 0, 'client.js 工具区定位失败')

// 归档区域分派段:从 archiveRegion 定义到面板 return 之前
const DISPATCH_SRC = CLIENT_SRC.slice(
  CLIENT_SRC.indexOf('const archiveRegion'),
  CLIENT_SRC.indexOf("h('div', { className: 'sm-panel' }"),
)

test('源码契约:搜索框独占标题/说明之下的搜索行,仅空归档时隐藏,不随浏览视图分叉', () => {
  assert.equal((CLIENT_SRC.match(/'sm-search__input'/g) || []).length, 1, '搜索输入框必须唯一')
  assert.ok(SEARCH_SRC.includes('const searchField = rows.length === 0'),
    '搜索框隐藏条件应仅为空归档')
  assert.ok(!SEARCH_SRC.includes('view ==='), '搜索框定义段不得引入视图分支')
  assert.ok(TOOLBAR_SRC.includes('searchField,'), '搜索框未渲染在工具区')
  assert.ok(TOOLBAR_SRC.includes('metaRow,'), '次级信息行未渲染')
  assert.ok(!CLIENT_SRC.includes('sm-libbar'), '二级视图内的旧搜索栏样式残留')
})

test('源码契约:放大镜按钮内嵌于输入框右侧', () => {
  assert.ok(SEARCH_SRC.includes("className: 'sm-search__go'"), '缺右侧内嵌放大镜按钮')
  assert.ok(SEARCH_SRC.includes("type: 'button'"), '内嵌放大镜须为 button(不进表单提交)')
  assert.ok(SEARCH_SRC.includes("'aria-label': '聚焦搜索框'"), '内嵌放大镜按钮缺准确可访问名')
  assert.ok(/\.sm-search__go, \.sm-search__clear \{[^}]*width:28px; height:28px/.test(CLIENT_SRC), '内嵌按钮未取图标按钮 28×28 规格')
  assert.ok(/\.sm-search \{ display:flex[^}]*padding:0 4px 0 0;/.test(CLIENT_SRC), '搜索框外框内边距未按 4px 右留白收敛')
  assert.ok(/\.sm-search__input \{[^}]*padding:0 10px;/.test(CLIENT_SRC), '输入框水平内边距未落在输入框自身(点击区)')
  assert.ok(CLIENT_SRC.includes('.sm-search:focus-within'), '焦点环未落在搜索框外框')
  assert.ok(CLIENT_SRC.includes('.sm-search__input::-webkit-search-cancel-button'),
    '原生清除叉未隐藏,会与内嵌按钮重叠')
  assert.ok(SEARCH_SRC.includes('h(SearchIcon, null)'), '内嵌按钮未使用放大镜图标')
  assert.ok(/function SearchIcon\(\)[^]*?'aria-hidden': 'true'/.test(CLIENT_SRC), '放大镜图标缺少装饰性语义')
  assert.ok(CLIENT_SRC.includes('.sm-search__icon { display:block; width:14px; height:14px; }'), '放大镜图标尺寸标尺缺失')
  const goSrc = SEARCH_SRC.slice(SEARCH_SRC.indexOf("className: 'sm-search__go'"))
  assert.ok(goSrc.includes('searchInputRef.current.focus()'), '放大镜按钮点击未把焦点交给输入框')
})

test('源码契约:有搜索词时内嵌清除按钮,清空后恢复全量', () => {
  assert.ok(SEARCH_SRC.includes("className: 'sm-search__clear'"), '缺内嵌清除按钮')
  assert.ok(/searching\s*\n\s*\? h\('button', \{\s*\n\s*className: 'sm-search__clear'/.test(SEARCH_SRC),
    '清除按钮未受搜索态显隐控制')
  assert.ok(SEARCH_SRC.includes("'aria-label': '清除搜索'"), '清除按钮缺可访问名')
  assert.ok(SEARCH_SRC.indexOf('sm-search__clear') > SEARCH_SRC.indexOf('sm-search__input'),
    '清除按钮未排在输入框之后(右侧内嵌)')
  assert.ok(SEARCH_SRC.indexOf('sm-search__clear') < SEARCH_SRC.indexOf('sm-search__go'),
    '清除按钮未排在放大镜按钮左侧')
  const clearSrc = SEARCH_SRC.slice(SEARCH_SRC.indexOf('sm-search__clear'), SEARCH_SRC.indexOf('sm-search__go'))
  assert.ok(clearSrc.includes("setQuery('')"), '清除按钮未清空搜索词')
  assert.ok(clearSrc.includes('setSearchCount(ARCHIVE_PAGE_SIZE)'), '清除按钮未重置命中分页')
  assert.ok(clearSrc.includes('h(ClearIcon, null)'), '清除按钮未使用关闭图标')
  assert.ok(!clearSrc.includes('setView'), '清除搜索不得改变浏览视图')
})

test('源码契约:命中集取全部归档行,不取当前视图可见页', () => {
  assert.ok(SEARCH_SRC.includes('filterArchiveRows(rows, query)'), '命中集未取全量归档行')
  assert.ok(!/filterArchiveRows\((recentPage|searchPage|groupTray)/.test(CLIENT_SRC), '命中集误取可见页')
  assert.ok(SEARCH_SRC.includes('pageArchiveRows(matchedRows, searchCount)'), '命中集未独立分页')
  assert.ok(SEARCH_SRC.includes('setSearchCount(ARCHIVE_PAGE_SIZE)'), '搜索词变化未重置命中分页')
})

test('源码契约:搜索态命中平铺、计数改报命中数、隐去视图入口', () => {
  assert.ok(/\? searchTray\s*\n\s*: view === 'recent' \? recentTray\(\) : groupTray\(\)/.test(DISPATCH_SRC),
    '归档区域分派顺序应为 搜索命中 > 主列表 > 工作区分组')
  assert.ok(CLIENT_SRC.includes("'没有匹配的归档会话'"), '缺搜索无命中空态')
  assert.ok(SEARCH_SRC.includes("matchedRows.length + ' 条匹配'"), '次级信息行未在搜索态改报命中数')
  assert.ok(TOOLBAR_SRC.includes('metaRow,'), '次级信息行未渲染')
  assert.ok(/const metaRow = rows\.length === 0[\s\S]*?headCount, h\('span', \{ className: 'sm-spacer' \}\), viewToggle/.test(CLIENT_SRC),
    '次级信息行顺序应为 计数/弹性空隙/视图切换')
  assert.ok(/const viewToggle = rows\.length === 0 \|\| searching/.test(CLIENT_SRC),
    '搜索态与空归档应隐藏视图切换入口(命中平铺已与视图无关)')
  assert.ok(SEARCH_SRC.includes("'共 ' + rows.length + ' 条'"), '计数缺「共」前缀')
})

test('源码契约:L1 分区标题与说明保留在工具区顶部,视图切换固定在次级信息行右侧', () => {
  assert.ok(TOOLBAR_SRC.includes("className: 'sm-heading'"), '缺分区标题容器')
  assert.ok(TOOLBAR_SRC.includes("'sm-title'"), '缺 L1 分区标题')
  assert.ok(TOOLBAR_SRC.includes("'sm-desc'"), '缺分区说明行')
  assert.ok(TOOLBAR_SRC.includes("'会话归档'"), '分区标题文案缺失')
  assert.ok(TOOLBAR_SRC.indexOf("'sm-heading'") < TOOLBAR_SRC.indexOf('searchField,'),
    'L1 标题/说明未排在搜索行之前')
  assert.ok(TOOLBAR_SRC.indexOf('searchField,') < TOOLBAR_SRC.indexOf('metaRow,'),
    '搜索行未排在次级信息行之前')
  assert.ok(/const metaRow = rows\.length === 0[\s\S]*?headCount, h\('span', \{ className: 'sm-spacer' \}\), viewToggle/.test(CLIENT_SRC),
    '次级信息行未按 计数/弹性空隙/视图切换 排列')
  assert.ok(/const viewToggle = rows\.length === 0 \|\| searching\s*\n\s*\? null\s*\n\s*: view === 'recent'\s*\n\s*\? h\('button'[^]*?'按工作区浏览 ›'\)\s*\n\s*: h\('button'[^]*?'取消按工作区'\)/.test(CLIENT_SRC),
    '视图切换未在同一位置互为反操作')
  assert.ok(!CLIENT_SRC.includes('‹ 返回'), '不应保留独立的返回按钮')
})
