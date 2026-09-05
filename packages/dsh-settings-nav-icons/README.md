# @mzzsfy/dsh-settings-nav-icons

DeepSeek Harness 纯前端插件:设置弹窗左侧导航与 dsh-market 插件市场卡片的图标适配——原版 Shell 只为 `models` / `agent-presets` / `plugins` 三个分区 id 提供专属图标,其余分区(含通用设置)一律回退齿轮;本插件按分区显示文本把齿轮换成专属图形,并为市场卡片头像槽提供插件语义图标。

## 行为

| 场景 | 行为 |
|---|---|
| 分区显示文本命中声明或内置映射 | 替换为对应图形 |
| 分区未收录、当前是官方齿轮 | 关键词主题图 → 稳定哈希备用池,不再露齿轮 |
| 分区未收录、当前是官方原生图标(模型/插件/Agent 预设/使用统计) | 不干预 |
| 市场卡片头像槽(有名称锚) | 按插件名取图替换作者头像/字母色块 |
| 语言切换导致 label 变化 | 按新 label 重新匹配替换 |
| 面板关闭后重新打开 / 会话切换 | 新渲染的齿轮自动再替换 |
| 插件卸载 | 观察器随 `ctx.effect` 销毁,重载页面即恢复官方默认 |

## 取图优先级

```
外部声明(register) → 内置映射(ICONS) → 名称关键词(NAME_RULES) → 稳定哈希备用池(FALLBACK)
```

- **外部声明**:其他插件运行时注册自己的 label/插件名 → 图标,优先级最高(见下节)。
- **内置映射**:官方分区与无法改源的第三方分区。
- **关键词**:插件名/分区名整词命中语义关键词得主题图(git→分支、im→机器人、search→放大镜、usage→图表等 19 组规则);整词边界匹配,`im` 不误伤 `important`。
- **备用池**:星芒/层叠/标签/网格四个中性图形,按名称稳定哈希取一个——同一名称永远同一图形,重渲染不闪动。dsh-market 目录内全部插件(含下载量前 1000)至此都有图标。

## 图标声明机制(其他插件接入)

设置分区或市场插件自定义图标,在 client 半区加载后调用:

```js
// 方式一:nav-icons 已就绪时直接注册
window.__navicIcons.register({ '消息通知': 'bell' })

// 方式二:nav-icons 未就绪时入队,由其启动时排空
;(window.__navicIconQueue ??= []).push({ '消息通知': 'bell' })
```

- 键:分区显示文本(设置导航)或插件名(dsh-market 卡片)。两域共用一张表,同名时以先命中者生效,键请取不易与官方分区撞名的插件名。
- 值:内置 glyph 名(`tune/theme/bot/market/cube/mcp/shield/cards/plan/bell/wrench/archive/spark/layers/tag/grid/git/search/term/chart/code/doc/db/flow/globe/lock/image/zap`)或完整 16×16 `<svg>` 字符串。svg 字符串过安全门:完整开标签(拒绝 `<svgx` 残串)、不带 `on*` 事件属性/`<foreignObject>`/`javascript:` 外联、长度 ≤4096 字符;glyph 名查表经 `typeof` 收口,原型链成员不可能被注入。
- 声明值经归一化后写入注册表;同值重复注册幂等短路;非法值(未知 glyph/被安全门拒绝/非字符串)撤销该键声明,该分区回到默认管线(关键词/哈希兜底)。
- 声明持久化在 `window.__navicIconDeclarations`:本插件 client 半区热重载会重跑工厂而生产者不重发注册,持久层让重装实例恢复声明,页面刷新随 window 释放。
- 污染面收敛在 `window.__navicIcons` 单一命名空间,插件卸载时移除 API、取消已排定的重绘、队列恢复数组形态——卸载后生产者按上方「方式二」入队等待下一实例,不再驱动 DOM 改写;重载页面后全部还原为官方图标。

本仓库自有插件的分区图标即全部走此机制:usage-panel(账号余额 → plan)、turn-notify(消息通知 → bell)、maintain(版本与运维 → wrench)、session-manager(会话归档 → archive);四包的注册样板由本包测试做契约锁定。

## 内置映射表

| 分区显示文本 | 图形 |
|---|---|
| 通用设置 / General | 调节滑杆 |
| Theme / 外观 | 明暗对比 |
| IM机器人 | 机器人 |
| 插件市场 | 店面 |
| Agent Plugins 市场 | 六边形魔方 |
| MCP 服务 | 服务器堆叠 |
| 认证 | 盾+勾 |
| 侧边卡片 | 分栏面板 |

图形为 16×16 stroke 1.5 轮廓,currentColor,与官方 IconOutline16 视觉节奏一致。模型 / 插件 / Agent 预设是官方专属图标、使用统计(usage-statistics-panel)自带柱状图,均不收录。

## 实现要点

- 实现边界:`settings.*` 子槽位的声明权与渲染权均被原版 `dsh-client-ui-settings-general` 条目占用——`renderSlot` 只授予声明了 `children` 的条目(dsh-client-ui-renderer),而 Slot 声明全局唯一、重复声明即 `already declared`,因此任何插件都无法在保留设置页内容的前提下接管 Shell 重绘导航。DOM 观察是唯一不依赖官方契约变更的路径(dream-skin 与 dsh-better-sidebar 各自内置了同原理的一次性 hack)。
- 匹配锚点:分区显示文本而非分区 id——id 不进 DOM,文本是唯一稳定可见锚点;CSS Modules 哈希类名(`VOzbGW_*`)取字面量。label 一律 trim 后匹配,空白 label 直接跳过。
- 替换节点带 `data-navic` 标记:button 记账 label 以识别语言切换;市场卡片头像槽记账为插件名。IMG 头像槽不移除原节点(React 持引用,移除后 reconcile 复活会双图),隐藏原节点并记账、注入图标跟随其后。
- 幂等判定与注入内容解耦:记账 label 匹配且现役图标非官方齿轮即视为已处理,外部声明内容无需自带标记;`replacePass` 逐项 try/catch,单项异常不中断当轮其余处理。
- 生命周期:单个 `MutationObserver` 常驻 `document.body`(`childList` + `characterData`),变更去抖到 `requestAnimationFrame` 扫描;`ctx.effect` 持有,卸载即断开并取消已排定帧。常驻全文档观察是已知性能取舍:装饰性插件的目标域(设置弹窗/市场卡片)无稳定根锚点,两级观察的回归风险大于收益。
- 纯逻辑层(映射表 + 替换决策)在 `src/logic.mjs`,`src/client.js` 内嵌同源实现,`node --test` 以同一套场景对两份实现做 parity 验证(全表 deepEqual),另有编排层契约测试(注册校验/队列三态/生命周期/异常隔离)与四生产者样板契约测试。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-settings-nav-icons
```

开发安装(仓库工作副本以 NTFS junction 挂进 profile,改代码刷新页面即生效,无需发版):

```sh
node scripts/dev-link.mjs dsh-settings-nav-icons
```

前提:profile `package.json` 的 dependencies 有本包 semver 行、`dsh.profile.bundles` 有本包名(未发布包 registry 拉取会失败,junction 覆盖 node_modules 物理目录后启动只走 realpath)。junction 会被 `pnpm install` / `dsh plugin add` 抹掉,之后重跑本脚本即可。

重启 dsh 后设置面板即生效;无设置项。

## 升级 / 卸载

```sh
dsh plugin --profile web add @mzzsfy/dsh-settings-nav-icons      # 升级到最新发布版本
dsh plugin --profile web remove @mzzsfy/dsh-settings-nav-icons   # 卸载
```

插件无 Host 端状态、无持久化副作用,卸载后重载页面即恢复官方默认齿轮。

## 测试

```sh
pnpm --dir packages/dsh-settings-nav-icons test
# 或
node --test packages/dsh-settings-nav-icons/test/*.test.mjs
```

覆盖:上表全部行为场景(替换 / 未收录跳过 / 幂等与内容解耦 / label 变化重贴 / trim 与空 label / 无 svg 降级 / 注入与记账 / 声明安全门 / 关键词边界 / 头像槽 img+div)、映射表契约、双实现全量同源 parity、client.js 注册 id 守卫、编排层契约(注册校验 / 队列三态 / 生命周期 / 异常隔离 / 持久层恢复)、四生产者样板契约。

## License

MIT
