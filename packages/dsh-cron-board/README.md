# @mzzsfy/dsh-cron-board

轻量级青龙面板 dsh 插件:环境变量集中管理 + 定时任务(cron)调度,执行体支持两类——本地脚本(dsh 宿主进程内 spawn)与 dsh 会话任务(定时在指定时间段向 dsh 会话发起任务,支持「每次新建会话」或「固定同一会话」)。

设计文档见仓库 `docs/progress/feat-cron-board.md`(架构 / 数据模型 / API 契约 / BDD 场景 / 里程碑)。

## 功能

- **看板**:任务卡片列表(状态色/下次触发相对时间/启停开关/立即运行/编辑/删除),新建编辑模态支持 shell 与会话两类任务、cron 预设与服务端实时预览(人话摘要 + 下三次触发)
- **环境变量**:集中管理,值打码展示,多值(同名展开笛卡尔积),dotenv 文本导入(预览/追加/覆盖)与导出
- **会话任务**:fresh 每次新建会话;pinned 固定会话(忙时跳过,会话丢失自动重建并回写);允许时段(支持跨零点)外按策略跳过或顺延
- **调度**:croner 解析,停机补跑(misfire 上限/停机错过跳过),孤儿运行恢复,全局与任务级并发闸门,超时收尾
- **日志**:每任务每运行独立日志文件,面板查看与清空,按任务保留条数裁剪

## 路由

前缀 `/api/cron-board`(envs / jobs / runs / status / cron/preview),REST 风格,中文业务错误透传。

## 依赖

- `croner`:cron 表达式解析与触发点计算
- 宿主服务:settings / timer(软依赖)、webServer、sessionController / agents / sessionQuery(缺失时会话通道整体禁用,脚本任务不受影响)

## 开发

```sh
node scripts/dev-link.mjs dsh-cron-board   # 挂载工作副本到 profile
cd packages/dsh-cron-board
node --test "test/*.test.mjs"              # 测试
```

注意:插件新增进入 profile bundles(`dsh plugin add`)后需 dsh 重启一次完成首装载;此后工作副本改动经 dev-link HMR 热重载。
