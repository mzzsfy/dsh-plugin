// 单批次执行器脚本:宿主 workflowEngine 裸 vm body,globals 仅 agent/parallel/pipeline/phase/log/args,无模块语法
const BATCH_PHASE = '若水批次'
const NULL_OUTPUT_ERROR = '子代理未提交结构化产出'

const errorText = (error) => String((error && error.message) || error)
const settle = (callId, outputs) => outputs === null
  ? { callId, ok: false, error: NULL_OUTPUT_ERROR }
  : { callId, ok: true, outputs }

const { calls } = args
const dispatches = calls.map((call) => agent(call.prompt, {
  label: call.label,
  phase: BATCH_PHASE,
  schema: call.schema,
  provider: call.provider,
  model: call.model,
}).then((outputs) => settle(call.callId, outputs))
  .catch((error) => ({ callId: call.callId, ok: false, error: errorText(error) })))

const results = await parallel(dispatches)
return { results }
