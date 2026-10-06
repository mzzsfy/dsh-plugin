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

- 0.2.0-rc.2:完全适配(装载 + 功能面逐格验证通过;2 格环境性登记:被测形态无 gateway 时 LLM 工具链不可真机触发)
- 0.1.7-rc.2:不崩溃底线通过(全家桶 crash-only)
- 0.1.5-rc.3:未承诺(仅 shell-select 有宿主要求豁免;全家桶在该版本不启动,详见仓库 docs/兼容性测试/逐包测试进度.md)

历史验收(Round 30,2026-09-27):0.1.7-rc.2 完全适配(20/21:预设卡真机渲染/模板模态/配置页/释放物落盘/删除联动;#18 真实 LLM 轮需 provider 接管,单包 bundles 下 NO_ADAPTER 预期形态);0.1.5-rc.3 曾判不崩溃底线通过(其上 21/21 全过含 #17 预设 seat 闭合;已被 2026-09-30 复测推翻,见上);历史窗口 0.1.2-rc.1 全格通过。0.1.7 预设页换形「模式」卡属宿主演进。

更细的逐包结论见仓库 `docs/兼容性测试/逐包测试进度.md` 与本包 `兼容性测试.md`。
