# fetch-overseas-stats.js を監視するウォッチドッグ(watch-manga-build.ps1と同じ設計)。
# - プロセスが予期せず落ちていたら自動的に再起動する(SQLiteキャッシュのおかげで続きから進む)
# - ログが一定時間更新されない場合はハングとみなし、強制終了してから再起動する
# - 完了ログを検知したら監視を終了する
# 実行: powershell -File watch-overseas-stats.ps1 (バックグラウンドで起動して放置する)

$ProjectDir = "C:\Users\kensh\anime_pageviews_ranking"
$WatchLog = Join-Path $ProjectDir "logs\watchdog-overseas-stats.log"
$CheckIntervalSec = 60
$StaleThresholdMin = 10

function Write-WatchLog([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $WatchLog -Value $line -Encoding utf8
}

function Start-Fetch {
    $n = 1
    while (Test-Path (Join-Path $ProjectDir "logs\overseas-stats-watch-$n.log")) { $n++ }
    $outLog = Join-Path $ProjectDir "logs\overseas-stats-watch-$n.log"
    $errLog = Join-Path $ProjectDir "logs\overseas-stats-watch-$n-err.log"
    $proc = Start-Process node -ArgumentList "fetch-overseas-stats.js" -WorkingDirectory $ProjectDir `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -NoNewWindow -PassThru
    Write-WatchLog "started PID=$($proc.Id) outLog=$outLog"
    return [PSCustomObject]@{ ProcId = $proc.Id; OutLog = $outLog }
}

Write-WatchLog "=== watchdog started ==="
$current = Start-Fetch

while ($true) {
    Start-Sleep -Seconds $CheckIntervalSec

    # 完了判定はASCII文字列(data/en-seiyuu-stats.jsonへの書き出し、声優が最後のカテゴリ)で行う。
    $logText = Get-Content $current.OutLog -Raw -ErrorAction SilentlyContinue
    if ($logText -and $logText -match [regex]::Escape("en-seiyuu-stats.json")) {
        Write-WatchLog "completion detected in $($current.OutLog), stopping watchdog"
        break
    }

    $alive = Get-Process -Id $current.ProcId -ErrorAction SilentlyContinue
    if (-not $alive) {
        Start-Sleep -Seconds 5
        $logText2 = Get-Content $current.OutLog -Raw -ErrorAction SilentlyContinue
        if ($logText2 -and $logText2 -match [regex]::Escape("en-seiyuu-stats.json")) {
            Write-WatchLog "completion detected after process exit (race avoided) in $($current.OutLog), stopping watchdog"
            break
        }
        Write-WatchLog "process PID=$($current.ProcId) is gone (not completed) -> restarting"
        $current = Start-Fetch
        continue
    }

    $lastWrite = (Get-Item $current.OutLog -ErrorAction SilentlyContinue).LastWriteTime
    if ($lastWrite -and ((Get-Date) - $lastWrite).TotalMinutes -gt $StaleThresholdMin) {
        Write-WatchLog "process PID=$($current.ProcId) looks hung (no log update for $StaleThresholdMin+ min) -> killing and restarting"
        Stop-Process -Id $current.ProcId -Force -ErrorAction SilentlyContinue
        $current = Start-Fetch
        continue
    }
}

Write-WatchLog "=== watchdog finished ==="
