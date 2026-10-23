// 漫画(原作)ごとの静的SEOページを生成するビルドスクリプト。
// node build-manga.js で dist/manga/ 以下に全漫画ページ + 一覧を書き出し、
// dist/sitemap.xml に漫画ページ分のURLを追記する。
// アニメ化済みの漫画はアニメ版と同じWikipedia記事・同じ閲覧数を単純複製する
// (方針として重複除去はしない)。作品ページとのクロスリンクは持たない。

import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDailyHistory, getCachedMax, getCachedRangeOnly, closeCache } from "./pageview-cache.js";
import { buildTrendWidget, TREND_WIDGET_CSS } from "./trend-widget.js";
import { exportDailyViews } from "./export-daily-views-lib.js";
import { loadYomiganaMap, groupByRow, getRow, getSortKey, buildKanaNav, buildRowToc, rowPageFileName, rowPageHref, KANA_NAV_CSS } from "./yomigana.js";
import { BACK_TO_TOP_CSS, BACK_TO_TOP_HTML, BACK_TO_TOP_SCRIPT } from "./back-to-top.js";
import { NAV_CONTEXT_SCRIPT } from "./nav-context.js";

const SITE_URL = "https://kenshow1116-blip.github.io/anime-pageviews-ranking";

const ALL_MANGA_LIST_FILE = path.resolve("data", "all-manga-list.json");

async function loadMangaList() {
  const raw = await readFile(ALL_MANGA_LIST_FILE, "utf-8");
  const list = JSON.parse(raw);
  console.log(`data/all-manga-list.json から${list.length}件を読み込みました。`);
  return list;
}

const API_START = "20150701";
const LAG_DAYS = 2; // Wikimedia側のダンプ/API処理が2日分遅延しているため一時的に増やしている(2026-10-18判明)
const CONCURRENCY = 6;
const OUT_DIR = path.resolve("dist");
const MANGA_DIR = path.join(OUT_DIR, "manga");
const SITEMAP_FILE = path.join(OUT_DIR, "sitemap.xml");

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// fetch-daily-from-dump.jsのdefaultUtcLagDate()と同じUTC基準の計算にする(build.js参照)。
function todayMinusLag() {
  const now = new Date();
  const utcToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  utcToday.setUTCDate(utcToday.getUTCDate() - LAG_DAYS);
  return utcToday;
}

function parseTimestamp(ts) {
  const y = Number(ts.slice(0, 4));
  const m = Number(ts.slice(4, 6));
  const d = Number(ts.slice(6, 8));
  return new Date(y, m - 1, d);
}

function articleToApiPath(title) {
  return encodeURIComponent(title.replace(/ /g, "_"));
}

export function safeFileName(title) {
  return title.replace(/[\\/:*?"<>|]/g, "_");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_ATTEMPTS = 7;
const MAX_BACKOFF_MS = 60000;

async function fetchDailyHistoryRange(title, startDate, endDate, attempt = 0) {
  const article = articleToApiPath(title);
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/ja.wikipedia/all-access/user/${article}/daily/${startDate}/${endDate}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: { "User-Agent": "anime-pageviews-ranking-bot/1.0 (personal project)" },
    });
    if (res.status === 404) return [];
    if (res.status === 429) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`HTTP 429 for ${title} (retries exhausted)`);
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Math.min(retryAfter > 0 ? retryAfter * 1000 : 1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
      await sleep(waitMs);
      return fetchDailyHistoryRange(title, startDate, endDate, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${title}`);
    const data = await res.json();
    await sleep(300);
    return (data.items || []).map((it) => ({ ts: it.timestamp, views: it.views || 0 }));
  } catch (e) {
    if (attempt >= MAX_ATTEMPTS) throw new Error(`failed for ${title} (retries exhausted): ${e.message}`);
    await sleep(Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS));
    return fetchDailyHistoryRange(title, startDate, endDate, attempt + 1);
  }
}

async function runPool(items, worker, concurrency, onProgress) {
  let next = 0;
  let done = 0;
  const results = new Array(items.length);
  async function runOne() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (e) {
        results[i] = { ok: false, error: e };
      }
      done++;
      if (onProgress) onProgress(done, items.length, items[i]);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, runOne);
  await Promise.all(runners);
  return results;
}

export function computeTotal(items) {
  return items.reduce((sum, it) => sum + it.views, 0);
}

export function computePeak(items) {
  if (items.length === 0) return null;
  let best = items[0];
  for (const it of items) {
    if (it.views > best.views) best = it;
  }
  return { date: parseTimestamp(best.ts), views: best.views };
}

export function formatViews(n) {
  return n.toLocaleString("ja-JP");
}

function formatDateJa(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const PAGE_CSS = `
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
  h1 { font-size: 24px; font-weight: 700; margin: 0 0 6px; }
  h2 { font-size: 17px; font-weight: 700; margin: 24px 0 10px; }
  .breadcrumb { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; }
  .breadcrumb a { color: var(--accent); text-decoration: none; }
  .top-link { font-size: 13px; margin-bottom: 10px; }
  .top-link a { color: var(--accent); text-decoration: none; }
  .top-link a:hover { text-decoration: underline; }
  .stats { font-size: 15px; line-height: 1.8; color: var(--text-primary); margin: 16px 0 24px; }
  .stats strong { color: var(--accent); }
  .chart-wrap { width: 100%; margin: 20px 0 28px; }
  .trend-svg .grid-line { stroke: var(--gridline); stroke-width: 1; }
  .trend-svg .axis-label { fill: var(--text-muted); font-size: 10px; font-family: inherit; }
  .trend-svg .trend-line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .trend-svg .trend-area { fill: var(--accent); opacity: 0.1; stroke: none; }
  .trend-svg .trend-dot { fill: var(--accent); stroke: var(--surface-1); stroke-width: 2; }
  .trend-svg .crosshair { stroke: var(--text-muted); stroke-width: 1; }
  .links { font-size: 14px; margin-top: 20px; }
  .links a { color: var(--accent); text-decoration: none; margin-right: 16px; }
  .links a:hover { text-decoration: underline; }
  .note { font-size: 12px; color: var(--text-muted); margin-top: 24px; border-top: 1px solid var(--gridline); padding-top: 12px; }
  .tooltip {
    position: fixed; pointer-events: none; background: var(--text-primary); color: var(--page-plane);
    font-size: 12px; padding: 6px 9px; border-radius: 6px; opacity: 0;
    transform: translate(-50%, -100%); transition: opacity .1s ease; z-index: 10; white-space: nowrap;
  }
  .tooltip.visible { opacity: 1; }
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
  ${TREND_WIDGET_CSS}
  ${KANA_NAV_CSS}
  ${BACK_TO_TOP_CSS}
`;

export function buildMangaPage(title, stat, totalCount, row) {
  const { total, peak } = stat;
  const peakText = peak
    ? `最も多く閲覧されたのは${formatDateJa(peak.date)}で、その日は${formatViews(peak.views)}回のアクセスがありました。`
    : "";
  const description = `${title}の日本語版Wikipedia記事は2015年7月から現在までで累計${formatViews(total)}回閲覧されています。${peakText}`;
  const wikiUrl = "https://ja.wikipedia.org/wiki/" + articleToApiPath(title);

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} のWikipedia閲覧数推移・累計${formatViews(total)}回</title>
<meta name="description" content="${escapeHtml(description)}">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="top-link"><a href="../index.html">&larr; ホームに戻る</a></div>
  <div class="breadcrumb"><a href="../index.html">ホーム</a> &gt; <a href="index.html">漫画一覧</a> &gt; <a href="${rowPageHref(row)}">${row === "その他" ? "その他" : `${row}行`}</a> &gt; ${escapeHtml(title)}</div>
  <h1>${escapeHtml(title)}</h1>
  <p class="stats">
    ${escapeHtml(title)}の日本語版Wikipedia記事は2015年7月から現在までで累計<strong>${formatViews(total)}回</strong>閲覧されています。
    ${peakText}
  </p>
  ${buildTrendWidget({ title, project: "ja.wikipedia", idbDbName: "mangaWorkPageCacheDB" })}
  <div class="links">
    <a href="${wikiUrl}" target="_blank" rel="noopener noreferrer">Wikipediaで記事を読む</a>
    <a href="../manga-ranking.html">漫画ランキングに戻る</a>
    <a href="../index.html">ホームに戻る</a>
  </div>
  <p class="note">
    閲覧数データはWikimedia Pageviews API(ja.wikipedia, all-access, 人間アクセスのみ)に基づきます。
    2015年7月以前のデータはAPI側で提供されていないため集計には含まれません。
    アニメ化済みの作品はアニメ版と同じWikipedia記事・同じ閲覧数を表示しています。
    対象漫画リストはWikidataの「日本の連載漫画」分類に基づき自動抽出した全${totalCount}件です。
  </p>
</div>
<div class="tooltip" id="tooltip"></div>
${NAV_CONTEXT_SCRIPT}
${BACK_TO_TOP_HTML}
${BACK_TO_TOP_SCRIPT}
</body>
</html>
`;
}

export function buildMangaIndexPage(groups, totalCount) {
  const toc = buildRowToc(groups);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>漫画一覧 - アニメ Wikipedia 閲覧数ランキング</title>
<meta name="description" content="日本語版Wikipediaの閲覧数データに基づく、漫画ごとの累計閲覧数・推移の一覧ページです(50音順)。対象はWikidataの「日本の連載漫画」分類に基づき自動抽出した全件です。">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="top-link"><a href="../index.html">&larr; ホームに戻る</a></div>
  <div class="breadcrumb"><a href="../index.html">ホーム</a> &gt; 漫画一覧</div>
  <h1>漫画一覧</h1>
  <p class="subtitle">行ごとのページに分かれています。見たい行を選んでください。</p>
  ${toc}
  <div class="links"><a href="../manga-ranking.html">漫画ランキングに戻る</a> <a href="../index.html">ホームに戻る</a></div>
  <p class="note">
    対象漫画はWikidataで「日本の連載漫画」に分類されているja.wikipedia記事全${totalCount}件です。
    アニメ化済みの作品はアニメ版と同じ記事・同じ閲覧数を表示しています。
    並び順はWikipedia記事のDEFAULTSORT(読み仮名)に基づく50音順です。読み仮名が取得できなかった作品は「その他」に入ります。
  </p>
</div>
${BACK_TO_TOP_HTML}
${BACK_TO_TOP_SCRIPT}
</body>
</html>
`;
}

export function buildMangaIndexRowPage(group, groups, totalCount) {
  const nav = buildKanaNav(groups, group.row);
  const heading = group.row === "その他" ? "その他" : `${group.row}行`;
  const items = group.items
    .map(
      (e) =>
        `<li><a href="${escapeHtml(safeFileName(e.title))}.html">${escapeHtml(e.title)}</a> — 累計${formatViews(e.total)}回</li>`
    )
    .join("\n    ");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>漫画一覧(${escapeHtml(heading)}) - アニメ Wikipedia 閲覧数ランキング</title>
<meta name="description" content="日本語版Wikipediaの閲覧数データに基づく、漫画ごとの累計閲覧数・推移の一覧ページ(${escapeHtml(heading)})です。">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="top-link"><a href="../index.html">&larr; ホームに戻る</a></div>
  <div class="breadcrumb"><a href="../index.html">ホーム</a> &gt; <a href="index.html">漫画一覧</a> &gt; ${escapeHtml(heading)}</div>
  <h1>漫画一覧 — ${escapeHtml(heading)}</h1>
  ${nav}
  <ol class="stats">
    ${items}
  </ol>
  <div class="links"><a href="index.html">漫画一覧トップに戻る</a> <a href="../manga-ranking.html">漫画ランキングに戻る</a> <a href="../index.html">ホームに戻る</a></div>
  <p class="note">
    対象漫画はWikidataで「日本の連載漫画」に分類されているja.wikipedia記事全${totalCount}件です。
    アニメ化済みの作品はアニメ版と同じ記事・同じ閲覧数を表示しています。
    並び順はWikipedia記事のDEFAULTSORT(読み仮名)に基づく50音順です。読み仮名が取得できなかった作品は「その他」に入ります。
  </p>
</div>
${BACK_TO_TOP_HTML}
${BACK_TO_TOP_SCRIPT}
</body>
</html>
`;
}

const EN_MANGA_TITLES_FILE = path.resolve("data", "en-manga-titles.json");

async function loadEnMangaTitleMap() {
  try {
    return JSON.parse(await readFile(EN_MANGA_TITLES_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export async function updateSitemap(entries, indexGroups) {
  const mangaUrls = [
    `${SITE_URL}/manga/index.html`,
    ...indexGroups.map((g) => `${SITE_URL}/manga/${rowPageHref(g.row)}`),
    ...entries.map((e) => `${SITE_URL}/manga/${encodeURIComponent(safeFileName(e.title))}.html`),
  ];
  const newLines = mangaUrls.map((u) => `  <url><loc>${u}</loc></url>`);

  let existingLines = [];
  try {
    const existing = await readFile(SITEMAP_FILE, "utf-8");
    existingLines = existing
      .split("\n")
      .filter((line) => line.includes("<url>") && !line.includes("/manga/"));
  } catch {
    existingLines = [];
  }

  const body = [...existingLines, ...newLines].join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  await writeFile(SITEMAP_FILE, xml, "utf-8");
}

async function main() {
  const mangaList = await loadMangaList();

  console.log(`対象漫画数: ${mangaList.length}`);
  await mkdir(MANGA_DIR, { recursive: true });

  console.log("Wikipedia Pageviews APIから取得中(キャッシュ差分方式)...");
  const endDate = fmtDate(todayMinusLag());
  // 13000件超の初回バックフィルでは、プロセスが何度か落ちて再起動するたびに
  // 「一度取得済みの記事も最新日まで埋まっているか」のAPIリクエストをやり直すと
  // いつまでも進まない(ユーザー指摘により判明)。そのため、一度でも取得履歴がある
  // 記事はキャッシュをそのまま使い、直近数日分の欠落は次回の通常の日次更新
  // (run-daily-update.ps1経由のgetDailyHistory)で自然に埋める運用にする。
  let apiFetchCount = 0;
  let cacheSkipCount = 0;
  const results = await runPool(
    mangaList,
    (title) => {
      const cachedMax = getCachedMax("ja.wikipedia", title);
      if (cachedMax !== null) {
        cacheSkipCount++;
        return Promise.resolve(getCachedRangeOnly("ja.wikipedia", title, API_START, endDate));
      }
      return getDailyHistory("ja.wikipedia", title, API_START, endDate, (article, s, e) => {
        apiFetchCount++;
        console.log(`  [API取得] ${article} (${s}-${e})`);
        return fetchDailyHistoryRange(article, s, e);
      });
    },
    CONCURRENCY,
    (done, total, title) => {
      process.stdout.write(`  [${done}/${total}] ${title}\r\n`);
    }
  );
  console.log(`APIへの実リクエスト件数: ${apiFetchCount} / ${mangaList.length}件(キャッシュそのまま使用: ${cacheSkipCount}件)`);

  const failed = [];
  const itemsByTitle = new Map();
  mangaList.forEach((title, i) => {
    const r = results[i];
    if (!r.ok) {
      failed.push({ title, error: r.error ? r.error.message : "unknown" });
      itemsByTitle.set(title, []);
      return;
    }
    itemsByTitle.set(title, r.value);
  });

  if (failed.length > 0) {
    console.warn("取得失敗:", failed);
  }

  const entries = [];
  for (const title of mangaList) {
    const items = itemsByTitle.get(title);
    const total = computeTotal(items);
    const peak = computePeak(items);
    entries.push({ title, total, peak });
  }

  const yomiganaMap = await loadYomiganaMap();

  console.log("静的ページを生成中...");
  for (const e of entries) {
    const row = getRow(getSortKey(e.title, yomiganaMap));
    const html = buildMangaPage(e.title, e, entries.length, row);
    const fileName = safeFileName(e.title) + ".html";
    await writeFile(path.join(MANGA_DIR, fileName), html, "utf-8");
  }

  const indexGroups = groupByRow(entries, yomiganaMap, (e) => e.title);
  await writeFile(path.join(MANGA_DIR, "index.html"), buildMangaIndexPage(indexGroups, entries.length), "utf-8");
  for (const group of indexGroups) {
    await writeFile(
      path.join(MANGA_DIR, rowPageFileName(group.row)),
      buildMangaIndexRowPage(group, indexGroups, entries.length),
      "utf-8"
    );
  }
  await updateSitemap(entries, indexGroups);
  await copyFile(path.resolve("overseas-manga-ranking.html"), path.join(OUT_DIR, "overseas-manga-ranking.html"));

  console.log(`完了: ${entries.length}件の漫画ページを dist/manga/ に生成しました。`);
  if (failed.length > 0) {
    console.log(`取得失敗: ${failed.map((f) => f.title).join(", ")}`);
  }

  const sample = entries.slice(0, 3);
  for (const s of sample) {
    console.log(
      `  サンプル: ${s.title} / 累計=${s.total} / ピーク=${s.peak ? `${s.peak.date.toISOString().slice(0, 10)} (${s.peak.views})` : "なし"}`
    );
  }

  closeCache();

  console.log("漫画ランキングページ用の静的JSONを書き出し中...");
  await copyFile(path.resolve("manga-ranking.html"), path.join(OUT_DIR, "manga-ranking.html"));
  await exportDailyViews({ listFile: ALL_MANGA_LIST_FILE, outPrefix: "manga-daily-views" });

  console.log("海外漫画ランキングページ用の静的JSONを書き出し中...");
  const enMangaTitleMap = await loadEnMangaTitleMap();
  await exportDailyViews({
    titles: Object.keys(enMangaTitleMap),
    outPrefix: "overseas-manga-daily-views",
    project: "en.wikipedia",
    titleMap: enMangaTitleMap,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error("ビルド失敗:", e);
    process.exit(1);
  });
}
