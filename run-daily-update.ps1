# 日次更新をまとめて実行する: タイトル一覧リフレッシュ -> ダンプ一括取得 -> build.js -> build-seiyuu.js -> build-manga.js
# 1. fetch-all-anime-list.js / fetch-all-manga-list.js でWikidataから対象タイトル一覧を再取得する
#    (新しくアニメ化された漫画などを翌日の更新で自動的に拾えるようにするため)
# 2. fetch-daily-from-dump.js で前日分をWikimediaのpageviewsダンプから一括取得しSQLiteへ書き込む
#    (個別記事ごとのAPIフェッチを避け、429レート制限を回避する)
# 3. build.js / build-seiyuu.js / build-manga.js を実行(当日分は既にSQLiteにあるため瞬時に終わる。
#    新規追加された作品・声優・漫画だけは、ダンプに無い過去分をAPI経由で取得するフォールバックが働く)
# タスクスケジューラ/cron/GitHub Actionsから1日1回呼び出す想定。
# fetch-all-manga-list.jsはWikidataへの問い合わせで15〜20分程度かかるため、
# 深夜帯などダンプ公開を待つ時間に実行されるこの日次更新に含めるのが適切。
# 実行: powershell -File run-daily-update.ps1

$ErrorActionPreference = "Stop"
$ProjectDir = "C:\Users\kensh\anime_pageviews_ranking"
Set-Location $ProjectDir

$LogFile = Join-Path $ProjectDir "logs\daily-update.log"

function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $LogFile -Value $line -Encoding utf8
    Write-Output $line
}

function Run-Step([string]$name, [string]$scriptFile) {
    Write-Log "step start: $name"
    & node $scriptFile
    if ($LASTEXITCODE -ne 0) {
        throw "$name failed with exit code $LASTEXITCODE"
    }
    Write-Log "step done: $name"
}

# 当日速報更新(1時間おき)が同じSQLiteキャッシュ(data/pageviews.db)に書き込むため、
# この日次フル更新の実行中だけ一時的に無効化する(同時書き込みで片方が完全停止するバグが
# 過去に確認済み)。処理の成否に関わらず必ず再有効化する。
$IntradayTaskName = "AnimePageviewsIntradayUpdate"
Write-Log "disabling scheduled task: $IntradayTaskName (avoid concurrent SQLite writes)"
Disable-ScheduledTask -TaskName $IntradayTaskName -ErrorAction SilentlyContinue | Out-Null

Write-Log "=== daily update started ==="
try {
    Run-Step "fetch-all-anime-list" "fetch-all-anime-list.js"
    Run-Step "fetch-all-manga-list" "fetch-all-manga-list.js"
    Run-Step "fetch-daily-from-dump" "fetch-daily-from-dump.js"
    Run-Step "build (anime works)" "build.js"
    Run-Step "build-seiyuu" "build-seiyuu.js"
    Run-Step "build-manga" "build-manga.js"
    Run-Step "build-categories" "build-categories.js"
    Write-Log "step start: deploy-to-pages"
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectDir "deploy-to-pages.ps1")
    if ($LASTEXITCODE -ne 0) { throw "deploy-to-pages failed with exit code $LASTEXITCODE" }
    Write-Log "step done: deploy-to-pages"
    Write-Log "=== daily update completed successfully ==="
} catch {
    Write-Log "=== daily update FAILED: $($_.Exception.Message) ==="
    Enable-ScheduledTask -TaskName $IntradayTaskName -ErrorAction SilentlyContinue | Out-Null
    Write-Log "re-enabled scheduled task: $IntradayTaskName"
    exit 1
}

Enable-ScheduledTask -TaskName $IntradayTaskName -ErrorAction SilentlyContinue | Out-Null
Write-Log "re-enabled scheduled task: $IntradayTaskName"

