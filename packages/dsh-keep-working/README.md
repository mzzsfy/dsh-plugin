# @mzzsfy/dsh-keep-working

持续工作:回合未声明结案就静默结束时,自动补一条用户消息把 AI 拉回,直到它交付产物或明确中止。

替代 `dsh-client-auto-continue` 的全部宿主侧恢复能力,并补上“任务没做完但回合正常结束”这一缺口。

## 结案规则

一句话:改过文件就 `present` 交付(之后不要再改文件、不再写 `TASK_DONE`),没改文件就最后一行单独写 `TASK_DONE`,做不下去最后一行写 `TASK_BLOCKED: 原因`。

判定层严格匹配裸标记:最后一行必须恰好是 `TASK_DONE`,或 `TASK_BLOCKED: 非空原因`。括号、下划线、连字符、反引号、粗体与句末标点都不算结案。

`write` / `edit` / `apply_patch` / `str_replace_editor` 都算改过文件;失败的写与 `str_replace_editor` 的 `view` 子命令不算。判定层在 present 有效时即判定结案,不追罚多余标记;二选一由提示词约束。

边界:经 shell 工具改写文件(`sed -i`、重定向)不在识别面内,这类回合不会被要求 present。工具名穷举不可能覆盖所有写路径,这里不追罚也不补判,是显式的口径边界。

规则经 `systemPrompt.section` 常驻注入,不依赖提醒文案。段落在 `DELIVERABLE_FILE_REFERENCES` 之后注册:宿主那段建议里写着“不要只为列出编辑过的源文件就调用 present”,结案规则必须压在其后,并显式声明 present 的时机以本段为准。

未结案时补发一条用户消息,内容按原因选择:结案提醒 / 输出截断 / 重启中断 / 失败详情 / 无可见输出。

## 恢复矩阵

| `turn/end` 原因 | 动作 |
|---|---|
| `completed` 且已结案 | 清连续计数,不发送 |
| `completed` 且有可见输出但未结案 | 结案提醒 |
| `completed` 且无可见输出 | 无输出提醒(用户已在回合中插话则让路) |
| `error` | 分类后恢复;鉴权、余额、模型不存在、上下文超限等永久错误跳过。宿主把 HTTP 状态并进错误消息而非独立字段,401/403 按文本识别 |
| `interrupted` | 重启中断提醒 |
| `max-tokens` | 截断提醒 |
| `aborted` | 用户取消不恢复;`disposed` / `legacy` 按中断恢复 |
| `forked` 等 | 不处理 |

以下回合一律不发送:子会话(`origin === 'subagent'`,旧记录按 `parentSession` + `delegationDepth >= 1`)、用户中途插话的回合、非用户发起的回合的结案提醒、已达连续上限的会话。

## 节奏

`graceMs` 到点才发送;两次发送之间至少间隔 `cooldownMs`,连续失败按 `backoffFactor` 退避,封顶 `backoffMaxMs`;单会话连续 `maxConsecutive` 次后放弃,等待人工介入;真人发起的回合一到就清零,额度恢复。判定看回合前导段:宿主注入的上下文(指令文件、工作目录、任务事件等,来源不是 `user`)不算发起,本插件补发的消息也不算。

断网时挂起,`offlineCheckMs` 后复查;探测失败按在线处理,不会永久卡住。

## 重启恢复

冷启动延迟 5 秒扫存储会话:直接扫 `$DSH_HOME/sessions` 取最近 `freshMs` 内写过的候选(上千个文件 stat 一遍是百毫秒级,候选通常只有几个),再按日志规模从小到大逐个判定。拿不到归档集合时本轮不恢复,下一轮重试。

判定只看尾部:回合正常结束且有可见回复就跳过(重启后重复执行整轮任务的代价,高于漏恢复的概率),未闭合回合、临时错误、重启中断、截断、无可见输出才恢复。子会话(origin 或旧格式 parentSession+depth)、已归档、用户主动取消同样排除。剩余会话物化后补一条恢复消息,每轮最多 `scanLimit` 个。

重启前已进入宿主 durable inbox 的排队消息是例外:它们不会自动唤醒 agent。扫描重放 `agent/inbox/spliced` 投影,`next-turn` 全部、`next-step` 中真人插话计为待处理输入;有排队消息的会话即使尾部正常结束也恢复。恢复消息必须插队发送(`agent.steer` 进 next-step),不追加到排队队列尾部、不重排或丢弃队列。

`goal` 在进程重启后会被宿主 disarm,`resumeGoals` 开启时对 `active` 且 `disarmed` 的 goal 重新武装。

启动扫描不常驻轮询:目录快照完整可读时一轮即止(近期没有会话被写过就是常态结果);持久层或全量回退给出空列表时按重试间隔重试,直到列出会话或超出新鲜窗口;快照不完整(部分子项读失败)时一律重试到窗口耗尽,不因已列出若干会话而收工。

## 配置

见 `src/config.mjs` 的 `DEFAULTS`;全部字段可在 profile 条目 `config` 中覆盖。语义要点:

- `paused`:全局刹车,置 true 后所有恢复停止
- `resumeGoals`:默认开启,与宿主“重启后 disarm”的默认相反,这是本插件有意的行为差异
- `resumePausedGoals`:默认关闭,暂停是人的决定
- `classify`:关闭后所有 `error` 都会重试

## 设置面板

配置卡片挂在插件管理页的包详情里(`plugins.bundle.config`,key 为包名),写的是宿主 `settings` 服务(profile 条目 `config` 的 volatile 字段),保存即时重建恢复引擎,不需要重启。

面板字段:总开关、等待时间、冷却、最大连续次数、重启恢复、空回合恢复、断网暂停、错误分类,以及五段补发文案。其余字段(退避倍数、扫描窗口等)仍走 `DEFAULTS` 与 profile 配置。

宿主路由 `GET/POST /api/keep-working/config` 供面板读写;`GET` 同时返回默认值,供「恢复默认」使用。

## 与 dsh-client-auto-continue 的关系

本包接管其宿主侧全部职责,装上后可卸载对方。未实现的部分:浏览器通知、会话级模式开关、循环护栏、子会话唤醒根会话。两包同时启用会出现同一回合被推两次。

## 开发

```bash
node --test "test/*.test.mjs"
```

判定、分类、探测、调度、扫描均可单测,不依赖宿主进程。

## dsh 版本兼容

宿主 API 面:`agents`、`systemPrompt`、`sessionQuery`、`workspaceRegistry`、`goals`、`@deepseek-ai/dsh-llm` 的 `createUserMessage`。

缺 `agents` 或 `systemPrompt` 时插件干净停用(不注册任何服务与提示词);缺 `sessionQuery` 时只停用重启扫描,实时恢复照常。`@deepseek-ai/dsh-llm` 动态导入失败时整体停用并留日志。

当前实测版本见 `dsh.compatibility.dshReleases`。
