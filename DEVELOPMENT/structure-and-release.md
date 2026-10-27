# 包结构与版本、发布

## 包结构与版本

- 插件一律位于 `packages/<包名>/`,npm 名为 `@mzzsfy/<包名>`,包清单 = `packages/` 下带 package.json 的目录,自动发现,不手工维护清单
- 版本语义:feat → minor,fix/style → patch;breaking(refactor! 等)在 0.x 走 minor、1.x 走 major;普通 refactor 触及功能面随 fix 走 patch,docs/chore 不单独占版本位;本地 manifest 版本只允许 大于等于 线上(发布脚本强制)
- `package-lock.json` 永不入库(.gitignore 已忽略);仓库根 package.json 仅为测试解析桥(private,钉版宿主 peer 同源包与 playwright,不发布),插件各包独立
- 新增插件包:目录骨架 `package.json` + `cordis.patch.yml` + `src/`(或 `lib/`)+ `test/` + `README.md`;manifest 最小集 = name/version/type:module/main/exports(带 client 的包含 `"./client"` 子路径)/scripts(test 与 npmPublish)/engines/files 白名单,dsh 扩展字段(bundle.patch、client.platform/inject、compatibility.dshReleases、hostMin)与 README 各节以 `packages/dsh-boss-simulator` 为完整参照先例;L3 功能面测试需建包内 `兼容性测试.md`(分层模板见任一现有包,如 dsh-auto-trust-all;确不建时须在包 README 提供等价实测记录节并在 dsh-api-alignment 登记豁免);公共依赖包(无 dsh.bundle.patch,如 dsh-common-tools)豁免「dsh 版本兼容」节与兼容性测试.md
- 新建修改包后需要同步更新所有文档:根 README 插件一览表、包 README、兼容性测试.md(或豁免登记)、settings-nav-icons 的 NAV_ICON 声明(新增生产者即纳入其契约测试)、声明 hostMin 的包确认根 README 兼容性节声明包清单同步

## 发布(唯一入口,版本管控以 git tag 为事实源)

```
node scripts/publish.mjs <包名|all> [--bump patch|minor|major] [--skip-test] [--dry-run]
```

- 测试门按目标分流:`node scripts/publish.mjs <包名>` 运行目标包有效 `npm test`；若 `test` script 缺失、空白则报错并拒绝无测试发布。`all` 先运行全仓 `aggregate-tests.mjs --rounds 1`,再对有有效 `test` script 的包逐个运行测试,无脚本包跳过；任一实际运行的测试失败均阻断发布。`--skip-test` 显式跳过聚合门和包测试,会警告未经测试发布,不得作为常规提速方式。

- npm 2FA 认证需交互终端(publish.mjs 本身不检测 TTY,非 TTY 下会在 npm 认证阶段卡住),用 terminal 工具执行;认证 URL 出现后由人浏览器完成认证,发布自动续跑;--dry-run 无此要求
- 发布范围必须已提交：目标包有修改、暂存或未跟踪文件即拒绝，包括 dry-run。`--bump` 由脚本修改版本并单独提交 manifest，测试之后再次核对源码洁净，再执行 `npm pack --ignore-scripts`；只允许打包已跟踪文件。包内 npmPublish 脚本不再用于构造或发布另一份目录内容。
- 每次发布在系统临时目录保留 tarball 与 release.json，记录 commit、打包文件清单和 SHA-512 integrity；发布这同一份 tarball，禁用发布生命周期脚本。失败时保留记录用于核对 registry，不能仅凭线上同版本认定内容一致。
- 每包独立版本 tag(格式 `@mzzsfy-<包>-v<版本>`,轻量 tag)，发布成功后将 tag 指向记录中的确切源码提交；发布期间 HEAD 推进不改变该指向。推送仍由维护者执行。
- 发版判定(本地版本==线上时)以版本 tag 后的包目录提交数为事实源:
  - tag 后无提交 → SKIP,该包无需发版(禁止凭"感觉有改动"重复发版,避免用户误判需要更新)
  - tag 后有提交 → 拒绝发布并提示提交数,必须显式传 --bump(防止代码已变而版本号未动被误判为无需更新而漏发);映射同上文"版本位"规则:feat 用 minor,fix/style 用 patch,breaking(含 refactor! 等)0.x 走 minor、1.x 走 major,普通 refactor 触及功能面随 fix 走 patch
  - 本地 tag 缺失 → 拒绝；维护者必须比较 registry tarball 与可还原的历史提交后恢复 tag，不得自动绑定当前 HEAD
- 本地版本低于线上:拒绝(防版本回退);高于线上:直接发布(--bump 仅适用于本地等于线上的场景)
- 推送 main 与 tag 由维护者执行;发版后重跑 `node scripts/dev-link.mjs all`,让 profile 依赖行追上线上新版本
