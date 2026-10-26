# dsh-boss-simulator

公司管理模拟器:以老板身份安排任务,分派给部门自治执行,只接受汇报。宿主仅注册唯一「公司管理」管理员预设会话,AI 以管理员身份经单一工具创建任务并派发,实际实施与独立验收由插件派发到标准会话执行,报告经 durable 会话事件归并,管理员 AI 只读汇报结果。GUI 提供看板/时间线视图、内嵌管理员聊天与侧边栏入口。

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

`create_task` / `define_workitem` / `authorize_task` / `dispatch_run`(phase: implement/fix/accept/integrate)/ `query_tasks` / `close_task` / `request_resume` / `confirm_resume`

仅管理员预设会话可执行(preset 校验 + tools.guard deny 兜底)。执行 Run 有幂等指纹与活跃冲突闸,独立验收须先有 ready_for_review 报告;恢复走 `request_resume`/`confirm_resume` 核对链。

## HTTP 面(`/api/boss-simulator/*`)

| 路由 | 方法 | 用途 |
|------|------|------|
| `board` | GET | 看板只读查询(分页筛选) |
| `admin` | POST | 管理员会话创建(幂等收养 / replace 重建,绝不代发 prompt) |
| `interrupt` | POST | 单任务或全局停止 |
| `settings` | GET/PUT | 并发引用数等设置(乐观锁) |
| `drive` | POST | create/dispatch 测试入口 |

写路由带 Origin 与 Host 同源守卫 + 64KB body 上限,无自设认证层。

## 存储与状态

宿主 storage-domain `boss_simulator` 单表 kv(键空间 `task/<taskId>`、`control`、`settings`、`adminBinding`),无独立文件落盘;Run 报告由会话事件跟随(`run-followers`,断线重试,重启恢复未结 Run)归并。

## GUI

- `main` 槽「公司管理」中央面板:任务看板/实际时间线/模型任务视图,约 3 秒轮询 `board`
- 内嵌管理员聊天(会话渲染槽)与 `sidebar.panellist` 侧边栏入口;导航图标经 `dsh-settings-nav-icons` 声明

## 开发

```sh
node scripts/dev-link.mjs dsh-boss-simulator   # 仓库根执行:归一依赖行 + 挂 junction
cd packages/dsh-boss-simulator
npm test                                        # node --test "test/*.test.mjs"
```

测试覆盖:核心编排/查询/设置/任务状态机、board 路由、管理员会话生命周期、工具行与隔离、报表事件归并、跟随恢复、用量台账、client 行为与结构守卫、浏览器端到端(browser/)。

## dsh 版本兼容

按仓库动态窗口验证(scripts/compat/window.mjs),不预置任何固定版本槽:主测 = 渠道 dist-tag 最新 rc,完全适配口径;基线 = npm latest,不崩溃底线口径;主测与基线同版时收敛单槽。本包声明 `dsh.hostMin = "0.2.0-rc.1"`:低于该代际的宿主 API 面未验证,compat 装载层自动排除。逐轮实测结论见 `docs/兼容性测试/逐包测试进度.md`。
