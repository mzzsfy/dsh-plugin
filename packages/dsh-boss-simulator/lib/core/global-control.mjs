// 全局控制记录(数据与工具契约"停止操作的读写分离"):同 commandId 不重复提升代次;
// 新 commandId 的新停止意图撤销全部单项放行。
import { applyEnvelope } from './command.mjs'

export function createGlobalControl(now) {
  return {
    globalStopped: false,
    globalStopGeneration: 0,
    concurrencySnapshot: null,
    stopOperations: {},
    commandReceipts: {},
    now,
  }
}

// stop.all:重复同 commandId 不再次提升;新 commandId 提升代次并清 allowedGlobalGeneration 效果
// (单项放行记录在 Task 侧,此处仅提升代次使其失效)
export function stopAll(control, { commandId, payloadHash, sourceRef }) {
  const outcome = applyEnvelope(control, { commandId, payloadHash }, () => {
    const operationId = `stop-${commandId}`
    const generation = control.globalStopGeneration + 1
    const next = {
      ...control,
      globalStopped: true,
      globalStopGeneration: generation,
      stopOperations: {
        ...control.stopOperations,
        [operationId]: {
          operationId, commandId, scope: 'all', requestedAt: control.now(), sourceRef,
          generation, requestErrors: [], observed: null,
        },
      },
      commandReceipts: { ...control.commandReceipts, [commandId]: { payloadHash, result: { operationId, globalStopGeneration: generation } } },
    }
    return { state: next, result: { operationId, globalStopGeneration: generation } }
  })
  return outcome
}

// stop.resume:解除全局停止,恢复新任务与未单独暂停任务的派发许可。
// 停止代次只由停止操作推进,解除不新增代次;下次停止仍会以更高代次使旧单项放行失效。
export function resumeAll(control, { commandId, payloadHash, sourceRef }) {
  const outcome = applyEnvelope(control, { commandId, payloadHash }, () => {
    const operationId = `resume-${commandId}`
    const generation = control.globalStopGeneration
    const next = {
      ...control,
      globalStopped: false,
      globalStopGeneration: generation,
      stopOperations: {
        ...control.stopOperations,
        [operationId]: {
          operationId, commandId, scope: 'all', action: 'resume', requestedAt: control.now(), sourceRef,
          generation, requestErrors: [], observed: null,
        },
      },
      commandReceipts: { ...control.commandReceipts, [commandId]: { payloadHash, result: { operationId, globalStopGeneration: generation, globalStopped: false } } },
    }
    return { state: next, result: { operationId, globalStopGeneration: generation, globalStopped: false } }
  })
  return outcome
}

// 单任务放行登记(control 侧无状态,放行事实在 Task.control.allowedGlobalGeneration;
// 此处登记 stopOperations 便于查询 operation)
export function recordStopOperation(control, { commandId, taskId, payloadHash, sourceRef }) {
  return applyEnvelope(control, { commandId, payloadHash }, () => {
    const operationId = `stop-${commandId}`
    const result = { operationId }
    const next = {
      ...control,
      stopOperations: {
        ...control.stopOperations,
        [operationId]: {
          operationId, commandId, scope: 'task', task: taskId, requestedAt: control.now(), sourceRef,
          requestErrors: [], observed: null,
        },
      },
      commandReceipts: { ...control.commandReceipts, [commandId]: { payloadHash, result } },
    }
    return { state: next, result }
  })
}
