# @mzzsfy/dsh-cron-board

轻量级青龙面板 dsh 插件:环境变量集中管理 + 定时任务(cron)调度,执行体支持两类——本地脚本(dsh 宿主进程内 spawn)与 dsh 会话任务(定时在指定时间段向 dsh 会话发起任务,支持「每次新建会话」或「固定同一会话」)。

设计文档见仓库 `docs/progress/feat-cron-board.md`(架构 / 数据模型 / API 契约 / BDD 场景 / 里程碑)。

## 状态

实现中(里程碑 M1 数据与手动执行已完成,M2 调度 / M3 会话编排 / M4 面板 UI 进行中)。

## 开发

```sh
node scripts/dev-link.mjs dsh-cron-board   # 挂载工作副本到 profile
cd packages/dsh-cron-board
node --test "test/*.test.mjs"              # 测试
```
