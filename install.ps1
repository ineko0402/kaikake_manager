# 買掛管理 v0.5.2 installer/updater. Run only from extracted release directory.
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'app'
if (-not (Test-Path (Join-Path $source 'server.js'))) { throw 'app フォルダが見つかりません。ZIPをすべて展開してください。' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22.13以上が必要です。インストール後に再実行してください。' }
$dest = Join-Path $env:LOCALAPPDATA 'KaikakeManager'
Write-Host "Install/update: $dest"
if (Test-Path (Join-Path $dest 'server.js')) {
  Write-Host '既存アプリを更新します。起動中のアプリを終了してから続行してください。'
  Read-Host '終了したら Enter'
  $listeners = Get-NetTCPConnection -LocalPort 37841 -State Listen -ErrorAction SilentlyContinue
  if ($listeners) { throw 'アプリが起動中です。黒いサーバー画面を閉じてから再実行してください。' }
  & node (Join-Path $dest 'backup-db.js')
  if ($LASTEXITCODE -ne 0) { throw '更新前バックアップに失敗したため、更新を中止しました。' }
} else {
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
}
# Copy only application files; data/ and backup/ are NEVER overwritten.
foreach ($file in @('server.js','business-api.js','schema.sql','backup-db.js','restore-db.js','create-test-db.mjs','テスト用DB作成.bat','起動.bat','README.md','STATE.md')) {
  Copy-Item (Join-Path $source $file) (Join-Path $dest $file) -Force
}
$publicDest = Join-Path $dest 'public'
New-Item -ItemType Directory -Path $publicDest -Force | Out-Null
Copy-Item (Join-Path $source 'public\*') $publicDest -Recurse -Force
foreach ($obsolete in @('supplier.html','supplier.js')) {
  $obsoletePath = Join-Path $publicDest $obsolete
  if (Test-Path -LiteralPath $obsoletePath -PathType Leaf) {
    Remove-Item -LiteralPath $obsoletePath -Force
  }
}
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) '買掛管理.lnk'
$wshell=New-Object -ComObject WScript.Shell
$shortcut=$wshell.CreateShortcut($shortcutPath)
$shortcut.TargetPath=Join-Path $dest '起動.bat'
$shortcut.WorkingDirectory=$dest
$shortcut.Description='買掛・決済管理アプリ'
$shortcut.Save()
Write-Host '完了しました。デスクトップの「買掛管理」から起動できます。' -ForegroundColor Green
Write-Host '保存データ: ' (Join-Path $dest 'data\kaikake.db')
