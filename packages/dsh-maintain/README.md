# @mzzsfy/dsh-maintain

DeepSeek Harness 设置页插件:版本监测、更新内容与安全重启与受管 A/B 升级。

## 功能

- 版本监测:host 启动即检查一次,按轮询间隔重复检查(内存快照,不持久化);当前版本与追踪通道最新版对比,落后即提示。运行版本(宿主启动时缓存)与已装版本(磁盘实时)分开统计与展示,落后判定以运行版本为准,已装版本领先运行版本时提示"重启后生效"。定时轮询为软依赖:宿主 timer 服务不可用时仅停用自动轮询,面板显示降级提示,手动刷新仍可使用。
- 版本更新内容:面板"更新内容"按钮按追踪通道最新版本拉取 GitHub Releases 发布说明(deepseek-ai/deepseek-harness,标签 `dsh-v<版本>`,npm 清单无 readme 字段故以官方 releases 为事实源;通道最新版就绪前按钮禁用)。数据源为 releases 页面而非 api.github.com(未认证 API 限流 60 次/小时/IP 且按 IP 共享,页面限流实际宽松),从 markdown-body 正文容器深度配对提取,渲染后 HTML 映射回行文本(标题→# 前缀、列表→- 前缀、块级闭合→换行、实体解码;标签剥离先于实体解码,产物只经 React 文本节点输出无 XSS 面),页面响应体上限 512KB 流式截断;页面 URL 自建,无需远端 URL 白名单。弹窗展示版本、发布时间与正文,附"在 GitHub 查看"源站链接,无发布说明时明确提示;host 进程内缓存(仅成功结果,上限 20 个版本,超限淘汰最早缓存的版本,GitHub Releases 视为不可变故不设过期),同一版本重复查看不重复请求。GitHub 不可达或该版本未发布 Release 时窗内提示错误并可重试,附 releases 页兜底链接;路由 `GET /api/maintain/release-notes` 取追踪通道最新版。
- 追踪通道:在 npm dist-tags 间切换(latest / next / alpha 等,选项由检查结果动态生成),切换后按新通道判定。
- 一键受管安装(A/B 双目录编排):安装前候选验证 fail-closed——依赖树完整性检查(npm ls)+ 候选 CLI 真实执行冒烟(`node <候选bin> --version`,隔离候选环境,自然退出,不启动宿主服务),验证通过才切换链接;任一失败保留原版本服务。确认弹窗带"安装后自动重启宿主"勾选(单次意图,默认开):勾选时切换成功即调度宿主正常退出,由托管方式拉起新版本;取消勾选则宿主继续运行当前版本,需手动点"重启宿主"加载新版本,重启前不能再次发起升级。验证超时或切换后状态不确定时保留升级锁并强制退出宿主,拒绝后续升级直至人工核验。
- 活跃工作门控(fail-closed):升级受理与提交切换前检测运行中的 agent 会话与后台 job(jobs 按官方 `list(caller)` 字符串语义逐 agent 查询)。检测面不可用即拒绝升级(不冒充弱一致窗口放行);存在活跃工作拒绝且不可越过;重启仍按原语义带 force 可越。概要随 status 提供给面板。terminals 服务面 0.2.0 对插件 ctx 不可探属宿主常态,不因面缺失降级:agents 计数覆盖 running 期间的终端活动;agent 转 idle 后仍存活的终端不可计数,升级会中断它们,属已知盲区。
- 审计日志:升级/重启的触发、落定与拒绝各输出一行结构化日志(`audit endpoint=… outcome=…`),动态串单行化,便于事后排查。
- 面板设置编辑:轮询间隔、镜像地址均可在面板直接编辑保存,与 settings.yaml 等效(轮询间隔保存即重排,镜像地址保存即重查);host 侧拒绝非 http(s) 地址与带查询串/锚点的镜像地址(拼接 dist-tags 路径时 query 会吞掉路径),面板清空输入即恢复对应默认值。
- 操作反馈:检查更新、通道切换、面板保存与升级触发的失败经全站浮出通知(@mzzsfy/dsh-toast)提示;页面加载失败与重启超时等状态提示仍在面板内展示。
- 安全重启:两段式确认后 host 优雅退出(`appExit`,5 秒兜底强制);重启指令在响应发出后延迟执行,退出调度与响应冲刷解耦,客户端断连不影响宿主退出,浏览器先收到回执进入重启等待态;确认后面板立即提示重启进行中,轮询探测宿主恢复,且主文档连续多次探测可加载(宿主页面服务 fallback 已就绪并稳定)后再稍候片刻才刷新页面,避免启动窗口内刷新拿到 404,总时长 30 秒,超时提示转人工检查。动作路由带跨源守卫(Origin 与 Host 不符即 403,阻断跨站简单请求),与外层鉴权插件(如 dsh-web-startup-auth)互补;未部署鉴权插件时同源请求仍匿名可达。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-maintain
```

标准插件安装:包进入 profile node_modules(pnpm hoisted 布局),bundle patch 随下次 dsh 重启自动生效,无需手动编辑 cordis.patch.yml;宿主 peer(`@deepseek-ai/*`)不落盘,经目录逐级兜底解析到 dsh 本体全局安装目录。

开发安装(仓库工作副本直挂,不经 npm 发布):

```sh
node scripts/dev-link.mjs dsh-maintain   # 仓库根执行:归一 profile 依赖行 + 挂 junction
```

工作副本以 junction 挂进 profile,host 半区改动保存约 1 秒热重载,client 半区改动刷新页面即生效,无需发版;规约与全仓归一见 `node scripts/dev-link.mjs all`。勿用 `link:` 或裸相对路径手工挂载——realpath 后 peer 从仓库目录解析会失败(早期"必须手工拷贝部署"结论的成因,对 dev-link junction 不成立,junction 内 peer 沿 profile 解析)。

## 设置(配置节,热加载)

```yaml
maintain:
  channel: latest                                # 追踪通道,选项以检查返回的 dist-tags 为准
  pollIntervalSec: 21600                         # 轮询间隔秒,仅正数启用周期检查,0/负数禁用
  registryBase: https://registry.npmjs.org       # 官方源不可达时可改为镜像地址
```

配置落在 profile 条目 `maintain` 的 config 节(即上例 settings.yaml 的 `maintain:` 块,经 dsh 配置迁移后为 profile patch 内该条目的 config 键):dsh 0.1.7+ 以插件静态 `Config` 导出生成节表单,字段均为 volatile,面板保存经 configEditor 写回、仅 volatile 变化时 loader 原地热更(不重启插件);legacy 宿主(≤0.1.6)经 settings 服务 `register/get/update` 命名空间语义等价存取。轮询间隔与镜像地址亦可在设置面板"版本与运维"页直接编辑保存(等效配置节,热生效)。

## 重启须知

- 重启依赖托管常驻(pm2 / systemd / supervisord / Kubernetes / 容器等)自动拉起;手动终端启动的进程不会自动恢复。重启判定为三信号:失联恢复、宿主进程启动时刻(bootAt,容器内 pid 恒 1 场景的可靠信号)或 pid 变化。
- 确认重启后本页以严格顺序轮询探测宿主恢复(任意时刻至多一拍在途),主文档连续多次探测可加载(页面服务就绪并稳定)后稍候片刻才整页刷新;面板后台探测请求失败或拿到 404 均属宿主退出与启动窗口的中间态,面板保持等待提示。重启请求本身收到明确 HTTP 回绝(如升级互斥 409、appExit 缺失 500)时立即提示失败,不进入等待轮询。若你手动刷新后浏览器显示 404,说明宿主仍在启动窗口内,稍候数秒再次刷新即可。轮询总时长 30 秒,超时通常是宿主未被进程管理器拉起(手动终端启动)、退出失败或启动过慢,请检查进程管理器后手动刷新排查。
- 存在活跃工作(agent 会话/后台 job/终端)时重启被 409 拒绝,确认按钮显示活跃计数,再次点击即以 force 越过;force 重启不等待任务收尾,最多 5 秒后强制退出,任务中断;会话已持久化,重开后可 resume。升级成功触发的自动重启同样会中断在跑任务,依赖托管的活跃工作请自行评估升级时机。
- 升级进行中重启请求返回409(双向互斥);升级成功触发的自动重启同样会中断在跑任务,依赖托管的活跃工作请自行评估升级时机。

## 开发

```
cd packages/dsh-maintain && npm test
```

## dsh 版本兼容

按仓库动态窗口验证(scripts/compat/window.mjs),不预置任何固定版本槽:主测 = 渠道 dist-tag 最新 rc,完全适配口径;基线 = npm latest,不崩溃底线口径;主测与基线同版时收敛单槽。兼容面以窗口实测为准,不逐版本承诺。逐轮实测结论见 `docs/兼容性测试/逐包测试进度.md` 与本包 `兼容性测试.md`。
