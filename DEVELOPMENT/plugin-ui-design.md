# 插件 UI 统一设计规范

所有带 client 半区的包共用一份视觉决策。目标:用户在宿主界面里打开任意插件,看到的色彩、圆角、间距、字号、控件形态属于同一套设计语言;插件之间不出现第二种蓝、第二种红、第二种圆角体系。

本文件与 [plugin-client-conventions.md](plugin-client-conventions.md) 并列:那份管控件的结构契约(switch 结构、data-plugin 注入),本份管视觉决策(颜色值、尺寸标尺、状态语义)。两份同时生效。

## 色彩:唯一来源是宿主语义别名

插件禁止在样式中书写裸 hex / rgb 色值表达界面语义色——**包括 `var()` 的 fallback 位置**:字面值在暗色模式与主题切换时原样漏出,是主题错乱的直接来源。所有语义色经包局部 token 二次封装,token 值直接引用宿主 `--dsw-alias-*`,不写 fallback:

```css
/* 合法:包前缀局部 token,直接引用宿主别名 */
--xx-accent: var(--dsw-alias-brand-primary);
--xx-danger: var(--dsw-alias-state-error-primary);

/* 禁止:裸 hex 直接用于界面元素 */
color: #1677ff;

/* 禁止:var() 内字面色值 fallback(暗色/主题切换时漏色) */
--xx-accent: var(--dsw-alias-brand-primary, #1677ff);

/* 禁止:映射表槽位绕过局部 token 直接写在规则里 */
color: var(--dsw-alias-brand-primary);
```

前提:宿主 client 全局定义 `--dsw-alias-*` 别名全集(当前版本 107 个),别名随主题(含暗色)统一切换。引用了不存在的别名属缺陷,去除该引用或走宿主 API 对齐路径让宿主补齐,禁止自造别名并配自填值(存量 `state-focus-primary` 即自造别名,已废弃,见输入框条目)。

语义色槽位与宿主别名的唯一映射(局部 token 后缀即此表槽位名):

| 语义槽位 | 宿主别名 | 用途 |
|---------|---------|------|
| `<pfx>-accent` | `--dsw-alias-brand-primary` | 主操作、选中态、链接 |
| `<pfx>-accent-deep` | `--dsw-alias-button-primary-hover` | 主按钮 hover / accent 加深 |
| `<pfx>-accent-wash` | `--dsw-alias-brand-primary` 经 color-mix 12% 掺透明派生 | accent 浅底(选中行、信息条背景) |
| `<pfx>-ok` | `--dsw-alias-state-success-primary` | 成功、健康、启用 |
| `<pfx>-warn` | `--dsw-alias-state-warn-primary` | 警告、降级、接近阈值 |
| `<pfx>-danger` | `--dsw-alias-state-error-primary` | 错误、危险操作、删除 |
| `<pfx>-danger-wash` | `--dsw-alias-state-error-primary` 经 color-mix 10% 掺透明派生 | 危险文本按钮 / 列表行 hover 浅底(实底危险按钮 hover 见组件节) |

wash 派生式:`color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)`。wash 类浅底禁止固定浅色值(暗色主题下刺眼且漏色),一律从语义色派生(usage-dash 既有写法)。

禁止各包自造第四种状态色。信息类提示需要区分于品牌蓝时用 `<pfx>-warn`,不加 info 槽位。

中性色(背景 / 文本 / 边框)同样只经局部 token 引用宿主别名:

| 语义槽位 | 宿主别名 |
|---------|---------|
| `<pfx>-bg` | `--dsw-alias-bg-layer-1` |
| `<pfx>-bg-sub` | `--dsw-alias-bg-layer-2` |
| `<pfx>-bg-muted` | `--dsw-alias-bg-module-platform` |
| `<pfx>-border` | `--dsw-alias-border-l2` |
| `<pfx>-border-strong` | `--dsw-alias-border-l3` |
| `<pfx>-text` | `--dsw-alias-label-primary` |
| `<pfx>-text-sub` | `--dsw-alias-label-secondary` |
| `<pfx>-text-dim` | `--dsw-alias-label-tertiary` |

图表、趋势线等数据可视化允许在语义槽位之外使用区分用色,但必须集中定义为包局部 token(如 `<pfx>-chart-1`),禁止规则内裸 hex;优先复用语义色,确需新增时饱和度(HSL S)不低于 70%,保证亮暗主题下可辨。

数据与代码用等宽字体,统一 `font-family: var(--ds-font-family-code)`(宿主主题层原生定义的等宽变量,链路至 `--dsh-font-family-code-default`;存量 `--dsw-font-mono` / `--dsw-font-family-mono` 宿主均无定义,废弃,迁移到此);界面文本一律 `inherit`,禁止插件自设无衬线字体族。

## 包局部 token 契约

- 命名:`<包前缀>-<语义槽位>`,前缀取包名缩写且在 packages/ 全清单内唯一(与样式类名前缀同一规则,见 plugin-client-conventions.md)
- 定义位置:包样式根作用域一次性声明(宿主容器节点或包根类),映射表槽位色在组件规则中只消费 `var(<pfx>-<槽位>)`;非槽位交互态按色彩节豁免直接引用,图表区分色消费 `<pfx>-chart-*`
- **fallback 禁止**:token 值直接引用宿主别名,`var()` fallback 位置禁止字面色值,也禁止嵌套别名兜底(存量 `var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary))` 形态简化为直接引用)。宿主全局定义全部被引变量并随主题切换,自填字面值必然在非默认主题漏色;引用失败按宿主对齐缺陷处理
- 禁止镜像宿主值:局部 token 不允许定义与别名无关的新颜色体系,只做"槽位 → 别名"封装;禁止插件重声明任何 `--dsw-*` 变量为固定值

既有包(cron-board 的 `--cb-*`、tunnel 的 `--tu-*` 等)已符合"槽位 → 别名"形态,但其字面 fallback 在触及对应规则时移除;未接入的包在新改样式时按本表槽位收敛,不强制一次性回改存量,但同一次改动触及的规则必须同步收敛——禁止同一个文件里新旧两套蓝。

## 尺寸标尺

间距以 4px 为基准刻度,允许 2/4/8/12/16/20/24;紧凑控件内部允许 6/10(存量主流值)。禁止 5/7/9 等奇数刻度新增。

字号标尺(存量分布收敛):正文 12px(默认)、辅助 11px、强调正文 13px、小标题 14px、区块标题 16px、页面主标题 20px。行高:12px 正文用 1.5,标题用 1.3。9/10px 字号禁止新增(可读性下限)。

圆角标尺:

| token | 值 | 用途 |
|-------|-----|------|
| `<pfx>-radius-sm` | 6px | 输入框、小按钮、徽标 |
| `<pfx>-radius-md` | 8px | 卡片、面板、下拉 |
| `<pfx>-radius-lg` | 12px | 弹窗、大容器 |
| 圆形 | 999px / 50% | pill、开关、头像 |

阴影不自定义:弹层统一挂宿主原生 `var(--dsw-shadow-lv3)`;卡片默认无阴影、用边框分层。禁止每个卡片挂一层软阴影。

## 组件视觉形态

控件结构契约(开关、pill、图标、样式注入)以 plugin-client-conventions.md 为准,本节只定视觉参数:

- **开关**:track 胶囊 34×19px、thumb 圆点 13px(参考 `.tn-switch` 存量值,防仿制漂移),选中底色 `<pfx>-accent`,禁用态 `<pfx>-bg-muted` 底 + `<pfx>-text-dim` 字,过渡 0.15s ease
- **按钮**:主按钮实底 `<pfx>-accent` 白字、hover `<pfx>-accent-deep`;次按钮透明底 + `<pfx>-border` 边框 + text 色,hover `var(--dsw-alias-interactive-bg-hover)`;危险按钮实底 `<pfx>-danger`,hover 用 `color-mix(in srgb, <pfx>-danger 85%, black)` 加深(wash 类浅底只作页面底色,不作实底按钮 hover)。圆角 radius-sm,高度 28px 量级,内边距水平 12px
- **输入框**:白底(`<pfx>-bg`)+ border 边框,radius-sm,焦点环 `outline: 2px solid var(--dsw-alias-state-business-primary)`(宿主焦点环的语义兜底色,随主题切换;存量自造别名 `state-focus-primary` 废弃,迁移到此),禁止自造聚焦色
- **卡片 / 面板**:`<pfx>-bg` 底 + border 边框 + radius-md,无阴影;嵌套分层用 bg-sub,不再加边框
- **徽标 / 状态点**:状态语义只允许 ok / warn / danger 三色,文字用对应语义色、底色统一 `color-mix(in srgb, var(<pfx>-<状态>) 10%, transparent)`(rgba 无法包裹 CSS 变量,禁止),禁止独立配色
- **表格 / 列表行**:行高 32px 量级,hover `var(--dsw-alias-interactive-bg-hover)`,选中行用 accent-wash 底 + accent 文字或左侧 accent 竖线(二选一,包内一致)
- **空态**:一行说明 + 一个主操作按钮,说明用 `<pfx>-text-sub`,不插图不造插画
- **错误与 toast**:错误文案 text 色不飘红,红只给图标 / 边框 / 操作按钮;toast 底色 `var(--dsw-alias-toast-bg)`,文案 `var(--dsw-alias-toast-label)`
- **禁用**:统一 opacity 0.5 + cursor not-allowed,不换色相

## 主题适配与验证

宿主的亮 / 暗主题与主题切换全部经 `--dsw-*` 变量层生效;插件只引用不重定义,即自动获得响应式主题。禁止写 `@media (prefers-color-scheme)` 覆盖,禁止把任何 `--dsw-*` 变量重声明为固定值。验证方式:用 dev-browser 有头浏览器打开插件页面,宿主亮 / 暗两套主题各过一遍,检查点:文本对比度、边框可见性、wash 浅底在暗色下不刺眼、焦点环可见。存量硬编码色未收敛的规则在暗色下暴露的对比度问题,单独按本规范收敛该规则后修复,不属新增 UI 验收范围。

## 新增 UI 验收清单

改 / 加插件 UI 时逐条自查:

- 规则内无裸语义色 hex,任何 `var()` fallback 位无字面值;语义色全部经 `<pfx>-*` token 引用宿主别名,非槽位交互态按色彩节豁免直接引用别名
- 未重定义任何 `--dsw-*` / `--ds-*` 变量;等宽字体只用 `--ds-font-family-code`,不引用宿主无定义的 `--dsw-font-mono` 类变量
- 无新增奇数间距、9/10px 字号、自造圆角值
- 状态色只用 ok / warn / danger,无第四种语义色
- 开关 / pill 结构符合 plugin-client-conventions.md,类名带包前缀
- 亮暗主题各验证一遍,无对比度失效
- 同类元素(按钮、行、徽标)在包内形态一致,与宿主设置页同类控件放在一起不违和
