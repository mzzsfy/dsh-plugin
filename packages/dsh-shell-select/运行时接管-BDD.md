# shell-select 运行时接管 BDD(能正常加载才禁用官方 pwsh 链)

> 状态:已实施,描述当前行为(guard 代挂与运行时禁用链在 src 中;README「接管失败自动回退官方 pwsh 链」即本设计)。验证版本见包 README 与 `兼容性测试.md`。

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
- **INV-7** 模型的终端入口不因展示策略归零:剔除 pwsh 与"不要调用 pwsh"改写
  只在**本包执行器已挂载接管终端**且**该作用域/该请求确有 `shell`** 时生效;
  yield/退场超时/回滚/执行器退役后一律原样透传。只保留 pwsh 的会话
  (子代理工具允许集)必须保留唯一终端。
- **INV-8** 原生 schemastery 设置节按主行 fiber 抑制(P2-36):策略登记在
  loader 行 fiber 上才被宿主 describe 命中;执行器子 fiber 上的登记无效,
  原生节照旧出现且其写口不经本包 refresh 桥,执行面不换源。
- **INV-9** apply 代际隔离:模块级 apply 旗标/请求缝活性是跨代共享状态,
  `beginShellSelectApply` 返回代际 token;异步接管链跨 await 落定时写旗标必须
  核对 token——旧代 `endActive/endInactive/setShellRequestSeam` 与旧代挂出的
  执行器 fiber 一律作废(挂出即回收),不得把新代判成旧代结论。

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
- **W-2** update 任一行失败:不挂载,告警降级,并按**禁用前快照**恢复全部目标行
  (含写入后抛错的 failed 行)——只回滚成功禁用清单会把「options 已写 disabled
  再抛错」的行永久留在禁用侧,shell 提供者缺席到重启。恢复逐行写回快照原值,
  三参恒 `create=false, force=true`;恢复失败逐行留 `rollback-failed` 排障面。
  禁一半挂一半是 shell 工具真空形态,必须避免。
- **W-3** 退场等待超时(官方 fiber 未清):放弃挂载并告警降级,主行旗标落
  `inactive`——落 active 等于宣称本包在服务,guard 的 `mainStalled` 恒 false,
  官方行(禁用仅内存残留)随后真退场后既无官方执行器也无本包执行器,无人代挂。
  不回滚这批官方行:它们不是本代禁的,回滚会翻成启用;若宿主在退场途中不重启,
  行树留下「启用但无 fiber」,反而挡住 guard 的 G-2 判据。放弃后官方真退场即
  进入死态,由 guard 代挂官方两行恢复服务;声明态由重启收敛,不补挂不重试。
- **W-4** 挂载失败(ctx.plugin 抛错 / executor 激活异常 / 未激活 fiber):官方两行
  已退场,ctx.shell 真空——回滚启用官方两行令其复活;无论回滚成败主行落
  inactive(旧实现裸 await 永 pending,官方仍禁且 guard mainStalled=false 不代挂,
  tools 全灭),回滚失败时由 guard 死态代挂兜底。
- **W-5** `yield`(仅 getter 求值抛错触发):零动作(不 update 不
  挂载),主行旗标 active,web 设置页照常可用,官方 pwsh 链全量服务。
- **W-6** `takeover` / `await-exit`:直接挂载(await-exit 先等退场,复用
  guard 的退场轮询常量与收尾间隔语义)。
- **W-7** POSIX:apply 首行早退(旗标 inactive),零 update 零挂载。
- **W-8** 请求缝活性(INV-7):执行器挂载成功才置活性,且 `hideShadowedPwsh`
  要求同批 tools 含 `shell`——请求只有 `pwsh` 时原引用透传;yield、await-exit
  退场超时、runtime 回滚、执行器 fiber 退役都显式复位(四类均有断言用例),
  复位后请求原样透传;活性开但无命中时请求对象本身零拷贝(热路径)。
  描述改写(`describePwshDirective`)同条件:作用域看不到 `shell` 不改写;
  作用域键是 agent 对象本身(宿主 `createScope(loopCtx, agent)`),传给
  `tools.get` 的 scope 形参不是 `agent.ctx`——传 ctx 只会命中全局视图,改的是
  本包全局 pwsh 镜像,子作用域 `deny shell` 的限制也绕过;tools 服务经
  `ctx.get` 读,cordis 属性直读在服务未注入/上下文停用时抛错,`agent/created`
  是 serial 事件,监听器抛错会打断会话创建(监听体内再兜一层告警)。
  改写**只作用于 agent 自有 scoped layer**:官方 `tool-pwsh` 在 preset 作用域注册
  (preset-registry 现造 `{}` 键,agent 作用域以它为父),definition 由该 preset
  下所有 agent 共享;继承/全局 definition 一律零动作。归属判定 = 用父作用域
  (`scopeParentOf(agent)`)的解析结果做对象身份比对:自有层只遮蔽继承层,不会
  解析到同一对象。改写共享定义会把"不要调用 pwsh"泄漏给同 preset 的其它 agent
  与 `deny shell` 的子作用域(那里没有 shell 可换)。
- **W-9** 原生设置节抑制(INV-8):主行 apply 里 `settings.configure({auto:false},
  ctx.fiber)`,策略落在 loader 行 fiber;执行器构造期不登记(子 fiber 上
  宿主 describe 永不命中,原生节与 Shell 管理页并存且写口不刷新执行面)。
- **W-10** 回滚安全网(INV-1):`entry.update({disabled:false}, create=false,
  force=true)`——create 为真会把官方行 options 整份替换成 `{disabled:false}`,
  毁掉 id/name/config;回滚失败的行进失败清单并记 `rollback-failed` 轨迹与
  error 日志,排障面不得显示成已复原。
- **W-11** 未激活 fiber 回收(S1):`ctx.plugin` 返回 ≠ 激活;`fiber.state`
  非 2 时先 `await fiber.dispose()` 再按挂载失败抛出——残留 pending fiber 会在
  宿主服务稍后就绪时自行激活并抢 `ctx.shell`。
- **W-12** 代际 token(INV-9):接管链落定前核对代际;旧代迟到的挂载结果
  立即 dispose 并记 `stale-generation 执行器已回收`,不写执行器句柄与请求缝;
  旧代已作废时不执行回滚/重挂,收敛交给新一代。

### 守卫层(guard)

- **G-1** `detectDeadState` 不变:主行功能性停摆(禁用停稳 / 旗标 inactive)
  且官方两行禁用停稳 → 死态代挂。新机制下死态窗口 = 接管中主行被禁
  (runtime-disable 内存残留),guard 行(id 含 "/",market 拒写)存活。
- **G-2** 官方任一行启用 → 恒非死态(官方自服务,guard 空闲)。主行包级
  损伤形态(原 import 崩下官方已被 patch 禁 + guard 同死)由此自然消解:
  主行崩时官方根本未被禁。
- **G-3** 官方启用形态本就让 `every(disabled)` 不成立;官方行翻回启用时只重发
  disabled 保持接管,不把执行器让位给官方链——写事务重建行树期间撤执行器会让
  `ctx.shell` 真空(2026-11-15 实机与隔离复现),让位分支已移除。
- **G-4** 官方包按需加载:只有死态代挂才加载官方两包(正常启动零加载、
  apply 不被加载预算阻塞);瞬时失败退避重试至多 3 次,耗尽停用死态自愈。
- **G-5** 代挂半失败回收:全部挂载先发起且发起即记账,任一环抛错/超时都对
  已发起 promise `allSettled`(有界等待)后逐个 dispose;本次尝试标记 abandoned
  后**再落定**的迟到 fiber 由落定回调直接回收(超出 2×mountTimeout 窗口也不
  泄漏)——不留半套官方链长期占着 `ctx.shell` 与工具注册,下轮 sweep 可重试。
- **G-6** 行状态是**三态**:已复活 / 未复活 / 求值不可信(官方行 `disabled`
  getter 抛错,如 `!!js` 表达式异常)。不可信 = 零动作:不重禁、不让位、不卸
  代挂,`loader/patch-context` 直接放行,`sweep` 跳过本轮(记 `revived=<id>
  unreliable, 保持现状` 轨迹)。把不可信折叠成"未复活"会让 patch 事件一路落到
  「卸代挂让位」,撤掉代挂服务而官方行并未复活——写事务重评表达式期实测。
  重禁失败(写事务重建行树中)或不可信都不退役执行器:只让本次保存由宿主判
  失败,终端能力不丢。主行 active 而执行器句柄不在场超过宽限窗口 = 接管链
  断裂,由 `sweep` 代挂官方链,不留给用户重启。
- **G-7** `guard-status` 路由注册容忍服务晚到:apply 时刻 `webServer` 未就绪时登记
  `ctx.inject(['webServer'], …)`,服务就绪即补注册——一次性 `ctx.get` 会永久丢注册,
  真机表现为带 cookie 也 404(无 cookie 被宿主 `/api` 闸门挡成 401)。路由 effect
  登记在注入上下文上,子 fiber 卸载即撤销、服务重注册不叠路由;`withHostGate` 用
  同一个上下文回问宿主闸门;服务在但 `register` 非契约时零动作(不挂空路由、不登记
  inject)。

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
