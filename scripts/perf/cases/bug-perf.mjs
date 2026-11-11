// 会话列表瘦身用例:宿主 session/list 返回全量会话投影,插件在返回前裁剪白名单键。
// 输入规模取真实会话目录数,覆盖裁剪与透传两条路径。
import { SCALE } from '../scale.mjs'
import { seededRandom } from '../lib.mjs'
import { slimItem, KEEP_PROJECTIONS } from '../../../packages/dsh-bug-perf/src/list-slim.mjs'

const SEED = 20261111
// 宿主列表投影的键面:白名单之外还有运行时状态、派生计数与权限位
const EXTRA_KEYS = [
  'runningState',
  'lastTurnAt',
  'createdAt',
  'updatedAt',
  'archived',
  'workspaceId',
  'parentSession',
  'delegationDepth',
  'origin',
  'messageCount',
  'toolCallCount',
  'workdir',
  'modelCatalog',
  'skills',
  'agents',
  'sandbox',
  'permissions',
  'approvals',
]

function buildItems() {
  const random = seededRandom(SEED)
  const items = []
  for (let index = 0; index < SCALE.sessions; index += 1) {
    const values = {}
    for (const key of KEEP_PROJECTIONS) values[key] = { index, weight: random() }
    for (const key of EXTRA_KEYS) values[key] = { index, weight: random(), text: `value-${index}-${key}` }
    items.push({ id: `session-${index}`, projections: { values, revision: index } })
  }
  return items
}

const items = buildItems()

export const cases = [
  {
    name: 'bug-perf/slimList-782',
    description: `整表裁剪 ${KEEP_PROJECTIONS.length} 个白名单键`,
    scale: `${items.length} 会话`,
    setup: () => items,
    run: (source) => source.map((item) => slimItem(item, KEEP_PROJECTIONS)),
  },
  {
    name: 'bug-perf/passthrough-782',
    judgeable: false,
    description: '对照组:不裁剪直接透传,给出裁剪的相对成本',
    scale: `${items.length} 会话`,
    setup: () => items,
    run: (source) => source.slice(),
  },
]

export default cases[0]
