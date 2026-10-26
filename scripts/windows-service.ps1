param(
  [ValidateSet('install', 'uninstall', 'status', 'run')][string]$Command = 'status',
  [string]$Python,
  [string]$DataRoot
)
$ErrorActionPreference = 'Stop'
$TaskName = 'GameAtelier'
$AppRoot = Split-Path -Parent $PSScriptRoot

if ($Command -eq 'status') {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) { @{ state = 'not_installed' } | ConvertTo-Json -Compress }
  else {
    $state = if ($task.Principal.LogonType -eq 'Password') { 'installed' } else { 'needs_credentials' }
    @{ state = $state; running = ($task.State -eq 'Running') } | ConvertTo-Json -Compress
  }
  exit 0
}
if ($Command -eq 'run') {
  if (-not $Python -or -not $DataRoot) { throw 'Missing registered runtime' }
  $env:GAME_ATELIER_DATA_ROOT = $DataRoot
  $env:PYTHONPATH = Join-Path $AppRoot 'src'
  $env:GAME_ATELIER_NO_UPDATE_CHECK = '1'
  $env:PYTHONUTF8 = '1'
  Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue
  Remove-Item Env:UV_PROJECT_ENVIRONMENT -ErrorAction SilentlyContinue
  & $Python (Join-Path $AppRoot 'src\viewer_server\server.py') start --no-browser
  exit $LASTEXITCODE
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '请在以管理员身份打开的 PowerShell 中运行此命令。'
}
if ($Command -eq 'uninstall') {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    Stop-ScheduledTask -TaskName $TaskName
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Write-Host '常驻任务已移除；仍可手动启动。'
  exit 0
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  throw '任务已存在。修改凭据请打开任务属性；更换安装路径请先 uninstall 再 install。'
}
$env:GAME_ATELIER_NO_UPDATE_CHECK = '1'
$bundlePython = Join-Path (Split-Path -Parent $AppRoot) 'python\python.exe'
$boot = Join-Path $PSScriptRoot 'bootstrap.py'
if (Test-Path $bundlePython) {
  # 最终模式由 bootstrap 根据正在运行的解释器路径判断。
  $raw = & $bundlePython $boot --check
} else {
  $uv = Get-Command uv -ErrorAction SilentlyContinue
  if ($null -eq $uv) { throw '请先运行一次启动器，准备 Python 运行环境。' }
  $raw = & $uv.Source run --no-project python $boot --check
}
if ($LASTEXITCODE -ne 0) { throw '无法读取运行环境，请先运行一次启动器。' }
$runtime = ($raw -join "`n") | ConvertFrom-Json
if ($runtime.status -notin @('ready', 'needs_first_key')) {
  throw '运行环境尚未就绪，请先运行一次启动器。'
}
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" run -Python "{1}" -DataRoot "{2}"' -f $PSCommandPath, $runtime.venv_python, $runtime.data_root
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $AppRoot
$bootTrigger = New-ScheduledTaskTrigger -AtStartup
# 无 RepetitionDuration 表示永久重复；IgnoreNew 防止启动第二个服务进程。
$watchTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($bootTrigger, $watchTrigger) -Settings $settings -Principal $taskPrincipal -Description 'Game Atelier 本机服务与局域网中转。请在任务属性中保存未登录运行的凭据。' | Out-Null
Write-Host '任务已创建，尚需完成凭据设置：任务计划程序库 → GameAtelier → 属性 → 不管用户是否登录都要运行 → 确定。密码仅在系统弹窗输入。'
Write-Host '完成后运行 status 确认 installed，再右键任务选择运行。'
Start-Process taskschd.msc
$answer = Read-Host '是否将接通电源时睡眠设为从不？[y/N]'
if ($answer -eq 'Y') { & powercfg /change standby-timeout-ac 0 }
