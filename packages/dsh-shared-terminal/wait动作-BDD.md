# wait 动作 BDD

`terminal` 工具新增 `wait` 动作:阻塞等待指定文本出现在终端屏幕(read 的 active viewport),带超时与终端退出短路。参照 dsh-better-sidebar `terminal_wait_for`,适配共享终端的 viewport 快照模型(无 transcript,滚出屏幕即不可见)。

## 请求形状

```json
{ "action": "wait", "terminal_id": "…", "text": "Build successful", "timeout_ms": 30000 }
```

- `terminal_id`、`text` 必填;`text` 为待等待子串,大小写敏感逐字匹配,非空
- `timeout_ms` 可选,默认 10000,合法域 [100, 55000](上限 = 工具超时 60s − 5s 返回余量),越界拒绝 `INVALID_TIMEOUT`

## 场景

### W1 文本已在屏幕,立即 found

- Given 终端屏幕文本已包含 needle
- When 执行 wait
- Then 返回 `kind:"found"`,携带 `elapsed_ms` 与当前屏幕快照(`text/lines/truncated/state/sequence`),不等待

### W2 文本稍后出现,轮询后 found

- Given 屏幕第 N 次轮询才出现 needle
- When 执行 wait
- Then 每隔轮询间隔读一次屏幕,命中即返回 `kind:"found"`,屏幕快照为命中时刻

### W3 needle 未出现,超时 timeout

- Given 超时内 needle 始终未出现且终端保持 running
- When 执行 wait
- Then 返回 `kind:"timeout"`,携带 `timeout_ms` 回显与最后一次屏幕快照

### W4 终端退出,exited 短路

- Given 轮询中 readScreen 返回 `state:"exited"` 或 `"failed"`
- When 执行 wait
- Then 即使该轮屏幕已含 needle 也返回 `kind:"exited"`(退出优先),携带屏幕快照

### W5 参数闭合

- When text 为空串 / 含未知字段 / terminal_id 无效
- Then 拒绝 `INVALID_ARGS`
- When timeout_ms 非整数或越界
- Then 拒绝 `INVALID_TIMEOUT`

### W6 协作取消

- Given 等待进行中回合被取消(exec.signal abort)
- Then 等待中止,返回 `TERMINAL_ERROR`(宿主同时以取消收敛该工具调用)

### W7 终端中途不可用

- Given 等待中 readScreen 抛 `terminal/unavailable`(终端被关闭)
- Then 返回 `TERMINAL_UNAVAILABLE`,不吞错继续空转

## 结果 schema(单闭合分支并入 oneOf)

`ok/terminal_id/kind(enum found|timeout|exited)/text/lines/truncated/state/sequence` 必填,`elapsed_ms`(found)/`timeout_ms`(timeout)按 kind 出现。

## 工具卡片(client)

- 动作名:等待屏幕文本 / Wait for screen text
- 摘要 = needle;徽章 = kind(已出现/超时/已退出)
- 展开 = 屏幕快照(空屏显示兜底提示,与 read 同构)
