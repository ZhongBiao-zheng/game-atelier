<#
  game-atelier 本地安装脚本（Windows / PowerShell）

  作用：把本源码包里的 Skill 一键链接到你机器上已安装的 AI 代理（Claude Code / Codex）。
    - Claude Code：整插件链到 %USERPROFILE%\.claude\skills\game-atelier
                   （保留 /game-atelier:* 命令命名空间，git pull 后自动是最新版）
    - Codex      ：每个 Skill 链到 %USERPROFILE%\.codex\skills\game-atelier-<name>

  只在检测到对应代理（存在 .claude 或 .codex 目录）时才安装，没装的会明确提示跳过。

  Windows 链接策略：优先建符号链接（SymbolicLink，需开发者模式或管理员）；
  失败则回退到目录联接（Junction，普通权限即可，对目录最稳）。

  用法：
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall

  注：首次运行任意 /game-atelier:* 命令时，插件会自动在数据目录创建 .venv 并装依赖。
#>

param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$RepoRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginName = "game-atelier"
$Skills     = @("character", "promo", "turnaround", "viewer-server")

$ClaudeLink = Join-Path $HOME ".claude\skills\$PluginName"
$CodexDir   = Join-Path $HOME ".codex\skills"

function Test-OurLink([string]$Path) {
  if (-not (Test-Path $Path)) { return $false }
  $item = Get-Item $Path -Force
  return ($item.LinkType -in @("SymbolicLink", "Junction")) -and ($item.Target -like "$RepoRoot*")
}

function New-Link([string]$Source, [string]$Target) {
  if ((Test-Path $Target) -and -not (Test-OurLink $Target)) {
    Write-Host "  ! 目标已存在且不是本脚本的链接，跳过（避免覆盖）：$Target" -ForegroundColor Yellow
    return $false
  }
  if (Test-Path $Target) { Remove-Item $Target -Force -Recurse }
  try {
    New-Item -ItemType SymbolicLink -Path $Target -Target $Source -ErrorAction Stop | Out-Null
  } catch {
    # 无开发者模式/管理员 → 回退到 Junction（仅目录，普通权限可用）
    New-Item -ItemType Junction -Path $Target -Target $Source | Out-Null
  }
  return $true
}

if ($Uninstall) {
  Write-Host "=== 卸载 game-atelier 本地链接 ==="
  if (Test-OurLink $ClaudeLink) { Remove-Item $ClaudeLink -Force -Recurse; Write-Host "  - 移除 $ClaudeLink" }
  foreach ($s in $Skills) {
    $t = Join-Path $CodexDir "$PluginName-$s"
    if (Test-OurLink $t) { Remove-Item $t -Force -Recurse; Write-Host "  - 移除 $t" }
  }
  Write-Host "完成。"
  exit 0
}

Write-Host "=== game-atelier 本地安装（源码：$RepoRoot）==="
$installed = @()
$skipped   = @()

# --- Claude Code ---
if (Test-Path (Join-Path $HOME ".claude")) {
  New-Item -ItemType Directory -Force -Path (Split-Path $ClaudeLink) | Out-Null
  if (New-Link $RepoRoot $ClaudeLink) {
    $installed += "Claude Code  -> $ClaudeLink  (命令：/game-atelier:character 等)"
  }
} else {
  $skipped += "Claude Code（未检测到 ~\.claude）"
}

# --- Codex ---
if (Test-Path (Join-Path $HOME ".codex")) {
  New-Item -ItemType Directory -Force -Path $CodexDir | Out-Null
  $codexOk = $true
  foreach ($s in $Skills) {
    if (-not (New-Link (Join-Path $RepoRoot "skills\$s") (Join-Path $CodexDir "$PluginName-$s"))) { $codexOk = $false }
  }
  if ($codexOk) { $installed += "Codex        -> $CodexDir\$PluginName-{$($Skills -join ',')}" }
} else {
  $skipped += "Codex（未检测到 ~\.codex）"
}

Write-Host ""
Write-Host "=== 结果 ==="
if ($installed.Count -gt 0) {
  foreach ($i in $installed) { Write-Host "  + 已安装：$i" -ForegroundColor Green }
} else {
  Write-Host "  （没有检测到任何代理，未安装任何东西）"
}
foreach ($s in $skipped) { Write-Host "  - 跳过：$s" }
Write-Host ""
Write-Host "重启代理后生效。首次触发 /game-atelier:* 会自动初始化数据目录与依赖。"
