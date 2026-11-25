# 模型工具支持(追加 / 覆盖)BDD

本文件约束 `dsh-cron-board` 的模型工具面:两种互不干扰的模式,默认全部关闭,由设置开关显式开启。

- **追加模式**:注册 `cron_board_*` 四工具,读写看板自有任务;与官方 `schedule_*` 并存。
- **覆盖模式**:注册与官方同名的 `schedule_*` 四工具,在 agent 作用域遮蔽官方定义,转调宿主 `ctx.schedule`;模型看到的是 cron-board 的实现,数据仍是宿主自动化任务。

两种模式都遵守同一原则:开关关闭 = 工具不存在(不是"注册后拒绝调用");开关打开/关闭即时生效,不需要重启宿主;任何挂载失败整体回滚,不留半套工具。

## S1 追加模式:看板任务读写

- 设置项 `toolsAppend`(布尔,默认 `false`)。
- 打开时注册 `cron_board_list` / `cron_board_view` / `cron_board_create` / `cron_board_edit`;关闭时撤销全部。
- 注册在插件根作用域(全局可见),不与任何官方工具同名。
- 工具执行时才装配运行时(惰性单例),首个调用可能等待数据目录初始化。

### 工具契约

| 工具 | 作用 | 关键参数 |
|------|------|----------|
| `cron_board_list` | 列出任务,启用的在前、按下次触发升序 | `active?` / `kind?` / `limit`(≤500,默认 100) / `offset` |
| `cron_board_view` | 单任务全貌 + 最近 5 条运行 | `id` |
| `cron_board_create` | 新建脚本/会话任务 | `name` / `schedule`(多行) / `kind?` / `command?` / `prompt?` / `sessionMode?` / `agentPreset?` / `enabled?` / `timeoutMs?` / `concurrency?` |
| `cron_board_edit` | 更新 / 启停 / 立即运行 / 删除 | `id` / `action`(`update`\|`delete`\|`run`) + 显式字段 + `expectedUpdatedAt?` |

规则:

- 归一与校验复用 HTTP 路由的同一套实现(`job-fields.mjs`),两条入口对同一输入给出同一结果。
- `schedule` 支持多行(多 cron 表达式),每条可带 `T+N` 时区后缀;新建与改期逐条要求有未来触发点。
- 列表与创建结果不含命令/提示正文;正文只在 `cron_board_view` 返回(控制工具结果体积)。
- 更新只写显式提交的字段;带 `schedule` 才重算 `nextRunAt`;`expectedUpdatedAt` 不匹配返回 `job_conflict`。
- 删除先停执行面(`stopJob`),未能终止返回 `job_not_terminated` 且任务保留;日志目录清理失败不翻案删除结果。
- 会话任务在会话服务缺失时返回 `session_unavailable`。
- 错误码:`invalid_name` / `invalid_kind` / `invalid_command` / `invalid_schedule` / `not_future` / `invalid_selector` / `job_not_found` / `job_conflict` / `job_not_terminated` / `session_unavailable` / `internal_error`。

## S2 覆盖模式:同名遮蔽官方工具

- 设置项 `toolsOverlay`(布尔,默认 `false`)。
- 打开时对每个 agent 在 **agent 作用域**注册 `schedule_create` / `schedule_list` / `schedule_view` / `schedule_edit`;更近作用域同名定义遮蔽 preset 的官方工具。
- 参数、描述、输出 schema、错误码与官方 `@deepseek-ai/dsh-tool-schedule` 对齐;执行转调宿主 `ctx.schedule`(创建/查看/编辑/删除自动化任务)。
- 官方工具语义完整保留:`this_session` / `new_once` / `new` 三种投递目标、rrule、暂停/恢复、`expectedUpdatedAt` 冲突。
- 子代理会话按官方规则拒绝(`subagent_session`);`ctx.schedule` 缺失时工具不注册(旧宿主无自动化任务服务)。
- 开关关闭:撤销 agent 作用域注册,官方工具在下一步工具表刷新后恢复;无需重启。
- 回退:关掉 `toolsOverlay` 即回到官方工具面;cron-board 不改官方数据、不改官方 preset 行。

### 替换官方自动化任务的边界(本阶段)

- 本阶段只替换**工具面**;官方 `dsh-client-ui-schedule` 页面与 turn card 仍由官方插件渲染。
- 看板面板接管官方任务管理(列表/编辑/运行/历史)与官方页隐藏属后续阶段,单独设计;在此之前不得声称"已替换官方自动化任务"。
- 覆盖模式不改写宿主自动化任务数据,模型通过覆盖工具创建的任务与官方页创建的任务等价。

## S3 开关一致性

- 两个开关独立:可只开追加、只开覆盖、或都开(覆盖只影响 `schedule_*`,追加只提供 `cron_board_*`,不冲突)。
- 开关变化经设置变更通道即时对账;注册失败记录告警并保持未注册状态(不回退到半套)。
- 插件卸载时撤销两种模式的全部注册。

## 不做

- 不注册与官方不同的 `schedule_*` 参数形态(覆盖模式必须逐字兼容,否则模型既有提示失效)。
- 不在覆盖模式下改写官方任务数据结构或做数据迁移。
- 不为工具实现独立的认证/权限层;沿用宿主工具面。
- 不在追加模式提供跨插件任务的通用管理(只看板自有任务)。
