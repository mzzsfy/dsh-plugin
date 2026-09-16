// orchestrator — 主循环工具行:rs_workflow_start/status/resume/cancel/message 五件套
// 编排以分段 continuable job 推进:每段 = jobs.start 包装 driver.runSegment,settle 负载经 tool-jobs
// 完成通知唤醒主循环;推进责任唯一在 rs_workflow_resume(页签 control 仅清 paused/裁决)
import { defineTool } from '@deepseek-ai/dsh-tools'
import { gate } from './planner-gate.mjs'
import { validateTemplate } from './template.mjs'
import { startRun, buildSeed } from './driver/index.mjs'
import { registry, registerInitiator, unregisterInitiator } from './driver/control.mjs'
import { reportStore } from './store.mjs'
import { loadJson } from './storage.mjs'
import { normalizeConfig } from './settings-schema.mjs'

const MAX_REJECTS = 3
const SEGMENT_KIND = 'rsww-segment'
const SETTLE_OUTPUT_LIMIT = 64 * 1024

// 已启用模板表(自有存储 → {entry, parsed};gate/驱动共用此形态)
export function enabledTemplates() {
  const out = []
  for (const entry of loadJson('templates.json', [])) {
    if (entry.enabled === false || typeof entry.json !== 'string') continue
    try {
      const parsed = JSON.parse(entry.json)
      if (validateTemplate(parsed).length === 0) out.push({ entry, parsed })
    } catch { /* 损坏模板不进候选 */ }
  }
  return out
}

/** 模式行激活入口(config: { role:'orchestrator', templateId });宿主服务缺一目工具即报错 */
export function registerOrchestrator(ctx, config) {
  const expectedTemplateId = config.templateId
  // 连续拒单计数与现役 run:行实例内存态,进程重启清零
  const rejectCounts = new Map()
  const activeRuns = new Map()

  const registered = ctx.inject(['tools', 'workflowEngine', 'jobs'], (tctx) => {
    const engine = tctx.workflowEngine
    const jobs = tctx.jobs

    const configOf = () => normalizeConfig(loadJson('config.json', undefined))

    const agentIdOf = (agent) => String(agent?.id ?? '')

    // 会话现役 run:同会话同一时刻至多一个未终态 run
    const currentRunId = (agent) => {
      const runId = activeRuns.get(agentIdOf(agent))
      if (runId === undefined) return undefined
      const record = reportStore().get(runId)
      if (record === undefined || record.finishedAt !== undefined) {
        activeRuns.delete(agentIdOf(agent))
        return undefined
      }
      return runId
    }

    // 段 job:jobs.start 包装 runSegment;settle 负载进 output,经 tool-jobs 完成通知唤醒主循环
    function startSegmentJob(agent, driver) {
      const promise = driver.runSegment()
      return jobs.start({
        kind: SEGMENT_KIND,
        label: `若水编排段推进 ${driver.runId}`,
        outputLimitBytes: SETTLE_OUTPUT_LIMIT,
        owner: agent,
        run: () => ({
          cancel: () => driver.cancel(),
          done: promise.then((payload) => ({ status: 'completed', output: JSON.stringify(payload) })),
        }),
      })
    }

    // 断点续跑挂靠:board resume-from 经此回调在原会话重建种子 run(engine/parent 闭包自本域)
    function startSeedRun(agent, record, fromStepId, inputs) {
      const templates = enabledTemplates()
      const template = templates.find((t) => t.entry.id === record.templateId)
      if (template === undefined) return { ok: false, error: `模板不存在或已禁用: ${record.templateId}` }
      const seed = buildSeed(record, record.plan, fromStepId, inputs)
      const driver = startRun({
        template: template.parsed, templateSet: templates.map((t) => t.parsed),
        plan: record.plan, warnings: record.warnings ?? [],
        request: record.request, inputs: seed.inputs, state: seed,
        sessionId: agentIdOf(agent), workspace: agent.session?.header?.cwd ?? process.cwd(),
        engine, slots: configOf().slots ?? {}, budgets: configOf().budgets ?? {},
        parent: agent,
      })
      return { ok: true, runId: driver.runId }
    }

    function finishRun(agent, runId) {
      if (currentRunId(agent) === runId) activeRuns.delete(agentIdOf(agent))
    }

    const tools = [
      defineTool({
        name: 'rs_workflow_start',
        description: [
          '启动若水工作流编排:提交用户请求原文与结构化规划,受理后引擎分段推进。',
          '受理返回 { ok, runId, status };规划被拒返回 { ok:false, errors }(按 errors 修正重交;连续 3 次被拒须回退直接答复并说明)。',
          'templateId 必须等于本组合锚定的模板 id;plan 缺省 = 保底全序(不推荐,多步骤任务应提交 steps/brief)。',
        ].join(''),
        parameters: {
          request: { type: 'string', required: true, description: '用户请求原文(逐字,不转写)' },
          templateId: { type: 'string', required: true, description: '本组合锚定的模板 id' },
          inputs: { type: 'object', additionalProperties: true, description: '模板顶层 inputs 的键值,值必须为字符串' },
          plan: {
            type: 'object',
            additionalProperties: true,
            description: '结构化规划 { steps: [{ref, note?, done?}], brief? }:steps 各步要点(note)与验收口径(done);缺省 = 保底全序',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              runId: { type: 'string' },
              status: { type: 'string' },
              errors: { type: 'array', items: { type: 'object', additionalProperties: true } },
              hint: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          const agent = exec.agent
          // 工具参数扁平:gate 入参 = 顶层三字段 + plan(steps/brief)组装(见 feat/orchestrator.md)
          const gatePlan = {
            request: args.request, templateId: args.templateId, inputs: args.inputs,
            brief: args.plan?.brief, steps: args.plan?.steps,
          }
          const rejects = (id) => {
            const next = (rejectCounts.get(id) ?? 0) + 1
            rejectCounts.set(id, next)
            return next
          }
          const rejected = (errors) => {
            const count = rejects(agentIdOf(agent))
            if (count >= MAX_REJECTS) return { ok: false, errors, hint: `已连续 ${MAX_REJECTS} 次规划被拒,本会话编排入口关闭:回退直接答复并向用户说明` }
            return { ok: false, errors, hint: '修正 plan 后重新调用;连续 3 次失败将回退直接答复' }
          }
          // 连续拒单达上限:本会话工具恒失败
          if ((rejectCounts.get(agentIdOf(agent)) ?? 0) >= MAX_REJECTS) {
            return { ok: false, errors: [], hint: `已连续 ${MAX_REJECTS} 次规划被拒,本会话编排入口关闭:回退直接答复并向用户说明` }
          }
          if (currentRunId(agent) !== undefined) {
            return { ok: false, errors: [], hint: `本会话已有进行中的编排 ${currentRunId(agent)},先等待终态或取消` }
          }
          const templates = enabledTemplates()
          const template = templates.find((t) => t.entry.id === args.templateId)
          if (template === undefined) {
            // 组合/环境错误而非规划错误:不计连续拒单,hint 指向组合而非 plan
            return { ok: false, errors: [{ target: 'templateId', message: `模板不存在或未启用: ${args.templateId}` }], hint: '本组合未启用该模板:检查组合锚定与模板启用状态,勿修改 plan' }
          }
          const outcome = gate(gatePlan, template, { expectedTemplateId })
          if (!outcome.ok) return rejected(outcome.errors)
          const driver = startRun({
            template: template.parsed, templateSet: templates.map((t) => t.parsed),
            plan: outcome.planScript, warnings: outcome.warnings ?? [],
            request: args.request, inputs: args.inputs ?? {},
            engine, slots: configOf().slots ?? {}, budgets: configOf().budgets ?? {},
            // 会话工作区取自会话 header(子代理继承同源);宿主 cwd 仅兜底
            sessionId: agentIdOf(agent), workspace: agent.session?.header?.cwd ?? process.cwd(),
            parent: agent,
          })
          rejectCounts.delete(agentIdOf(agent))
          activeRuns.set(agentIdOf(agent), driver.runId)
          // 断点续跑挂靠:本会话 agent 成为推进器,board resume-from 据此重建种子 run
          registerInitiator(agentIdOf(agent), (record, fromStepId, inputs) => startSeedRun(agent, record, fromStepId, inputs))
          startSegmentJob(agent, driver)
          return { ok: true, runId: driver.runId, status: driver.state.status }
        },
      }),
      defineTool({
        name: 'rs_workflow_status',
        description: '查询若水编排状态:runId 缺省 = 本会话现役 run。返回 status/awaitingResume(补拉判定信号)/steps 账目/waiting 待裁决摘要。',
        parameters: {
          runId: { type: 'string', description: '缺省 = 本会话现役 run' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          const store = reportStore()
          const runId = typeof args.runId === 'string' && args.runId !== '' ? args.runId : currentRunId(exec.agent)
          if (runId === undefined) return { ok: false, error: '本会话无现役 run(编排未启动)' }
          const record = store.get(runId)
          if (record === undefined) return { ok: false, error: '运行记录不存在:' + runId }
          const driver = registry.drivers.get(runId)
          const steps = {}
          for (const [id, s] of Object.entries(record.state?.steps ?? {})) {
            steps[id] = { status: s.status, failCount: s.failCount ?? 0 }
          }
          const waiting = []
          if (record.status === 'waiting_approval') {
            const stepId = record.state?.waitingApproval
            const planStep = (record.plan?.steps ?? []).find((p) => p.ref === stepId)
            waiting.push({ stepId, note: planStep?.note ?? '', done: planStep?.done ?? '' })
          }
          return {
            ok: true, runId, status: record.status,
            awaitingResume: record.status === 'paused' && driver?.awaitingResume === true,
            steps,
            // 宿主校验工具输出须为纯 JSON:undefined 值键会被判无效输出
            ...(waiting.length > 0 ? { waiting } : {}),
            summary: record.summary ?? '',
          }
        },
      }),
      defineTool({
        name: 'rs_workflow_resume',
        description: [
          '拉起若水编排下一段(推进责任唯一在此):paused 拉起时同步置 running;已推进/终态返回 skipped。',
          '裁决回写后、页签恢复后、running 无活跃段(待拉起)时调用。',
        ].join(''),
        parameters: {
          runId: { type: 'string', required: true, description: '要推进的 run' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          const store = reportStore()
          const record = store.get(args.runId)
          if (record === undefined) return { ok: false, error: '运行记录不存在:' + args.runId }
          if (record.finishedAt !== undefined) {
            finishRun(exec.agent, args.runId)
            return { ok: true, runId: args.runId, status: record.status, summary: record.summary }
          }
          const driver = registry.drivers.get(args.runId)
          if (driver === undefined) {
            return { ok: false, error: '编排驱动器未注册(进程重启后 run 已收敛为终态,请 rs_workflow_status 确认)' }
          }
          // 页签已推进(有活跃段):不重复拉起
          if (driver.active) return { ok: true, runId: args.runId, status: record.status, skipped: true }
          if (record.status === 'paused') {
            driver.state.status = 'running'
            driver.awaitingResume = false
            driver.persistState()
          }
          if (record.status === 'waiting_approval') {
            return { ok: true, runId: args.runId, status: record.status, skipped: true, hint: '先裁决(control approve/reject 或经会话页签),再 resume 拉起下一段' }
          }
          startSegmentJob(exec.agent, driver)
          registerInitiator(agentIdOf(exec.agent), (record2, fromStepId, inputs) => startSeedRun(exec.agent, record2, fromStepId, inputs))
          return { ok: true, runId: args.runId, status: record.status }
        },
      }),
      defineTool({
        name: 'rs_workflow_cancel',
        description: '取消若水编排(幂等):running 有活跃段则 abort 收敛;waiting_approval/paused 即时终态;已终态返回摘要无副作用。',
        parameters: {
          runId: { type: 'string', required: true, description: '要取消的 run' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          const store = reportStore()
          const record = store.get(args.runId)
          if (record === undefined) return { ok: false, error: '运行记录不存在:' + args.runId }
          if (record.finishedAt !== undefined) {
            finishRun(exec.agent, args.runId)
            return { ok: true, runId: args.runId, status: record.status, summary: record.summary }
          }
          const driver = registry.drivers.get(args.runId)
          if (driver === undefined) return { ok: false, error: '编排驱动器未注册' }
          driver.cancel()
          const hint = '已完成步骤保留,可在会话页签断点续跑'
          if (driver.active) {
            await driver.runSegment().catch(() => {})
            const after = store.get(args.runId)
            finishRun(exec.agent, args.runId)
            return { ok: true, runId: args.runId, status: after?.status ?? 'cancelled', summary: after?.summary ?? '', hint }
          }
          const after = store.get(args.runId)
          finishRun(exec.agent, args.runId)
          return { ok: true, runId: args.runId, status: after?.status ?? 'cancelled', hint }
        },
      }),
      defineTool({
        name: 'rs_workflow_message',
        description: '向进行中的若水编排转达用户纠偏:下一步骤边界进入编排(纠偏类经主循环转译后 inject 注入后续指令)。',
        parameters: {
          runId: { type: 'string', required: true, description: '目标 run' },
          text: { type: 'string', required: true, description: '用户纠偏内容(转译后)' },
          inject: { type: 'boolean', description: 'true = 注入后续指令;缺省 false 排队' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args) {
          const driver = registry.drivers.get(args.runId)
          if (driver === undefined) return { ok: false, error: '编排驱动器未注册(run 未终态但不在内存,或已终态)' }
          const accepted = driver.handlePost({ kind: 'message', text: args.text, inject: args.inject === true })
          return accepted ? { ok: true } : { ok: false, error: 'run 已终态,消息不予受理' }
        },
      }),
    ]
    for (const tool of tools) tctx.effect(() => tctx.tools.register(tool), 'rs-workflow orchestrator: ' + tool.name)
  })
  return { rejectCounts, activeRuns }
}
