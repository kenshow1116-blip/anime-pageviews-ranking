// data/metadata.json + data/work-stats.json から、制作会社別のまとめページを生成する。
// 原作種類別(source/)の独立ランキングページは本人要望により廃止(2026-10-17)。
// 将来的にアニメランキング側の絞り込み表示として復活させる可能性はあるが、
// 独立ページとしては作らない。
// Pageviews APIへの新規アクセスはなし。
// node build-categories.js

import { stylesheetTag } from "./shared-assets.js";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { BACK_TO_TOP_CSS, BACK_TO_TOP_HTML, BACK_TO_TOP_SCRIPT } from "./back-to-top.js";
import { exportStudioDailyViews } from "./export-daily-views-lib.js";

const SITE_URL = "https://ninkimeter.com";
const OUT_DIR = path.resolve("dist");
const STUDIOS_DIR = path.join(OUT_DIR, "studios");
const SITEMAP_FILE = path.join(OUT_DIR, "sitemap.xml");

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
    --baseline: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --accent: #3b7de8;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--page-plane);
    color: var(--text-primary);
  }
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

  .row {
    display: grid;
    grid-template-columns: 34px 1fr;
    align-items: center;
    gap: 14px;
    padding: 10px 14px;
    margin-bottom: 8px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.05);
  }
  .rank {
    font-size: 14px;
    font-weight: 700;
    color: var(--text-muted);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .rank.top3 { font-size: 20px; }
  .row-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .row-top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .title-link {
    font-size: 14px;
    color: var(--text-primary);
    text-decoration: none;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title-link:hover { text-decoration: underline; }
  .value {
    font-size: 13px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .bar-track { height: 12px; border-radius: 6px; background: var(--gridline); overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 6px; background: var(--accent); }
  ${BACK_TO_TOP_CSS}
`;

function buildRowsHtml(items, maxValue) {
  const MEDALS = ["🥇", "🥈", "🥉"];
  return items
    .map((it, idx) => {
      const pct = maxValue > 0 ? Math.max(2, (it.value / maxValue) * 100) : 0;
      return `  <div class="row">
    <div class="rank${idx < 3 ? " top3" : ""}">${idx < 3 ? MEDALS[idx] : idx + 1}</div>
    <div class="row-main">
      <div class="row-top">
        <a class="title-link" href="${it.href}">${escapeHtml(it.label)}</a>
        <div class="value">${escapeHtml(it.meta)}</div>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
    </div>
  </div>`;
    })
    .join("\n");
}

function buildListPage({ breadcrumbLabel, title, description, items, backHref }) {
  const maxValue = Math.max(1, ...items.map((it) => it.value));
  const rows = buildRowsHtml(items, maxValue);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} - アニメ Wikipedia 閲覧数ランキング</title>
<meta name="description" content="${escapeHtml(description)}">
${stylesheetTag("studios", PAGE_CSS)}
</head>
<body>
<div class="wrap">
  <div class="top-link"><a href="../index.html">&larr; ホームに戻る</a></div>
  <div class="breadcrumb"><a href="../index.html">ホーム</a> &gt; ${escapeHtml(breadcrumbLabel)}</div>
  <h1>${escapeHtml(title)}</h1>
  <p class="subtitle">${escapeHtml(description)}</p>
${rows}
  <div class="links"><a href="${backHref}">${escapeHtml(breadcrumbLabel)}一覧に戻る</a> <a href="../index.html">ホームに戻る</a></div>
</div>
${BACK_TO_TOP_HTML}
${BACK_TO_TOP_SCRIPT}
</body>
</html>
`;
}

function buildTopIndexPage({ title, description, items }) {
  const maxValue = Math.max(1, ...items.map((it) => it.totalViews));
  const rowItems = items.map((it) => ({
    href: `${safeFileName(it.name)}.html`,
    label: it.name,
    meta: `${it.count}作品 / 累計${formatViews(it.totalViews)}回`,
    value: it.totalViews,
  }));
  const rows = buildRowsHtml(rowItems, maxValue);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} - アニメ Wikipedia 閲覧数ランキング</title>
<meta name="description" content="${escapeHtml(description)}">
${stylesheetTag("studios", PAGE_CSS)}
</head>
<body>
<div class="wrap">
  <div class="top-link"><a href="../index.html">&larr; ホームに戻る</a></div>
  <div class="breadcrumb"><a href="../index.html">ホーム</a> &gt; ${escapeHtml(title)}</div>
  <h1>${escapeHtml(title)}</h1>
  <p class="subtitle">${escapeHtml(description)}</p>
${rows}
  <div class="links"><a href="../anime-ranking.html">アニメランキングに戻る</a> <a href="../index.html">ホームに戻る</a></div>
  <p class="note">対象は作品ページに制作会社情報が確認できたアニメです。</p>
</div>
${BACK_TO_TOP_HTML}
${BACK_TO_TOP_SCRIPT}
</body>
</html>
`;
}

async function updateSitemapSection(sectionPrefix, urls) {
  const newLines = urls.map((u) => `  <url><loc>${u}</loc></url>`);
  let existingLines = [];
  try {
    const existing = await readFile(SITEMAP_FILE, "utf-8");
    existingLines = existing
      .split("\n")
      .filter((line) => line.includes("<url>") && !line.includes(sectionPrefix));
  } catch {
    existingLines = [];
  }
  const body = [...existingLines, ...newLines].join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  await writeFile(SITEMAP_FILE, xml, "utf-8");
}

async function main() {
  const metadata = JSON.parse(await readFile(path.resolve("data", "metadata.json"), "utf-8"));
  const workStats = JSON.parse(await readFile(path.resolve("data", "work-stats.json"), "utf-8"));
  const totalByTitle = new Map(workStats.map((w) => [w.title, w.total]));

  const studioGroups = new Map(); // studio -> [{title, total}]

  for (const title of Object.keys(metadata)) {
    const m = metadata[title];
    const total = totalByTitle.get(title) || 0;
    if (m.studios) {
      for (const studio of m.studios) {
        if (!studioGroups.has(studio)) studioGroups.set(studio, []);
        studioGroups.get(studio).push({ title, total });
      }
    }
  }

  await mkdir(STUDIOS_DIR, { recursive: true });

  // 制作会社ページ
  const studioSummaries = [];
  for (const [studio, works] of studioGroups.entries()) {
    works.sort((a, b) => b.total - a.total);
    const totalViews = works.reduce((sum, w) => sum + w.total, 0);
    studioSummaries.push({ name: studio, count: works.length, totalViews });

    const items = works.map((w) => ({
      href: `../works/${safeFileName(w.title)}.html`,
      label: w.title,
      meta: `累計${formatViews(w.total)}回`,
      value: w.total,
    }));
    const topWork = works[0];
    const description = `${studio}が制作したアニメの中で、日本語版Wikipedia閲覧数が最も多いのは『${topWork.title}』(累計${formatViews(topWork.total)}回)です。`;
    const html = buildListPage({
      breadcrumbLabel: "制作会社",
      title: `${studio}の作品一覧`,
      description,
      items,
      backHref: "index.html",
    });
    await writeFile(path.join(STUDIOS_DIR, `${safeFileName(studio)}.html`), html, "utf-8");
  }
  studioSummaries.sort((a, b) => b.totalViews - a.totalViews);
  await writeFile(
    path.join(STUDIOS_DIR, "index.html"),
    buildTopIndexPage({
      title: "制作会社別ランキング",
      description: "日本語版Wikipediaの閲覧数データに基づく、アニメ制作会社ごとの作品一覧・合計閲覧数ランキングです。",
      items: studioSummaries,
    }),
    "utf-8"
  );

  await updateSitemapSection("/studios/", [
    `${SITE_URL}/studios/index.html`,
    ...studioSummaries.map((s) => `${SITE_URL}/studios/${encodeURIComponent(safeFileName(s.name))}.html`),
  ]);
  // 原作種類別(/source/)の独立ページ生成は廃止。sitemapからも既存のURLを除去するだけ行う。
  await updateSitemapSection("/source/", []);

  await copyFile(path.resolve("studio-ranking.html"), path.join(OUT_DIR, "studio-ranking.html"));

  console.log("制作会社ランキングページ用の静的JSONを書き出し中...");
  const studioToWorks = new Map();
  for (const [studio, works] of studioGroups.entries()) {
    studioToWorks.set(studio, works.map((w) => w.title));
  }
  await exportStudioDailyViews({
    studioToWorks: Object.fromEntries(studioToWorks),
    outPrefix: "studio-daily-views",
  });

  console.log(`完了: 制作会社${studioSummaries.length}件のページを生成しました。`);
  console.log("制作会社トップ5:", studioSummaries.slice(0, 5).map((s) => `${s.name}(${s.count}作品)`).join(", "));
}

main().catch((e) => {
  console.error("ビルド失敗:", e);
  process.exit(1);
});
