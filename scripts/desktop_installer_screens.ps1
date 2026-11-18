# Windows desktop CI: screenshots of every installer screen, for review without a Windows machine.
# `--preview <state>` renders one screen and acts on nothing; then one real windowed install
# (`--auto` clicks the main button) and a windowed uninstall. Leaves nothing installed.
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$Output
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$installer = (Resolve-Path $Installer).Path
$runtimeParent = Join-Path $env:LOCALAPPDATA 'game-atelier\runtime'
$product = (Get-Content (Join-Path $PSScriptRoot '..\desktop\package.json') -Raw | ConvertFrom-Json).productName

function Save-Screen([string]$Name) {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    [System.Drawing.Graphics]::FromImage($bitmap).CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save((Join-Path $Output "installer-$Name.png"))
    $bitmap.Dispose()
}

function Save-Preview([string]$State, [string]$Name = $State) {
    $process = Start-Process -FilePath $installer -ArgumentList '--preview', $State -PassThru
    Start-Sleep -Seconds 5
    Save-Screen $Name
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

function Wait-For([scriptblock]$Condition, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while (-not (& $Condition) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    return (& $Condition)
}

foreach ($state in 'welcome', 'custom', 'installing', 'done', 'update', 'running', 'error', 'confirm', 'uninstalling', 'uninstalled') {
    Save-Preview $state
}
# Light: the installer follows the theme the app last remembered.
New-Item -ItemType Directory -Force -Path $runtimeParent | Out-Null
Set-Content -Path (Join-Path $runtimeParent 'window-theme') -Value 'light' -NoNewline
Save-Preview 'welcome' 'welcome-light'
Save-Preview 'installing' 'installing-light'
Remove-Item -Recurse -Force $runtimeParent

# A real install through the window, then a real uninstall through the window.
$work = Join-Path ([System.IO.Path]::GetTempPath()) "atelier-gui-$PID"
$setup = Start-Process -FilePath $installer -ArgumentList '--auto', '--dir', "`"$work`"" -PassThru
Start-Sleep -Seconds 4
Save-Screen 'gui-installing'
$programs = [Environment]::GetFolderPath('Programs')
$installed = Wait-For { Test-Path (Join-Path $programs "$product.lnk") } 300
Start-Sleep -Seconds 3
Save-Screen 'gui-done'
Stop-Process -Id $setup.Id -Force -ErrorAction SilentlyContinue
if (-not $installed) { throw 'windowed install did not finish' }

Start-Process -FilePath (Join-Path $work 'uninstall.exe') -ArgumentList '--auto'
$removed = Wait-For { -not (Test-Path $work) } 120
Start-Sleep -Seconds 2
Save-Screen 'gui-uninstalled'
Get-Process | Where-Object { $_.Name -like 'atelier-uninstall-*' } | Stop-Process -Force -ErrorAction SilentlyContinue
if (-not $removed) { throw 'windowed uninstall left the install folder' }
if (Test-Path $runtimeParent) { throw 'windowed uninstall left the runtime root' }
Write-Output 'installer screens captured'
