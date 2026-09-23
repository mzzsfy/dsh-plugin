# @mzzsfy/dsh-rs-workflow

若水工作流 dsh 插件——设置面:流程模板管理与工作位/预算配置。模板编辑(host dryRun 权威校验)、只读详情、模板规范、六工作位与三预算配置读写。

**编排运行时(driver/store/flow-exec/释放链)按 v5 设计(`docs/rsww-v5/`)实现。**

模板文本为**严格 JSON**(有 GUI 编辑器,无 JSON5 需求);配置与模板存自有文件 `~/.dsh/dsh-rs-workflow/v5/`,**不经宿主 settings 服务,不写 settings.yaml**。

## 行角色

| 行角色 | 作用 |
|---|---|
| `board` | `/api/rsww/*` 设置子域路由(模板 CRUD/校验/规范/配置读写),数据落 `~/.dsh/dsh-rs-workflow/v5/{templates,config}.json` |

## 设置页路由

`/api/rsww/templates` `template` `template-save`(含 dryRun) `template-remove` `spec` `config` `config-save`

## 开发

```sh
node scripts/dev-link.mjs all      # 挂 junction 开发态
node --test "test/*.test.mjs"      # 包内测试(在 packages/dsh-rs-workflow 下)
```

## dsh 版本兼容

三版本(0.1.2-rc.1 / 0.1.5-rc.3 / 0.1.7-rc.1)全部通过:preset 释放、Agent 预设页若水工作流卡(0.1.7-rc.1 预设页换形「模式」卡,属宿主演进)、rs_workflow_ 工具可列出、配置页六工作位、移除删除联动、激活 live。
