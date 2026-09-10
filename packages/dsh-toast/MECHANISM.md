# dsh-toast 装载机制原理

本文记录公共 client 依赖包(dsh-toast 为参考实现)不进 profile 表层 manifest 却能被安装、解析、装载的完整原理。规约条目见 AGENTS.md「公共 client 依赖包规约」与「profile 链接」第 4 条;本文是其推导与实证依据。

## 问题:市场为什么曾显示它

dsh 生态里「插件」没有独立于 npm 的注册机制。一个包被视为插件的全部凭证只有三处:

1. 出现在 profile `package.json` 的 `dependencies`(pnpm 装入 node_modules)
2. 名字写进 `dsh.profile.bundles`(宿主装载列表)
3. cordis.patch.yml 的 insert 条目(宿主加载其宿主半区)

而 dshmarket 插件市场的「已安装」列表(`lib/profile.js` `readInstalled()`)= profile dependencies 全量,仅过滤官方 inbox 三件(`@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` / `@deepseek-ai/dsh-headless`),**列表粒度是 npm 包,无「是否 dsh 插件」判定**。dsh-toast 曾在表层 dependencies 里,市场必然显示——与它是不是插件无关。

## 约束:为什么曾经不敢删这一行

浏览器端(宿主 client 半区)没有文件系统,`require('@mzzsfy/dsh-toast/client')` 是 client-modules 模块表查找,模块表条目按 npm 名从磁盘解析。解析基是 **profile 目录**,走 Node 标准算法(`profile/node_modules/@mzzsfy/<包>` 逐级向上),不认 pnpm 默认布局的 `.pnpm` 虚拟 store(不在标准解析链上)。

传统 pnpm 布局下,传递依赖只存在于 `.pnpm/<store>` 内部——表层不写行则顶层不可见,宿主解析即失败(`ERR_MODULE_NOT_FOUND`)。这是「必须写行」结论的来源,也是本机制成立的前提差异。

## 解法:两个实测事实

**事实 A——profile 是 pnpm `nodeLinker: hoisted` 布局**(pnpm-workspace.yaml 实配)。hoisted 模式把所有依赖(含传递依赖)以实体目录直接安装到顶层 `node_modules`,不建 `.pnpm` symlink 结构。toast 退出表层行后,仅凭五个消费插件的 dependencies 声明,pnpm 11.24 实测仍把它实体安装到 `profile/node_modules/@mzzsfy/dsh-toast`——解析链天然可达,表层行不需要存在。

**事实 B——Node 解析只认磁盘,不认 manifest**。宿主装载占位条目(`Entry.import` → `internal.import(name, baseUrl)`)与 client-modules 构建模块表(`locatePkgJson` → `createRequire(baseUrl).resolve('包名/package.json')`)的 baseUrl 都是 profile 目录,只查顶层 node_modules。目录在,解析就成;dependencies 行不参与解析。

dependencies 行的真实职责只有一条:**让 pnpm 装它**。该职责由消费插件的 dependencies 承接后,表层行的存在理由归零——删掉它只是市场不再把本包算作「已装插件」。

## 机制链(各层职责)

| 环节 | 机制 | 属性 |
|---|---|---|
| 安装声明 | 五个消费插件 dependencies 声明(session-manager 权威,余者可选消费) | npm 标准语义 |
| 物理安装 | pnpm hoisted:传递依赖实体落顶层 | pnpm 标准逻辑 |
| 开发热更 | dev-link junction 覆盖同一路径 → 仓库工作副本 | 开发态基础设施(全仓包共用) |
| 兜底补链 | dsh 启动 `healProfileModuleFallback` 沿 bundles 依赖闭包补链顶层缺失的包 | dsh 本体内置,零操作 |
| 浏览器装载 | session-manager cordis.patch.yml 代挂宿主占位条目(id 带前缀,name 为包解析键) | 既有机制,占位全仓唯一 |
| 模块物化 | dsh client-modules 按 name 解析包 → 读 `dsh.client` 声明 → client.js 进模块表 | 既有机制,未变 |

运行时(生产用户视角)全部是 pnpm + dsh 原生逻辑,无任何手工步骤。junction 仅存在于开发者机器(dev-link 维护),且 install 对其不 prune 不覆盖(实测)。

## 实测记录(2026-09)

1. **hoisted 传递依赖落顶层**:临时工程仅声明 `@mzzsfy/dsh-turn-notify`(其 dependencies 含 toast),hoisted 安装后 toast 以实体目录出现在顶层(LinkType 空,版本 0.1.2)
2. **install 不动 junction**:顶层 junction 在场时 `pnpm install` 与 `--force` 均保持 junction 指向不变;`Already up to date` 增量 install 不补装缺失的包
3. **宿主解析链**:`createRequire(profile 根).resolve('@mzzsfy/dsh-toast/package.json')` 经 junction realpath 直达仓库工作副本——client bundle 按请求现读即热更生效
4. **dsh fallback 源码**(dsh 0.1.2-rc.1,dsh-app-boot lib/index.js):`healProfileModuleFallback` 每次 profile 启动沿 bundles 依赖闭包(dependencies + peerDependencies)补链;`ensureProfileSymlink` 对已存在链接跳过不替换(dev-link junction 优先);`ownedPackageNames` 清理循环移除「曾补链但已不在闭包」的包——卸载最后消费方后自动善后

## 空窗形态(唯一残余风险)

顶层 junction 不在 + `pnpm install` 增量(Already up to date)不补装 → 顶层暂无本包,toast 通道断。恢复路径任一:重跑 `node scripts/dev-link.mjs all` / 依赖图变化的 install / dsh 重启时 fallback 补链。非静默损坏:session-manager 的 require 会显式报错。

## 装载前提与回退

- 代挂方 session-manager 必须存在于 `dsh.profile.bundles`(占位条目随其装载);全部消费方退出 bundles 时 fallback 闭包不覆盖,本包功能整体下线
- 回退:`git revert` 引入本机制的提交后重跑 `node scripts/dev-link.mjs all`,恢复「表层依赖行 + junction」旧形态;外部用户在自己 profile 多写一行 dependencies 无害(有行也工作,仅市场会显示)
