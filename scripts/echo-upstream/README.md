# 本地 LLM 模拟器

这是一套可通过 HTTP 控制的本地测试服务，不调用真实模型。CLI、控制面、OpenAI / Anthropic / Responses 协议实现和测试集中在本目录。`cli.mjs` 是唯一启动入口。

## 启动与接入

```bash
node scripts/echo-upstream/cli.mjs --port 18123
# 独立实例，打印实际端口；不同实例的队列和请求历史互不影响
node scripts/echo-upstream/cli.mjs --port 0 --log .compat/llm-requests.jsonl
```

只监听 `127.0.0.1`，无真实凭据需求。将宿主 provider 的 baseURL 设为 `http://127.0.0.1:18123`；支持 `/v1/chat/completions`、`/v1/messages`、`/v1/responses`（也支持无 `/v1` 前缀）。`stream` 由上游请求决定，模拟器自动返回 JSON 或 SSE。

默认日志位于系统临时目录下的 `echo-upstream.jsonl`。指定 `--log` 时，父目录必须预先存在；模拟器不会创建目录。

CLI 参数：`--port`、`--log`、`--tokens 输入,输出`、`--models a,b,c`、`--echo-user-message`。没有 HTTP 配置时保留模型后缀场景（`-think`、`-thinkslow`、`-tool`、`-call`、`-slow`、`-drop`、`-err429`、`-err500`）。

## 设置接下来两轮：工具调用 → 文本结束

```bash
curl -X POST http://127.0.0.1:18123/control/replies \
  -H 'Content-Type: application/json' \
  -d '{"replies":[{"thinking":"先验证 PowerShell 执行链。","toolCalls":[{"name":"pwsh","arguments":{"command":"Write-Output probe-ok","description":"验证直接 pwsh 调用"}}]},{"text":"验证结束。"}]}'
```

`POST /control/replies` 接受单个回复对象或 `{ "replies": [...] }`，追加到 FIFO 队列。每个真正的生成请求原子消费一条，包括失败响应；模型发现和控制请求不消费。**工具执行后的续轮也是一个生成请求**，因此一般应再排一条纯文本结束，避免无限调用工具。多个会话共享同一实例时按请求到达顺序消费；需要严格归属时为测试各起独立端口。

## 默认回复与独立思考、吐字速度

```bash
# 队列为空时使用默认回复
curl -X PUT http://127.0.0.1:18123/control/default \
  -H 'Content-Type: application/json' \
  -d '{"text":"这是缓慢输出的正文。","thinking":"这是独立的思考内容。","stream":{"chunkSize":2,"intervalMs":100,"thinkingChunkSize":1,"thinkingIntervalMs":50}}'

# 只修改思考，不改变正文与正文速度
curl -X PATCH http://127.0.0.1:18123/control/default \
  -H 'Content-Type: application/json' \
  -d '{"thinking":"替换思考。","stream":{"thinkingIntervalMs":200}}'
```

正文和思考分别按 Unicode 字符分片，`intervalMs` / `thinkingIntervalMs` 是相邻片段间隔（毫秒），不是 token 速率。缺省全文一次、无间隔。非流式请求不应用速度；流式断开会取消后续等待。每个请求开始时确定回复快照，运行中的流不受随后 PATCH 影响。

| 回复字段 | 含义 |
|---|---|
| `text` | 正文，可为空字符串 |
| `thinking` | 独立思考：OpenAI `reasoning_content`、Anthropic `thinking`、Responses `reasoning` |
| `toolCalls` | 多工具数组，每项 `{id?, name, arguments}`；arguments 为对象或合法 JSON 对象字符串 |
| `tokens` | `[输入, 输出]`，允许 0；默认各 1 |
| `stream.chunkSize` / `thinkingChunkSize` | 正整数；正文 / 思考每片字符数 |
| `stream.intervalMs` / `thinkingIntervalMs` | 0–2147483647 的整数；正文 / 思考片间隔 |
| `status` | 注入 400–599 HTTP 错误，响应始终为 JSON |
| `error` | 自定义错误对象；仅提供 error 时默认 HTTP 500 |

正文、思考和多个工具可同时设置；仅思考、空正文也合法。非法参数、未知字段、重复工具 id 或坏 JSON 返回 400，批量队列整批拒绝，不会部分入队。

## 查询上次收到的对话、tools 与完整请求

```bash
curl http://127.0.0.1:18123/control/requests/latest
curl 'http://127.0.0.1:18123/control/requests?after=0&limit=10'
curl http://127.0.0.1:18123/control/state
curl http://127.0.0.1:18123/control/replies
```

最近请求返回 `id`、时间、path、model、stream、messages、tools、system、input、完整 body/raw，以及实际使用的回复 `reply`（无 HTTP 配置则 null）。尚未收到生成请求时为 JSON `null`。`after` 是请求 id 游标，reset 后 id 仍单调增长；GET 查询不成为“上次请求”。请求历史驻留当前进程内存；长期调试定期 reset，磁盘 JSONL 留档独立保留，总量超 100MB 时按行截断只留最近约 50MB，长驻实例不失控。

授权头、Cookie、API-Key 头不在 HTTP 查询中返回。**body/raw 是原始测试输入，仍可能包含敏感数据；只使用测试会话，不发送真实密钥或私人对话。** CLI 的 JSONL 是原有完整请求留档，请同样按测试数据管理。

| HTTP 操作 | 行为 |
|---|---|
| `POST /control/replies` | 追加一次性回复或回复批次，201 |
| `GET /control/replies` | 查看未消费回复 |
| `DELETE /control/replies` | 清空队列 |
| `PUT /control/default` | 替换缺省回复 |
| `PATCH /control/default` | 按字段更新缺省回复，stream 按子字段合并 |
| `GET /control/default` | 查看缺省回复，未设为 null |
| `DELETE /control/default` | 清缺省回复，队列耗尽时回到原场景行为 |
| `GET /control/requests/latest` | 最近生成请求 |
| `GET /control/requests?after=0&limit=100` | 分页读取生成请求历史 |
| `GET /control/state` | 队列数、请求数、最近 id、缺省回复 |
| `POST /control/reset`（body `{}`） | 清队列、缺省回复和内存请求历史，不清磁盘 JSONL |

控制面只用于本地测试，未提供认证、规则匹配或跨实例同步。生效顺序：一次性队列 → HTTP 缺省回复 → 原模型后缀场景。

## 验证与目录

```bash
node --test "scripts/echo-upstream/test/*.test.mjs" tests/echo-upstream.test.mjs
```

- `cli.mjs` / `cli-args.mjs`：启动入口与参数解析。
- `server.mjs` / `control.mjs`：实例装配、HTTP 控制及请求历史。
- `controlled-response.mjs`：自定义回复的三协议 JSON/SSE、思考与速度。
- `protocol.mjs` / `streaming.mjs` / `scenarios.mjs`：原协议与固定场景。
- `recorder.mjs`：JSONL 留档。
- `test/`：真实 HTTP、协议、控制、分片和断开回归。
- `兼容性测试.md`：宿主链路测试协议。
