# 包结构与版本、发布

## 包结构与版本

- 插件一律位于 `packages/<包名>/`,npm 名为 `@mzzsfy/<包名>`,包清单 = `packages/` 下带 package.json 的目录,自动发现,不手工维护清单
- 版本语义:feat → minor,fix/style → patch;breaking(refactor! 等)在 0.x 走 minor、1.x 走 major;普通 refactor 触及功能面随 fix 走 patch,docs/chore 不单独占版本位;本地 manifest 版本只允许 大于等于 线上(发布脚本强制)
- `package-lock.json` 永不入库(.gitignore 已忽略);仓库根 package.json 是唯一解析桥(private,不发布,不参与任何包的 npm 包内容):宿主 peer 同源包钉版、playwright 测试依赖、以及各包 dependencies 外部依赖并集(工作副本经 junction realpath 解析时的唯一稳定锚点,见 profile-link.md),新 clone 在仓库根 `npm install` 一次装齐;插件各包独立,包内 node_modules 不承担运行态依赖解析
- 新增插件包:目录骨架 `package.json` + `cordis.patch.yml` + `src/`(或 `lib/`)+ `test/` + `README.md`;manifest 最小集 = name/version/type:module/main/exports(带 client 的包含 `"./client"` 子路径)/scripts(test)/engines/files 白名单,dsh 扩展字段(bundle.patch、client.platform/inject、compatibility.dshReleases、hostMin)与 README 各节以 `packages/dsh-boss-simulator` 为完整参照先例;L3 功能面测试需建包内 `兼容性测试.md`(分层模板见任一现有包,如 dsh-auto-trust-all);所有包(含公共依赖包与数据包)均须有 `兼容性测试.md`,无豁免
- 新建修改包后需要同步更新所有文档:根 README 插件一览表、包 README、兼容性测试.md、settings-nav-icons 的 NAV_ICON 声明(新增生产者即纳入其契约测试)、声明 hostMin 的包确认根 README 兼容性节声明包清单同步

## 发布(唯一入口,版本管控以 git tag 为事实源)

```
node scripts/publish.mjs <包名|all> [--bump patch|minor|major] [--skip-test] [--dry-run]
```

- 测试门按目标分流:`node scripts/publish.mjs <包名>` 运行目标包有效 `npm test`；若 `test` script 缺失、空白则报错并拒绝无测试发布。`all` 先运行全仓 `aggregate-tests.mjs --rounds 1`,再对有有效 `test` script 的包逐个运行测试,无脚本包跳过；任一实际运行的测试失败均阻断发布。`--skip-test` 显式跳过聚合门和包测试,会警告未经测试发布,不得作为常规提速方式;公共依赖检查 `check-common-tools.mjs` 仍强制执行,不可绕过。

- npm 2FA 认证需交互终端(publish.mjs 本身不检测 TTY,非 TTY 下会在 npm 认证阶段卡住),用 terminal 工具执行;认证 URL 出现后由人浏览器完成认证,发布自动续跑;--dry-run 无此要求
- 发布范围必须已提交：目标包有修改、暂存或未跟踪文件即拒绝，包括 dry-run。`--bump` 由脚本修改版本并单独提交 manifest，测试之后再次核对源码洁净，再执行 `npm pack --ignore-scripts`；只允许打包已跟踪文件。各包不提供单包发布脚本，发版唯一入口是 `scripts/publish.mjs`。
- 每次发布在系统临时目录保留 tarball 与 release.json，记录 commit、打包文件清单和 SHA-512 integrity；发布这同一份 tarball，禁用发布生命周期脚本。失败时保留记录用于核对 registry，不能仅凭线上同版本认定内容一致。
- 每包独立版本 tag(格式 `@mzzsfy-<包>-v<版本>`,轻量 tag)，发布成功后将 tag 指向记录中的确切源码提交；发布期间 HEAD 推进不改变该指向。推送仍由维护者执行。
- 发版判定(本地版本==线上时)以版本 tag 后的包目录提交数为事实源:
  - tag 后无提交 → SKIP,该包无需发版(禁止凭"感觉有改动"重复发版,避免用户误判需要更新)
  - tag 后有提交 → 拒绝发布并提示提交数,必须显式传 --bump(防止代码已变而版本号未动被误判为无需更新而漏发);映射同上文"版本位"规则:feat 用 minor,fix/style 用 patch,breaking(含 refactor! 等)0.x 走 minor、1.x 走 major,普通 refactor 触及功能面随 fix 走 patch
  - 本地 tag 缺失 → 拒绝；维护者必须比较 registry tarball 与可还原的历史提交后恢复 tag，不得自动绑定当前 HEAD
- 本地版本低于线上:拒绝(防版本回退);高于线上:直接发布(--bump 仅适用于本地等于线上的场景)
- 推送 main 与 tag 由维护者执行;发版后重跑 `node scripts/dev-link.mjs all`,让 profile 依赖行追上线上新版本
- 公共依赖包(common-tools)只发库自己:九个消费方 `dependencies` 浮动在同一 minor(`^0.5.0`),库发 patch 时消费方无需重发;改帧集合/导出形状即破坏,须发行破坏版并与消费方范围抬升同批发布(装载行按包名解析,版本范围管不住它,规约见 [client-dependency.md](client-dependency.md))
- 发布顺序由 `publish.mjs all` 的 `topoSortPackages` 按依赖拓扑保证(库先于消费方);新增包必须让依赖关系可被 manifest 解析,不得依赖目录名顺序。**先发库再发消费方**,否则新消费方安装时 `^0.5.0` 解析不到(ETARGET)

### 版本枚举包的发版前自动纳表

`dsh-shared-terminal` 用精确版本枚举约束功能面(`SUPPORTED_VERSIONS`、`package.json` 的 `dsh.compatibility.dshReleases`、`test/plugin.test.mjs` 逐版本夹具、`README.md` 两处白名单、`兼容性测试.md` 允许表与 D01 上限,共 7 处)。宿主发新版本而枚举未更新时,装载闸门会放行(peer 是 `>=` 范围),但包内 host 半区按未实测版本干净禁用,工具与 `/api/shared-terminal/*` 静默不注册。该缺口已多次出现(留档见 `.compat/version-watch/2026-11-29.md`),故发布流程强制机械补齐:

- 触发点:`scripts/publish.mjs` 的发布范围洁净门之后、线上版本判定之前;仅对 `scripts/compat/enum-check.mjs` 登记了枚举的包执行,其他包跳过。
- 检测:`enum-check <包> --check` 经 `packages/dsh-maintain/src/core.mjs` 的 `fetchDistTags` 取 alpha/next/latest 三渠道去重后的关注版本,与每个位置已枚举集合求差。退出码 `2` = 有 missing;`1` = 网络失败、锚点/格式漂移或包无枚举登记,直接中止发布,禁止猜测。
- 补齐:有 missing 时运行 `enum-check <包>`,按固定锚点机械插入(排序、去重、JSON 逗号规范化),随后跑 L1:包目录 `node --test "test/*.test.mjs"` + 仓库根 `node scripts/smoke-load.mjs`。通过后以 `chore(<包>): 纳表宿主版本 <版本>` 只提交改动文件,再继续版本判定——枚举变更按 fix 走 patch,同版本发布仍需显式 `--bump`。
- 失败语义:L1 失败 exit `3`,发布中止并保留已改文件供人工看 diff,不自动回滚;锚点缺失报错指出位置,更新脚本锚点前不得发布。
- 观测:发布日志打印 missing、补齐插入的版本与改动文件清单。
- 人工兜底:文档/夹具改版导致锚点漂移时,手工执行 `node scripts/compat/enum-check.mjs dsh-shared-terminal --check`(只报告、exit 2 表示待补)与去掉 `--check`(补齐 + L1)排查;`--dry-run` 只报告 missing,不改文件不提交;`--skip-test` 不豁免本闸门的 L1。`兼容性测试.md` 的实测记录段属历史证据,脚本不自动追加。
- 边界:关注版本只取 dist-tags 三渠道的当前最新版,跳过的中间版本不会被补;机械纳表不等于实测证据,新版本功能面结论仍以 L1/L3 与宿主升级回归为准。`dshReleases` 已登记 `unknown` 的版本按未纳表升级为 `compatible`;登记 `incompatible` 时闸门报错交人工,不静默覆盖。补齐后脚本会复检 missing 为空才跑 L1 并提交。
