// skeleton — rs-workflow 预设组合骨架单一源(JS 行形态)+ 规范化 yml 序列化器
// 消费方:注册形态(buildDefinition 的 plugins)直接用 skeletonRows;目录形态
// 仍读 preset/rs-workflow/agent.cordis.yml——该文件是 emitRows 的规范化产物,
// 由 test/skeleton.test.mjs 对拍防漂移,两形态共享同一骨架事实源。
// 基底是 standard 全功能编码代理行集,差异:persona 换流程模式纪律 v5;
// delegation 组含 rs-workflow-orchestrator/template-tool 行;无 report 行
// (trace 事件 + run-store 取代);plan-mode 组移除(规划在编排内)。
// 行形状闭集:id/name/disabled{__jsExpr}/group/isolate/config(对象或子行数组)。
// `!!js` 表达式在 JS 形态统一为 {__jsExpr: '表达式'},与 loader 解析语义一致。
export const TEMPLATE_ANCHOR = 'TPL_ANCHOR'

const JS_EXPR = (expr) => ({ __jsExpr: expr })

const ORCHESTRATOR_CONFIG = (templateId) => ({
  role: 'orchestrator',
  templateId,
})

export function skeletonRows(templateId) {
  if (typeof templateId !== 'string' || templateId.trim() === '') {
    throw new Error(`骨架 templateId 非法: ${JSON.stringify(templateId)}`)
  }
  return [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: PERSONA_PREFIX, suffix: 'Your working directory is {{cwd}}.' } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    // 不可禁本组合 shell/fs 工具行:workflow worker 的段子代理继承组合行集,禁行使
    // 段子代理无法落盘交付物(实测证实)。主循环不写文件由 persona 判据约束
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: JS_EXPR('process.platform === \'win32\'') },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: JS_EXPR('process.platform !== \'win32\'') },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    // 缺省连续唤醒预算 3 次且仅用户消息重置:纯自主编排每段 settle 耗 1 次,放宽到
    // 64 段覆盖 spec 建议的 3~12 步多实例流程上限
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs', config: { maxConsecutiveWakes: 64 } },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: false, searchTimeoutMs: 60000 } },
    // 编排子代理上下文较长,保留压缩组
    {
      id: 'compaction', name: 'cordis:group', group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
      ],
    },
    // workflowEngine 是预设私有服务(preset 组合发布全局服务会被宿主拒绝 mount),
    // 所有触达它的行共享一个 entry-local isolate realm;orchestrator 行模板 id 由
    // 组合名承载(rs-<id> → <id>),目录形态经 TPL_ANCHOR 锚定改写
    {
      id: 'delegation', name: 'cordis:group', group: true,
      isolate: { workflowEngine: true },
      config: [
        { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
        { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
        { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable' } },
        { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable' } },
        { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
        { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
        { id: 'tool-ralph', name: '@deepseek-ai/dsh-tool-ralph', config: { subagentProvider: 'spawn', maxRounds: 64 } },
        { id: 'rs-workflow-orchestrator', name: '@mzzsfy/dsh-rs-workflow', config: ORCHESTRATOR_CONFIG(templateId) },
        { id: 'rs-workflow-template-tool', name: '@mzzsfy/dsh-rs-workflow', config: { role: 'template-tool' } },
      ],
    },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  ]
}

const PERSONA_PREFIX = `你是"若水工作流"会话代理,由 {{model}} 模型驱动。你负责人机协作与编排调度;
任务交付由流程引擎接管下的子代理完成,你不直接产出交付物。
职责判据:
1. 纯会话内请求(问答、解释、讨论,不产生文件)→ 直接答复,不起编排;
2. 凡需新建或修改交付物文件(代码、页面、脚本、文档、配置,无论大小与步骤数,例如"写个贪吃蛇html")
   → 必须调用 rs_workflow_start,提交结构化规划(steps 各步要点与验收口径);禁止以"一句话能答、
   改动小"为由绕开编排自行产出文件;此通道无豁免:规划被拒按 errors 修正重交,不许改道自行完成;
3. 编排运行中你只被段结束通知或用户消息唤醒:任一唤醒轮先 rs_workflow_status 检查现役 run——
   status=running 且无活跃段 job(待拉起)或 status=paused 且 awaitingResume=true(页签已发恢复)
   时,即 rs_workflow_resume 补拉;waiting_approval 一律不补拉,轮到裁决:按模板 autoApprove 决定
   代审或 ask_user 转呈真人,裁决经 rs_workflow_verdict 回写(autoApprove 代审 by 缺省,转呈真人
   by=user,意见必填),裁决受理后 rs_workflow_resume 拉起下一段;
   终态则汇报(完成经 deliverables 交付,汇报必须引用 runId 供页签核验;失败/阻塞说明卡点与建议);
   任何交付说明若无对应 run 记录即为违规——禁止把自行产出的文件当交付物汇报;
   用户中途纠偏经 rs_workflow_message 注入,下一步骤边界进入编排;
4. 你不代替子代理执行编排内步骤,不伪造产出,不跳过引擎直接交付;
5. 引擎不可用或编排启动失败时,不得自行完成文件类请求——向用户说明故障与已尝试的调用,
   等待用户处置;文件交付只有 rs_workflow_ 通道,没有自行兜底。`

const ROW_KEYS = ['id', 'name', 'disabled', 'group', 'isolate', 'config']
// 裸标量白名单:内部冒号(: 后非空格,如 cordis:group)合法且为宿主 preset 惯例;
// '@' 起(保留字符)与含 ': '/尾冒号形态拒绝,BARE_RE 字符类不含 @ 且前置检查排除
const BARE_RE = /^[A-Za-z0-9_][A-Za-z0-9_: ./+(){}|=<>~^-]*$/

// 标量:数字/布尔直书;字符串裸安全(无 ': '、不以 ':' 收尾、字符类受控)则裸,
// 否则单引号(内部 ' 翻倍)
function scalarOf(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = String(value)
  if (!text.includes(': ') && !text.endsWith(':') && BARE_RE.test(text)) return text
  return `'${text.replace(/'/g, '\'\'')}'`
}

// 键值行:!!js 表达式 / 块标量(多行串)|- / 映射 / 子行序列 / 标量,五形态收口
function entryLines(key, value, indent) {
  const pad = ' '.repeat(indent)
  if (value !== null && typeof value === 'object' && value.__jsExpr !== undefined) {
    return [`${pad}${key}: !!js ${value.__jsExpr}`]
  }
  if (typeof value === 'string' && value.includes('\n')) {
    return [`${pad}${key}: |-`].concat(value.split('\n').map((line) => ' '.repeat(indent + 2) + line))
  }
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      return [`${pad}${key}:`].concat(value.flatMap((row) => renderRow(row, indent + 2)))
    }
    return [`${pad}${key}:`].concat(
      Object.entries(value).flatMap(([childKey, childValue]) => entryLines(childKey, childValue, indent + 2)),
    )
  }
  return [`${pad}${key}: ${scalarOf(value)}`]
}

function renderRow(row, indent) {
  const pad = ' '.repeat(indent)
  const rest = ROW_KEYS.slice(1)
    .filter((key) => row[key] !== undefined)
    .flatMap((key) => entryLines(key, row[key], indent + 2))
  return [`${pad}- id: ${scalarOf(row.id)}`].concat(rest)
}

// 规范化 yml 序列化:行集 → 确定性文本(尾随换行);与 preset/rs-workflow/
// agent.cordis.yml 正文逐字节对拍(test/skeleton.test.mjs)
export function emitRows(rows) {
  return rows.flatMap((row) => renderRow(row, 0)).join('\n') + '\n'
}
