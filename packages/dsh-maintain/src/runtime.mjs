// 运行环境检测:判定宿主进程是否处于托管启动形态,决定升级后可否自动重启。
// 纯函数,探测点经参数注入;顺序:env 显式覆盖 > 进程环境表 > POSIX 容器探测 > 双 TTY > unknown。
import { stat, readFile } from 'node:fs/promises'

export const RUNTIME_KINDS = Object.freeze({
  DECLARED_MANAGED: 'declared-managed',
  PM2: 'pm2',
  SYSTEMD: 'systemd',
  SUPERVISORD: 'supervisord',
  KUBERNETES: 'kubernetes',
  DOCKER: 'docker',
  CONTAINER: 'container',
  MANUAL_START: 'manual-start-likely',
  UNKNOWN: 'unknown',
})

// 环境覆盖键:managed|manual,测试与用户显式纠偏用
const RUNTIME_ENV_OVERRIDE = 'DSH_MAINTAIN_RUNTIME_ENV'
const OVERRIDE_MANAGED = 'managed'
const OVERRIDE_MANUAL = 'manual'

// 各托管形态的特征环境变量表:命中任一即声明
const MANAGED_ENV_KEYS = Object.freeze([
  [RUNTIME_KINDS.PM2, Object.freeze(['pm_id', 'PM2_HOME', 'pm_uptime'])],
  [RUNTIME_KINDS.SYSTEMD, Object.freeze(['INVOCATION_ID', 'JOURNAL_STREAM', 'NOTIFY_SOCKET'])],
  [RUNTIME_KINDS.SUPERVISORD, Object.freeze(['SUPERVISOR_ENABLED', 'SUPERVISOR_PROCESS_NAME'])],
  [RUNTIME_KINDS.KUBERNETES, Object.freeze(['KUBERNETES_SERVICE_HOST'])],
])

const DOCKERENV_PATH = '/.dockerenv'
const CGROUP_PATH = '/proc/1/cgroup'
// cgroup 归类:/docker/ 与 dockerenv 同为 docker;kubepods 即 k8s;其余容器运行时归 container
const CGROUP_DOCKER_PATTERN = /\/docker\//
const CGROUP_K8S_PATTERN = /kubepods/
const CGROUP_CONTAINER_PATTERN = /containerd|lxc|podman/

const fallbackExists = async (path) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const fallbackRead = async (path) => readFile(path, 'utf8')

export async function detectRuntimeEnv({ env, platform, isTTY, existsImpl = fallbackExists, readFileImpl = fallbackRead }) {
  const override = env[RUNTIME_ENV_OVERRIDE]
  if (override === OVERRIDE_MANAGED) return { kind: RUNTIME_KINDS.DECLARED_MANAGED, declared: true }
  if (override === OVERRIDE_MANUAL) return { kind: RUNTIME_KINDS.MANUAL_START, declared: false }

  for (const [kind, keys] of MANAGED_ENV_KEYS) {
    if (keys.some((key) => env[key])) return { kind, declared: true }
  }

  if (platform !== 'win32') {
    try {
      if (await existsImpl(DOCKERENV_PATH)) return { kind: RUNTIME_KINDS.DOCKER, declared: true }
      const cgroup = await readFileImpl(CGROUP_PATH)
      if (CGROUP_DOCKER_PATTERN.test(cgroup)) return { kind: RUNTIME_KINDS.DOCKER, declared: true }
      if (CGROUP_K8S_PATTERN.test(cgroup)) return { kind: RUNTIME_KINDS.KUBERNETES, declared: true }
      if (CGROUP_CONTAINER_PATTERN.test(cgroup)) return { kind: RUNTIME_KINDS.CONTAINER, declared: true }
    } catch { /* 探测失败按未声明继续 */ }
  }

  if (isTTY.stdin === true && isTTY.stdout === true) return { kind: RUNTIME_KINDS.MANUAL_START, declared: false }
  return { kind: RUNTIME_KINDS.UNKNOWN, declared: false }
}
