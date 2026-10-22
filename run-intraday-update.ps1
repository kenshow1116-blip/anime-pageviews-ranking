# 当日(UTC)分のpageviewsダンプを、今その時点で公開されている時間帯だけ取得し、
# ランキング用の軽量JSON(3種)だけを再書き出す「当日速報」更新。
# 個別ページ(1.9万ページ超)のHTML再生成は行わない(重すぎるため夜間の本更新のみで行う)。
# 1〜2時間おきにタスクスケジューラ等から呼び出す想定。
# UTC日付が変わった直後などダンプがまだ1件も公開されていない時間帯は、
# fetch-daily-from-dump.js が exit 1 を返すが、これは「まだ早いだけ」で異常ではないため
# エラーにはせず今回はスキップして次回に回す。
# 実行: powershell -File run-intraday-update.ps1

$ErrorActionPreference = "Stop"
$ProjectDir = "C:\Users\kensh\anime_pageviews_ranking"
Set-Location $ProjectDir

$LogFile = Join-Path $ProjectDir "logs\intraday-update.log"

function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $LogFile -Value $line -Encoding utf8
    Write-Output $line
}

$todayUtc = (Get-Date).ToUniversalTime().ToString("yyyyMMdd")
Write-Log "=== intraday update started (target=$todayUtc) ==="

node fetch-daily-from-dump.js $todayUtc
if ($LASTEXITCODE -ne 0) {
    Write-Log "fetch-daily-from-dump: 当日分のダンプがまだ公開されていない可能性(exit $LASTEXITCODE)。今回はスキップし次回に回す。"
    exit 0
}

node export-rankings-json.js
if ($LASTEXITCODE -ne 0) {
    Write-Log "=== intraday update FAILED: export-rankings-json exit code $LASTEXITCODE ==="
    exit 1
}

Write-Log "=== intraday update completed successfully ==="
