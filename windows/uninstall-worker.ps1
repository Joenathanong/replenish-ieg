<#
  Menghentikan dan menghapus tugas terjadwal worker.
  Jalankan sebagai Administrator.
#>

param(
  [string]$TaskName = 'OCS Replenish Worker'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
  Write-Host "`n  Tugas '$TaskName' tidak ditemukan.`n" -ForegroundColor Yellow
  exit 0
}

try { Stop-ScheduledTask -TaskName $TaskName } catch { }
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "`n  Tugas '$TaskName' dihapus.`n" -ForegroundColor Green
