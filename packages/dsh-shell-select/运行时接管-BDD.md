# shell-select 运行时接管 BDD(能正常加载才禁用官方 pwsh 链)

背景:原设计以 bundle patch 静态声明 `tool-pwsh: disabled: true` 与
`pwsh-sandbox: disabled: true`,loader 组合期无条件生效。本包级损伤(import 崩、
node_modules 损伤)时 guard 哨兵与主行同包同死,官方两行已被禁而无人提供
ctx.shell 与 shell 工具 → shell 能力全灭(dsh 崩溃形态)。本设计把「禁用官方
pwsh 链」从组合期静态声明改为「本包 apply 全部落定后的运行时动作」,使禁用
官方的前提严格强于本包自身可服务性。设计同构 dsh-llm-pi-gateway 的运行时
接管(takeover.mjs / 运行时接管-BDD.md),差异与本包形态三点:

- 官方受控对象是**两行**:`tool-pwsh`(shell 工具行)+ `pwsh-sandbox`
  (ctx.shell 执行器服务行),链式依赖,决策与禁用以链为单位。
- 官方行与主行抢同一个 cordis 服务(`ctx.shell`,cordis 重复 provide 抛错)
  与工具名(`shell`),主行不能以 Service 类形态与官方并存——主行改为
  apply 型行,执行器(ShellSelectExecutor Service 类)由主行按接管时序
  经 ctx.plugin 挂载,与 guard 的 mountOfficial 互为镜像。
- 本包行全部带平台门控:POSIX(Linux/macOS)上主行/guard/web/preset 行
  均停用,官方两行由 dsh-base 平台表达式停用(POSIX 用 tool-bash 链)。

## 核心不变式

- **INV-1** 官方两行被禁用的唯一执行者是本包主行 apply 落定后的
  runtime-disable 序列;主行未完整加载并装配成功,官方 pwsh 链保持启用。
- **INV-2** 主行任意死法(模块加载崩 / apply 中途崩 / apply 后被禁 / 卸载)
  下系统至少有官方 pwsh 链服务:未接管时官方自服务;接管中被禁由 guard
  代挂覆盖。
- **INV-3** 用户意图通道 = 「禁用本包」(market 禁主行 / user patch 禁行):
  主行退场后官方自然回归自服务,重启即收敛。与 gateway 不同,本包官方两行
  在 dsh-base 带平台表达式(`disabled: !!js process.platform !== 'win32'`,
  win32 求值 false),宿主默认启用态与「用户显式启用」在行树上不可区分,
  行级 false 不作为让位信号——凡非 true 即接管空间。getter 求值抛错与
  options 非布残值仍让位安全向。
- **INV-4** runtime-disable 是内存态,不持久;重启后官方两行回归行树声明态,
  由新一轮 apply → runtime-disable → 接管收敛。本包消失官方自然回归。
- **INV-5** POSIX 零接触:主行 POSIX 不激活(行级禁用 + apply 平台早退双
  防),不 update 不挂载;Linux 行为与无本包逐字一致。
- **INV-6** 宿主服务缺口自愈(0.1.7 实证):ctx.shell 真空期间宿主会按声明态
  自愈重载官方 pwsh 行(禁用后官方退场到本包挂载之间必然存在此缺口窗)。
  挂载轮终态 = 本包执行器 provide 取胜(激活在场),官方行自愈 init 撞
  cordis 唯一性失败,行树留 enabled/running 残影(无提供者,不服务);
  本包让位(market 禁/主行 reload gap)时官方自愈复活独占,自然回归。
  官方行 options.disabled 原始值恒为 !!js 表达式包装对象(不被宿主物化),
  启用中判定必须走 entry.disabled getter 求值,不读原始值(S-8)。

## 场景

### 决策层(takeoverDecision,输入为双行状态)

- **S-1** 两行全部禁用停稳 → `takeover`(直接挂载)。
- **S-2** 两行禁用但任一行仍在退场(fiber 在)→ `await-exit`。
- **S-3** 行启用中(entry.disabled getter 求值 false:平台默认启用 / 无声明,
  同形不可分)→ `runtime-disable`(同为接管空间,见 INV-3)。
- **S-4** 双行默认启用(平台表达式求值 false)→ `runtime-disable`。
- **S-5** 混合态(0.1.7 web 面常态:tool-pwsh 被宿主 patch 禁、pwsh-sandbox
  平台默认启用)→ `runtime-disable`,仅更新启用中的行。
- **S-6** 任一行 disabled getter 求值抛错 → `yield`(安全向:不抢)。
- **S-7** 行缺席(官方包未装):缺席行不参与 update,视为已禁;全缺席 →
  `takeover`。
- **S-8** `options.disabled` 原始值为 `!!js` 表达式包装对象(真机实证形态,
  非求值布尔)→ 决策不读原始值,按 getter 求值结果判定(同 S-1~S-5)。

### 接线层(apply)

- **W-1** `runtime-disable`:apply 期不占 ctx.shell / 不注册工具;apply 全部
  落定(旗标 active)后才启动序列:对启用中的行逐行
  `entry.update({disabled:true}, false, true)`(dsh-market 同款)→ 等双行
  退场(fiber 清)→ `ctx.plugin(ShellSelectExecutor, config)` 挂执行器
  (构造内注册 shell 工具与 systemPrompt 段)。
- **W-2** update 任一行失败:不挂载,已禁成的行回滚启用(官方链整体复活),
  告警降级——禁一半挂一半是 shell 工具真空形态,必须避免。
- **W-3** 退场等待超时(官方 fiber 未清):放弃挂载并告警降级;官方 fiber
  仍在服务(禁用残留仅内存态),重启收敛,不补挂不重试。
- **W-4** 挂载失败(ctx.plugin 抛错 / executor 激活异常):官方两行已退场,
  ctx.shell 真空——回滚启用官方两行令其复活,再失败仅告警(重启收敛)。
- **W-5** `yield`(仅 getter 求值抛错触发):零动作(不 update 不
  挂载),主行旗标 active,web 设置页照常可用,官方 pwsh 链全量服务。
- **W-6** `takeover` / `await-exit`:直接挂载(await-exit 先等退场,复用
  guard 的退场轮询常量与收尾间隔语义)。
- **W-7** POSIX:apply 首行早退(旗标 inactive),零 update 零挂载。

### 守卫层(guard,语义不变)

- **G-1** `detectDeadState` 不变:主行功能性停摆(禁用停稳 / 旗标 inactive)
  且官方两行禁用停稳 → 死态代挂。新机制下死态窗口 = 接管中主行被禁
  (runtime-disable 内存残留),guard 行(id 含 "/",market 拒写)存活。
- **G-2** 官方任一行启用 → 恒非死态(官方自服务,guard 空闲)。主行包级
  损伤形态(原 import 崩下官方已被 patch 禁 + guard 同死)由此自然消解:
  主行崩时官方根本未被禁。
- **G-3** guard 零改动:官方启用形态本就使 `every(disabled)` 不成立,无需
  新增分支。

### 端到端(真机)

- **E-1** win32 boot 舞蹈:官方先服务 → 主行 apply 落定 → 官方两行禁用
  退场 → 执行器挂载(shell 工具 + prompt 段回归)→ 模型发话走本包执行器。
- **E-2** 主行损伤:篡改主入口制造 import 崩 → 官方 pwsh 链正常服务
  (shell 工具可用),无 shell 全灭窗口。
- **E-3** market 禁主行:接管中禁 → guard 代挂官方;重启后官方行回归
  默认启用,官方原生服务。
- **E-4** Linux:本包行全停用,官方 tool-bash 链照常,零行为差异。
- **E-5** 旧宿主(0.1.5-rc.3 / 0.1.2-rc.1):同机制收敛,entry.update 签名
  兼容已由 gateway E-4 实证。
