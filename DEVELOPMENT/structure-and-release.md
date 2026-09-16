# 包结构与版本、发布

## 包结构与版本

- 插件一律位于 `packages/<包名>/`,npm 名为 `@mzzsfy/<包名>`,包清单 = `packages/` 下带 package.json 的目录,自动发现,不手工维护清单
- 版本语义:feat → minor,fix/style → patch;本地 manifest 版本只允许 大于等于 线上(发布脚本强制)
- `package-lock.json` 永不入库(.gitignore 已忽略);仓库无根 package.json,各包独立
- 新建修改包后需要同步更新所有文档

## 发布(唯一入口,版本管控以 git tag 为事实源)

```
node scripts/publish.mjs <包名|all> [--bump patch|minor|major] [--skip-test] [--dry-run]
```

- npm 2FA 认证需交互终端(publish.mjs 本身不检测 TTY,非 TTY 下会在 npm 认证阶段卡住),用弹出 shell 执行,不用于后台/管道;--dry-run 无此要求
- 每包独立版本 tag(格式 `@mzzsfy-<包>-v<版本>`,轻量 tag),发版即对齐:发布成功后脚本自动提交该包版本号变更(`chore(<包>): 发版版本号 x.y.z`)并把 tag 打在该提交上,tag 始终指向该版本的完整源码状态,不再需要手动"版本号对齐"提交
- 发版判定(本地版本==线上时)以版本 tag 后的包目录提交数为事实源:
  - tag 后无提交 → SKIP,该包无需发版(禁止凭"感觉有改动"重复发版,避免用户误判需要更新)
  - tag 后有提交 → 拒绝发布并提示提交数,必须显式传 --bump 才发(防止代码已变而版本号未动被误判为无需更新而漏发);feat 用 minor,fix/style 用 patch
  - 本地 tag 缺失 → 补打 tag 并跳过(自愈历史"发布成功未打 tag"状态)
- 本地版本低于线上:拒绝(防回退);高于线上:直接发布(--bump 仅适用于本地等于线上的场景)
- 推送 main 与 tag 由维护者执行;发版后重跑 `node scripts/dev-link.mjs all`,让 profile 依赖行追上线上新版本
