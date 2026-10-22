// 既存キャッシュ(data/en-work-stats.json)だけから海外ランキングページを再生成する軽量スクリプト。
// Pageviews APIへの新規アクセスなし。build.jsのフル再生成が終わらない間のつなぎ用。
// node generate-overseas-ranking.mjs

import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.resolve("dist");
const EN_STATS_FILE = path.resolve("data", "en-work-stats.json");

function safeFileName(title) {
  return title.replace(/[\\/:*?"<>|]/g, "_");
}

function formatViews(n) {
  return n.toLocaleString("ja-JP");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PAGE_CSS = `
  :root {
    color-scheme: light;
    --surface-1: #ffffff;
    --page-plane: #ffffff;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #898781;
    --gridline: #e8e8e5;
    --border: rgba(11,11,11,0.10);
    --accent: #3b7de8;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--page-plane); color: var(--text-primary); }
  .wrap { max-width: 760px; margin: 0 auto; padding: 32px 20px 60px; }
  h1 { font-size: 24px; font-weight: 700; margin: 0 0 4px; }
  .subtitle { color: var(--text-secondary); font-size: 13px; margin: 0 0 20px; }
  .breadcrumb { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; }
  .breadcrumb a { color: var(--accent); text-decoration: none; }
  .top-link { font-size: 13px; margin-bottom: 10px; }
  .top-link a { color: var(--accent); text-decoration: none; }
  .top-link a:hover { text-decoration: underline; }
  .links { font-size: 14px; margin-top: 20px; }
  .links a { color: var(--accent); text-decoration: none; margin-right: 16px; }
  .links a:hover { text-decoration: underline; }
  .note { font-size: 12px; color: var(--text-muted); margin-top: 24px; border-top: 1px solid var(--gridline); padding-top: 12px; }
  .row { display: grid; grid-template-columns: 34px 1fr; align-items: center; gap: 14px; padding: 10px 14px; margin-bottom: 8px; background: var(--surface-1); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 1px 4px rgba(0,0,0,0.05); }
  .rank { font-size: 14px; font-weight: 700; color: var(--text-muted); text-align: center; font-variant-numeric: tabular-nums; }
  .rank.top3 { font-size: 20px; }
  .row-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .row-top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .title-link { font-size: 14px; color: var(--text-primary); text-decoration: none; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title-link:hover { text-decoration: underline; }
  .value { font-size: 13px; color: var(--text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .bar-track { height: 12px; border-radius: 6px; background: var(--gridline); overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 6px; background: var(--accent); }
`;

function buildOverseasRankingPage(ranked) {
  const MEDALS = ["🥇", "🥈", "🥉"];
  const maxTotal = Math.max(1, ...ranked.map((r) => r.total));
  const rows = ranked
    .map((r, idx) => {
      const pct = Math.max(2, (r.total / maxTotal) * 100);
      return `  <div class="row">
    <div class="rank${idx < 3 ? " top3" : ""}">${idx < 3 ? MEDALS[idx] : idx + 1}</div>
    <div class="row-main">
      <div class="row-top">
        <a class="title-link" href="works/${escapeHtml(safeFileName(r.title))}.html">${escapeHtml(r.title)}</a>
        <div class="value">${formatViews(r.total)} views</div>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
    </div>
  </div>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>海外(英語版)Wikipedia閲覧数ランキング - アニメ Wikipedia 閲覧数ランキング</title>
<meta name="description" content="英語版Wikipediaの閲覧数データに基づく、海外での人気ランキングです。各作品名をクリックすると日本語版の作品ページに移動します。">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="top-link"><a href="index.html">&larr; アニメランキングに戻る</a></div>
  <div class="breadcrumb"><a href="index.html">アニメ Wikipedia 閲覧数ランキング</a> &gt; 海外ランキング</div>
  <h1>海外(英語版)Wikipediaランキング</h1>
  <p class="subtitle">英語版Wikipediaの累計閲覧数(2015年7月〜現在)に基づく順位です。作品名をクリックすると日本語版の作品ページに移動します。</p>
${rows}
  <div class="links"><a href="index.html">アニメランキングに戻る</a></div>
  <p class="note">
    閲覧数データはWikimedia Pageviews API(en.wikipedia, all-access, 人間アクセスのみ)に基づきます。
    対象はこのサイトで追跡している作品のうち、英語版記事が確認できたもののみです。
  </p>
</div>
</body>
</html>
`;
}

async function main() {
  const enStats = JSON.parse(await readFile(EN_STATS_FILE, "utf-8"));
  const ranked = Object.entries(enStats)
    .map(([title, s]) => ({ title, enTitle: s.enTitle, total: s.total }))
    .sort((a, b) => b.total - a.total);
  await writeFile(path.join(OUT_DIR, "overseas-ranking.html"), buildOverseasRankingPage(ranked), "utf-8");
  console.log(`完了: ${ranked.length}件で dist/overseas-ranking.html を生成しました。`);
  console.log("トップ5:", ranked.slice(0, 5).map((r) => `${r.title}(${formatViews(r.total)})`).join(", "));
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
