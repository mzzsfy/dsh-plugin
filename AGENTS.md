# dsh-plugin 开发规约

本文件约束所有在本仓库工作的 AI 会话与人类。核心目标:profile 与仓库只有一种合法状态,任何会话不得发明自己的做法。

## 包结构与版本

- 插件一律位于 `packages/<包名>/`,npm 名为 `@mzzsfy/<包名>`,包清单 = `packages/` 下带 package.json 的目录,自动发现,不手工维护清单
- 版本语义:feat → minor,fix/style → patch;本地 manifest 版本只允许 大于等于 线上(发布脚本强制)
- `package-lock.json` 永不入库(.gitignore 已忽略);仓库无根 package.json,各包独立
- 新建修改包后需要同步更新所有文档
## profile 链接(开发态,唯一合法形态)

profile 位于 `~/.dsh/profiles/web`。合法状态只有一种,禁止第三种:

1. **已发布包依赖行 = semver**:线上已有版本的包,profile 的 package.json 中依赖行必须是 `^线上最新版`,禁止 `link:` / 本地路径
2. **未发布包依赖行 = file 协议**:线上 404 的包,依赖行由 dev-link 自动写为 `file:<仓库>/packages/<包>`(不强制先发布;junction 照挂,线上出版本后重跑 dev-link 自动归一 ^latest)
3. **工作副本挂载 = junction**:`node_modules/@mzzsfy/<包>` 是指向仓库 `packages/<包>` 的 junction

**操作唯一入口:**

```
node scripts/dev-link.mjs all          # 归一依赖行(查 npm 线上 latest,自动清 link:/file: 残留)+ 挂 junction
node scripts/dev-link.mjs <包名>       # 单包模式:仅归一/挂载/校验该包,清单内其他包不动
node scripts/dev-link.mjs all --unlink # 恢复纯 registry 版本
```

- 单包模式用于两点:只想调试某一个包;或清单内存在未发布包(线上查询 404)卡住 `all` 时的绕行路径。`all` 仍是日常默认,单包后其余包的终态不随之校验
- 依赖行变化触发 `pnpm install` 重建 node_modules 时,脚本会重挂所有**有依赖声明**的包,保住既有链接;无声明的包(如未发布新品)不产生 junction

禁止手工编辑 profile 的 package.json;禁止 `pnpm add file:...` / `pnpm add link:...`;禁止在 profile 里直接 mklink。

**重新挂载时机:** profile 内跑过 `pnpm install` 或 `dsh plugin add` 之后,junction 被实体目录覆盖,必须重跑 `node scripts/dev-link.mjs all`。

**已知策略:** profile 的 pnpm 配了 `minimumReleaseAge`(新发布包有安装宽限期)。刚发版后 install 可能被拦,等宽限期过再装,或单次 `node scripts/dev-link.mjs all --allow-fresh`(仅限自家刚发的包,知根知底)。

## 日常开发循环

1. 改代码在仓库 `packages/<包>/` 内进行,直接改工作副本
2. 测试:`node --test "test/*.test.mjs"`(在包目录内);rs-workflow 引擎测试在仓库根 `node --test tests/engine.test.mjs`;rs-workflow 插件冒烟在仓库根 `node scripts/test-workflow-plugin.mjs`(默认测 profile 安装副本,传包目录可测任意构建)
3. 验证效果:确保 dev-link 已挂。**host 半区改动自动热重载**(dev-link 在 home 补丁层 `~/.dsh/cordis.patch.yml` 维护 hmr 覆盖行,watch 仓库 packages,保存后约 1 秒重载对应插件;测试/文档/依赖目录不触发);**client 半区改动刷新页面即生效**(client bundle 从磁盘按请求现读)。改完代码不要求重启 dsh,也不要建议用户重启
4. 提交:语义化中文提交信息,一事一提交,禁止把无关改动混入

## 发布(唯一入口)

```
node scripts/publish.mjs <包名|all> [--bump patch|minor|major] [--skip-test] [--dry-run]
```

- npm 2FA 认证需交互终端(publish.mjs 本身不检测 TTY,非 TTY 下会在 npm 认证阶段卡住),用弹出 shell 执行,不用于后台/管道;--dry-run 无此要求
- 本地版本 == 线上:无 --bump 时自动 SKIP;本地 < 线上:拒绝(防回退)
- 发布成功后脚本自动打 tag(`@mzzsfy-<包>-v<版本>`,轻量 tag;本地==线上 SKIP 时亦会补打本地缺失的 tag),推送 main 与 tag 由维护者执行
- 发版后记得重跑 `node scripts/dev-link.mjs all`,让 profile 依赖行追上线上新版本

## 双实现同源

client.js 与 core 之间存在镜像逻辑的(如 turn-notify 的 chooseChannels、nav-icons 的 ICONS),必须保持 parity 测试覆盖,改一侧必须同步另一侧并在提交信息注明。

## 插件 UI 控件规约

- 插件 UI 中的布尔开关一律用开关(switch)形态,即 track 胶囊 + thumb 圆点的视觉开关,禁止裸 `<input type="checkbox">` 直接呈现,也不得用 `<input type="range">` 数值滑块实现布尔语义;多选列表行内的勾选同样用开关。独立布尔偏好用开关;成组分类的快捷切换(如事件分类启停)可用 pill 组(参考 `dsh-turn-notify` 的 `.tn-pill`,选中态 `.tn-pill--on`),不属布尔开关
- 实现模式:原生 checkbox 保留(`input[type="checkbox"]`,保可访问性与表单语义)但视觉隐藏,相邻兄弟节点 `track`(圆角胶囊 `<span>`)+ 其子节点 `thumb`(圆点 `<span>`)用 CSS 过渡呈现选中态;结构为 `label.<前缀>-switch > input[type="checkbox"] + .<前缀>-switch__track > .<前缀>-switch__thumb`,label 内允许其余子节点(文字标签、同 label 的文本 input)
- 各包样式类名必须带包前缀(前缀取包名缩写,须在 packages/ 全清单内唯一,如 `tn-switch` / `mce-switch`),因插件 style 均为全局注入;开关的 `:checked` / `:focus-visible` / `:disabled` 状态选择器必须以 `input[type="checkbox"]` 锚定,防止组合进含其他 input 的 label 时误伤;`:hover` 例外地锚定 label(视觉隐藏的 input 无法成为指针目标)
- 参考实现:`dsh-model-capability-editor` 的 `.mce-switch`(状态最全,含 disabled);`dsh-turn-notify` 的 `.tn-switch` 为同款。新包仿制并复制对应 switch-guard 守卫测试,不抽共享 UI 包

## 公共 client 依赖包规约

跨插件共享的 client 能力(如 `dsh-toast` 的浮出通知)按**普通 npm 依赖**形态发布,禁止做成 dsh 插件(不声明 `dsh.bundle.patch`、不自带 cordis.patch.yml、无需 plugin add):

- 消费插件在 `dependencies` 声明该包(pnpm 随装),在 `dsh.client.external` 声明 `'@mzzsfy/<包>/client'`,factory 内直接 `require` 使用;禁止 window 全局注册器 + 队列模式——纯依赖包不经宿主条目装载,其模块永不物化,window API 无人物化挂载
- 依赖包的 client 进入客户端模块表靠**消费插件代挂**:消费插件 cordis.patch.yml 的 insert 列表追加该包宿主占位条目,**id 必须带消费插件前缀**(如 `session-manager-dsh-toast`),`name` 指向依赖包 npm 名(name 才是 cordis 加载与模块表的包解析键);依赖包宿主入口形态 = **仅 `export function apply() {}`**(对齐 `dsh-think-expand`;name+inject+apply 三件套命名空间形态经 dsh-web-app 装载链被判 invalid plugin 拖垮整树,禁止使用)
- **占位条目全仓唯一**:同一依赖包的占位只允许一个 insert——client-modules 按 npm 名做多源检查,两个占位条目若装载基不同(如市场托管 .dsh-market 与 profile 根 junction)即判 fatal 拖垮整树组合。其余消费方一律**可选消费**:factory 内 try/catch 动态 require,模块表缺失即禁用该通道,禁止再代挂占位(参考 `dsh-turn-notify`)
- client.js 仍以 `__ModuleLoader__.load({id, factory})` 自注册格式发布;**factory 返回值必须含空 `apply()`**——浏览器 cordis loader 装载宿主占位条目时经裸名 id 从模块表取同一记录(stripClientSuffix 使裸名与 /client 共享),无 apply 即判 invalid plugin 拖垮整树(参考 `dsh-toast`:库导出 show/dismiss/mount + 空 apply 共存);渲染容器惰性自举、按 id 幂等自愈(HMR 新代首挂清旧代残留),不依赖宿主生命周期
- 参考实现:`dsh-toast`(README 含接入三步);react / react-dom/client 由宿主平台种子表提供


## DSH 本体 API 对齐

背景:profile 的 `@deepseek-ai/*` 一律不落盘(pnpm `autoInstallPeers: false`),插件对它们的 import 靠目录逐级兜底解析到 dsh 本体全局安装目录。dsh 本体升级(dsh-maintain 一键升级等)后,插件的宿主 API **立即**随之变化,无任何过渡。2026-09-04 dsh 0.1.2-rc.1 升级即移除了 `@deepseek-ai/dsh-settings` 模块级导出 `settingsNamespace` / `installSettingsSection` / `deepEqualJson`,并变更了 `@deepseek-ai/dsh-llm` 图片文本 API 签名,静态 import 这些导出的包当场全崩,正常包(free-search 等)无一受害。

规约(违反即复现同款事故):

**兼容性是第一要务**:插件缺依赖(宿主服务或导出缺失)时必须干净禁用——打日志说明原因并不注册任何服务/UI,禁止 boot pending 挂死、加载崩溃或运行时抛错。禁用是唯一合法的降级形态,禁止为旧版本宿主维护双路径功能。

1. **服务优先,禁止静态 import 版本脆弱的模块级导出**:宿主能力一律通过服务注入使用——`export const inject = [...]` 或 `ctx.inject(['settings'], (sctx) => ...)`,然后调服务方法(settings 服务:`register(ns, schema, {base})` / `get(ns)` / `update(ns, patch)` / `installSection(ctx, ns, schema, entry, hooks)`;ns 直接传合法字符串,格式校验内置于方法)。确需模块级 API(如 dsh-settings 的 `SettingsConflictError` 这类稳定导出)时,只 import 官方文档级稳定符号;不确定稳定与否就用动态 `import()` + 特性检测 + 降级告警(范例:dsh-free-search 的 installSection 双兼容写法)。同理,**静态 inject 只声明跨版本存在的基座服务**:版本脆弱服务(如 dsh 0.1.2 引入的 `remote.settings`)移出 inject,在 apply 内以可选链探测,缺失即禁用(范例:dsh-model-capability-editor、dsh-llm-pi-gateway 的宿主探测)
2. **peerDependencies 声明实际使用的 API 最低引入版本**,不照抄其他包的旧模板
3. **dsh 本体升级后必跑回归**:仓库根 `node scripts/smoke-load.mjs`(全包逐个加载,命名导出缺失当场暴露)+ 各包 `node --test "test/*.test.mjs"`;镜像官方语义的包(如 llm-pi-gateway 之于 dsh-llm-pi-ai)以官方新源码为规范逐项对表
4. 镜像官方语义的代码,注释保留"官方同构"定位;官方源码位于 dsh 本体安装目录 `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>/lib/`
