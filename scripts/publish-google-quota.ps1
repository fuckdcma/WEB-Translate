$ErrorActionPreference='Stop'
$gcloud='C:\Users\Pjzno\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
$node='C:\Program Files\nodejs\node.exe'
$env:GOOGLE_CLOUD_ACCESS_TOKEN=& $gcloud auth print-access-token
if($LASTEXITCODE -ne 0 -or -not $env:GOOGLE_CLOUD_ACCESS_TOKEN){throw 'Google chưa đăng nhập trên máy'}
& $node (Join-Path $PSScriptRoot 'publish-google-quota.mjs')
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
