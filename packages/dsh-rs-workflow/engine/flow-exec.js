// 单批次执行器脚本:宿主 workflowEngine 裸 vm body,globals 仅 agent/parallel/pipeline/phase/log/args,无模块语法
const BATCH_PHASE = '若水批次'
const NULL_OUTPUT_ERROR = '子代理未提交结构化产出'

const errorText = (error) => String((error && error.message) || error)
const settle = (callId, outputs) => outputs === null
  ? { callId, ok: false, error: NULL_OUTPUT_ERROR }
  : { callId, ok: true, outputs }

const { calls } = args
// v5 引擎 parallel 契约:零参 thunk 数组(每个 thunk 失败→null),不再是 promise 数组;
// agent() options 键存在则值必须是 JSON(undefined 不行),缺省键须整键省略
const dispatches = calls.map((call) => () => agent(call.prompt, {
  label: call.label,
  phase: BATCH_PHASE,
  ...call.schema !== undefined ? { schema: call.schema } : {},
  ...call.provider !== undefined ? { provider: call.provider } : {},
  ...call.model !== undefined ? { model: call.model } : {},
}).then((outputs) => settle(call.callId, outputs))
  .catch((error) => ({ callId: call.callId, ok: false, error: errorText(error) })))

const results = await parallel(dispatches)
return { results }
