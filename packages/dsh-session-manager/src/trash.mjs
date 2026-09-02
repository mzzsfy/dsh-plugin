// 回收站:跨平台把文件或目录移入系统回收站,不做直接删除降级。
// 执行器可注入以便测试;失败按原样抛出,由调用方按失败矩阵处理。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const TRASH_TIMEOUT_MS = 60 * 1000
const execFilep = promisify(execFile)

// 路径经 argv 传入 scriptblock param,避免拼接进脚本文本;
// 按目标为目录或文件分派 DeleteDirectory / DeleteFile;
// UIOption 枚举为 API 必需重载参数,在 -NonInteractive 宿主下无对话框,
// 失败经 catch 置非零退出码直达失败矩阵(powershell.exe 对终止错误默认退出 0)。
const WIN_SCRIPT =
  '& {param($p) Add-Type -AssemblyName Microsoft.VisualBasic; try { '
  + 'if ((Get-Item -LiteralPath $p).PSIsContainer) { '
  + "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } "
  + "else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } "
  + "exit 0 } catch { $_ | Out-String | Write-Error; exit 1 }}"

/** 按平台产出回收站命令;路径始终走最后一个参数,不进命令文本。 */
export function trashCommandFor(platform, path) {
  if (platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT, path] }
  }
  if (platform === 'darwin') {
    return {
      file: 'osascript',
      args: ['-e', 'on run argv', '-e', 'tell application "Finder" to delete POSIX file (item 1 of argv)', '-e', 'end run', path],
    }
  }
  return { file: 'gio', args: ['trash', path] }
}

/**
 * 把一个已存在的文件或目录移入系统回收站。
 * @param options.run - 注入的执行器,默认 promisify(execFile)
 */
export async function trashPath(path, options = {}) {
  const { platform = process.platform, run = execFilep, timeoutMs = TRASH_TIMEOUT_MS } = options
  const command = trashCommandFor(platform, path)
  await run(command.file, command.args, { timeout: timeoutMs })
}
