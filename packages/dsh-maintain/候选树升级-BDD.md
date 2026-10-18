# dsh-maintain 候选树升级 BDD

## 状态与交付边界

**历史Windows强一致方案，停止作为当前实施依据。** 用户后续确认弱一致性、
原全局包不动、两个新安装目录与目录链接切换；当前规格见
[双目录安装与链接升级设计](<透明升级-设计.md>)。本文保留旧契约及历史证据，
原审核/原语探针不代表新方案已验收，强一致不变量和G1—G5不再作为新方案要求。

这是候选树事务的设计规格，不是已实现功能。本轮仅写文档、核查与 review；
未修改生产安装、profile、PATH、守护循环，也未重启宿主。文档审查通过不等于
Windows 原语、DSH 候选启动和故障恢复已经实测通过。发布必须满足文末验收门。

本规格替代原地安装方案；旧[草案](./升级根治-BDD.md)保持“审核未通过”，
旧[审核报告](./升级根治-审核.md)保留为反例记录。不得再据旧稿实施。

目标：对**受管 Windows 安装**提供升级、同版修复和版本回退；每次安装只写
独立候选树，未验证树不获得启动许可，故障不会自动恢复为带伤启动或无限
重启。失败可以保留旧版本继续服务，也可以显式停机；不承诺任何环境永远
可用、不承诺上游版本与所有生产插件天然兼容。

## 已验证事实与被撤回的推论

| 事实 | 证据与结论 |
|------|------------|
| 用户生产循环是 PowerShell | `while ($true) { dsh web --no-open }`，没有启动屏障和失败限次 |
| 本机 PowerShell 优先解析 dsh.ps1 | 本轮 `Get-Command dsh -All`：依次 dsh.ps1、dsh.cmd、dsh；不能只以 Bash shim 推断用户启动链 |
| shim 绑定全局树 | 已读本机 dsh.ps1：从 basedir 的 node.exe 启动 basedir/node_modules/@deepseek-ai/dsh/lib/bin.js |
| 本机 Node 与 npm prefix 使用 nvm 别名 | 本轮只读命令：execPath 为 <node install dir>\node.exe，npm config get prefix 为 <node install dir>；realpath显示该 SymbolicLink 别名与版本实体一致；不能误称本机此链接必为junction |
| npm 合法提升依赖 | 前轮从 web-app 的 createRequire 成功解析同层 connection，直接子目录却不存在；验证器不能只查引用方直接子目录 |
| 前轮两个新进程分别读到版本 A、B | 仅证明 junction 换向后新进程可读新入口；未测 DSH 实例、并发 reader、掉电或失败路径 |
| 前轮活进程再次 import 仍读 A | 仅证明那条 import 路径的缓存行为，不证明全部晚加载或任意 path 访问免疫 |

撤回三项结论：

- `rmSync(junction)` 后 `symlinkSync(newTarget)` 是两个操作，不能称原子，
  两者之间目录确实可以缺失；“耗时 1ms”不证明不存在缺口。
- junction 回指旧树可能遭遇权限、文件系统或介质失败，不能承诺回滚永远成功。
- 原 PowerShell 循环使用 npm shim，不具备健康监督、事务协调或启动许可。
  **必须一次接入稳定受管启动器**，不能承诺一行不改。

## 第一性约束与方案取舍

输入为 registry、通道或精确版本、当前受管部署与启动参数；输出为安装事务
状态、候选验证报告以及明确的 active 版本。版本通道在事务开始解析为精确
版本并钉定 tarball integrity；构建、验证、发布不得重新读取移动的 tag。

外部约束：Windows 与上述 PowerShell 启动方式来自用户；生产面零接触的
AI 自测边界来自仓库规约；npm/DSH 上游接口不可任意修改；首次接入是未来
部署操作，需要单独授权，不包含在本轮“写文档”的授权中。

| 路线 | 操作序列 | 薄弱环节与取舍 |
|------|----------|----------------|
| 原地离线安装 | 停机→屏障→原地 npm→自检→恢复 | 装到一半仍会毁掉唯一树；裸循环不参与协议。弃选 |
| 候选＋换 junction | 装候选→验证→删/建或改 junction→下轮启动 | 未证明无缺口与断电恢复，晚加载仍可能依赖可变入口。弃选 |
| 候选＋稳定监督入口 | 独立安装→停止候选写者→验证→受管停机→提交版本指针→监督启动 | 需一次接入启动器与 Windows 原语适配器；选择，所需证据明确且旧运行树不参与安装 |

移除三个假设：无需安装发生在原 prefix；无需“单文件零依赖”而手写 semver；
无需把 npm shim 当成稳定升级入口。替代为独立发行目录、随管理工具快照的
成熟依赖、外置受管启动器。超时是故障检测条件，绝不作为健康或退出证明。

## 术语与目录

- **管理根 M**：由首次接入显式选择的本地 NTFS 目录，位于 npm 全局目录与
  dsh release 树之外。身份是 M 的 canonical realpath；资源 ID 是该身份的
  SHA-256。不同 DSH_HOME 不得各自发明管理根来控制同一发行库。
- **稳定监督入口**：M/tools 内固定发行的 launch.ps1、Windows 适配器与
  coordinator 工具快照。升级 dsh 不修改这些文件；管理工具自身更新另立
  离线维护任务。本期仅管理一个 web 启动配置、一个生产 DSH_HOME、一个端口。
- **发行树**：M/releases/<releaseId>，含完整局部 npm prefix 与安装记录；
  releaseId 使用随机 UUID，不以版本号单独命名。同版修复也创建新树。
- **候选**：发行树处于 building/validating 时的状态，从未被 active 指向。
  构建失败或写者未知时标 quarantine，不重用该目录重装。
- **sealed**：构建和验证的进程树都已确认结束，来源、依赖解析、文件及
  隔离启动检查通过，文件清单/摘要与验证报告完整提交。seal/inventory/
  来源报告固定放M/evidence/<releaseId>/，永不写进被hash的发行树，避免
  self-reference和封存后变更；管理工具以后不写sealed树。生产缓存、日志
  与数据必须在DSH_HOME/显式数据目录，不在树内。
- **控制记录**：M/control.json，严格 schema，含 schemaVersion、deploymentId、
  revision、activationGeneration、active、lastGood、phase、transaction、
  hostIdentity、reason。revision每次control更新递增；activationGeneration
  仅active选择改变时递增，候选CAS比较后者与expectedActive，不比较自身
  building步骤写入已改变的全记录revision。
  所有时间戳为 epoch 毫秒，仅作诊断，不以“过期”解除安全状态。
- **hostIdentity**：PID＋创建时间＋确定发行路径＋启动 nonce。PID 单独不够。

production phase 为 idle/draining/starting/serving/blocked；事务阶段另为
accepted/building/validating/sealed/published/succeeded/failed/cancelled/
indeterminate；只有succeeded/failed/cancelled为终态，sealed是待发布状态。active/lastGood 为
releaseId＋精确版本＋清单摘要；active 指针不是 junction，不更改全局 npm shim。

## 核心不变量

- **INV-I** 受管宿主永不加载 building、validating、quarantine 或摘要检查
  失败的树。安装和修复永不写 active 或 lastGood 发行树。
- **INV-II** 宿主启动前，在同一部署控制互斥域内读取 active、检查许可、
  登记 hostIdentity 并完成受监督进程创建；发布也持同一互斥域。不得使用
  “检查一个文件后在互斥外 spawn”的分离步骤。
- **INV-III** 任一事务只允许一个构建写者组。不能证明候选写者已全部退出时
  不 seal、不 publish、不删除/重用候选目录；旧 active 可以继续服务。
- **INV-IV** 发布指针只指向 sealed 树。原子替换失败则保留原记录；记录
  损坏、缺失或读取结果未知则 blocked，不回退为默认版本、无 gate或无锁。
- **INV-V** 每轮发布后的首次生产启动最多一次；失败不得由外层 while 自动
  反复启动同一个发行版本。blocked 状态只能经外部受管恢复命令解除。
- **INV-VI** 升级、修复、版本回退走同一事务，无宿主内 `npm install -g`、
  无任意 shell 命令模板、无仅改变文案的 autoRestart 开关。
- **INV-VII** rollback 仅指发行版本选择，不证明生产数据兼容。没有数据
  兼容/恢复授权时生产启动失败进入 blocked，不自动用旧代码读已改变的数据。
  production激活前必须显式接受该精确版本的共享状态变更与恢复策略；不能
  从文件摘要或隔离fixture推导此授权。没有该授权只允许准备sealed候选。

这些保证限于受管操作、可信 registry、正常 OS 进程与文件 API 契约。
任意手动写 release 树、强行全局 npm、磁盘永久损坏、恶意 lifecycle script
逃逸不在管理器可强制控制的边界内；不得因此放行未验证树。权限/介质失败时
选择显式停机，而不是宣称必然自动回滚。

## 稳定启动与一次接入

首次接入顺序：

1. 用户停止原裸循环；保存启动参数与 DSH_HOME，不杀用户其他终端。
2. 离线部署管理工具到 M；钉定 node.exe 的物理路径及版本，不再使用
   nvm 可变别名执行候选；同时钉定物理 npm-cli.js 及 npm 版本，物理载体
   被外部删除时明确blocked，不fallback到PATH。更换 Node 是单独迁移，
   不混入 dsh 升级。
3. 将基线精确版本重新安装到新发行树，按同一验证路径得到 sealed 基线。
   不复制当前可能混装的全局树当作“已知好版本”。原全局树不修改。
4. 明确登记一个 production launch configuration；按首次接入授权准备
   数据/profile 恢复措施并检查受管 profile 的宿主依赖实际解析路径。
   实际解析到旧全局宿主或跨发行共享依赖时拒绝启用，不手工补 junction。
5. 原子创建初始 control.json；由稳定入口启动基线并完成生产就绪确认。

新的 PowerShell 调用形态（设计示例；脚本尚未实现，不应现在执行）：

```powershell
# 用实际管理根绝对路径替换示例，启动器自身负责持续监督。
& 'C:\DSH-managed\tools\launch.ps1' web --no-open
```

外层 while 可保留，但不是必要条件。启动器在 blocked 状态仍存活并等待恢复
命令，不马上返回制造紧循环；若自身崩溃，下次调用先读持久控制记录并按
故障恢复规则处理，不能凭等待时长自动解封。

不修改全局 dsh.ps1/dsh.cmd，不使用 PATH shadow/function 假装已完成接入。
原 `dsh web` 仍是非受管入口；同一生产 HOME 被其他入口使用时拒绝发布。
本期第二个 production 注册、多个 HOME 共用同管理根、不可判定的外部消费者
均拒绝，返回明确错误，不静默降级。工具提供进程/路径诊断；不承诺从任意
进程命令行可靠推断用户行为，独占 production HOME 是接入前提。

## 监督器与 Windows 原语契约

监督器在 PowerShell/独立管理工具进程中存活，不属于 dsh 宿主子树。宿主
通过既有维护 API 请求事务；host 半区仅桥接稳定工具，不负责启动独立 WMI
worker。不在本插件新增 Host/token 认证层；受管本机控制传输为管理根中
原子发布的请求记录，以 operationId 去重，监督器按固定 schema 消费，不执行
请求中任意命令。请求来自进程日志/配置的字符串始终视为数据。

- **唯一监督器**：`.NET System.Threading.Mutex`系统命名域以资源ID
  命名，覆盖同机器登录会话；存在活所有者时第二入口拒绝。持锁线程身份
  固定，control登记supervisor PID/creationTime/epoch；abandoned不等于
  进程死亡，新入口须先核验旧supervisor及named jobs全部退出。旧进程仍
  活或查询失败即blocked且不创建新child；旧控制线程死亡必须触发监督器
  整体fail-stop并关闭jobs，不能让其他工作线程继续执行事务。
  jobName和step/startIntent先持久记录；OpenJobObject未找到且对应旧owner
  确认已死，结合KILL_ON_JOB_CLOSE契约与创建时原子归属，才能判断该job
  不再有存活进程；access denied不是not found。目标环境G-1必须验证此
  组合前提，否则blocked。初始化失败禁止服务。
- **发布/启动控制互斥**：唯一监督器的串行控制队列为线性化点；跨进程读取
  或变更 active 的恢复工具必须取得同一 OS 控制 mutex，且不与 live监督器
  并行操作。构建异步执行，发布/登记/spawn 串行执行。
- **进程树**：安装、隔离验证、production host各使用独立命名Windows
  Job Object(名称含resourceId/operationId/startNonce)，KILL_ON_JOB_CLOSE，
  禁止breakaway，job handle不继承。使用CreateProcessW＋STARTUPINFOEXW
  的PROC_THREAD_ATTRIBUTE_JOB_LIST将子进程**在创建时原子加入job**，并
  CREATE_SUSPENDED；先持久startIntent，再create-with-job，再记录identity，
  最后resume。不得用先Create再Assign的两步序列：父在中间死时会遗留
  未登记且不受job约束的child。API不支持/分配失败即拒绝，不fallback。
  [Microsoft API文档](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
  列出JOB_LIST为Windows10/Server2016+能力；仍需G-1验证目标环境。
  监督器是唯一job handle持有者；恢复工具仅在获监督所有权后按记录打开
  named job核验/终止残留，不能在live监督器旁边持handle影响kill-on-close。
- **取消**：TerminateJobObject 后核验 active process count 为零；不能确认
  时事务 indeterminate，不启动另一写者。固定 grace 不替代此核验。
- **生产启动**：执行钉定 node.exe＋sealed 树内 bin.js 的绝对 realpath，
  传 argv 数组、已确认 cwd、production env；不使用 mutable junction 作入口，
  不加 preserve-symlinks/NODE_PATH 让依赖跨发行。宿主实际闭包越界拒绝交付。
- **信号与断电**：control 新记录在同目录临时文件完整写、flush、关闭，再
  以 Windows 原子文件替换 API 发布；Windows adapter 必须在隔离 NTFS 上
  实测已有文件替换、共享句柄、拒写与杀进程行为。不能用 unlink＋rename
  模拟原子。临时记录不是 active；commit outcome 未知时持锁重读对账。
  OS 不提供当前使用方式所需原子语义时禁用发布，不另加未经测试回退。

Job Object、全局 mutex 和原子替换是**实施适配器要求，尚未证明在目标环境
全部可用**。管理工具可携带固定依赖快照及原生适配器；不坚持单文件零依赖，
不把 lifecycle/native 构建需求转嫁成手写协议。需在实施前原语实验过门。

## 请求账本与启动意图

所有request的公共字段为schemaVersion、deploymentId、requestId(UUID)、
kind、payloadDigest；payloadDigest涵盖kind及全部语义字段。安装request
的requestId也是operationId，kind=install，其payload为targetExact、registry、
expectedActive、expectedActivationGeneration、prepareOnly。接受与发布时
都核对active/generation，A→B→A仍是stale，不能补读最新代际冒充原授权。
管理工具在M/requests原子发布<requestId>.json，不使用任意路径作为执行目标。
同ID异payload拒绝；同ID同payload返回已接受记录或完成账本。

监督器只允许一个非终态事务。接受请求必须先原子提交control.transaction
中的operationId/payloadDigest/候选ID/stage=accepted，再产生任何安装进程；
返回HTTP202只表示桥接记录已发布，accepted状态另以监督器记录确认为准。
完成时先提交operationId结果到M/results/<operationId>.json、核实耐久提交，
再把control事务stage标为succeeded/failed/cancelled并设terminal=true；其他
阶段terminal=false，terminal不是另一个stage。结果只读不删，未完成记录保留。
下一事务接受前
核对上次terminal/result一致；结果写失败不清理接受记录。crash恢复对accepted
非终态一律暂停对账，不自动重跑install；结果/请求损坏返回显式indeterminate。
本期不GC request/result/release目录，避免保留窗口带来的重放/reader问题。

控制请求永不以PID或时间戳作去重键。本期结果账本不GC，任何历史operationId
仍返回其确切终态；历史结果存在但请求原文缺失时核对持久payloadDigest，
不启动新事务。恢复读取损坏结果不默认新建。恢复工具在监督器存活时只可
发请求，不直接夺mutex或改control。

### 最小管理控制请求

kind=control不新建安装事务，因此不受“已有一个非终态安装”拒绝；同一
控制队列串行执行。payload含action、expectedRevision、expectedSupervisorEpoch、
targetOperationId(可null)、targetAttemptId(可null)及authorization。接受控制
请求先在control.managementIntent持久记录requestId/摘要/预期状态，再有
任何进程/启动副作用；完成结果使用同一永久results账本后清除intent。
崩溃后未知control intent不自动重放启动，保留blocked等待新授权请求。
新控制请求不得直接覆盖旧managementIntent：先核验旧intent关联的named
job与startIntent副作用，禁止未知启动重放；将旧request以status=failed、
reason=interrupted/indeterminate写入永久result并核实，再清旧intent，才接受
新requestId。这里是中断控制请求的终态，不表示未知进程已清除；生产许可
仍blocked，terminationUnknown保持。任一步结果写失败不接受新启动请求。
此时仅允许在独占控制域核验或终止旧intent指定jobs的无启动恢复步骤，
不create/reuse/spawn任何child、不改active；核验日志保留至能提交旧result。
新请求同ID仍返旧终态，只有不同ID且绑定新revision/epoch的显式授权能
发起新attempt。清intent与接新intent之间崩溃仍凭旧result去重，不丢历史。

最小action与确定转移：

| action | 输入/许可条件 | 状态转移 |
|--------|---------------|----------|
| terminate | targetOperationId/targetAttemptId指当前残留named jobs | 先保持blocked/indeterminate，终止并核验全部零，成功仅清terminationUnknown，不自动start、不把候选标sealed；失败保持未知 |
| cancel | targetOperationId等于当前非终态，候选job核验全部零；未知job只允许请求terminate，不允许标取消完成 | 写cancelled结果并结束该安装；不修改active，若production原先blocked仍blocked |
| activate | targetOperationId指sealed候选，精确目标共享状态/停机授权齐备，expectedActivationGeneration/expectedActive另在payload中核验 | 按既定draining→发布→一次startIntent执行；无需另一install |
| recover | payload选择active或保留old releaseId，数据compatibilityConfirmed或stateRestoreCompleted显式授权、摘要及当前production已退出证明；暂停安装先终止其job并写cancelled/failed终态，恢复指向树须seal通过 | blocked→先提交新的active代际(改变选择时递增)及starting/startIntent，允许一次启动；失败再次blocked |
| restart | serving当前受管host，当前operation无发布中步骤；请求用户正常重启与停机授权 | draining→核验退出→starting新attempt，active/generation不变；失败blocked |

authorization为管理CLI从用户显式确认生成的结构记录(type、exact目标版本、
releaseId、confirmedAt、报告digest)，不是host身份认证token。管理器仅据
schema和绑定目标执行，不能根据布尔默认值假定用户已授权；未来部署的数据
恢复执行属于授权范围内外部步骤，此工具不猜测备份/还原命令。没有确认则
拒绝action，状态不动。未知writer/production terminationUnknown任何action
都不能clear或resume；可以再次请求终止核验，成功后用户发新的recover。
同requestId冲突、预期revision/epoch变化或target不匹配均stale拒绝，无副作用。
管理record/results写失败时保留intent并停止进一步启动，不能只清安装事务。

每次production spawn前，控制队列持锁原子提交phase=starting与startIntent
{attemptId,releaseId,sealDigest,nonce,jobName,consumed:true}。该nonce永不
重新resume/spawn；create失败也消耗attempt。随后原子create-with-job suspended
child，再持久hostIdentity，核实后resume。监督器在任意两步之间死时，恢复
根据startIntent/namedJob结束或核验残留，并blocked；不假设PID记录存在才
可能有child。没有startIntent与control有效记录不得创建production child。
building/verifier同样先登记命名job与stepIntent，未知结果不得原candidate
重跑。独占mutex的持有与释放固定在同一OS线程，异步工作不得跨线程继承
Mutex ownership；串行队列回调归该线程处理control线性化。

## 构建、校验与封存

准备期原 active 可继续运行，因为 npm 只写独立候选。典型命令形态：

```text
<pinned npm> install --prefix <unique release prefix> --save-exact
  @deepseek-ai/dsh@<resolved exact version> --registry=<fixed registry>
```

实际执行使用钉定Node调npm CLI的参数数组，非shell拼串；候选在其最终
唯一绝对路径构建，seal后不搬目录。候选manifest、lock、cache/temp、npm
userconfig/globalconfig均独立，按allowlist构造env，不读取生产用户npm配置、
API凭据或旧NODE_PATH。安装exit=0是必要但非充分条件；JobObject与prefix
不是文件权限沙箱，可信registry与可信lifecycle是前提，不承诺任意恶意安装
脚本不能访问同用户文件。失败可创建另一个新候选重试一次，绝不在未知写者
尚在的目录叠加install；两次失败结束准备，旧宿主不受受管文件写入影响。

验证分层：

- **来源与版本**：root 等于钉定目标；依赖 lock、resolved tarball、SRI
  可验证；registry 请求超时/摘要失败终止候选。tarball 整体 integrity
  不被当作本地文件完整性证明。来源关联键为安装包realpath＋name/exact
  version＋tarball URL/SRI；生成物策略记录policyId/version/digest、受信
  文件集合、OS/arch/NodeABI/npm版本和构建输入。缺策略不能以true布尔
  标志代替批准。
- **实际依赖解析**：安装图验收与入口解析分开：成熟npm图工具＋semver
  检查完整runtime图(含第三方)，不要求所有包都export '.'，不强装devDeps。
  用引用方上下文检验关键import/require specifier及条件，不拿createRequire
  的require分支冒充ESM；检查required deps及非可选peers约束，optional
  peer缺失合法、已出现则校验；平台optional deps按安装决策记录处理。
  支持hoisting/嵌套/shared/同名多版本，realpath＋包身份去重防循环；
  宿主运行依赖不得逃到旧全局树。使用成熟semver，不维护手写range子集；
  exports阻止package.json subpath时从入口/安装inventory定位清单，不借机
  加载模块，也不要求asset-only/subpath-only包可作为通用模块import。
  模块探针输入明确为(importer真实文件,specifier,mode=require|import,
  pinnedNode,conditions,loaderFlags)，覆盖CLI/web-app启动的固定specifier、
  fixture/plugin声明探针；相对导入、#imports、自引用与exports子路径按
  对应模式解析，resolve不执行模块。报告持久保存探针边和观察到的运行边；
  未观察动态晚加载不能被宣称穷尽，源码包全量文件证据覆盖其bytes，后续
  运行越界/未知失败由稳定监督blocked收敛，不拿一次boot证明所有功能。
- **文件证据**：whole-candidate inventory覆盖prefix中全部文件、目录类型、
  size、强摘要、链接目标及必要mode，规范排序形成摘要；lock与生成物也在
  inventory，证据报告位于树外。拒绝跨发行symlink/junction/hardlink共享
  写面。对lock对应可信tarball安全解包，发行源文件逐项对照实际内容；
  禁止归档路径穿越与未定义外链，不拿少数入口hash替代完整集合。
  npm合法生成metadata/shim及原生生成物使用明确映射/策略，不要求它们
  与tarball原文必相同；未知生成物/源代码修改不得无条件exclude放行。
  需要原生生成物的包必须有按OS/arch/NodeABI描述的受信构建产物策略及
  加载探测；无法识别则拒绝，不猜测忽略。快照摘要检测后来变化，但不能
  证明首次取样之前完整，来源对照不可省，第三方包同样检查。
- **隔离启动**：先确认writers=0并生成候选暂存manifest，然后使用候选
  真实 bin.js＋隔离 DSH_HOME＋loopback 随机端口，以新造无密钥fixture
  profile进行验证；不读取、复制或链接真实profile/生产依赖副本。
  环境以allowlist构造，HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG/cache/
  temp/cwd及插件数据目录均指向隔离根；去掉NODE_PATH/NODE_OPTIONS与API
  凭据、provider、计划任务、外部MCP继承，LLM链路仅独立echo-upstream。
  项目fixture仅加载已声明隔离数据路径的插件；不支持隔离则拒绝该fixture。
  停止全部验证进程后逐项重对暂存manifest，任何新增/修改/删除不予seal。
  核查实际候选版本/实例nonce、宿主插件加载诊断、主页面渲染，不只测HTTP
  200。隔离profile通过不证明真实生产配置和数据库向后兼容。
  只借鉴compat的隔离构造/探针；不得直接执行现有run.mjs，它可能补装
  hostDir、杀占用端口、改仓库root依赖桥，并继承不完整隔离的环境。
  新验证runner只能操作本事务进程与隔离路径，不调用killPortOwner。
  实际env allowlist/路径映射/fixture版本摘要进报告；Windows变量名按
  不区分大小写归一，cwd与DSH_HOME的.env/patch仅新造，不能复制生产秘密。
- **封存**：验证进程及 npm writer job全部退出，重查文件/摘要，与参考
  报告一致；写 seal 记录，核实文件清单不再变化，只有此时可标 sealed。

seal 后管理器不得改树。每次启动前重查 seal/inventory 摘要；发现外部修改
进入 blocked。在威胁模型内依赖没有绕过管理协议的并发写者，不声称对拥有
同等用户写权限的任意恶意进程具有不可变性安全边界。

## 发布状态机

```text
request(target exact, operationId, expected activationGeneration/active)
→ building unique candidate（旧 active 服务）
→ writers=0 → validating → verifier jobs=0 → seal
→ 核对请求的 activationGeneration/active 未变化
→ 宿主活跃工作检查与用户“必需停机”确认
→ draining：持久禁止新启动，通知当前受管宿主退出
→ host job process count=0
→ 原子提交 control：active=candidate，lastGood=old，phase=starting
→ 按candidate realpath监督启动一次
→ production ready ACK → active通过，phase=serving，lastGood=candidate
```

request 重复只返回同一 operationId 状态，不创建第二候选。未取得 OS 控制
互斥或activationGeneration/expectedActive已变则不发布；candidate可保留
sealed供新事务显式复用。
停止旧宿主前失败只记录 failed，active 保持旧版。不得拿“旧版本仍在跑”
伪装为“升级成功”。用户未同意停机则候选保持 sealed，不先退出生产。

生产启动 ready标准与实际失败：

- startup deadline 从 spawn开始；必须收到同nonce、同PID/创建时间、同
  releaseId、正确服务地址的宿主健康信息，且加载诊断无启动失败。固定
  延时/孤立200不是ACK。缺少这一健康探测能力不发布。
- production startup失败：识别失败立即原子持久phase=blocked，撤销所有
  新启动许可，然后停止候选host job。无法证实退出则记录terminationUnknown，
  仍blocked且禁止恢复；确认退出后保留old lastGood及候选日志，不自动
  再次spawn候选。blocked提交结果未知时监督器停止处理启动并核验control，
  不以仍在serving的旧记录继续重拉。
- 默认不自动回退旧代码：新宿主可能已经写生产数据。恢复命令可选择旧版，
  但必须先明确确认数据兼容或恢复授权、确认无相关进程、重验旧seal；不
  满足则保持blocked。这里显式停机而非无限崩溃是根治目标的安全终态。
- 没有绕过验证的“force start”；修复命令创建同版新候选，走完整验证，
  不能直接信任损坏版本号。目标未知时用户显式选择registry精确版本。

正常 serving运行期间宿主异常退出也转blocked并保留诊断；只有已确认用户
正常重启动作才重拉已验证active一次。外层裸while不能覆盖管理器策略。

## 预算与错误收敛

| 环节 | 上界 | 到点行为 |
|------|------|----------|
| registry请求 | `20 * 1000` ms | 候选失败，旧版继续 |
| 单次npm | `10 * 60 * 1000` ms | 取消writer job；退出未知→quarantine，禁止seal |
| 隔离启动 | `150 * 1000` ms | 取消verifier job；不发布 |
| 排空旧宿主 | `30 * 1000` ms | 拒杀/无法证实退出→blocked，不提交版本指针 |
| job终止核验 | `5 * 1000` ms | 仍有进程/查询失败→indeterminate；不继续安装/发布 |
| production ready | `150 * 1000` ms | 停止新host并blocked；不得无限重试 |

不计算“总预算到期自动放行”。预算不覆盖OS暂停的健康推论；系统时钟
回拨/进程暂停只改变诊断时长，不改变许可条件。

## 故障恢复表

| 崩溃或错误点 | 下次稳定入口行为 |
|--------------|------------------|
| serving中监督器死亡 | Job关闭可能终止production；下轮无旧owner的serving记录不是启动许可，先持久blocked，核验namedJob与hostIdentity；必须显式恢复命令，不能当正常重启 |
| building/validating中监督器死亡 | OS job关闭应终止其树；恢复核验job/记录，未sealed候选隔离，旧active不改；production同样按serving-owner丢失规则blocked；无法核验仍blocked |
| draining中死亡 | production job关闭；恢复不凭TTL启动，重验active/进程及控制记录，明确恢复命令方可重拉 |
| 指针发布前异常 | 重读有效control与事务意图；确认revision仍旧才判未提交，不能先删屏障 |
| 指针提交后回执丢失 | 锁内重读revision/transaction归属，确认已提交后按记录处理，不重复publish |
| starting中死亡/未ACK | 不知道新宿主是否写过数据，blocked；保存old可恢复版本，不自动回退 |
| control或seal损坏/缺失 | blocked，打印管理根及恢复报告；不能从“目录看起来存在”推断active |
| 文件替换/flush/rename权限失败 | 原指针有效则保持原状态；提交结果未知则blocked；不unlink原文件重试 |
| active被手动改动 | 预启动摘要失败blocked，修复只创建新树 |

## BDD 验收场景

### 候选隔离与证据

- **B-1** Given旧宿主运行，When候选npm半程EBUSY，Then旧树逐文件摘要不变、
  旧实例继续服务，candidate不成为active。
- **B-2** Given失败目录有拒死writer，When重试，Then不复用目录、不seal该
  目录；无法核验进程隔离则整个事务indeterminate。
- **B-3** Given清单版本齐但关键JS截断/旧内容，When文件或启动校验，Then
  拒绝发布而非status=ok。
- **B-4** Givenhoisted/嵌套/shared/cycle依赖与optional peer缺失，When
  解析校验，Then遵循真实Node/npm语义，不误判健康树，不逃逸发行边界。
- **B-5** Given移动tag改变，When候选安装及verify，Then仍使用事务钉定
  精确版本与integrity。
- **B-6** Given候选启动只能使用旧全局宿主依赖，When隔离验证，Then拒绝
  发布，明确列出越界解析源。

### 原子控制、进程与恢复

- **A-1** Given双并发请求/双启动入口，Whenclaim与启动登记，Then一个
  owner、一个production child；另一请求复用/拒绝，不产生双npm写同树。
- **A-2** Givenreader在pointer提交期间持续读取，When替换或故障注入，
  Then每次只得到完整旧/新记录或明确blocked，没有missing默认放行。
- **A-3** Given任一launch和publish并发，Then同控制互斥域内线性化，
  启动实例取得确定版本并完成登记，绝不读一个版本却从可变入口加载另一个。
- **A-4** Givenwriter/verifier派生子孙，When监督器被杀，ThenJobObject
  终止全部后代；核验失败保持blocked/quarantine。
- **A-5** GivenJob分配/终止/查询被拒绝，Then不resume未分配的子进程，
  不把固定等待替代退出证明，不发布。
- **A-6** Given提交成功但响应丢失，ThenoperationId/revision核验识别
  同一提交，不清理别的owner，不重入执行安装。
- **A-7** Givennvmjunction别名、空格/单引号/非ASCII路径，Thenrealpath
  归一且argv数组正确；不通过多层shell插值传参。
- **A-8** Given控制/意图/seal每个写点中断或损坏，Then下轮blocked或
  有效旧记录；损坏不视为“没有事务”。

### 生产与用户行为

- **P-1** Given用户拒绝停机或activework非空，Then只构建候选、不停当前
  宿主、不发布。
- **P-2** Given候选preflight过但production startup失败，Then仅一次
  attempt、持久blocked、保留日志/old；外层while不造成crash loop。
- **P-3** Givenproduction曾写数据，When申请回退，Then必须显式兼容/
  恢复授权，不自动用旧代码读新数据。
- **P-4** Given修复同版，Then新候选及完整验证，永不活体覆盖原树。
- **P-5** Given第二HOME/第二production注册或未接入管理的启动方式，Then
  拒绝受管发布，告知一次接入前提，不声称裸循环自动受保护。
- **P-6** Givenblocked持续任意时长或重启管理器，Then时间不解除许可，
  必须恢复命令及验证才能启动。
- **P-7** Given启动前active摘要变化，Thenblocked；错误输出发生在宿主
  外，不依赖maintain成功apply。

## 必须完成的发布验收门

- **G-1 Windows原语**：同卷NTFS原子替换＋并发读者＋每个commit点杀进程/
  拒绝写入；全局mutex abandoned与双入口；job原子create-with-job suspended、
  父死亡、拒绝kill及后代存活核验。前轮junction PoC不覆盖本门。
- **G-2 来源与安装**：隔离prefix使用真实npm解析完整dsh发行依赖闭包，
  审计native/lifecycle生成物与来源对照；未定义产物策略不得上线。
- **G-3 DSH隔离**：按仓库compat方法，独立随机端口echo实例/DSH_HOME/
  插件配置投影，验证候选真实版本和就绪协议；不消耗真实LLM配额。
- **G-4 故障矩阵**：B/A/P所有场景包括production假host的首次启动失败、
  恢复和数据兼容授权分支，在临时目录完成；生产采用需另行授权。
- **G-5 管理工具**：固定发行工具及runtime依赖快照完整，host死后独立
  控制；无production配置写入测试残留，子进程全部终止并重复检查。

当前G-1至G-5均未完成。文档可审核架构与契约，不能用“已经review”替代这些
实际验证。某个适配器无法满足契约即阻断发布，返回重设计，不添加活体安装
或TTL自动启动的fallback。

## 与现有插件接口的变化

host升级/修复路由只提交request并返回operationId、阶段、active/pending
精确版本；currentStatus区分宿主running release和deployment active，不
把磁盘读包号当内存运行事实。前端按operationId恢复事务结果，失联后重查
稳定状态，保留pid/bootAt代际识别但改造旧upgradeWatch终态消费。

移除任意upgradeCommandTemplate与无作用autoRestart字段/开关，不保留旧
危险路径；明确停机确认。非Windows或未接入受管启动器时禁用自动升级/修复，
只提供版本检查与外部采用说明，不继续宿主内npm作为兼容路径。

不修改生产profile链接规约。将来实施需通过dev-link/官方profile管理方式
解决生产解析对齐，一次接入对生产的修改须另行授权；无法让profile解析到
选定发行闭包则G-3/接入失败，不手工发明第三种profile状态。

## 剩余技术风险与停止条件

此设计不依赖junction原子换向，但依赖尚未实测的Windows适配器与DSH独立
profile解析。出现以下任一证据立即停止实施并重设计：非原子状态发布1次；
未登记生产host 1个；sealed后管理器仍写发行树1次；writer核验不完整1次；
依赖越界1项；候选profile产生生产面写入1次。

可信上游软件仍可能有兼容性bug，验证也不能穷尽未来运行行为。该设计根治的
可检验范围是**管理升级不再混写运行树，未验证发布与启动失败不再触发无限
自动崩溃重启**；不是承诺任意外部破坏或上游错误永远自动自愈。
