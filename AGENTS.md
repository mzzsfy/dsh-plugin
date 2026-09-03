# dsh-plugin 开发规约

本文件约束所有在本仓库工作的 AI 会话与人类。核心目标:profile 与仓库只有一种合法状态,任何会话不得发明自己的做法。

## 包结构与版本

- 插件一律位于 `packages/<包名>/`,npm 名为 `@mzzsfy/<包名>`,包清单 = `packages/` 下带 package.json 的目录,自动发现,不手工维护清单
- 版本语义:feat → minor,fix/style → patch;本地 manifest 版本只允许 大于等于 线上(发布脚本强制)
- `package-lock.json` 永不入库(.gitignore 已忽略);仓库无根 package.json,各包独立

## profile 链接(开发态,唯一合法形态)

profile 位于 `~/.dsh/profiles/web`。合法状态只有一种,禁止第三种:

1. **依赖行 = semver**:profile 的 package.json 中所有 `@mzzsfy/*` 依赖行必须是 `^线上最新版`,禁止 `link:` / `file:` / 本地路径(历史残留已清,勿再引入;pnpm 对 file: 是整目录拷贝,永远吃不到工作副本)
2. **工作副本挂载 = junction**:`node_modules/@mzzsfy/<包>` 是指向仓库 `packages/<包>` 的 junction

**操作唯一入口:**

```
node scripts/dev-link.mjs all          # 归一依赖行(查 npm 线上 latest,自动清 link:/file: 残留)+ 挂 junction
node scripts/dev-link.mjs all --unlink # 恢复纯 registry 版本
```

禁止手工编辑 profile 的 package.json;禁止 `pnpm add file:...` / `pnpm add link:...`;禁止在 profile 里直接 mklink。

**重新挂载时机:** profile 内跑过 `pnpm install` 或 `dsh plugin add` 之后,junction 被实体目录覆盖,必须重跑 `node scripts/dev-link.mjs all`。

**已知策略:** profile 的 pnpm 配了 `minimumReleaseAge`(新发布包有安装宽限期)。刚发版后 install 可能被拦,等宽限期过再装,或单次 `pnpm install --config.minimum-release-age=0`(仅限自家刚发的包,知根知底)。

## 日常开发循环

1. 改代码在仓库 `packages/<包>/` 内进行,直接改工作副本
2. 测试:`node --test "test/*.test.mjs"`(在包目录内);rs-workflow 引擎测试在仓库根 `node --test tests/engine.test.mjs`
3. 验证效果:确保 dev-link 已挂,重启 dsh 即加载工作副本
4. 提交:语义化中文提交信息,一事一提交,禁止把无关改动混入

## 发布(唯一入口)

```
node scripts/publish.mjs <包名|all> [--bump patch|minor|major] [--skip-test] [--dry-run]
```

- 发布需交互 TTY(npm 2FA),用弹出 shell 执行,不用于后台/管道
- 本地版本 == 线上:无 --bump 时自动 SKIP;本地 < 线上:拒绝(防回退)
- 发布成功后脚本自动打 tag(`@mzzsfy-<包>-v<版本>`,轻量 tag),推送 main 与 tag 由维护者执行
- 发版后记得重跑 `node scripts/dev-link.mjs all`,让 profile 依赖行追上线上新版本

## 双实现同源

client.js 与 core 之间存在镜像逻辑的(如 turn-notify 的 chooseChannels、nav-icons 的 ICONS),必须保持 parity 测试覆盖,改一侧必须同步另一侧并在提交信息注明。
