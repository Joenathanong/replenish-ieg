<#
  Mendaftarkan worker penarik data sebagai tugas terjadwal Windows yang berjalan
  otomatis saat komputer menyala, tanpa perlu ada orang yang login.

  Memakai Task Scheduler bawaan Windows, jadi tidak perlu mengunduh apa pun.
  Jalankan sebagai Administrator:

      powershell -ExecutionPolicy Bypass -File windows\install-worker.ps1
#>

param(
  [string]$TaskName = 'OCS Replenish Worker'
)

$ErrorActionPreference = 'Stop'

# --- pastikan dijalankan sebagai Administrator ---
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host ''
  Write-Host '  Skrip ini harus dijalankan sebagai Administrator.' -ForegroundColor Red
  Write-Host '  Klik kanan PowerShell -> Run as administrator, lalu ulangi.' -ForegroundColor Red
  Write-Host ''
  exit 1
}

$projectDir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $node) {
  Write-Host "`n  node.exe tidak ditemukan di PATH. Pasang Node.js 22.5+ lebih dulu.`n" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path (Join-Path $projectDir '.env'))) {
  Write-Host "`n  Berkas .env belum ada di $projectDir" -ForegroundColor Red
  Write-Host "  Salin .env.example menjadi .env dan isi TIDB_URL lebih dulu.`n" -ForegroundColor Red
  exit 1
}

$logDir = Join-Path $projectDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir 'worker.log'

Write-Host ''
Write-Host "  Proyek : $projectDir"
Write-Host "  Node   : $node"
Write-Host "  Log    : $logFile"
Write-Host ''

# Task Scheduler tidak menangkap keluaran konsol, jadi prosesnya dibungkus cmd
# agar stdout dan stderr tersimpan ke berkas log.
#
# Bentuk kutipannya harus persis seperti ini: cmd membuang sepasang kutip terluar
# ketika argumen /c diawali dan diakhiri kutip serta memuat kutip lain di dalamnya.
# Itulah satu-satunya cara path ber-spasi tetap utuh.
$workerScript = Join-Path $projectDir 'src\worker.js'
$inner = '"{0}" "{1}" >> "{2}" 2>&1' -f $node, $workerScript, $logFile
$argument = '/c "{0}"' -f $inner

$action = New-ScheduledTaskAction -Execute "$env:ComSpec" -Argument $argument -WorkingDirectory $projectDir
$trigger = New-ScheduledTaskTrigger -AtStartup

# SYSTEM agar berjalan tanpa perlu ada user yang login.
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "  Tugas '$TaskName' sudah ada — mendaftarkan ulang." -ForegroundColor Yellow
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName `
  -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Menarik data stok OCS ke TiDB untuk dashboard Monitoring Replenish.' | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 6

$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host "  Status : $state" -ForegroundColor Green
Write-Host ''
Write-Host '  Perintah yang berguna:'
Write-Host "    Get-ScheduledTask -TaskName '$TaskName'"
Write-Host "    Stop-ScheduledTask  -TaskName '$TaskName'"
Write-Host "    Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "    Get-Content '$logFile' -Tail 30 -Wait"
Write-Host ''
