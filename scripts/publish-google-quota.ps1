$ErrorActionPreference='Stop'
$gcloud='C:\Users\Pjzno\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
$node='C:\Program Files\nodejs\node.exe'
$logDir=Join-Path $env:LOCALAPPDATA 'WEBTranslate'
$logFile=Join-Path $logDir 'quota-monitor.log'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
try{
  $env:QUOTA_MONITOR_SECRET_FILE=Join-Path (Split-Path $PSScriptRoot -Parent) '.vercel\quota-monitor-secret.txt'
  $oldPreference=$ErrorActionPreference;$ErrorActionPreference='Continue'
  $env:GOOGLE_CLOUD_ACCESS_TOKEN=(& $gcloud auth print-access-token 2>&1 | Out-String).Trim();$gcloudCode=$LASTEXITCODE
  if($gcloudCode -ne 0 -or -not $env:GOOGLE_CLOUD_ACCESS_TOKEN){throw 'Google login is not available on this computer'}
  $result=(& $node (Join-Path $PSScriptRoot 'publish-google-quota.mjs') 2>&1 | Out-String).Trim();$nodeCode=$LASTEXITCODE
  $ErrorActionPreference=$oldPreference
  if($nodeCode -ne 0){throw $result}
  "$(Get-Date -Format o) OK $result" | Out-File -FilePath $logFile -Append -Encoding utf8
}catch{
  "$(Get-Date -Format o) ERROR $($_.Exception.Message)" | Out-File -FilePath $logFile -Append -Encoding utf8
  exit 1
}
