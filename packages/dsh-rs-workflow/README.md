# @mzzsfy/dsh-rs-workflow

若水工作流 dsh 插件——设置面:流程模板管理与工作位/预算配置。模板编辑(host dryRun 权威校验)、只读详情、模板规范、六工作位与三预算配置读写。

**编排运行时(takeover/driver/store/flow-exec/释放链)已随 v4 清理移除,按 v5 设计(`docs/rsww-v5/`)另行实现。** 本包当前只承载设置页能力;历史 UI 截图存档见 `docs/rsww-v4/ui-snapshot/`。

## 行角色

| 行角色 | 作用 |
|---|---|
| `settings` | 注册 settings 命名空间 `rs-workflow`(6 工作位/3 预算/templates) |
| `board` | `/api/rsww/*` 设置子域路由(模板 CRUD/校验/规范/配置读写) |

## 设置页路由

`/api/rsww/templates` `template` `template-save`(含 dryRun) `template-remove` `spec` `config` `config-save`

## 开发

```sh
node scripts/dev-link.mjs all      # 挂 junction 开发态
node --test "test/*.test.mjs"      # 包内测试(在 packages/dsh-rs-workflow 下)
```
