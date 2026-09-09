# @mzzsfy/dsh-model-capability-editor

DeepSeek Harness 模型能力编辑插件:编辑 `llm-pi-ai` 管理的第三方模型的 `reasoningEfforts`(7 个标准思考档位与每档线上值)与 `input` 多模态声明,经官方 settings RPC 整组写回 settings.yaml。

默认注入官方「模型」页:打开 provider 编辑卡并展开「自定义设置」后,每个模型行下方出现"模型能力"编辑块,行内直接编辑。本插件不注册独立设置分区。官方 DOM 结构变化导致锚点失效时,自动在模型页右侧注入浮动"模型能力"入口,点开即完整编辑卡;注入恢复后浮动入口自动移除。

## 解决什么问题

- 手声明模型被当纯文本:图片附件被拒(`input` 未声明图像模态)。
- 推理档位拼写不可控:网关自有词汇需要 `reasoningEfforts: { high: ultra }` 这类重命名。
- 需要显式禁用推理(`reasoningEfforts: false`)或回到 host 默认(删除字段)。

## 功能

- provider 选择(来源为 describe 返回的 `providers` 键),列出各模型行(独立编辑卡形态,当前仅作为锚点破坏时的浮动回退面板呈现)。
- 推理档位七档(off / minimal / low / medium / high / xhigh / max,与宿主 pi-ai `THINKING_LEVELS` 一致)开关(语义保留 checkbox,视觉为 `mce-switch` 开关形态)+ 每档线上值输入,判定表:

  | 勾选状态 | 写回行为 |
  |---|---|
  | 全不勾选 | 删除 `reasoningEfforts` 字段(回到 host 默认) |
  | 仅勾选 off,拼写留空 | `reasoningEfforts: false`(禁用推理) |
  | off 勾选拼写留空,存在其他勾选档 | 对象形态 `off: null` |
  | off 勾选拼写填值 | 对象形态 `off: "拼写"` |

- input 四态:未声明(删除字段)/ 仅文本(`["text"]`)/ 文本+图像(`["text", "image"]`)/ 仅图片(`["image"]`,纯视觉网关不收文本输入)。
- 保存前本地校验:非 off 档勾选但拼写空白时拒绝保存并提示具体模型与档位(空白拼写会静默以档位名作线上值,易被误当作已填;off 档留空有专门语义,不参与校验)。卡片与行内编辑块均拦截。保存与校验反馈经全站浮出通知(`@mzzsfy/dsh-toast` 可选依赖,缺失时降级 console)。
- 一键草稿填充:卡片底部「填充草稿」对当前 provider 内未声明任何档位的模型填入七档全勾、拼写留空(线上值=档位名)的草稿;只改内存草稿,不触碰 inputMode,已声明档位的模型不受影响,写回仍需手动保存。
- 保存 = mutate set `providers.<route>.models` 整个数组:以 describe 读到的数组为基线,未编辑条目原样保留,settings 未声明的(自动发现的)模型不被删除;providers 缺失或 models 非数组时拒绝保存(防静默覆写为空数组)。
- 修订冲突:重读 describe 取新 revision,按字段级 diff 仅重放本次修改(仅用户改过的模型条目的 `reasoningEfforts` / `input` 两字段,其余字段保留最新文档值),重试一次;再冲突报错终止并保留用户输入,绝不静默覆盖。"本次修改"以草稿加载时点冻结的种子为参照:加载后他方对基线的修改,不会被零编辑或仅改单一字段的保存静默回滚(该保证覆盖保存开始后的并发写,revision 乐观锁语义)。
- `settings` wire 面缺失 / describe 失败 / `writable === false`:卡片显示具体原因并只读,绝不静默;describe 返回缺 revision 时拒绝盲写。
- 行内注入块:每模型档位与模态编辑,应用 = 单模型草稿并入整组保存流,语义与独立分区一致。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-model-capability-editor
```

重启 dsh 后,打开官方「模型」页任意 provider 的编辑卡,展开「自定义设置」,模型行内即出现"模型能力"编辑块;若官方结构变化导致注入失效,模型页右侧自动出现"模型能力"浮动入口作为回退。

## 前置:dsh 本体版本

需要 dsh 本体 0.1.2 及以上(读写经 `remote.settings` 服务面,该面由 0.1.2 引入的 host 侧 `dsh-api-settings-controller` 提供)。更旧的本体上无此服务面,client 半区因注入声明 `remote.settings` 未满足而保持未激活(无 UI、无告警、不影响 web 启动与其他插件);请先升级 dsh,或改用插件 0.1.2(旧 settings 面,已停止维护)。

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

纯逻辑层单测(node --test,无外部依赖):档位四态判定表与拼写回填、input 四态(含纯图像)、保存前空拼写校验、一键草稿填充、整组写回基线合并、冲突字段级重放与一次重试判定、竞品痕迹检测、wire 信封适配(含 transport 抛错透传)与端到端冲突重放、client.js 与 logic.mjs 的 wire 适配段同源守卫,以及锚点判定与行内目标解析、注入编排与生命周期、开关守卫、client id 等其余模块测试。

## License

MIT

## 开发安装(仓库工作副本直挂,不经 npm 发布)

```sh
node scripts/dev-link.mjs dsh-model-capability-editor   # 仓库根执行:归一 profile 依赖行 + 挂 junction
```

工作副本以 junction 挂进 profile,client 半区改动刷新页面即生效,无需发版;规约与全仓归一见仓库根 `node scripts/dev-link.mjs all`。
