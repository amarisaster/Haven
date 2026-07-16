# Haven Codex Bridge - tray companion
# A small status light: green = connected, gray = offline, tooltip shows state.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $here "daemon.log"
$envPath = Join-Path $here ".env"
$workspace = (Select-String -Path $envPath -Pattern '^CODEX_WORKSPACE=(.*)$' -ErrorAction SilentlyContinue).Matches.Groups[1].Value

function New-DotIcon([System.Drawing.Color]$color) {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = "AntiAlias"
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $color), 2, 2, 12, 12)
    $g.Dispose()
    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$iconOn  = New-DotIcon ([System.Drawing.Color]::FromArgb(110, 231, 183))
$iconOff = New-DotIcon ([System.Drawing.Color]::Gray)

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $iconOff
$tray.Text = "Haven Codex Bridge"
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add("Open workspace folder", $null, { if ($workspace) { Start-Process explorer.exe $workspace } })
[void]$menu.Items.Add("View log", $null, { if (Test-Path $logPath) { Start-Process notepad.exe $logPath } })
$menu.Items.Add("-") | Out-Null
[void]$menu.Items.Add("Restart bridge", $null, {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'daemon\.mjs' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c cd /d `"$here`" && node daemon.mjs >> daemon.log 2>&1" -WindowStyle Hidden
})
[void]$menu.Items.Add("Quit (stops the bridge)", $null, {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'daemon\.mjs' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})
$tray.ContextMenuStrip = $menu

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 10000
$timer.Add_Tick({
    $daemonAlive = [bool](Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'daemon\.mjs' })
    $connected = $false
    if ($daemonAlive -and (Test-Path $logPath)) {
        $tailLines = Get-Content $logPath -Tail 40 -ErrorAction SilentlyContinue
        $lastConnect = ($tailLines | Select-String "connect (connected|closed)" | Select-Object -Last 1)
        $connected = $lastConnect -and ($lastConnect.Line -match "connect connected")
    }
    if ($connected) { $tray.Icon = $iconOn;  $tray.Text = "Haven Codex Bridge - connected" }
    elseif ($daemonAlive) { $tray.Icon = $iconOff; $tray.Text = "Haven Codex Bridge - reconnecting..." }
    else { $tray.Icon = $iconOff; $tray.Text = "Haven Codex Bridge - stopped (right-click to restart)" }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
