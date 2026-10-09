# Empirically test whether a per-user WebView2 policy registry value can force Gale to open a debug port.
# NOTE: keep this file ASCII-only; Windows PowerShell 5.1 mis-decodes BOM-less UTF-8 scripts.
$ErrorActionPreference = 'SilentlyContinue'
$key = 'HKCU:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
$browserArgs = '--remote-debugging-port=9223 --remote-allow-origins=*'
$gale = 'D:\Gale\gale.exe'

function Test-Port {
  try { return (Invoke-WebRequest 'http://127.0.0.1:9223/json/version' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { return $false }
}
function Stop-Gale {
  Get-Process gale -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 3
}

$candidates = @(
  @{ name = 'full-exe-path';      value = $gale },
  @{ name = 'full-path-no-ext';   value = 'D:\Gale\gale' },
  @{ name = 'exe-name';           value = 'gale.exe' },
  @{ name = 'exe-name-no-ext';    value = 'gale' }
)

Write-Output '=== Baseline: no env var, no policy ==='
Remove-Item $key -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
Stop-Gale
Start-Process $gale -WorkingDirectory 'D:\Gale'
Start-Sleep -Seconds 12
Write-Output ("  debug port open: " + (Test-Port))
Stop-Gale

foreach ($c in $candidates) {
  Write-Output ("`n=== Candidate: " + $c.name + "  [" + $c.value + "] ===")
  Remove-Item $key -Force -ErrorAction SilentlyContinue
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name $c.value -Value $browserArgs -PropertyType String -Force | Out-Null
  Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  Stop-Gale
  Start-Process $gale -WorkingDirectory 'D:\Gale'
  Start-Sleep -Seconds 13
  if (Test-Port) { Write-Output '  >>> SUCCESS: debug port is open'; Stop-Gale; break }
  Write-Output '  FAILED: port closed'
  Stop-Gale
}

Write-Output "`n=== Cleanup ==="
Remove-Item 'HKCU:\Software\Policies\Microsoft\Edge\WebView2' -Recurse -Force -ErrorAction SilentlyContinue
Write-Output ('  policy key remains: ' + (Test-Path $key))
