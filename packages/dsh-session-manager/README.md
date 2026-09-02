# @mzzsfy/dsh-session-manager

DeepSeek Harness 会话生命周期管理插件:自动归档 + 归档面板 + 归档删除三合一。

## 功能

- 自动归档:host 半区监听 `session/created`,对该会话所属工作区评估——超过 N 天未活动、非运行中、非空白的会话逐个走官方 `workspace.archiveSession` 通道。幂等:已归档会话不参与评估。阈值 `autoArchiveDays` 默认 7,`0` 关闭,经 settings 命名空间 `session-manager` 注册(schema 拒绝负数与非整数)。
- 归档面板:设置页「会话归档」分区,数据为 client 侧 `session.list` 行 ∩ `workspaces.follow` 归档快照的交集,按更新时间倒序;行内支持取消归档与删除。
- 归档 Toast:host 归档动作经 `workspace.follow` 的 `archived` 增量帧到达 client,集合差分得到新增条数 N,在 `shell.overlay` 槽位显示「有 N 个会话已归档」,持续 4 秒。
- 删除:仅对已归档会话生效,两段式确认(展示标题 / 更新时间 / 日志体积)后按 locate → trash → detach → 归档清理单序执行。日志产物移入系统回收站(Windows PowerShell VisualBasic / macOS Finder / Linux gio),可还原,不做直接删除降级。

## 失败矩阵

| 失败点 | 表现 |
|--------|------|
| locate 返回 undefined(SQLite 等后端) | 拒绝执行,提示后端不支持,无副作用 |
| trash 失败 | 整体中止,提示失败,目录与账本未动,可重试 |
| trash 成功、detach 失败 | 视为已删除,提示「已移入回收站,但移除列表记录失败」,detach 幂等可重试 |
| trash 成功、归档清理失败 | 已删除但归档集合残留,提示「已移入回收站,但移除归档记录失败」;经取消归档重试清理(幂等) |

## 已知取舍

- 取消归档:官方 workspace registry 明确归档为 one-way,无移除 API。本插件经 `storageDomain.get('workspace')` 的 global 句柄直写 `archivedSessionIds`(写入经 `domain/changed` 驱动 follow 帧),并把注册表进程内快照 `registry.state` 同步为写后值——注册表只在自身写路径同步该快照,不同步则其后续全量写回与 `workspace.list` 重连基线会复活刚移除的 id,官方归档的幂等判定也会因旧快照静默跳过(即早期版本「取消归档后列表不消失 / 二次归档不出现」的根因)。合并 durable 与快照取并集后再移除:可自愈历史失同步与清理半失败(经取消归档重试即补全),代价是快照中的陈旧 id 会在任一次清理时随全量写回重新落盘,可经再次取消归档清除。`registry.state` 为上游内部字段,缺失即路由报错 loud fail(注册表未就绪或上游形态变更)。域 global 仅支持整体写回,读改写窗口若与注册表两阶段变更交错,理论上可回退其 pendingMutation/workspaceIds 中间态,下次启动校验将 loud fail;同理,恢复操作与进行中的自动归档评估并发时,评估携带的旧快照整包写回也可能复活刚移除的 id,再次恢复即可清除——窗口极窄且域 API 无原子原语可用,属已知取舍。
- 删除:成功路径在 detach 后同样从归档集合移除该 id(域与快照同步),清理失败响应 partial 提示;detach 失败时不清理归档集合,保留归档资格供重试。删除后 `session.list` 的会话行按官方语义保留至重连,归档集合已不含该 id,面板即不再显示。
- 评估的活跃时间:JSONL 后端以产物 mtime 作为最近活跃代理,updatedAt = max(createdAt, mtime);非 JSONL 后端退化为 createdAt。空白判定:live 会话 seq=0,冷会话以 JSONL 产物「仅 header 一行」判定,locate 不可用的后端按非空白处理。
- 无批量操作、无内容搜索、无会话详情预览。
- 自动归档评估门闩:评估进行中新触发的 session/created 直接丢弃,不做排队;漏掉的会话由下一次 session/created 评估兜底,极端情况(长期无新会话创建)下积压会话可能延迟归档。产物不可读(mtime 探测失败)的会话视为已删除,不参与归档,防止删除后的会话被重新归档复活。
- 归档 Toast 提示以「连续两个 ready 快照」为差分启用条件:基线首装(启动与重连)不提示存量,重连基线携带的离期新增仍会提示。client.js 为单文件自包含格式,守卫逻辑与 core.mjs 各存一份镜像,修改需两处同步。
- 已知测试缺口:删除路由 detach 成功后的归档清理成功 / 失败分支无路由层覆盖(trashPath 静态导入无法桩替,需测试基建扩展),清理逻辑本体由取消归档路由同函数覆盖。

## 验证

```sh
npm test
```

纯逻辑层(评估状态机 / 删除资格与失败矩阵 / 面板投影 / 归档差分 / 空白判定 / 回收站命令构造)以 `node --test` 覆盖,无外部依赖。路由层测试依赖 peer 包可解析,仓库根未安装依赖时自动 skip,`npm install` 后激活。Windows 真实回收站执行测试仅在本平台执行,其余平台自动 skip。

## 开发安装(不经 npm 发布直接装仓库副本)

```sh
dsh plugin --profile web add file:./packages/dsh-session-manager
```

`file:` 安装指向仓库工作副本,改代码后重跑该命令即同步,无需发版。
