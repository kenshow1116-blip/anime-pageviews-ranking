# build-seiyuu.js を監視するウォッチドッグ。
# - プロセスが(スリープ復帰失敗・予期しない終了などで)落ちていたら自動的に再起動する
# - ログが一定時間更新されない場合はハングとみなし、強制終了してから再起動する
# - 完了ログを検知したら監視を終了する
# 実行: powershell -File watch-seiyuu-build.ps1 (バックグラウンドで起動して放置する)

$ProjectDir = "C:\Users\kensh\anime_pageviews_ranking"
$WatchLog = Join-Path $ProjectDir "logs\watchdog-seiyuu.log"
$CheckIntervalSec = 120
$StaleThresholdMin = 10

function Write-WatchLog([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $WatchLog -Value $line -Encoding utf8
}

function Start-Build {
    $n = 1
    while (Test-Path (Join-Path $ProjectDir "logs\build-seiyuu-watch-$n.log")) { $n++ }
    $outLog = Join-Path $ProjectDir "logs\build-seiyuu-watch-$n.log"
    $errLog = Join-Path $ProjectDir "logs\build-seiyuu-watch-$n-err.log"
    $proc = Start-Process node -ArgumentList "build-seiyuu.js" -WorkingDirectory $ProjectDir `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -NoNewWindow -PassThru
    Write-WatchLog "started PID=$($proc.Id) outLog=$outLog"
    return [PSCustomObject]@{ ProcId = $proc.Id; OutLog = $outLog }
}

Write-WatchLog "=== watchdog started ==="
$current = Start-Build

while ($true) {
    Start-Sleep -Seconds $CheckIntervalSec

    $logText = Get-Content $current.OutLog -Raw -ErrorAction SilentlyContinue
    if ($logText -and $logText -match [regex]::Escape("seiyuu-daily-views.json")) {
        Write-WatchLog "completion detected in $($current.OutLog), stopping watchdog"
        break
    }

    $alive = Get-Process -Id $current.ProcId -ErrorAction SilentlyContinue
    if (-not $alive) {
        # プロセス終了直後はログへの書き込み・フラッシュがわずかに遅れることがあるため、
        # 再起動する前に少し待ってから完了文字列をもう一度確認する(誤検知での無駄な再実行を防ぐ)。
        Start-Sleep -Seconds 5
        $logText2 = Get-Content $current.OutLog -Raw -ErrorAction SilentlyContinue
        if ($logText2 -and $logText2 -match [regex]::Escape("seiyuu-daily-views.json")) {
            Write-WatchLog "completion detected after process exit (race avoided) in $($current.OutLog), stopping watchdog"
            break
        }
        Write-WatchLog "process PID=$($current.ProcId) is gone (not completed) -> restarting"
        $current = Start-Build
        continue
    }

    $lastWrite = (Get-Item $current.OutLog -ErrorAction SilentlyContinue).LastWriteTime
    if ($lastWrite -and ((Get-Date) - $lastWrite).TotalMinutes -gt $StaleThresholdMin) {
        Write-WatchLog "process PID=$($current.ProcId) looks hung (no log update for $StaleThresholdMin+ min) -> killing and restarting"
        Stop-Process -Id $current.ProcId -Force -ErrorAction SilentlyContinue
        $current = Start-Build
        continue
    }
}

Write-WatchLog "=== watchdog finished ==="

