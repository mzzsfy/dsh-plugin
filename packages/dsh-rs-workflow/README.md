# @mzzsfy/dsh-rs-workflow

若水工作流 (rs-workflow):通用**强流程工作流编排工具**。在每一轮强制 AI 做被安排的事,产出不达标不放行,然后分诊推进到下一流程。两种形态:

- **内置协作模板(collab)**:rs-tui 工作流引擎的忠实移植,planner/executor/reviewer 三角色子代理分工,难度分诊四模板(lite / plan-final / step-review / multi-plan),审批循环、升级重规划、工作位模型降级链。
- **用户流程模板(flow)**:一份 JSON5 声明的强流程。每步安排 AI 产出什么(`<output>` 契约),引擎强制校验后推进;支持 for_each 循环、嵌套子流程、分诊动态路由、技能/文档强制加载。设置中配置多套模板,每套点「更新到 dsh」释放为一个模式。
- **内置流程模板**:包内 `flows/*.json5`(novel 小说写作 / news 新闻生产 / default 通用默认)作为模板数组开箱默认值,开箱即可在「若水·流程模板」释放为模式;与用户模板同源管理——用户可修改覆盖、删除(内置项删除落禁用记录防止合并复活)。

选中任一模式后,会话内一切用户消息被 pre-step 拦截进编排,主会话模型零参与——弱模型也能被流程兜住出活。设计原理、BDD 验收场景与 rscli 映射见仓库根 `docs/DESIGN.md`;模板 DSL 规范的唯一真相源是包内 `lib/spec.mjs`(工具 `spec` 动作与看板「模板规范」分区同源输出)。

## 行角色

| 行角色 | 所在平面 | 位置 | 作用 |
|---|---|---|---|
| `settings` | host | 包内 bundle patch(cordis.patch.yml) | 注册 settings 命名空间 `rs-workflow`:16 工作位(3 基础+13 细分)、collab 默认项、预算、**流程模板数组(templates)**,持久化于 `~/.dsh/settings.yaml` |
| `preset-sync` | host | 同上 | 启动时把包内 `preset/rs-workflow`(collab 模式)幂等释放到用户预设根;并提供 `releaseFlowTemplate`/`unreleaseFlowTemplate` 供模板释放为 `rs-<id>` 模式 |
| `board` | host | 同上 | 注册 `/api/rs-workflow/*`:运行看板读路(run/runs/remove)+ 模板读写路(templates/spec/released/release/unrelease/template-save/template-remove)→ GUI 设置页唯一「若水工作流」分区(子页:运行历史/流程模板/配置) |
| `template-tool` | agent | 释放出的 preset 组合(agent.cordis.yml) | 注册模型工具 `rs_workflow_template`(spec/list/save/remove):AI 友好的模板编辑入口,用户口述流程逻辑,AI 按规范写模板并 release 释放为模式 |
| `report` | agent | 同上 | 注册模型工具 `rs_workflow_report`:子代理节点级软上报(可选,失败即弃),数据落 `~/.dsh/dsh-rs-workflow/runs.json` 供看板展示 |
| `takeover` | agent | 同上(delegation 组内) | `agent/pre-step` 拦截用户消息,经 `workflowEngine.start` 以插件自有脚本启动编排(collab=engine/collab.js,flow=engine/flow.js),监听运行生命周期写 report-store |

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-rs-workflow
```

重启 dsh 后自动发生:设置页出现唯一「若水工作流」分区(子页:运行历史 / 流程模板 / 配置);collab 模式释放到 `<dsh-home>/.agent-presets/rs-workflow`;模式选择器出现「若水·协作编码」。

preset 内行以裸包名引用本包(从 profile 目录上溯解析),包与 preset 始终由本包同时交付,不存在顺序问题。

## 使用

### 用 collab(编码协作)

模式选择器选「若水·协作编码」→ 直接发需求 → 引擎分诊四模板之一 → planner 规划、executor 执行、reviewer 审批 → 看板看进度。运行期间追加消息只做简短答疑,不进入编排。

### 用 flow(自定义强流程)

1. **让 AI 写**(推荐):任意会话口述流程逻辑,如"帮我做一个新闻生产流程:先列采集计划,再逐源检索,交叉核对后成稿"。AI 调 `rs_workflow_template` {action:"spec"} 拿规范 → 写 JSON5 → {action:"save", release:true} 保存并释放。
2. **手写**:设置页「若水·流程模板」→ 新建 → 按「模板规范」写 JSON5 → 保存。
3. **更新到 dsh**:模板列表点「更新到 dsh」释放为模式(或撤下/删除)。
4. 模式选择器选该模式 → 发需求 → 引擎按流程逐步推进,产出不达标自动重问/重试/blocked。

### 工作位与预算

16 工作位(基础 planner/executor/reviewer + 13 细分)可绑 `provider/model`、候选数组(重试轮换)或 `{rotation:[...]}`;细分位缺省降级基础位。预算四阈值(reject 升级 2 / plan 拒绝升级 2 / 教学重问 3 / 报告追问 3,clamp [1,10])语义与 rs-tui 原始配置一致。

## 升级

同一命令重复执行即升级到最新发布版本,重启 dsh 后 preset-sync 自动同步新版 collab 组合;流程模板释放目录按 marker 指纹感知重释放。

## 卸载

```sh
dsh plugin --profile web remove @mzzsfy/dsh-rs-workflow   # 或 pnpm remove(profile 内)
rm -r ~/.dsh/.agent-presets/rs-workflow                   # collab 模式
rm -r ~/.dsh/.agent-presets/rs-<id>                       # 各流程模式(逐个)
```

pnpm 不执行依赖的卸载脚本,插件无法在被移除后自动清理,残留会在模式选择器显示为 broken——按上面命令手动删除即可。编程接口(从包根导入):

```js
import { presetDest, removePreset, syncPreset, releaseFlowTemplate, unreleaseFlowTemplate, flowPresetDest } from '@mzzsfy/dsh-rs-workflow'
// presetDest(): collab 释放目标绝对路径(诊断 home 错位)
// syncPreset(): 'created'|'updated'|'unchanged'|'skipped-foreign'
// removePreset(): 'removed'|'missing'|'foreign'
// releaseFlowTemplate({id,label,description,json5}) / unreleaseFlowTemplate(id) / flowPresetDest(id)
```

## 版本兼容

- 宿主 0.1.5-rc.1 起 persona 行键为 `prefix`/`suffix` 形态;更旧宿主由 preset-sync 在释放时按 `hostVersion()`(argv[1] 上溯解析 @deepseek-ai/dsh 包版本,env `dshVersion` 优先)自动回退改写为旧 `text` 形态(见 `lib/persona-compat.mjs`)。
- 模板释放组合内的 takeover 行要求宿主提供 `workflowEngine` 服务与 `agent/pre-step` 事件;服务缺失时行保持未激活(干净禁用),其余角色不受影响。

## 开发与测试

```sh
node --test "test/*.test.mjs"                                # 包内单测(flows/preset-sync/board/persona-compat/report-store/builtin-templates)
node --test tests/engine.test.mjs                            # 仓库根:collab 引擎验收(76 场景)
node --test tests/flow.test.mjs                              # 仓库根:流程解释器验收(13 BDD 场景)
node --test tests/workflow-parity.test.mjs                   # 仓库根:工作位键集/spec 锚点/资源上限 parity
node scripts/test-workflow-plugin.mjs [包目录]                # 冒烟:六角色全链(默认测 profile 安装副本)
```

开发态:`node scripts/dev-link.mjs all` 挂 junction,host 半区改动自动热重载。
