// 声優ごとの静的SEOページを生成するビルドスクリプト。
// node build-seiyuu.js で dist/seiyuu/ 以下に全声優ページ + 一覧を書き出し、
// dist/sitemap.xml に声優ページ分のURLを追記する。

import { stylesheetTag } from "./shared-assets.js";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDailyHistory, closeCache } from "./pageview-cache.js";
import { buildTrendWidget, TREND_WIDGET_CSS } from "./trend-widget.js";
import { exportDailyViews } from "./export-daily-views-lib.js";
import { loadYomiganaMap, groupByRow, getRow, getSortKey, buildKanaNav, buildRowToc, rowPageFileName, rowPageHref, KANA_NAV_CSS } from "./yomigana.js";
import { BACK_TO_TOP_CSS, BACK_TO_TOP_HTML, BACK_TO_TOP_SCRIPT } from "./back-to-top.js";
import { NAV_CONTEXT_SCRIPT } from "./nav-context.js";

const CROSSLINKS_FILE = path.resolve("data", "crosslinks.json");

async function loadCrosslinks() {
  try {
    const raw = await readFile(CROSSLINKS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { worksToCast: {}, seiyuuToWorks: {} };
  }
}

// キャラクターページ機能は見送り(Wikidata P1441のノイズ問題で単体記事の母数が
// 少なすぎた)。常に空集合を返し、出演作表示はWikipediaへの直リンクに統一する。
async function loadCharacterNames() {
  return new Set();
}

const SITE_URL = "https://kenshow1116-blip.github.io/anime-pageviews-ranking";

const SEIYUU_LIST_FILE = path.resolve("data", "seiyuu-list.json");
const ALL_SEIYUU_LIST_FILE = path.resolve("data", "all-seiyuu-list.json");

async function loadSeiyuuList() {
  try {
    const raw = await readFile(ALL_SEIYUU_LIST_FILE, "utf-8");
    const list = JSON.parse(raw);
    console.log(`data/all-seiyuu-list.json から${list.length}件を読み込みました。`);
    return list;
  } catch {
    const raw = await readFile(SEIYUU_LIST_FILE, "utf-8");
    return JSON.parse(raw).map((e) => e.name);
  }
}
const API_START = "20150701";
const LAG_DAYS = 2; // Wikimedia側のダンプ/API処理が2日分遅延しているため一時的に増やしている(2026-10-18判明)
const CONCURRENCY = 6;
const OUT_DIR = path.resolve("dist");
const SEIYUU_DIR = path.join(OUT_DIR, "seiyuu");
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

function computeTotal(items) {
  return items.reduce((sum, it) => sum + it.views, 0);
}

function computePeak(items) {
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
  .cast-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
  .cast-list li { background: var(--gridline); border-radius: 999px; padding: 5px 12px; font-size: 13px; }
  .cast-list a { color: var(--text-primary); text-decoration: none; }
  .cast-list a:hover { text-decoration: underline; }
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

function buildFilmographySection(works, characterNames) {
  if (!works || works.length === 0) return "";
  const items = works
    .map((w) => {
      const label = escapeHtml(w.title);
      const workLink = w.tracked
        ? `<a href="../works/${escapeHtml(safeFileName(w.title))}.html">${label}</a>`
        : `<a href="https://ja.wikipedia.org/wiki/${articleToApiPath(w.title)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      if (!w.character) return `<li>${workLink}</li>`;
      const characterLabel = escapeHtml(w.character);
      const characterLink = characterNames && characterNames.has(w.character)
        ? `<a href="../characters/${escapeHtml(safeFileName(w.character))}.html">${characterLabel}</a>`
        : `<a href="https://ja.wikipedia.org/wiki/${articleToApiPath(w.character)}" target="_blank" rel="noopener noreferrer">${characterLabel}</a>`;
      return `<li>${workLink}（${characterLink}役）</li>`;
    })
    .join("\n    ");
  return `
  <h2>出演作品</h2>
  <ul class="cast-list">
    ${items}
  </ul>`;
}

function buildSeiyuuPage(name, stat, totalCount, works, characterNames, row) {
  const { total, peak } = stat;
  const peakText = peak
    ? `最も多く閲覧されたのは${formatDateJa(peak.date)}で、その日は${formatViews(peak.views)}回のアクセスがありました。`
    : "";
  const description = `${name}さんの日本語版Wikipedia記事は2015年7月から現在までで累計${formatViews(total)}回閲覧されています。${peakText}`;
  const wikiUrl = "https://ja.wikipedia.org/wiki/" + articleToApiPath(name);

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(name)} のWikipedia閲覧数推移・累計${formatViews(total)}回</title>
<meta name="description" content="${escapeHtml(description)}">
${stylesheetTag("seiyuu", PAGE_CSS)}
</head>
<body>
<div class="wrap">
  <div class="top-link"><a href="../index.html">&larr; ホームに戻る</a></div>
  <div class="breadcrumb"><a href="../index.html">ホーム</a> &gt; <a href="index.html">声優一覧</a> &gt; <a href="${rowPageHref(row)}">${row === "その他" ? "その他" : `${row}行`}</a> &gt; ${escapeHtml(name)}</div>
  <h1>${escapeHtml(name)}</h1>
  <p class="stats">
    ${escapeHtml(name)}さんの日本語版Wikipedia記事は2015年7月から現在までで累計<strong>${formatViews(total)}回</strong>閲覧されています。
    ${peakText}
  </p>
  ${buildTrendWidget({ title: name, project: "ja.wikipedia", idbDbName: "seiyuuWorkPageCacheDB" })}
  ${buildFilmographySection(works, characterNames)}
  <div class="links">
    <a href="${wikiUrl}" target="_blank" rel="noopener noreferrer">Wikipediaで記事を読む</a>
    <a href="../seiyuu-ranking.html">声優ランキングに戻る</a>
    <a href="../index.html">ホームに戻る</a>
  </div>
  <p class="note">
    閲覧数データはWikimedia Pageviews API(ja.wikipedia, all-access, 人間アクセスのみ)に基づきます。
    2015年7月以前のデータはAPI側で提供されていないため集計には含まれません。
    対象声優リストはWikidataの出演作品数(P725)に基づき自動抽出した上位${totalCount}名です。
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

export function buildSeiyuuIndexPage(groups, totalCount) {
  const toc = buildRowToc(groups);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>声優一覧 - アニメ Wikipedia 閲覧数ランキング</title>
<meta name="description" content="日本語版Wikipediaの閲覧数データに基づく、声優の名前一覧(50音順)です。各声優のページでは累計閲覧数・推移を確認できます。対象はWikidataの出演作品数に基づき自動抽出した声優陣です。">
${stylesheetTag("seiyuu", PAGE_CSS)}
</head>
<body>
<div class="wrap">
  <div class="top-link"><a href="../index.html">&larr; ホームに戻る</a></div>
  <div class="breadcrumb"><a href="../index.html">ホーム</a> &gt; 声優一覧</div>
  <h1>声優一覧</h1>
  <p class="subtitle">行ごとのページに分かれています。見たい行を選んでください。</p>
  ${toc}
  <div class="links"><a href="../seiyuu-ranking.html">声優ランキングに戻る</a> <a href="../index.html">ホームに戻る</a></div>
  <p class="note">
    対象声優はWikidataで記録されている声の出演作品数(P725)の多い順に自動抽出した上位${totalCount}名です。
    並び順はWikipedia記事のDEFAULTSORT(読み仮名)に基づく50音順です。読み仮名が取得できなかった名前は「その他」に入ります。
  </p>
</div>
${BACK_TO_TOP_HTML}
${BACK_TO_TOP_SCRIPT}
</body>
</html>
`;
}

export function buildSeiyuuIndexRowPage(group, groups, totalCount) {
  const nav = buildKanaNav(groups, group.row);
  const heading = group.row === "その他" ? "その他" : `${group.row}行`;
  const items = group.items
    .map((e) => `<li><a href="${escapeHtml(safeFileName(e.name))}.html">${escapeHtml(e.name)}</a></li>`)
    .join("\n    ");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>声優一覧(${escapeHtml(heading)}) - アニメ Wikipedia 閲覧数ランキング</title>
<meta name="description" content="日本語版Wikipediaの閲覧数データに基づく、声優の名前一覧(${escapeHtml(heading)})です。">
${stylesheetTag("seiyuu", PAGE_CSS)}
</head>
<body>
<div class="wrap">
  <div class="top-link"><a href="../index.html">&larr; ホームに戻る</a></div>
  <div class="breadcrumb"><a href="../index.html">ホーム</a> &gt; <a href="index.html">声優一覧</a> &gt; ${escapeHtml(heading)}</div>
  <h1>声優一覧 — ${escapeHtml(heading)}</h1>
  ${nav}
  <ol class="stats">
    ${items}
  </ol>
  <div class="links"><a href="index.html">声優一覧トップに戻る</a> <a href="../seiyuu-ranking.html">声優ランキングに戻る</a> <a href="../index.html">ホームに戻る</a></div>
  <p class="note">
    対象声優はWikidataで記録されている声の出演作品数(P725)の多い順に自動抽出した上位${totalCount}名です。
    並び順はWikipedia記事のDEFAULTSORT(読み仮名)に基づく50音順です。読み仮名が取得できなかった名前は「その他」に入ります。
  </p>
</div>
${BACK_TO_TOP_HTML}
${BACK_TO_TOP_SCRIPT}
</body>
</html>
`;
}

const EN_SEIYUU_TITLES_FILE = path.resolve("data", "en-seiyuu-titles.json");

async function loadEnSeiyuuTitleMap() {
  try {
    return JSON.parse(await readFile(EN_SEIYUU_TITLES_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export async function updateSitemap(entries, indexGroups) {
  const seiyuuUrls = [
    `${SITE_URL}/seiyuu/index.html`,
    ...indexGroups.map((g) => `${SITE_URL}/seiyuu/${rowPageHref(g.row)}`),
    ...entries.map((e) => `${SITE_URL}/seiyuu/${encodeURIComponent(safeFileName(e.name))}.html`),
  ];
  const newLines = seiyuuUrls.map((u) => `  <url><loc>${u}</loc></url>`);

  let existingLines = [];
  try {
    const existing = await readFile(SITEMAP_FILE, "utf-8");
    existingLines = existing
      .split("\n")
      .filter((line) => line.includes("<url>") && !line.includes("/seiyuu/"));
  } catch {
    existingLines = [];
  }

  const body = [...existingLines, ...newLines].join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  await writeFile(SITEMAP_FILE, xml, "utf-8");
}

async function main() {
  const seiyuuList = await loadSeiyuuList();

  console.log(`対象声優数: ${seiyuuList.length}`);
  await mkdir(SEIYUU_DIR, { recursive: true });

  console.log("Wikipedia Pageviews APIから取得中(キャッシュ差分方式)...");
  const endDate = fmtDate(todayMinusLag());
  let apiFetchCount = 0;
  const results = await runPool(
    seiyuuList,
    (name) =>
      getDailyHistory("ja.wikipedia", name, API_START, endDate, (article, s, e) => {
        apiFetchCount++;
        console.log(`  [API取得] ${article} (${s}-${e})`);
        return fetchDailyHistoryRange(article, s, e);
      }),
    CONCURRENCY,
    (done, total, name) => {
      process.stdout.write(`  [${done}/${total}] ${name}\r\n`);
    }
  );
  console.log(`APIへの実リクエスト件数: ${apiFetchCount} / ${seiyuuList.length}件`);

  const failed = [];
  const itemsByName = new Map();
  seiyuuList.forEach((name, i) => {
    const r = results[i];
    if (!r.ok) {
      failed.push({ name, error: r.error ? r.error.message : "unknown" });
      itemsByName.set(name, []);
      return;
    }
    itemsByName.set(name, r.value);
  });

  if (failed.length > 0) {
    console.warn("取得失敗:", failed);
  }

  const entries = [];
  for (const name of seiyuuList) {
    const items = itemsByName.get(name);
    const total = computeTotal(items);
    const peak = computePeak(items);
    entries.push({ name, total, peak });
  }

  const crosslinks = await loadCrosslinks();
  const characterNames = await loadCharacterNames();
  const yomiganaMap = await loadYomiganaMap();

  console.log("静的ページを生成中...");
  for (const e of entries) {
    const works = crosslinks.seiyuuToWorks[e.name];
    const row = getRow(getSortKey(e.name, yomiganaMap));
    const html = buildSeiyuuPage(e.name, e, entries.length, works, characterNames, row);
    const fileName = safeFileName(e.name) + ".html";
    await writeFile(path.join(SEIYUU_DIR, fileName), html, "utf-8");
  }
  const indexGroups = groupByRow(entries, yomiganaMap, (e) => e.name);
  await writeFile(path.join(SEIYUU_DIR, "index.html"), buildSeiyuuIndexPage(indexGroups, entries.length), "utf-8");
  for (const group of indexGroups) {
    await writeFile(
      path.join(SEIYUU_DIR, rowPageFileName(group.row)),
      buildSeiyuuIndexRowPage(group, indexGroups, entries.length),
      "utf-8"
    );
  }
  await updateSitemap(entries, indexGroups);
  await copyFile(path.resolve("overseas-seiyuu-ranking.html"), path.join(OUT_DIR, "overseas-seiyuu-ranking.html"));

  console.log(`完了: ${entries.length}件の声優ページを dist/seiyuu/ に生成しました。`);
  if (failed.length > 0) {
    console.log(`取得失敗: ${failed.map((f) => f.name).join(", ")}`);
  }

  const sample = entries.slice(0, 3);
  for (const s of sample) {
    console.log(
      `  サンプル: ${s.name} / 累計=${s.total} / ピーク=${s.peak ? `${s.peak.date.toISOString().slice(0, 10)} (${s.peak.views})` : "なし"}`
    );
  }

  closeCache();

  console.log("声優ランキングページ用の静的JSONを書き出し中...");
  await copyFile(path.resolve("seiyuu-ranking.html"), path.join(OUT_DIR, "seiyuu-ranking.html"));
  await exportDailyViews({ listFile: ALL_SEIYUU_LIST_FILE, outPrefix: "seiyuu-daily-views" });

  console.log("海外声優ランキングページ用の静的JSONを書き出し中...");
  const enSeiyuuTitleMap = await loadEnSeiyuuTitleMap();
  await exportDailyViews({
    titles: Object.keys(enSeiyuuTitleMap),
    outPrefix: "overseas-seiyuu-daily-views",
    project: "en.wikipedia",
    titleMap: enSeiyuuTitleMap,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error("ビルド失敗:", e);
    process.exit(1);
  });
}
