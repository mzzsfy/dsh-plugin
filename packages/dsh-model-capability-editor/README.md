# @mzzsfy/dsh-model-capability-editor

DeepSeek Harness 模型能力编辑插件:在设置 → 模型页底部(官方 `settings.models.footer` 插槽)渲染"模型能力"卡片,编辑 `llm-pi-ai` 管理的第三方模型的 `reasoningEfforts`(思考档位与线上拼写)与 `input` 多模态声明,经官方 settings RPC 整组写回 settings.yaml。

## 解决什么问题

- 手声明模型被当纯文本:图片附件被拒(`input` 未声明图像模态)。
- 推理档位拼写不可控:网关自有词汇需要 `reasoningEfforts: { high: ultra }` 这类重命名。
- 需要显式禁用推理(`reasoningEfforts: false`)或回到 host 默认(删除字段)。

## 功能

- provider 选择(来源为 describe 返回的 `providers` 键),列出各模型行。
- 推理档位四档(off / low / medium / high)复选框 + 每档线上拼写输入,判定表:

  | 勾选状态 | 写回行为 |
  |---|---|
  | 全不勾选 | 删除 `reasoningEfforts` 字段(回到 host 默认) |
  | 仅勾选 off,拼写留空 | `reasoningEfforts: false`(禁用推理) |
  | off 勾选拼写留空,存在其他勾选档 | 对象形态 `off: null` |
  | off 勾选拼写填值 | 对象形态 `off: "拼写"` |

- input 三态:未声明(删除字段)/ 仅文本(`["text"]`)/ 文本+图像(`["text", "image"]`)。
- 保存 = mutate set `providers.<route>.models` 整个数组:以 describe 读到的数组为基线,未编辑条目原样保留,settings 未声明的(自动发现的)模型不被删除。
- 修订冲突:重读 describe 取新 revision,按字段级 diff 仅重放本次修改(仅用户改过的模型条目的 `reasoningEfforts` / `input` 两字段,其余字段保留最新文档值),重试一次;再冲突报错终止并保留用户输入,绝不静默覆盖。
- `remote.settings` 槽缺失 / describe 失败 / `writable === false`:卡片显示具体原因并只读,绝不静默。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-model-capability-editor
```

重启 dsh 后,设置 → 模型页底部出现"模型能力"卡片。

## 前置:移除 dsh-better-reasoning-effort

本插件与竞品 `dsh-better-reasoning-effort` 互斥,安装本插件前必须先移除竞品:

1. 竞品的 host 端 autofill 是 settings 写者,其滑块也控制推理档位,共存即双写冲突。
2. 迁移步骤:在 profile 中 `pnpm remove dsh-better-reasoning-effort`(并从 profile 捆绑包依赖里删去该行),重启 dsh,确认模型菜单滑块消失。
3. 若竞品遗留了写入痕迹(模型条目上出现词汇表外的 `reasoningEffortsUnset` / `inputUnset` 标记字段),本卡片初始化时会在状态区告警;这些字段不影响本插件读写,可顺手删除或保留。

本插件不做自动卸载他包的越权行为,移除竞品由用户完成。

## 覆盖范围

- 仅编辑 `llm-pi-ai` 命名空间的 `providers`;内置 DeepSeek 等非 llm-pi-ai 管理的 provider 不出现,写入也不生效。
- 编辑粒度为每模型的 `reasoningEfforts` 与 `input` 两个字段;上下文窗口 / 最大输出 token 等 GUI 原生字段不在本卡片编辑。

## 测试

```sh
npm test
```

纯逻辑层单测(node --test,无外部依赖):档位四态判定表与拼写回填、input 三态、整组写回基线合并、冲突字段级重放与一次重试判定、竞品痕迹检测。

## License

MIT
