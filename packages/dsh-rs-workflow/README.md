# @mzzsfy/dsh-rs-workflow

若水工作流 v4:人可以在场的强规则编排 dsh 插件。单引擎 flow 形态:模式选中后用户消息被 pre-step 拦截进编排,批次推进、结构化产出契约强制校验、审批原语、运行中排队/注入/取消/暂停/断点续跑、全量运行记录无截断回看。

**本包 v1.0.0 起为 v4 重写版,旧版(v0.x collab 引擎/flow 解释器)实现已全部删除。** 当前仓库状态:设计与审核文档已完成,实现待按里程碑重建。

## 设计文档(唯一事实源)

- `docs/rsww-v4/architecture.md` — 宿主执行模型约束、模块图、接口契约(settings/board 路由/DSL v4)
- `docs/rsww-v4/feat/driver/design.md` — 驱动器详设(状态机/批次算法/审批路由/终态判定/控制时序)
- `docs/rsww-v4/feat/` — 13 份模块设计(store/takeover/board/settings/release/template-tool/preset-combo/builtin-templates/gui-*)
- `docs/rsww-v4/steps/` — 五步里程碑(MVP → 运行中心 → 编辑器配置 → 审批模板集 → 清理收尾)
- `docs/rsww-v4/review-findings.md` — 双审核结论与处置记录
- `docs/rsww-v4/overview.md` — 目标与关键决策

## 行角色(v4)

| 行角色 | 作用 |
|---|---|
| `settings` | 注册 settings 命名空间 `rs-workflow`(6 工作位/3 预算/templates) |
| `release` | 模板释放/撤下/同步(marker v4 三字段;v3 释放目录自清理) |
| `board` | `/api/rsww/*` 路由(运行中心/模板管理/配置读写) |
| `takeover`(preset 平面) | `agent/pre-step` 拦截,经 workflowEngine 启动 RunDriver 编排 |
| `template-tool`(preset 平面) | 模型工具 `rs_workflow_template`(spec/list/save/remove) |

## v3 → v4 破坏性变更(零兼容)

- collab 引擎(engine/collab.js)与 v3 flow 解释器(engine/flow.js)删除,统一为 driver+flow-exec 单引擎
- 16 工作位 → 6 工作位;4 预算 → 3 预算;`<output>` 块文本协议 → structured_output 结构化提交
- 运行记录 runs.json 单文件截断制 → 每 run 全量 JSON + index.json 索引(零截断)
- 运行中消息忽略制 → 排队/注入/取消/暂停/续跑全干预面
- v3 释放目录与 runs.json 由 v4 启动期自动归档/清理,无迁移代码

## 开发

```sh
node scripts/dev-link.mjs all      # 挂 junction 开发态
```

实现里程碑与验收点见 `docs/rsww-v4/steps/01-mvp.md`。
