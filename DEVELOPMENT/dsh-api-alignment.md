# DSH 本体 API 对齐

背景:profile 的 `@deepseek-ai/*` 一律不落盘(pnpm `autoInstallPeers: false`),插件对它们的 import 靠目录逐级兜底解析到 dsh 本体全局安装目录。dsh 本体升级(dsh-maintain 一键升级等)后,插件的宿主 API **立即**随之变化,无任何过渡。2026-09-04 dsh 0.1.2-rc.1 升级即移除了 `@deepseek-ai/dsh-settings` 模块级导出 `settingsNamespace` / `installSettingsSection` / `deepEqualJson`,并变更了 `@deepseek-ai/dsh-llm` 图片文本 API 签名,静态 import 这些导出的包当场全崩,正常包(free-search 等)无一受害。

规约(违反即复现同款事故):

**兼容性是第一要务**:插件缺依赖(宿主服务或导出缺失)时必须干净禁用——不注册任何服务/UI,禁止加载崩溃或运行时抛错。干净禁用的合法形态:client 半区 = 注入门控下 fiber 未激活(条款 1 点分声明,宿主升级即自愈,不阻塞 web 启动);host 半区 = apply 内探测缺失,打日志说明原因即返回。禁用是唯一合法的降级形态,禁止为旧版本宿主维护双路径功能。

1. **服务优先,禁止静态 import 版本脆弱的模块级导出**:宿主能力一律通过服务注入使用——`export const inject = [...]` 或 `ctx.inject(['settings'], (sctx) => ...)`,然后调服务方法(settings 服务:`register(ns, schema, {base})` / `get(ns)` / `update(ns, patch)` / `installSection(ctx, ns, schema, entry, hooks)`;ns 直接传合法字符串,格式校验内置于方法)。确需模块级 API(如 dsh-settings 的 `SettingsConflictError` 这类稳定导出)时,只 import 官方文档级稳定符号;不确定稳定与否就用动态 `import()` + 特性检测 + 降级告警(范例:dsh-free-search 的 installSection 双兼容写法)。同理,**client 半区的版本脆弱 namespace 服务以点分 inject 声明交由 cordis 门控**:`ctx.remote.<ns>` 面由宿主 dsh-api-remotes assembly 异步 `$mount` 挂载,inject 必须点分声明(如 `['remote', 'remote.settings']`,官方 dsh-client-ui-settings-general 同构),fiber 等 namespace 就绪才激活,旧宿主无此 namespace 即保持未激活(即干净禁用);**禁止在 apply 内同步可选链探测该面**——探测跑在挂载完成前,时序竞态会误报缺失而禁用插件(mce 0.2.1 在 0.1.2-rc.1 实测事故)。host 半区服务为同步注册,不受此限,apply 内缺失探测(如 dsh-llm-pi-gateway)仍合法
2. **peerDependencies 声明实际使用的 API 最低引入版本**,不照抄其他包的旧模板
3. **dsh 本体升级后必跑回归**:仓库根 `node scripts/smoke-load.mjs`(全包逐个加载,命名导出缺失当场暴露)+ 各包 `node --test "test/*.test.mjs"` + 仓库根 `node --test tests/engine.test.mjs tests/workflow-parity.test.mjs`;镜像官方语义的包(如 llm-pi-gateway 之于 dsh-llm-pi-ai)以官方新源码为规范逐项对表
4. 镜像官方语义的代码,注释保留"官方同构"定位;官方源码位于 dsh 本体安装目录 `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>/lib/`
