import { spawnSync } from 'node:child_process'

export const SIMULATOR_COMMAND_PATTERN = 'scripts[\\\\/]echo-upstream[\\\\/]cli\\.mjs'
export const isEchoSimulatorCommandLine = (commandLine) => new RegExp(SIMULATOR_COMMAND_PATTERN, 'i').test(commandLine ?? '')

export function reportSimulatorCleanupFailure(result, writeLog) {
  if (!result.error && result.status === 0) return
  const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`
  writeLog(`keep-stop: 模拟器清理失败: ${detail}`)
}

export function killSimulators(spawn = spawnSync) {
  const result = spawn('powershell', [
    '-NoProfile', '-Command',
    `Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match '${SIMULATOR_COMMAND_PATTERN}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }`,
  ], { encoding: 'utf8', windowsHide: true })
  return result
}
