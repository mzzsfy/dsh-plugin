# 插件 UI 统一设计规范

所有带 client 半区的包共用一份视觉决策。目标:用户在宿主界面里打开任意插件,看到的色彩、圆角、间距、字号、控件形态属于同一套设计语言;插件之间不出现第二种蓝、第二种红、第二种圆角体系,也不出现"插件比宿主小一号"的尺度断层。

本文件与 [plugin-client-conventions.md](plugin-client-conventions.md) 并列:那份管控件的结构契约(switch 结构、data-plugin 注入),本份管视觉决策(颜色值、尺寸标尺、状态语义、页面骨架)。两份同时生效。

## 场景分层:一套语言,三种密度

插件 UI 按宿主呈现位置分三层。层内参数固定,层间只允许下表的差异;禁止同一元素在两层出现两种形态。

| 层 | 适用 | 正文 | 控件高 | 容器圆角 | 行距 | 页面标题 |
|---|---|---|---|---|---|---|
| L1 设置类 | `settings.section` 分区、设置弹窗内表单 | 14px/22px | 32px | radius-md | 行 padding 8-12px(卡内)/16px(卡外) | 18px/600 分区标题(与导航同名),说明 13px |
| L2 面板类 | 侧栏入口的全屏页面(股票/定时任务/公司管理/穿透隧道等) | 13px/20px,表格 13px | 32px | radius-md | 行高 40px | 20px/500 |
| L3 注入类 | 输入区按钮、思维块、终端、提示条、状态栏 | 12px/18px | 24-28px | radius-sm | 紧凑 8-12px | 不适用 |

控件(按钮、输入、下拉)自身圆角统一 radius-sm,上表的"容器圆角"指卡片、面板、弹窗容器。

L1 的尺度与宿主官方设置页同一密度带(宿主设置行 14px/22px、控件 32-36px、行 padding 16px);卡内行 8-12px 是压缩密度的既定选择,与宿主行 16px 并存但不得用于宿主原生行替换。设置页顶部保留 18px/600 分区标题,与导航标签同名是允许且推荐的(标题是页面身份,不是重复噪音);空态与卡片不得用大留白撑高页面。设置面板内容宽度上限 560px(宽屏不铺满),列表操作列紧随内容,禁止用 `1fr` 把操作推到行尾留出大片空白。

宿主原生同构例外:与宿主官方行(如 BashRow 13px/24px、代码块小号 11px/16px)混排的注入面,允许按官方像素实现,优先级高于本表 L3 的 12px/18px;需在注释注明对齐目标。

## 色彩:唯一来源是宿主语义别名

插件禁止在样式中书写裸 hex / rgb 色值表达界面语义色——**包括 `var()` 的 fallback 位置**:字面值在暗色模式与主题切换时原样漏出,是主题错乱的直接来源。所有颜色必须来自宿主 `--dsw-alias-*` 语义别名:品牌色、状态色、中性色都允许规则内直接引用别名;需要 wash、别名复用或包级统一调整时,再经包局部 token 二次封装(token 值直接引用宿主别名,不写 fallback)。禁止的是自造色值与 fallback:

```css
/* 合法:包前缀局部 token,直接引用宿主别名 */
--xx-accent: var(--dsw-alias-brand-primary);
--xx-danger: var(--dsw-alias-state-error-primary);

/* 禁止:裸 hex 直接用于界面元素 */
color: #1677ff;

/* 禁止:var() 内字面色值 fallback(暗色/主题切换时漏色) */
--xx-accent: var(--dsw-alias-brand-primary, #1677ff);
```

前提:宿主 client 全局定义 `--dsw-alias-*` 别名全集(当前版本 114 个),别名随主题(含暗色)统一切换。引用了不存在的别名属缺陷,去除该引用或走宿主 API 对齐路径让宿主补齐,禁止自造别名并配自填值。

色彩槽位与宿主别名的唯一映射(局部 token 后缀即此表槽位名;直引或封装均可,值必须一致):

| 语义槽位 | 宿主别名 | 用途 |
|---------|---------|------|
| `<pfx>-accent` | `--dsw-alias-brand-primary` | 主操作、选中态、链接 |
| `<pfx>-accent-deep` | `--dsw-alias-button-primary-hover` | 主按钮 hover / accent 加深 |
| `<pfx>-accent-wash` | `--dsw-alias-brand-primary` 经 color-mix 12% 掺透明派生 | accent 浅底(选中行、信息条背景) |
| `<pfx>-ok` | `--dsw-alias-state-success-primary` | 成功、健康、启用 |
| `<pfx>-warn` | `--dsw-alias-state-warn-primary` | 警告、降级、接近阈值 |
| `<pfx>-danger` | `--dsw-alias-state-error-primary` | 错误、危险操作、删除 |
| `<pfx>-danger-wash` | `--dsw-alias-state-error-primary` 经 color-mix 10% 掺透明派生 | 危险文本按钮 / 列表行 hover 浅底 |

wash 派生式:`color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)`。wash 类浅底禁止固定浅色值(暗色主题下刺眼且漏色),一律从语义色派生。

禁止各包自造第四种状态色。信息类提示需要区分于品牌蓝时用 `<pfx>-warn`,不加 info 槽位。

中性色槽位(可选封装;规则内直引宿主别名等价,值必须与下表一致):

| 语义槽位 | 宿主别名 | 用途 |
|---------|---------|------|
| `<pfx>-bg` | `--dsw-alias-bg-layer-1` | 输入框、卡片底 |
| `<pfx>-bg-sub` | `--dsw-alias-bg-layer-2` | 嵌套层、下拉 |
| `<pfx>-bg-muted` | `--dsw-alias-bg-module-platform` | pill 容器、分区底 |
| `<pfx>-card` | `--dsw-alias-bg-layer-1` | 设置卡底(设置面板底为 layer-2,卡片下沉一层) |
| `<pfx>-card-border` | `--dsw-alias-border-l2` | 设置卡描边 |
| `<pfx>-border` | `--dsw-alias-border-l2` | 默认边框、分隔线 |
| `<pfx>-border-strong` | `--dsw-alias-border-l3` | 输入框、按钮描边 |
| `<pfx>-text` | `--dsw-alias-label-primary` | 主文本 |
| `<pfx>-text-sub` | `--dsw-alias-label-secondary` | 次要文本 |
| `<pfx>-text-dim` | `--dsw-alias-label-tertiary` | 说明、占位、单位 |
| `<pfx>-hover` | `--dsw-alias-interactive-bg-hover` | 行/按钮 hover |
| `<pfx>-hover-danger` | `--dsw-alias-interactive-bg-hover-danger` | 危险按钮 hover |
| `<pfx>-skeleton` | `--dsw-alias-bg-skeleton` | 加载骨架 |

图表、趋势线等数据可视化允许在语义槽位之外使用区分用色,但必须集中定义为包局部 token(如 `<pfx>-chart-1`),禁止规则内裸 hex;优先复用语义色,确需新增时饱和度(HSL S)不低于 70%,保证亮暗主题下可辨。等宽字体统一 `font-family: var(--ds-font-family-code)`;界面文本一律 `inherit`。宿主已定义的字体简写 token(`--dsw-font-*`)可直接使用,但字号必须落在本规范的标尺上;禁止引用宿主未定义的变量名。

例外:镜像宿主官方插件卡(settings.plugin.item 的 PluginCard)外观时,允许按官方 CSS 的固定像素值实现(需在注释中注明"镜像官方形制"),因为该类卡片要与同页官方卡片逐像素一致,优先于插件自身尺度。

## 尺寸标尺

- 间距以 4px 网格为主,允许 2/4/6/8/10/12/16/20/24;禁止 3/5/7/9/11 等奇数刻度新增。1px 只用于边框、徽标垂直微调与控件几何(如 34×19 开关内 13px thumb 的居中留白),不作为布局间距。
- 字号只用 11/12/13/14/16/20。禁止新增 9/10px;存量 9/10px 触及即收敛到 11。数据展示型大数字(卡片主数值、价格、图表中心值)允许 18/24/28,不得用于正文。行高固定 16/18/20/22/24/28。
- 圆角只经宿主变量:`<pfx>-radius-sm: var(--dsw-radius-sm)`(8px,输入/小按钮/徽标)、`<pfx>-radius-md: var(--dsw-radius-md)`(12px,卡片/面板/下拉)、`<pfx>-radius-lg: var(--dsw-radius-lg)`(16px,弹窗/大容器);圆形 999px/50%。禁止自造 9/10/14px 等布局圆角;1/2px 只允许用于图形细节(图例方块、2px 线条端点)与徽标几何。
- 阴影不自定义:弹层统一 `var(--dsw-shadow-lv3)`;卡片默认无阴影、用边框分层;禁止每卡片挂软阴影。

## 页面骨架

L1 设置分区:

```
<section class="pfx-section">
  <header class="pfx-section-head">说明行(13px,text-sub)</header>
  <div class="pfx-card">…行…</div>
  <div class="pfx-card">…行…</div>
</section>
```

- 设置导航已显示分区名,页面顶部仍保留 18px/600 分区标题(与导航同名),下接一行 13px 说明;标题是页面定位锚点,不得以"重复"为由省略。
- 分区内的每组设置各成一张卡片,卡片之间 16px;卡内行用 0.5px 分隔线,最后一行不留线。

L2 全屏页面:

```
<div class="pfx-page">
  <header class="pfx-page-head">
    <div>标题(20/500) + 说明(13px,text-sub)</div>
    <div class="pfx-page-actions">主操作(primary)+ 次级操作(secondary/ghost)</div>
  </header>
  <div class="pfx-toolbar">筛选 pill 组 / 搜索 / 状态计数</div>
  <div class="pfx-content">表格或卡片</div>
</div>
```

- 页头必须有标题;无说明时留空不硬凑。主操作只允许一个 primary。
- 工具条与内容之间用 0.5px `--dsw-alias-border-l2` 分隔;页面 padding 24。
- L2 的列表优先表格化:固定列、表头 12px text-dim、行 40px、hover `<pfx>-hover`、操作列右对齐;数字等宽、单位 11px dim。

## 组件视觉形态

控件结构契约(开关、pill、图标、样式注入)以 plugin-client-conventions.md 为准,本节只定视觉参数:

- **开关**:track 胶囊 34×19px、thumb 圆点 13px(参考 `.tn-switch` 存量值,防仿制漂移),关闭态底色 `<pfx>-bg-muted`,选中底色 `<pfx>-accent`,过渡 0.15s ease;禁用态统一见文末"禁用"。禁止 40×24 等放大变体。
- **按钮**:主按钮实底 `<pfx>-accent` + `--dsw-alias-bg-base` 文字、hover `<pfx>-accent-deep`;次按钮透明底 + `<pfx>-border-strong` 边框 + text 色,hover `<pfx>-hover`;ghost 按钮无边框、text-sub,hover `<pfx>-hover`;危险按钮默认 ghost + `<pfx>-danger` 文字,hover `<pfx>-hover-danger`,实底危险仅用于确认弹窗主操作。危险按钮进入确认态后必须保持实心底 + 反白文字,`:hover` 也不得回退成 wash 底;否则反白文字落在浅色底上不可读。高度 L1 36 / L2 32 / L3 28,圆角 radius-sm,内边距水平 12/14。图标按钮 28×28,`aria-label` 必填。
- **输入框**:白底(`<pfx>-bg`)+ `<pfx>-border-strong` 边框,radius-sm,焦点环 `outline: 2px solid var(--dsw-alias-state-business-primary)`。L1 高 36,L2/L3 高 32/28。数字输入右侧单位用 `<pfx>-text-dim` 11px。
- **卡片 / 面板**:L1 `<pfx>-card` 底 + `<pfx>-card-border` 0.5px 描边 + radius-md + padding 10-16;L2 `<pfx>-bg` 底 + `<pfx>-border` 描边 + radius-md;嵌套分层用 bg-sub,不再加边框。与官方 PluginCard 同槽位并列的卡片,二选一并全页一致:镜像官方像素(注释豁免),或统一为 L1 卡并在注释说明不镜像。
- **表格 / 列表**:表头 12px text-dim,行高 40px(L2)/36px(L3),hover `<pfx>-hover`,选中行 accent-wash 底 + accent 文字或左侧 accent 竖线(二选一,包内一致);操作列在最右,默认 opacity .75,hover 行时 1。
- **徽标 / 状态点**:状态语义只允许 ok / warn / danger 三色,文字用对应语义色、底色统一 `color-mix(in srgb, var(<pfx>-<状态>) 10-14%, transparent)`(包内固定一档);计数徽标用 `<pfx>-bg-muted` 底 + text-sub。禁止独立配色。
- **pill 组**:容器 `<pfx>-bg-muted` + radius-sm + padding 2-4;选项高 28(普通 pill)/30(导航 tab,参考 `.tn-tab`);选中 accent 实底 + `--dsw-alias-bg-base` 文字,或 accent-wash 底 + accent 文字(包内二选一)。
- **悬浮提示**:鼠标悬停出现的提示统一用公共依赖 `@mzzsfy/dsh-common-tools/client` 导出的 `Tooltip`(视觉 `.dct-tip`,由 dsh-usage-dash 悬浮窗迁移而来):`bg-layer-2` 底 + 1px border-l2 + radius-md + shadow-lv3 + 12px/1.5 + padding 10/12 + max-width 420 + 8px 箭头 + 0.12s 透明度过渡。消费方只传 `anchor`(`{kind:'point',x,y}` 指针跟随或 `{kind:'rect',left,top,width,height}` 元素锚点)、内容与可选 `panelSelector` 裁剪边界;禁止各包再写定位算法或自定义提示外观。图表十字线等高频跟随提示可保留专用定位,但视觉参数必须与 `.dct-tip` 一致;dsh-usage-dash 的 `.ud-tip` 是公共提示的迁移来源,其图表浮层保留专用实现,改动任一侧须同步另一侧。
- **空态**:一行说明(14px text-sub)+ 一个主操作按钮,居中,上下留白 24px;不插图不造插画。加载态用骨架条(不含文案)或纯"加载中…"文案,二者不可混排;禁止空白。
- **错误与 toast**:错误文案 text 色不飘红,红只给图标 / 边框 / 操作按钮;toast 底色 `var(--dsw-alias-toast-bg)`,文案 `var(--dsw-alias-toast-label)`。
- **折叠**:头部整行可点,chevron 14px;展开内容顶部 8px,说明 12px text-dim。
- **禁用**:统一 opacity 0.5 + cursor not-allowed,不换色相(开关、按钮、输入一致)。

## 主题适配与验证

宿主的亮 / 暗主题与主题切换全部经 `--dsw-*` 变量层生效;插件只引用不重定义,即自动获得响应式主题。禁止写 `@media (prefers-color-scheme)` 覆盖,禁止把任何 `--dsw-*` 变量重声明为固定值。暗色下 `--dsw-alias-brand-primary` 为近白色,这是宿主"暗色主色"的既定语义,插件不得自造蓝色主色绕过;需要蓝色语义时用 `--dsw-alias-state-business-primary`(亮色蓝、暗色亮蓝)。

验证方式:用 dev-browser 有头浏览器打开插件页面,宿主亮 / 暗两套主题各过一遍,检查点:文本对比度、边框可见性、wash 浅底在暗色下不刺眼、焦点环可见、卡片描边不消失。

## 新增 UI 验收清单

改 / 加插件 UI 时逐条自查:

- 规则内无裸语义色 hex,任何 `var()` fallback 位无字面值;颜色全部来自宿主 `--dsw-alias-*`(直引或经 `<pfx>-*` token),图表区分色除外但须集中为 token 并注释
- 未重定义任何 `--dsw-*` / `--ds-*` 变量;未引用宿主未定义的变量名;等宽字体只用 `--ds-font-family-code`
- 无新增奇数间距与 9/10px 字号;圆角只经 radius token / 999px / 50%,或官方卡镜像例外(须注释)
- 状态色只用 ok / warn / danger,无第四种语义色
- 页面骨架符合所处层的规格(L1 有 18px 分区标题与卡片分组;L2 有 20px 页头与唯一主操作;L3 紧凑;宿主原生同构面按例外条款)
- 开关 / pill 结构符合 plugin-client-conventions.md,类名带包前缀
- 列表有 hover 与列对齐;空态有说明 + 主操作;加载态不空白
- 亮暗主题各验证一遍,无对比度失效
- 同类元素(按钮、行、徽标)在包内形态一致,与宿主设置页同类控件放在一起不违和
