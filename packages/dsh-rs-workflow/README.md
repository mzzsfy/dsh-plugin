# @mzzsfy/dsh-rs-workflow

若水工作流 dsh 插件——设置面:流程模板管理与工作位/预算配置。模板编辑(host dryRun 单模板权威校验,跨流程校验在释放权威点)、只读详情、模板规范、六工作位与三预算配置读写;模板一键释放为「若水·<label>」Agent 预设组合,提供主循环编排(七工具)、分段推进、结构化产出契约、审批原语与运行记录;会话页签「若水编排」回看运行。

模板文本为**严格 JSON**(有 GUI 编辑器,无 JSON5 需求);配置与模板存自有文件 `~/.dsh/dsh-rs-workflow/v5/`,**不经宿主 settings 服务,不写 settings.yaml**。

## 行角色

| 行角色 | 作用 |
|---|---|
| `board` | 宿主根注册(经 cordis.patch.yml):`/api/rsww/*` 路由(模板/配置/运行记录/控制/释放链),数据落 `~/.dsh/dsh-rs-workflow/v5/{templates,config}.json` |
| `orchestrator` | 不在宿主根注册:随释放的 `rs-<模板id>` 预设组合挂载,注册 `rs_workflow_*` 七工具承载主循环编排 |
| `template-tool` | 同随释放组合挂载,注册 `rs_workflow_template` 供 AI 编辑模板 |

## HTTP 路由(前缀 `/api/rsww`)

模板与配置:`templates` `template` `template-save`(含 dryRun:仅单模板校验;跨流程校验在 `release`) `template-remove` `spec` `config` `config-save`
运行与释放:`runs` `run` `control` `resume-from` `run-remove` `released` `release` `unrelease`

会话运行记录列表与详情刷新经公共 WS 总线 `@mzzsfy/dsh-rs-workflow` 插件通道驱动;首连与重连全量对账,变更广播合并节流。模板与配置使用各自请求刷新。host/client 均在 `apply(ctx)` 调用 `setupCommonTools(ctx)`，通道身份取 `ctx.fiber.entry.options.name` 的完整 npm 包名；client 各实例退出时释放自己的订阅，同一 factory 的存活实例接管共享变更广播，最后实例退出才取消合并计时器；跨 factory HMR 清理旧代。

## 开发

```sh
node scripts/dev-link.mjs all      # 挂 junction 开发态
node --test "test/*.test.mjs"      # 包内测试(在 packages/dsh-rs-workflow 下)
```

## dsh 版本兼容

按仓库动态窗口验证(scripts/compat/window.mjs),不预置任何固定版本槽:主测 = 渠道 dist-tag 最新 rc,完全适配口径;基线 = npm latest,不崩溃底线口径;主测与基线同版时收敛单槽。兼容面以窗口实测为准,不逐版本承诺。逐轮实测结论见 `docs/兼容性测试/逐包测试进度.md`(本地维护,不入库)与本包 `兼容性测试.md`。
