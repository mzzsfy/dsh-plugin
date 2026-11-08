# dsh-boss-simulator

公司管理模拟器:以老板身份安排任务,授权后派发给部门自治执行,只接受汇报。任务可由面板直接创建(不依赖 AI 可用性),也可交给管理员预设会话澄清方案;实际实施与独立验收由标准会话执行,报告经 durable 会话事件归并。GUI 以任务列表为主视图,管理员对话作为可选助手。

## 行角色

行配置 `role` 必填,三值分发(`lib/index.js`):

| role | 作用 |
|------|------|
| `control` | 控制室:打开 `boss_simulator` 存储域,注册 HTTP 路由与管理员预设,装配派发/跟随/恢复运行时 |
| `tools-row` | 在 agent realm 注册业务工具行;控制室未启动即干净禁用 |
| `persona-row` | 预留声明,当前未实现 |

bundle patch(`cordis.patch.yml`)插入 `role: control` 单行(`boss-simulator-control`),由 `dsh plugin add` 应用;工具行随管理员预设组合。

## 管理员工具

预设会话内仅注册一个工具 `boss_simulator`(`tool` + `args` 双参数),8 个操作:

`boss_simulator_create_task` / `boss_simulator_define_workitem` / `boss_simulator_authorize_task` / `boss_simulator_dispatch_run`(phase: implement/fix/accept/integrate)/ `boss_simulator_query_tasks` / `boss_simulator_close_task` / `boss_simulator_request_resume` / `boss_simulator_confirm_resume`

仅管理员预设会话可执行(preset 校验 + tools.guard deny 兜底)。执行 Run 有幂等指纹与活跃冲突闸,独立验收须先有 ready_for_review 报告;恢复走 `boss_simulator_request_resume`/`boss_simulator_confirm_resume` 核对链。

## HTTP 面(`/api/boss-simulator/*`)

| 路由 | 方法 | 用途 |
|------|------|------|
| `board` | GET | 任务列表/详情/设置只读查询(分页筛选) |
| `workspaces` | GET | 新建任务可选工作区:宿主工作区注册表优先,不可用时回落到已有任务的工作区标识 |
| `task` | POST | 人类操作入口:`create`(落草稿并自动建 w1)/`authorize`(幂等)/`dispatch`(交给 Run 服务) |
| `admin` | POST | 管理员会话创建(幂等收养 / replace 重建,绝不代发 prompt) |
| `interrupt` | POST | 单任务或全局停止 |
| `settings` | GET/PUT | 并发引用数等设置(乐观锁) |
| `drive` | POST | 测试入口 |

写路由带 Origin 与 Host 同源守卫 + 64KB body 上限,无自设认证层。`task` 以客户端生成的 `taskId` 作幂等键,重复提交得到 409 而不是第二条任务;派发前必须已有当前定义的有效授权。

## 存储与状态

宿主 storage-domain `boss_simulator` 单表 kv(键空间 `task/<taskId>`、`control`、`settings`、`adminBinding`),无独立文件落盘;Run 报告由会话事件跟随(`run-followers`,断线重试,重启恢复未结 Run)归并。

## GUI

- `main` 槽「公司管理」中央面板,主视图是任务列表:按进行中/待处理/已结束分组(已结束默认收起),状态筛选 + 搜索 + 工作区筛选
- 首屏主操作「新建任务」:标题、目标、范围、验收标准(每行一条)、工作区、优先级;创建后落草稿,详情里「授权」→「派发实施」(二次确认,明确标注开始消耗模型);实施报告提交后进入待验收,可「派发独立验收」,通过后才可结案
- 任务详情:状态与控制、目标与范围、工作区、验收标准、工作项、执行记录(Run/模型/token)、验收结果;窄容器转为全屏对话框
- 数据新鲜度:总线订阅就绪显示「实时」,未就绪显示「轮询兜底」,附最后更新时刻与手动「刷新」;空闲期无周期 HTTP 快照
- 管理员对话作为可选助手视图(Tab):澄清方案、拆分工作项、调度验收;会话异常时提供两步「重建管理员会话」,任务与历史记录保留
- 侧边栏 `sidebar.panellist` 入口;导航图标经 `dsh-settings-nav-icons` 声明

## 开发

```sh
node scripts/dev-link.mjs dsh-boss-simulator   # 仓库根执行:归一依赖行 + 挂 junction
cd packages/dsh-boss-simulator
npm test                                        # node --test "test/*.test.mjs"
```

测试覆盖:核心编排/查询/设置/任务状态机、board 路由、人类操作入口(`task`/`workspaces` 的创建/授权/派发/同源/体积/幂等)、管理员会话生命周期、工具行与隔离、报表事件归并、跟随恢复、用量台账、client 行为与结构守卫;浏览器端到端经 `test/browser/run.mjs` 单独驱动,不在默认 `npm test` 内(live-workbench 用例另需独立宿主 :9382)。

## dsh 版本兼容

按仓库动态窗口验证(scripts/compat/window.mjs),不预置任何固定版本槽:主测 = 渠道 dist-tag 最新 rc,完全适配口径;基线 = npm latest,不崩溃底线口径;主测与基线同版时收敛单槽。本包声明 `dsh.hostMin = "0.2.0-rc.1"`:低于该代际的宿主 API 面未验证,compat 装载层自动排除。逐轮实测结论见 `docs/兼容性测试/逐包测试进度.md`(本地维护,不入库)。

本包兼容性断言、D01-D15 维度适用表与判据见 `兼容性测试.md`(2026-11-07 建立):L1 由 `test/` 全量用例承载(核心编排/查询/设置/任务状态机、board 路由、管理员会话生命周期、工具行与隔离、报表事件归并、跟随恢复、用量台账、client 行为与结构守卫);L2 由 `scripts/compat/run.mjs --only dsh-boss-simulator` 承载;L3 按该文件断言表人工执行;L4 为全家桶 `ci.mjs`。逐格证据登记在本包 `兼容性测试.md`,轮次汇总登记于逐包测试进度,二者不重复记账。
