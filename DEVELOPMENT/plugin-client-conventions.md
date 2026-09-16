# 插件 client 规约(UI 控件 / 导航图标 / 样式注入)

## 插件 UI 控件规约

- 插件 UI 中的布尔开关一律用开关(switch)形态,即 track 胶囊 + thumb 圆点的视觉开关,禁止裸 `<input type="checkbox">` 直接呈现,也不得用 `<input type="range">` 数值滑块实现布尔语义;多选列表行内的勾选同样用开关。独立布尔偏好用开关;成组分类的快捷切换(如事件分类启停)可用 pill 组(参考 `dsh-turn-notify` 的 `.tn-pill`,选中态 `.tn-pill--on`),不属布尔开关
- 实现模式:原生 checkbox 保留(`input[type="checkbox"]`,保可访问性与表单语义)但视觉隐藏,相邻兄弟节点 `track`(圆角胶囊 `<span>`)+ 其子节点 `thumb`(圆点 `<span>`)用 CSS 过渡呈现选中态;结构为 `label.<前缀>-switch > input[type="checkbox"] + .<前缀>-switch__track > .<前缀>-switch__thumb`,label 内允许其余子节点(文字标签、同 label 的文本 input)
- 各包样式类名必须带包前缀(前缀取包名缩写,须在 packages/ 全清单内唯一,如 `tn-switch` / `mce-switch`),因插件 style 均为全局注入;开关的 `:checked` / `:focus-visible` / `:disabled` 状态选择器必须以 `input[type="checkbox"]` 锚定,防止组合进含其他 input 的 label 时误伤;`:hover` 例外地锚定 label(视觉隐藏的 input 无法成为指针目标)
- 参考实现:`dsh-model-capability-editor` 的 `.mce-switch`(状态最全,含 disabled);`dsh-turn-notify` 的 `.tn-switch` 为同款。新包仿制并复制对应 switch-guard 守卫测试,不抽共享 UI 包

## 导航图标声明规约

插件需要设置导航分区图标或 dsh-market 卡片图标时,唯一合法方式是经 `dsh-settings-nav-icons` 的声明机制在 client 半区注册,禁止自行改写官方 svg 或另行注入图标:

```js
const NAV_ICON = { '<分区显示文本或插件名>': '<glyph 名或 svg>' }
if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
else window.__navicIconQueue = [NAV_ICON]
```

- 键为设置分区显示文本或插件名;值为内置 glyph 名或完整 16×16 `<svg>` 字符串(经安全门),合法 glyph 名与安全门规则见 `packages/dsh-settings-nav-icons/README.md`
- 生产者样板由 `dsh-settings-nav-icons` 契约测试锁定,改样板须同步全部生产者包
- 取图优先级:用户覆盖 > 插件声明 > 内置映射 > 关键词 > 哈希;同键重复注册幂等

## 插件 client 样式注入规约

插件 client 半区向文档注入或渲染 `<style>` 时(document.head 注入、组件树内 React 渲染或其他容器一律适用),创建节点必须自带 `data-plugin="<npm 包名>"`,值与 `__ModuleLoader__.load({id})` 注册 id(即 npm 包名)逐字一致,无论注入时机(材质化 / apply / 运行时挂载):

```js
// head 注入形态
const style = document.createElement('style')
style.setAttribute('data-plugin', '@mzzsfy/<包名>')
style.textContent = CSS
document.head.appendChild(style)
// 组件树内 React 渲染形态(h 别名等价,但守卫文本断言以全名匹配,示例与守卫对齐)
React.createElement('style', { 'data-plugin': '@mzzsfy/<包名>', dangerouslySetInnerHTML: { __html: CSS } })
```

- 机制背景:宿主 client-modules 在任意插件材质化时运行 `claimStyles`,把**文档中所有**无 `data-plugin` 的 style(不限 head,含组件树内渲染节点)归属给该材质化插件;该插件 HMR rebuilt 时 `dsh-client-hmr` 的 `removeOwnedStyles` 按 `data-plugin` 逐字匹配整批删除。无标记样式会被后续材质化的插件误收,随其 rebuilt 连带删除,受害插件无新的材质化/挂载触发前不重注,页面裸样式直至刷新——表现为"启动后多次点击后某插件页面偶发丢失 CSS"。机制对齐版本:dsh 0.1.5-rc.1 实测(dsh-client-modules / dsh-client-hmr 的 lib/client.js)
- 自带标记后三路径全通:他插件材质化 claimStyles 只收无标记节点(不误收);他插件 rebuilt 删不到本插件样式;自身 rebuilt 先删旧标记样式,fiber refresh 重跑 apply/挂载/渲染路径幂等重注(自愈)
- 原位复用路径(按 id 找到在位节点仅改 textContent)必须幂等补 `setAttribute('data-plugin', ...)`,防修复前旧代残留的缺标记节点跨代延续(参考 `dsh-toast` 的 ensureStyle stale 分支)
- 标记值禁止另起短名(如省略 @mzzsfy 前缀的包短名):值 != 注册 id 时自身 rebuilt 删不到旧样式,重注被幂等守卫跳过,刷新页面前 CSS 停留在旧版
- 契约守卫测试:包内测试断言 client.js 每个样式注入点都伴随 data-plugin 标记——head 注入断言 `createElement('style')` 与 `setAttribute('data-plugin', '<包名>')` 计数相等(守卫形态参考 `dsh-cron-board/test/client-id.test.mjs`);React 渲染形态断言 `createElement('style'` 出现处均携带 `data-plugin` prop;DOM 桩测试的假元素须实现 `setAttribute` 并记录属性供断言(参考 `dsh-toast/test/mount.test.mjs` 的 attrs 桩)
- 已知待归一:`dsh-usage-dash` 的 STYLE_ID 当前为包短名(`dsh-usage-dash`),不满足值=注册 id,自身 rebuilt 后样式不刷新;`dsh-rs-workflow` 两处 React 渲染 style(src/client.js:342,1170)无 data-plugin 标记,属标准受害形态且无守卫。两包待单独修复
