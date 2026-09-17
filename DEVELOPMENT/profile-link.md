# profile 链接(开发态,唯一合法形态)

profile 位于 `~/.dsh/profiles/web`。合法状态只有一种,禁止第三种:

1. **已发布包依赖行 = semver**:线上已有版本的包,profile 的 package.json 中依赖行必须是 `^线上最新版`,禁止 `link:` / 本地路径
2. **未发布包依赖行 = file 协议**:线上 404 的包,依赖行由 dev-link 自动写为 `file:<仓库>/packages/<包>`(不强制先发布;junction 照挂,线上出版本后重跑 dev-link 自动归一 ^latest)
3. **工作副本挂载 = junction**:`node_modules/@mzzsfy/<包>` 是指向仓库 `packages/<包>` 的 junction
4. **公共依赖包(manifest 无 dsh.bundle.patch,如 dsh-toast)= 无表层依赖行**:不写依赖行(任意形态残留由 dev-link 删除);安装与装载由消费插件 dependencies 声明承载——pnpm hoisted 布局把传递依赖实体安装到顶层 node_modules,dsh 启动 fallback 沿 bundles 依赖闭包补链兜底;junction 照挂工作副本保开发热更。junction(仓库工作副本)与 pnpm/fallback 安装实体是同一 npm 包的两种实体来源。禁止手工放置非脚本管理的目录

**操作唯一入口:**

```
node scripts/dev-link.mjs all          # 归一依赖行(查 npm 线上 latest,自动清 link:/file: 残留)+ 对账 dsh.profile.bundles + 挂 junction
node scripts/dev-link.mjs <包名>       # 单包模式:仅归一/对账/挂载/校验该包,清单内其他包不动
node scripts/dev-link.mjs all --unlink # 恢复纯 registry 版本
```

- 单包模式用于只想调试某一个包的场景(线上 404 的未发布包不会卡住 `all`:其依赖行自动写 file 协议,归一继续)。`all` 仍是日常默认,单包后其余包的终态不随之校验
- `dsh.profile.bundles` 由脚本对账(镜像官方 `dsh plugin` 的 reconcilePlugins 语义):清单内插件包且依赖行已声明即入层,公共依赖包或无依赖行即出层,本仓清单外条目不动;dev-link 直写依赖行不经 `dsh plugin add`,装载层必须由本脚本补齐,否则装而不载;装载层变化不走热重载,重启 dsh 后生效
- 包内外部依赖(dependencies/devDependencies 含非 @mzzsfy,如 croner / pi-ai)由脚本自动 `npm install --omit=peer`(与 CI test.yml 同源,已装跳过幂等):工作副本经 junction realpath 解析,host 运行时外部依赖须物理存在于包内 node_modules,profile 安装态则由依赖声明经 pnpm 承载,两态都覆盖
- 依赖行变化触发 `pnpm install` 重建 node_modules 时,脚本会重挂所有**有依赖声明**的包与**公共依赖包**,保住既有链接
- `--unlink` 对公共依赖包:卸链后顶层不留实体,不恢复 registry 版本(无依赖行可恢复),dsh 启动 fallback 补链接管

禁止手工编辑 profile 的 package.json;禁止 `pnpm add file:...` / `pnpm add link:...`;禁止在 profile 里直接 mklink。

**重新挂载时机:** `dsh plugin add`(重建 junction)与依赖图变化的 `pnpm install` 之后须重跑 `node scripts/dev-link.mjs all`;增量 install(Already up to date)按实测不动 junction,重跑幂等,拿不准就重跑。

**已知策略:** profile 的 pnpm 配了 `minimumReleaseAge`(新发布包有安装宽限期)。`dev-link all` 每次全量重写 profile pnpm-workspace.yaml 的 `minimumReleaseAgeExclude` 为各已发布包线上最新版精确并集,自家刚发版的包即装不被拦;`node scripts/dev-link.mjs all --allow-fresh`(仅限自家刚发的包,知根知底)在豁免未生效、install 仍被拦时兜底(如 profile pnpm-workspace.yaml 的豁免节缺失或 pnpm 版本不识别该配置)。
