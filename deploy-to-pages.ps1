# dist/ の内容を GitHub Pages(gh-pagesブランチ)へ公開する。
# このPCでビルドした結果をそのままアップロードする方式(GitHub Actions/Google Driveは使わない)。
#  1. dist/ -> C:\Users\kensh\gh-pages-deploy-tmp へミラーコピー(.git と Search Console確認ファイルは残す)
#  2. 変更があれば commit して gh-pages ブランチへ push
# 実行: powershell -File deploy-to-pages.ps1
# 初回だけ、push時にGitHubのログイン画面が出る(以後はWindowsの資格情報に保存される)。

$ErrorActionPreference = "Stop"
$ProjectDir = "C:\Users\kensh\anime_pageviews_ranking"
$DistDir = Join-Path $ProjectDir "dist"
$DeployDir = "C:\Users\kensh\gh-pages-deploy-tmp"
$RemoteUrl = "https://github.com/kenshow1116-blip/anime-pageviews-ranking.git"
$VerifyFile = "google2d2cf974c93a7546.html"
$LogFile = Join-Path $ProjectDir "logs\deploy.log"

function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $LogFile -Value $line -Encoding utf8
    Write-Output $line
}

function Invoke-Git([string[]]$GitArgs) {
    & git.exe -C $DeployDir @GitArgs
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE" }
}

Write-Log "=== deploy started ==="

# サイトマップに仮URLが混ざっていたら公開しない(Search Consoleで弾かれる原因になったため)
$SitemapPath = Join-Path $DistDir "sitemap.xml"
if (Select-String -Path $SitemapPath -Pattern "example.com" -SimpleMatch -Quiet) {
    throw "sitemap.xml に example.com のURLが残っています。build-categories.js 等を再実行してください。"
}

# Jekyll処理を無効化(大量ファイルでのビルド遅延と _ 始まりファイルの除外を防ぐ)
New-Item -ItemType File -Force (Join-Path $DistDir ".nojekyll") | Out-Null

# /MIR でも /XD /XF に指定したものは削除されない
& robocopy $DistDir $DeployDir /MIR /XD .git /XF $VerifyFile /NFL /NDL /NJH /NP /R:2 /W:5 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
Write-Log "copied dist -> $DeployDir"

# GitHubは1ファイル100MB(104,857,600バイト)を超えるとpushを拒否するため、上限を超えるファイルは公開から外す
$MaxBytes = 100MB  # = 104,857,600バイト(GitHubの上限)
Get-ChildItem -Path $DeployDir -Recurse -File | Where-Object { $_.FullName -notlike "*\.git\*" -and $_.Length -gt $MaxBytes } | ForEach-Object {
    Write-Log ("WARNING: skip oversized file {0} ({1:N1} MB)" -f $_.FullName.Substring($DeployDir.Length + 1), ($_.Length / 1MB))
    Remove-Item -LiteralPath $_.FullName -Force
}

# スケジューラ実行中にログイン画面待ちで止まらないようにする
$env:GCM_INTERACTIVE = if ($args -contains "-Interactive") { "auto" } else { "never" }

Invoke-Git @("add", "-A")
& git -C $DeployDir diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
    Write-Log "no changes to deploy"
} else {
    Invoke-Git @("commit", "-q", "-m", "Update site $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
    Write-Log "committed"
}

Invoke-Git @("push", $RemoteUrl, "gh-pages:gh-pages")
Write-Log "=== deploy completed successfully ==="
