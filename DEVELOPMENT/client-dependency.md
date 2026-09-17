# 公共 client 依赖包规约

跨插件共享的 client 能力(如 `dsh-toast` 的浮出通知)按**普通 npm 依赖**形态发布,禁止做成 dsh 插件(不声明 `dsh.bundle.patch`、不自带 cordis.patch.yml、无需 plugin add):

- 消费插件在 `dependencies` 声明该包,在 `dsh.client.external` 声明 `'@mzzsfy/<包>/client'`,factory 内直接 `require` 使用;禁止 window 全局注册器 + 队列模式——纯依赖包不经宿主条目装载,其模块永不物化,window API 无人物化挂载
- **安装与装载链(不进 profile 表层 manifest 依赖行)**:消费插件 dependencies 声明 → pnpm 安装时作为传递依赖落顶层 node_modules(profile 为 `nodeLinker: hoisted` 布局,传递依赖实体直达解析链;dev-link junction 覆盖同一路径保工作副本,`pnpm install` 对既有 junction 不 prune 不覆盖)。dsh 启动 `healProfileModuleFallback` 沿 bundles 依赖闭包补链顶层缺失的包(`ensureProfileSymlink` 对已存在链接跳过不替换;卸载最后消费方后 owned 清理循环自动移除残留链接)作为兜底。表层 manifest 无此包行 → 插件市场已装列表不显示它。机制对齐版本:dsh 0.1.2-rc.1 源码实测 + hoisted 传递依赖落顶层的 pnpm 11.24 实测(dsh-app-boot lib/index.js healProfileModuleFallback / ensureProfileSymlink / ownedPackageNames)
- **装载前提**:代挂方 session-manager 必须存在于 `dsh.profile.bundles`(占位条目随其装载,模块表才物化依赖包 client);全部消费方都退出 bundles 时闭包不覆盖、fallback 不补链。已知空窗形态:顶层 junction 不在 + `pnpm install` 增量(Already up to date)不补装 → 顶层暂无该包,直到依赖图变化触发真实安装 / 重跑 dev-link / dsh 启动 fallback 补链
- 依赖包的 client 进入客户端模块表靠**消费插件代挂**:消费插件 cordis.patch.yml 的 insert 列表追加该包宿主占位条目,**id 必须带消费插件前缀**(如 `session-manager-dsh-toast`),`name` 指向依赖包 npm 名(name 才是 cordis 加载与模块表的包解析键);依赖包宿主入口形态 = **仅 `export function apply() {}`**(对齐 `dsh-think-expand`;name+inject+apply 三件套命名空间形态经 dsh-web-app 装载链被判 invalid plugin 拖垮整树,禁止使用)
- **占位条目全仓唯一**:同一依赖包的占位只允许一个 insert——client-modules 按 npm 名做多源检查,两个占位条目若装载基不同(如市场托管 .dsh-market 与 profile 根 junction)即判 fatal 拖垮整树组合。其余消费方一律**可选消费**:factory 内 try/catch 动态 require,模块表缺失即禁用该通道,禁止再代挂占位(参考 `dsh-turn-notify`)
- client.js 仍以 `__ModuleLoader__.load({id, factory})` 自注册格式发布;**factory 返回值必须含空 `apply()`**——浏览器 cordis loader 装载宿主占位条目时经裸名 id 从模块表取同一记录(stripClientSuffix 使裸名与 /client 共享),无 apply 即判 invalid plugin 拖垮整树(参考 `dsh-toast`:库导出 show/dismiss/mount + 空 apply 共存);渲染容器惰性自举、按 id 幂等自愈(HMR 新代首挂清旧代残留),不依赖宿主生命周期
- 参考实现:`dsh-toast`(README 含接入三步,机制推导见 `packages/dsh-toast/MECHANISM.md`);react / react-dom/client 由宿主平台种子表提供
