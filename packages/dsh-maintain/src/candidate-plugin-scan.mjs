import { parentPort, workerData } from 'node:worker_threads'
import { loadHostCompatibilityApi, scanProfilePlugins } from './plugin-compat.mjs'

const { candidateSlot, plugins, ...options } = workerData
parentPort.postMessage(await scanProfilePlugins({
  ...options,
  strict: true,
  pluginManager: { listBundles: () => plugins },
  loadEvaluator: (anchor) => loadHostCompatibilityApi(anchor, candidateSlot),
}))
