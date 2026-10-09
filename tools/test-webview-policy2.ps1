# Second round (fixed): user-data-folder as value name, and machine-level policy.
# ASCII-only on purpose (Windows PowerShell 5.1 mis-decodes BOM-less UTF-8 scripts).
$ErrorActionPreference = 'SilentlyContinue'
$browserArgs = '--remote-debugging-port=9223 --remote-allow-origins=*'
$gale = 'D:\Gale\gale.exe'
$udf = Join-Path $env:LOCALAPPDATA 'com.kesomannen.gale\EBWebView'
$hkcuKey = 'HKCU:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
$hklmKey = 'HKLM:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'

function Test-Port {
  try { return (Invoke-WebRequest 'http://127.0.0.1:9223/json/version' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { return $false }
}
function Stop-Gale {
  Get-Process gale -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 3
}
function Clear-Policies {
  & reg delete 'HKCU\Software\Policies\Microsoft\Edge\WebView2' /f 2>&1 | Out-Null
  & reg delete 'HKLM\Software\Policies\Microsoft\Edge\WebView2' /f 2>&1 | Out-Null
}
function Try-Candidate {
  param($label, $key, $name)
  Write-Host ("`n=== " + $label + " ===")
  Clear-Policies
  if ($key -like 'HKLM*') {
    & reg add ($key -replace 'HKLM:\\', 'HKLM\') /v $name /t REG_SZ /d $browserArgs /f 2>&1 | Out-Null
  } else {
    & reg add ($key -replace 'HKCU:\\', 'HKCU\') /v $name /t REG_SZ /d $browserArgs /f 2>&1 | Out-Null
  }
  $exists = (Test-Path $key)
  Write-Host ("  key created: " + $exists)
  if (-not $exists) { return $false }
  Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  Stop-Gale
  Start-Process $gale -WorkingDirectory 'D:\Gale'
  Start-Sleep -Seconds 13
  $ok = Test-Port
  Write-Host ("  debug port open: " + $ok)
  Stop-Gale
  return $ok
}

Write-Host ('user data folder = ' + $udf)

$r1 = Try-Candidate 'HKCU, value name = user data folder' $hkcuKey $udf
if ($r1 -ne $true) {
  $r2 = Try-Candidate 'HKLM, value name = full exe path' $hklmKey $gale
  if ($r2 -ne $true) {
    $r3 = Try-Candidate 'HKLM, value name = user data folder' $hklmKey $udf
    if ($r3 -ne $true) { Write-Host "`n=== all registry candidates failed ===" }
  }
}

Clear-Policies
Write-Host ("`ncleanup -> HKCU key exists: " + (Test-Path $hkcuKey) + " ; HKLM key exists: " + (Test-Path $hklmKey))
