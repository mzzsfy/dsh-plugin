# 运行时接管 BDD(gateway 修复:能正常加载才允许禁用官方行)

背景:原设计以 bundle patch 静态声明 `llm-pi-ai: disabled: true`,loader 组合期无条件生效。
gateway 包级损伤(import 崩、node_modules 损伤、共享模块图崩)时 guard 哨兵与主行同包同死,
官方行已被禁而无人服务 → 全模型不可用(dsh 崩溃形态)。本设计把「禁用官方行」从组合期
静态声明改为「gateway apply 全部落定后的运行时动作」,使禁用官方的前提严格强于 gateway
自身可服务性。

## 核心不变式

- **INV-1** 官方行被禁用的唯一执行者是 gateway apply 落定后的 runtime-disable 序列;
  gateway 未完整加载并装配成功,官方行保持启用。
- **INV-2** gateway 任意死法(模块加载崩 / apply 中途崩 / apply 后被禁 / 卸载)下,系统
  至少有官方插件服务 LLM 路由:未接管时官方在场自服务;接管中被禁由 guard 代挂覆盖。
- **INV-3** 用户显式启用官方行(`options.disabled === false`)是最高意图,gateway yield,
  永不强抢;行树默认态(`undefined`)才是 gateway 的接管空间。
- **INV-4** runtime-disable 是内存态,不持久;重启后官方行回归默认启用,由新一轮
  apply → runtime-disable → 接管收敛。gateway 消失(bundles 移除)时官方行自然回归。

## 场景

### 决策层(takeoverDecision)

- **D-1** 官方行缺席(loader 缺失 / 行不存在)→ `takeover`(与官方包缺失路径同构)。
- **D-2** 官方行禁用(getter true)且停稳 → `takeover`。
- **D-3** 官方行禁用(getter true)且仍在退场(fiber 在)→ `await-exit`。
- **D-4** 官方行启用且 `options.disabled === false`(用户显式启用)→ `yield`。
- **D-5** 官方行启用且 `options.disabled` 为 `undefined`(行树默认态)→ `runtime-disable`。
- **D-6** disabled getter 求值抛错(!!js 求值失败)→ `yield`(安全向:不抢)。

### 接线层(apply)

- **W-1** `runtime-disable` 态:apply 期不占用官方资源(不装守卫/不注册官方
  discovery/不装官方节),只装配本包节;apply 全部落定(`endGatewayApplyActive` 后)
  才启动 disable 序列:`entry.update({disabled:true}, false, force)` → `awaitOfficialExit`
  → `completeOfficialTakeover`(守卫 + 官方 discovery + 官方节 + 路由重算)。
- **W-2** disable 序列在 apply 返回后的异步序列执行,不阻塞 apply 生命周期;
  序列内任何异常只告警降级,官方继续服务。
- **W-3** update 抛错 → 告警「官方行运行时禁用失败,官方继续服务」,不接管。
- **W-4** disable 成功但退场超时(在途流)→ 降级只服务本包节 + `armDeferredTakeover`
  武装延迟补接管(现有原语复用)。
- **W-5** `yield` 态行为不变:只服务本包节,不装守卫,官方资源零占用。
- **W-6** `takeover` / `await-exit` 态行为不变(官方行已禁场景,含退场超时降级)。

### 守卫层(guard)

- **G-1** `detectDeadState` 语义不变:gateway 功能性停摆(禁用停稳 / apply 声明
  inactive)且官方行禁用停稳 → 死态,代挂官方。新机制下死态窗口 = 接管中 gateway
  被禁(runtime-disable 内存残留),窗口内 guard 行存活(market 拒写含 "/" 的行 id)。
- **G-2** 官方行启用(未被 runtime-disable 或已回归默认)时恒非死态——官方自服务,
  guard 空闲。gateway 包级损伤形态(原 import 崩死态)由此自然消解。
- **G-3** `detectImportCrashState` 及 90s 宽限机制整体删除:该形态在新机制下不存在
  (apply 崩溃 ⇒ 未到 runtime-disable ⇒ 官方行启用),无路径可触发,保留即死代码。

### 端到端(真机)

- **E-1** boot 舞蹈:官方先服务(默认启用)→ gateway apply 落定 → 官方行禁用退场 →
  gateway 接管(官方节 + 注入路由)→ 模拟器断言 #3/#4/#5 注入面回归。
- **E-2** 包损伤:篡改 gateway 主入口制造模块加载崩溃 → boot 后官方插件正常服务
  (deepseek/echo 路由可用),无全模型不可用窗口。
- **E-3** market 禁用 gateway:接管中禁 → guard 代挂官方,echo 请求 200 官方语义;
  重启后官方行回归默认启用,官方原生服务。
- **E-4** 旧宿主(0.1.5-rc.3 / 0.1.2-rc.1)boot 不回归:gateway live、官方行收敛为
  禁用态内存残留、无崩溃。

## 实测记录(2026-09-25)

- **E-1 PASS**(0.1.7-rc.1 全链 × 3 轮):`decision=runtime-disable → runtimeDisableOfficial ok
  → awaitOfficialExit=true → completeOfficialTakeover ok` 全序列落定;注入面三协议 upstream
  全中(`/chat/completions`、`/v1/messages?beta=true`、`/responses`),affinity=[x-session-affinity],
  metadata.user_id=dsh:<hash> 逐轮刷新;activation live、diagnostics findings=0。
  说明:catalog 的 routableProviders 只含 settings 存储节值里的 provider(register-echo-provider
  写入后才有 echo 组),gateway 行 config 声明不经存储直显——adapter 路由面与 catalog 目录面
  是两个判据,注入断言以留档 upstream 为准。
- **E-2 PASS**:主入口注入 `throw`(import 崩)→ hot reload 后 gateway 不服务,官方插件
  与宿主内置 provider 正常在场,failures=[] 无崩溃;修复源码后恢复。
- **E-3 PASS**:market HTTP toggle 禁 gateway(`ok=true, hot=false`),user patch 写入
  `- id: llm-pi-gateway / disabled: true`,**carrier=[]**(静态禁行移除后 disable-carrier
  语义消失,bundles 保留,guard 行存活);guard sweep 代挂官方(官方 ns 探活 ok),
  系统无崩溃;重新启用热恢复(hot mount ok)。
- **E-4 PASS**:0.1.5-rc.3(9292)与 0.1.2-rc.1(9293)boot 活 + `llm-pi-gateway=live` +
  接管态官方 ns 探活 ok——旧宿主 `entry.update(options, create, force)` 签名兼容
  (cordis-plugin-loader 1.0.3 / 1.0.5 同构),runtime-disable 跨版本可用。
  阻塞修复备注:两台旧宿主上 `preset-shell-select`(shell-select 的 preset insert 行,
  peer `@deepseek-ai/dsh-agent-preset >=0.1.7-rc.1` 在旧宿主未装)import 崩导致 boot
  exit 1——shell-select 独立缺陷(insert 行缺宿主版本守卫),与本修复无关,验证时以
  user patch 禁行绕过,正解待 shell-select 补 insert 门控。
- 回归:gateway 253/253,全仓 L1 2584/2584 fail=0。
