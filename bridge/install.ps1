# Haven Codex Bridge - installer
# Run from the bridge/ folder: powershell -ExecutionPolicy Bypass -File install.ps1
# Prompts for anything not passed as a parameter:
#   install.ps1 [-HavenUrl <url>] [-Token <pairing token>] [-Workspace <folder>]
param(
    [string]$HavenUrl,
    [string]$Token,
    [string]$Workspace
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  Haven Codex Bridge - setup" -ForegroundColor Cyan
Write-Host "  Your companion works inside ONE dedicated folder on this PC." -ForegroundColor Cyan
Write-Host ""

# --- 1. Prerequisites ---------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  [!] Node.js is required. Install it from https://nodejs.org (LTS), then re-run." -ForegroundColor Yellow
    exit 1
}
$codexCmd = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codexCmd) {
    Write-Host "  [!] Codex CLI not found. Install it with:  npm install -g @openai/codex" -ForegroundColor Yellow
    Write-Host "      then run 'codex login' to sign into your ChatGPT account, and re-run this installer." -ForegroundColor Yellow
    exit 1
}
# Prefer the vendored native exe over the .cmd shim (stdin + sandbox reliability).
$vendored = Join-Path (Split-Path $codexCmd.Source) "node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"
$codexBin = if (Test-Path $vendored) { $vendored } else { $codexCmd.Source }

# --- 2. Questions (skipped for any value passed as a parameter) ----------
$havenUrl = if ($HavenUrl) { $HavenUrl } else { Read-Host "  Haven URL (e.g. https://your-haven.example.workers.dev)" }
$token    = if ($Token)    { $Token }    else { Read-Host "  Pairing token (Haven -> Settings -> Codex bridge -> Generate)" }
$defaultWs = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Codex Workspace"
$workspace = if ($Workspace) { $Workspace } else { Read-Host "  Dedicated workspace folder [$defaultWs]" }
if ([string]::IsNullOrWhiteSpace($workspace)) { $workspace = $defaultWs }

if ([string]::IsNullOrWhiteSpace($havenUrl) -or [string]::IsNullOrWhiteSpace($token)) {
    Write-Host "  [!] Haven URL and pairing token are both required." -ForegroundColor Yellow
    exit 1
}
New-Item -ItemType Directory -Force -Path $workspace | Out-Null

# --- 3. Config + dependencies -------------------------------------------
@(
    "HAVEN_URL=$havenUrl"
    "CODEX_CONNECTOR_TOKEN=$token"
    "CODEX_WORKSPACE=$workspace"
    "CODEX_BIN=$codexBin"
    "CODEX_TIMEOUT_MS=600000"
) | Out-File -FilePath (Join-Path $here ".env") -Encoding ascii
Write-Host "  [ok] config written" -ForegroundColor Green

Push-Location $here
npm install --omit=dev --silent | Out-Null
Pop-Location
Write-Host "  [ok] dependencies installed" -ForegroundColor Green

# --- 4. Start on boot + start now ---------------------------------------
$startup = [Environment]::GetFolderPath("Startup")
$launcher = Join-Path $here "start-bridge.cmd"
$trayPath = Join-Path $here "tray.ps1"
$launcherLines = @(
    '@echo off'
    ('cd /d "{0}"' -f $here)
    'start /min "Haven Codex Bridge" cmd /c "node daemon.mjs >> daemon.log 2>&1"'
    ('start "" powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $trayPath)
)
$launcherLines | Out-File -FilePath $launcher -Encoding ascii
Copy-Item $launcher (Join-Path $startup "haven-codex-bridge.cmd") -Force
Write-Host "  [ok] starts with Windows" -ForegroundColor Green

& cmd /c $launcher
Write-Host ""
Write-Host "  Bridge running. Look for the tray icon; pick 'Codex (your PC)' in Haven's model selector." -ForegroundColor Cyan
Write-Host "  Workspace: $workspace" -ForegroundColor Cyan
