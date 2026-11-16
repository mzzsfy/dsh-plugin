// 隔离宿主环境:清除一切可能指向生产/真实凭据的变量,只保留系统运行必需项,
// 再由调用方显式注入本工位数据目录与 ECHO_KEY。
// DSH_* 包含 DSH_HOME/DSH_INSTALL_DIR/DSH_PROFILE_DIR/各包 DATA_DIR;STOCK_* 与
// ECHO_* 同理;NODE_OPTIONS/NODE_PATH 会把测试进程带回外部注入的模块解析面。
const SENSITIVE_ENV = /^(DSH_|STOCK_|ECHO_|NODE_OPTIONS$|NODE_PATH$)/i

export function compatEnv(extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SENSITIVE_ENV.test(key)) continue
    env[key] = value
  }
  return { ...env, ...extra }
}
