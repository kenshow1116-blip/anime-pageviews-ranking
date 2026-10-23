// 作品ごとの静的SEOページを生成するビルドスクリプト。
// node build.js で dist/ 以下に全作品ページ + 一覧 + sitemap.xml を書き出す。

import { mkdir, writeFile, copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDailyHistory, closeCache } from "./pageview-cache.js";
import { buildTrendWidget, TREND_WIDGET_CSS } from "./trend-widget.js";
import { exportDailyViews } from "./export-daily-views-lib.js";
import { loadYomiganaMap, groupByRow, getRow, getSortKey, buildKanaNav, buildRowToc, rowPageFileName, rowPageHref, KANA_NAV_CSS } from "./yomigana.js";
import { BACK_TO_TOP_CSS, BACK_TO_TOP_HTML, BACK_TO_TOP_SCRIPT } from "./back-to-top.js";
import { NAV_CONTEXT_SCRIPT } from "./nav-context.js";

const CROSSLINKS_FILE = path.resolve("data", "crosslinks.json");

export async function loadCrosslinks() {
  try {
    const raw = await readFile(CROSSLINKS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { worksToCast: {}, seiyuuToWorks: {} };
  }
}

// キャラクターページ機能は見送り(Wikidata P1441のノイズ問題で単体記事の母数が
// 少なすぎた)。常に空集合を返し、キャスト表示はWikipediaへの直リンクに統一する。
export async function loadCharacterNames() {
  return new Set();
}

const EN_STATS_FILE = path.resolve("data", "en-work-stats.json");
const EN_TITLES_FILE = path.resolve("data", "en-titles.json");

export async function loadEnStats() {
  try {
    const raw = await readFile(EN_STATS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function loadEnTitleMap() {
  try {
    const raw = await readFile(EN_TITLES_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const METADATA_FILE = path.resolve("data", "metadata.json");

export async function loadMetadata() {
  try {
    const raw = await readFile(METADATA_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const SITE_URL = "https://kenshow1116-blip.github.io/anime-pageviews-ranking";

const FALLBACK_ANIME_LIST = [
  "ONE PIECE",
  "NARUTO -ナルト-",
  "BLEACH",
  "鋼の錬金術師",
  "進撃の巨人",
  "鬼滅の刃",
  "呪術廻戦",
  "僕のヒーローアカデミア",
  "転生したらスライムだった件",
  "Re:ゼロから始める異世界生活",
  "この素晴らしい世界に祝福を!",
  "SPY×FAMILY",
  "葬送のフリーレン",
  "【推しの子】",
  "新世紀エヴァンゲリオン",
  "コードギアス 反逆のルルーシュ",
  "STEINS;GATE",
  "機動戦士ガンダム",
  "名探偵コナン",
  "クレヨンしんちゃん",
  "ちびまる子ちゃん",
  "ドラえもん",
  "サザエさん",
  "魔法少女まどか☆マギカ",
  "ソードアート・オンライン",
  "五等分の花嫁",
  "東京卍リベンジャーズ",
  "チェンソーマン",
  "怪獣8号",
  "ブルーロック",
  "薬屋のひとりごと",
  "ワンパンマン",
  "デスノート",
  "銀魂",
  "ハイキュー!!",
  "SLAM DUNK",
  "ドラゴンボール",
];

const ALL_ANIME_LIST_FILE = path.resolve("data", "all-anime-list.json");

async function loadAnimeList() {
  try {
    const raw = await readFile(ALL_ANIME_LIST_FILE, "utf-8");
    const list = JSON.parse(raw);
    console.log(`data/all-anime-list.json から${list.length}件を読み込みました。`);
    return list;
  } catch {
    console.log("data/all-anime-list.json が見つからないため、既定の37作品リストを使用します。");
    return FALLBACK_ANIME_LIST;
  }
}

const API_START = "20150701";
const LAG_DAYS = 2; // Wikimedia側のダンプ/API処理が2日分遅延しているため一時的に増やしている(2026-10-18判明)
const CONCURRENCY = 6;
const OUT_DIR = path.resolve("dist");
const WORKS_DIR = path.join(OUT_DIR, "works");

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// fetch-daily-from-dump.jsのdefaultUtcLagDate()と同じUTC基準の計算にする。
// ローカル(JST)基準で「前日」を計算すると、fetch-daily-from-dump.jsが用意した
// データより1日新しい日付を要求してしまい、全記事に個別API差分フェッチが発生して
// 極端に遅くなる(2026-10-17に発覚、429バックオフ待ちがハングに見えた)。
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
      if (attempt >= 6) throw new Error(`HTTP 429 for ${title} (retries exhausted)`);
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : 2000 * Math.pow(2, attempt);
      await sleep(waitMs);
      return fetchDailyHistoryRange(title, startDate, endDate, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${title}`);
    const data = await res.json();
    return (data.items || []).map((it) => ({ ts: it.timestamp, views: it.views || 0 }));
  } catch (e) {
    if (attempt >= 6) throw new Error(`failed for ${title} (retries exhausted): ${e.message}`);
    await sleep(Math.min(2000 * Math.pow(2, attempt), 60000));
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
      await sleep(300); // 連続リクエストの間隔を空ける
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
  .meta-line { font-size: 13px; color: var(--text-secondary); margin: -8px 0 16px; }
  .meta-line a { color: var(--accent); text-decoration: none; }
  .meta-line a:hover { text-decoration: underline; }
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
  .subtitle { color: var(--text-secondary); font-size: 13px; margin: 0 0 20px; }
  ${TREND_WIDGET_CSS}
  ${KANA_NAV_CSS}
  ${BACK_TO_TOP_CSS}
`;

function buildCastSection(cast, characterNames) {
  if (!cast || cast.length === 0) return "";
  const items = cast
    .map((c) => {
      const label = escapeHtml(c.name);
      const personLink = c.tracked
        ? `<a href="../seiyuu/${escapeHtml(safeFileName(c.name))}.html">${label}</a>`
        : `<a href="https://ja.wikipedia.org/wiki/${articleToApiPath(c.name)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      if (!c.character) return `<li>${personLink}</li>`;
      const characterLabel = escapeHtml(c.character);
      const characterLink = characterNames && characterNames.has(c.character)
        ? `<a href="../characters/${escapeHtml(safeFileName(c.character))}.html">${characterLabel}</a>`
        : `<a href="https://ja.wikipedia.org/wiki/${articleToApiPath(c.character)}" target="_blank" rel="noopener noreferrer">${characterLabel}</a>`;
      return `<li>${personLink}（${characterLink}役）</li>`;
    })
    .join("\n    ");
  return `
  <h2>声優</h2>
  <ul class="cast-list">
    ${items}
  </ul>`;
}

function buildMetaLine(meta) {
  if (!meta) return "";
  const parts = [];
  if (meta.studios && meta.studios.length > 0) {
    const studioLinks = meta.studios
      .map((s) => `<a href="../studios/${escapeHtml(safeFileName(s))}.html">${escapeHtml(s)}</a>`)
      .join(" / ");
    parts.push(`制作会社: ${studioLinks}`);
  }
  if (meta.sourceType) {
    parts.push(`原作: <a href="../source/${escapeHtml(safeFileName(meta.sourceType))}.html">${escapeHtml(meta.sourceType)}</a>`);
  }
  if (parts.length === 0) return "";
  return `<p class="meta-line">${parts.join(" ／ ")}</p>`;
}

export function buildWorkPage(title, stat, cast, characterNames, meta, enStat, row) {
  const { total, peak } = stat;
  const peakText = peak
    ? `最も多く閲覧されたのは${formatDateJa(peak.date)}で、その日は${formatViews(peak.views)}回のアクセスがありました。`
    : "";
  const enCompareText = enStat
    ? `参考までに、英語版Wikipediaでは累計${formatViews(enStat.total)}回閲覧されています。`
    : "";
  const description = `『${title}』の日本語版Wikipedia記事は2015年7月から現在までで累計${formatViews(total)}回閲覧されています。${peakText}`;
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
  <div class="breadcrumb"><a href="../index.html">ホーム</a> &gt; <a href="index.html">作品一覧</a> &gt; <a href="${rowPageHref(row)}">${row === "その他" ? "その他" : `${row}行`}</a> &gt; ${escapeHtml(title)}</div>
  <h1>${escapeHtml(title)}</h1>
  ${buildMetaLine(meta)}
  <p class="stats">
    『${escapeHtml(title)}』の日本語版Wikipedia記事は2015年7月から現在までで累計<strong>${formatViews(total)}回</strong>閲覧されています。
    ${peakText}
    ${enCompareText}
  </p>
  ${buildTrendWidget({ title, project: "ja.wikipedia", idbDbName: "animeWorkPageCacheDB" })}
  ${buildCastSection(cast, characterNames)}
  <div class="links">
    <a href="${wikiUrl}" target="_blank" rel="noopener noreferrer">Wikipediaで記事を読む</a>
    <a href="../anime-ranking.html">ランキング一覧に戻る</a>
    <a href="../index.html">ホームに戻る</a>
  </div>
  <p class="note">
    閲覧数データはWikimedia Pageviews API(ja.wikipedia, all-access, 人間アクセスのみ)に基づきます。
    2015年7月以前のデータはAPI側で提供されていないため集計には含まれません。
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

export function buildIndexPage(groups) {
  const toc = buildRowToc(groups);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>作品一覧 - アニメ Wikipedia 閲覧数ランキング</title>
<meta name="description" content="日本語版Wikipediaの閲覧数データに基づく、アニメ作品ごとの累計閲覧数・推移の一覧ページです(50音順)。">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="top-link"><a href="../index.html">&larr; ホームに戻る</a></div>
  <div class="breadcrumb"><a href="../index.html">ホーム</a> &gt; 作品一覧</div>
  <h1>作品一覧</h1>
  <p class="subtitle">行ごとのページに分かれています。見たい行を選んでください。</p>
  ${toc}
  <div class="links"><a href="../anime-ranking.html">ランキング一覧に戻る</a> <a href="../index.html">ホームに戻る</a></div>
  <p class="note">
    並び順はWikipedia記事のDEFAULTSORT(読み仮名)に基づく50音順です。読み仮名が取得できなかった作品は「その他」に入ります。
  </p>
</div>
${BACK_TO_TOP_HTML}
${BACK_TO_TOP_SCRIPT}
</body>
</html>
`;
}

export function buildIndexRowPage(group, groups) {
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
<title>作品一覧(${escapeHtml(heading)}) - アニメ Wikipedia 閲覧数ランキング</title>
<meta name="description" content="日本語版Wikipediaの閲覧数データに基づく、アニメ作品ごとの累計閲覧数・推移の一覧ページ(${escapeHtml(heading)})です。">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="top-link"><a href="../index.html">&larr; ホームに戻る</a></div>
  <div class="breadcrumb"><a href="../index.html">ホーム</a> &gt; <a href="index.html">作品一覧</a> &gt; ${escapeHtml(heading)}</div>
  <h1>作品一覧 — ${escapeHtml(heading)}</h1>
  ${nav}
  <ol class="stats">
    ${items}
  </ol>
  <div class="links"><a href="index.html">作品一覧トップに戻る</a> <a href="../anime-ranking.html">ランキング一覧に戻る</a> <a href="../index.html">ホームに戻る</a></div>
  <p class="note">
    並び順はWikipedia記事のDEFAULTSORT(読み仮名)に基づく50音順です。読み仮名が取得できなかった作品は「その他」に入ります。
  </p>
</div>
${BACK_TO_TOP_HTML}
${BACK_TO_TOP_SCRIPT}
</body>
</html>
`;
}


export async function writeSitemap(entries, indexGroups) {
  // 既存のsitemap.xml(声優・キャラクターページ分など)を上書きせず、
  // /works/ の行だけを入れ替えて他のセクションは保持する。
  const worksUrls = [
    `${SITE_URL}/index.html`,
    `${SITE_URL}/anime-ranking.html`,
    `${SITE_URL}/seiyuu-ranking.html`,
    `${SITE_URL}/manga-ranking.html`,
    `${SITE_URL}/works/index.html`,
    ...indexGroups.map((g) => `${SITE_URL}/works/${rowPageHref(g.row)}`),
    `${SITE_URL}/overseas-ranking.html`,
    ...entries.map((e) => `${SITE_URL}/works/${encodeURIComponent(safeFileName(e.title))}.html`),
  ];
  const worksLines = worksUrls.map((u) => `  <url><loc>${u}</loc></url>`);

  let existingLines = [];
  try {
    const existing = await readFile(path.join(OUT_DIR, "sitemap.xml"), "utf-8");
    const rootIndexLine = `<loc>${SITE_URL}/index.html</loc>`;
    existingLines = existing
      .split("\n")
      .filter(
        (line) =>
          line.includes("<url>") &&
          !line.includes("/works/") &&
          !line.includes("overseas-ranking.html") &&
          !line.includes("anime-ranking.html") &&
          !line.includes("seiyuu-ranking.html") &&
          !line.includes("manga-ranking.html") &&
          !line.includes(rootIndexLine)
      );
  } catch {
    existingLines = [];
  }

  const body = [...worksLines, ...existingLines].join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  await writeFile(path.join(OUT_DIR, "sitemap.xml"), xml, "utf-8");
}

async function main() {
  const ANIME_LIST = await loadAnimeList();
  console.log(`対象作品数: ${ANIME_LIST.length}`);
  await mkdir(WORKS_DIR, { recursive: true });

  console.log("Wikipedia Pageviews APIから取得中(キャッシュ差分方式)...");
  const endDate = fmtDate(todayMinusLag());
  let apiFetchCount = 0;
  const results = await runPool(
    ANIME_LIST,
    (title) =>
      getDailyHistory("ja.wikipedia", title, API_START, endDate, (article, s, e) => {
        apiFetchCount++;
        console.log(`  [API取得] ${article} (${s}-${e})`);
        return fetchDailyHistoryRange(article, s, e);
      }),
    CONCURRENCY,
    (done, total, title) => {
      process.stdout.write(`  [${done}/${total}] ${title}\r\n`);
    }
  );
  console.log(`APIへの実リクエスト件数: ${apiFetchCount} / ${ANIME_LIST.length}件`);

  const failed = [];
  const itemsByTitle = new Map();
  ANIME_LIST.forEach((title, i) => {
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
  for (const title of ANIME_LIST) {
    const items = itemsByTitle.get(title);
    const total = computeTotal(items);
    const peak = computePeak(items);
    entries.push({ title, total, peak });
  }

  const crosslinks = await loadCrosslinks();
  const characterNames = await loadCharacterNames();
  const metadata = await loadMetadata();
  const enStats = await loadEnStats();
  const yomiganaMap = await loadYomiganaMap();

  console.log("静的ページを生成中...");
  for (const e of entries) {
    const cast = crosslinks.worksToCast[e.title];
    const meta = metadata[e.title];
    const enStat = enStats[e.title];
    const row = getRow(getSortKey(e.title, yomiganaMap));
    const html = buildWorkPage(e.title, e, cast, characterNames, meta, enStat, row);
    const fileName = safeFileName(e.title) + ".html";
    await writeFile(path.join(WORKS_DIR, fileName), html, "utf-8");
  }

  const indexGroups = groupByRow(entries, yomiganaMap, (e) => e.title);
  await writeFile(path.join(WORKS_DIR, "index.html"), buildIndexPage(indexGroups), "utf-8");
  for (const group of indexGroups) {
    await writeFile(path.join(WORKS_DIR, rowPageFileName(group.row)), buildIndexRowPage(group, indexGroups), "utf-8");
  }
  await writeSitemap(entries, indexGroups);
  await copyFile(path.resolve("anime-ranking.html"), path.join(OUT_DIR, "anime-ranking.html"));
  await copyFile(path.resolve("overseas-ranking.html"), path.join(OUT_DIR, "overseas-ranking.html"));
  await copyFile(path.resolve("index.html"), path.join(OUT_DIR, "index.html"));

  await mkdir(path.resolve("data"), { recursive: true });
  await writeFile(
    path.resolve("data", "work-stats.json"),
    JSON.stringify(entries.map((e) => ({ title: e.title, total: e.total })), null, 2),
    "utf-8"
  );

  console.log(`完了: ${entries.length}件の作品ページを dist/works/ に生成しました。`);
  if (failed.length > 0) {
    console.log(`取得失敗: ${failed.map((f) => f.title).join(", ")}`);
  }

  // サンプル表示
  const sample = entries.slice(0, 3);
  for (const s of sample) {
    console.log(
      `  サンプル: ${s.title} / 累計=${s.total} / ピーク=${s.peak ? `${s.peak.date.toISOString().slice(0,10)} (${s.peak.views})` : "なし"}`
    );
  }

  closeCache();

  console.log("ランキングページ用の静的JSONを書き出し中...");
  await exportDailyViews({ listFile: ALL_ANIME_LIST_FILE, outPrefix: "daily-views" });

  console.log("海外ランキングページ用の静的JSONを書き出し中...");
  const enTitleMap = await loadEnTitleMap();
  await exportDailyViews({
    titles: Object.keys(enTitleMap),
    outPrefix: "overseas-daily-views",
    project: "en.wikipedia",
    titleMap: enTitleMap,
  });
}

// 他スクリプトからページ生成関数だけを再利用するためにimportされた場合は
// 自動実行しない(node build.js で直接実行された場合のみ実行する)。
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error("ビルド失敗:", e);
    process.exit(1);
  });
}
