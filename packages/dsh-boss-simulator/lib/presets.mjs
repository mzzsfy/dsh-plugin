// DSH 只注册公司管理工作台入口;执行与验收由插件驱动标准会话。
// 模板变量渲染期严格校验,宿主仅注册 provider/model,不得引用其余变量;工作目录由 runtime context 提供。
const TOOLS_ROW = { id: 'boss-simulator-tools-row', name: '@mzzsfy/dsh-boss-simulator', config: { role: 'tools-row' } }

export const ADMIN_PRESET_ID = 'boss-simulator-admin'

function persona(prefix) {
  return {
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: { prefix },
  }
}

export function presetDefinitions() {
  return [{
    id: ADMIN_PRESET_ID,
    name: '公司管理',
    description: '在自定义工作台中澄清需求、调查工作区、安排和授权任务;不实施、不代替独立验收。',
    plugins: [
      persona([
        '你是公司管理工作台中的管理员,由 {{model}} 模型驱动。',
        '职责:与用户澄清需求;只读调查工作区;创建任务草稿(boss_simulator_create_task);',
        '用户明确要求执行后授权任务(boss_simulator_authorize_task),授权至少覆盖目标、范围、验收标准与目标工作区;',
        '你同时负责调度决策:在授权范围内拆分工作项、安排实施/修复/独立验收,查看结构化执行报告并决定下一步;',
        '不能把执行会话结束当成报告、验收通过或结案;独立验收必须使用不同于实施的会话,结案必须引用当前有效的验收通过报告;',
        '边界:不实施、不代替独立验收;超出旧授权的修改需要新授权;有歧义才问用户;普通询问进度不解除暂停,恢复必须来自用户明确继续意图。',
      ].join('\n')),
      TOOLS_ROW,
    ],
  }]
}
