// 英語版(en.wikipedia)の作品ごとの静的ページを生成するビルドスクリプト。
// node build-en.js で dist/en/works/ 以下に英語版作品ページ + 一覧を書き出し、
// dist/sitemap.xml に /en/ 配下のURLを追記する。

import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { getDailyHistory, closeCache } from "./pageview-cache.js";

const EN_TITLES_FILE = path.resolve("data", "en-titles.json");
const JA_STATS_FILE = path.resolve("data", "work-stats.json");
const EN_STATS_FILE = path.resolve("data", "en-work-stats.json");
const SITE_URL = "https://example.com"; // build.js と同じ値(ドメインが決まったら両方変更する)

const API_START = "20150701";
const LAG_DAYS = 1;
const CONCURRENCY = 1;
const OUT_DIR = path.resolve("dist");
const EN_DIR = path.join(OUT_DIR, "en");
const EN_WORKS_DIR = path.join(EN_DIR, "works");
const USER_AGENT = "anime-pageviews-ranking-bot/1.0 (personal project)";

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function todayMinusLag() {
  const d = new Date();
  d.setDate(d.getDate() - LAG_DAYS);
  return d;
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

function safeFileName(title) {
  return title.replace(/[\\/:*?"<>|]/g, "_");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_ATTEMPTS = 7;
const MAX_BACKOFF_MS = 60000;

async function fetchDailyHistoryRange(title, startDate, endDate, attempt = 0) {
  const article = articleToApiPath(title);
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${article}/daily/${startDate}/${endDate}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "User-Agent": USER_AGENT } });
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
      await sleep(800);
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

function computeMonthlySeries(items) {
  const byMonth = new Map();
  for (const it of items) {
    const key = it.ts.slice(0, 6);
    byMonth.set(key, (byMonth.get(key) || 0) + it.views);
  }
  const keys = Array.from(byMonth.keys()).sort();
  let running = 0;
  return keys.map((key) => {
    running += byMonth.get(key);
    const y = Number(key.slice(0, 4));
    const m = Number(key.slice(4, 6));
    return { date: new Date(y, m - 1, 1), value: running };
  });
}

function formatViews(n) {
  return n.toLocaleString("en-US");
}

function formatDateEn(d) {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildMonthlyChartSvg(series) {
  const W = 640, H = 200, padL = 50, padR = 14, padT = 14, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = series.length;
  if (n === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="trend-svg"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="axis-label">No data</text></svg>`;
  }
  const values = series.map((p) => p.value);
  const maxRaw = Math.max(1, ...values);
  const magnitude = Math.pow(10, Math.floor(Math.log10(maxRaw)));
  const steps = [1, 2, 5, 10];
  let maxV = 10 * magnitude;
  for (const s of steps) {
    if (maxRaw <= s * magnitude) { maxV = s * magnitude; break; }
  }
  const xAt = (i) => padL + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const yAt = (v) => padT + plotH - (v / maxV) * plotH;

  let gridSvg = "";
  [0, 0.5, 1].forEach((frac) => {
    const y = padT + plotH * (1 - frac);
    gridSvg += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" class="grid-line"/>`;
    gridSvg += `<text x="${padL - 6}" y="${y + 3}" text-anchor="end" class="axis-label">${Math.round(maxV * frac).toLocaleString("en-US")}</text>`;
  });

  let d = `M ${xAt(0)} ${yAt(values[0])}`;
  for (let i = 1; i < n; i++) d += ` L ${xAt(i)} ${yAt(values[i])}`;
  const areaD = `${d} L ${xAt(n - 1)} ${padT + plotH} L ${xAt(0)} ${padT + plotH} Z`;

  const monthLabel = (date) => `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}`;
  const firstLabel = monthLabel(series[0].date);
  const lastLabel = monthLabel(series[n - 1].date);
  const endX = xAt(n - 1), endY = yAt(values[n - 1]);

  const pointsForJs = series.map((p, i) => ({ x: Number(xAt(i).toFixed(2)), y: Number(yAt(p.value).toFixed(2)), label: monthLabel(p.date), value: p.value }));

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="${H}" class="trend-svg" id="chartSvg">
    ${gridSvg}
    <path d="${areaD}" class="trend-area"/>
    <path d="${d}" class="trend-line"/>
    <circle cx="${endX}" cy="${endY}" r="4" class="trend-dot"/>
    <text x="${padL}" y="${H - 6}" text-anchor="start" class="axis-label">${firstLabel}</text>
    <text x="${W - padR}" y="${H - 6}" text-anchor="end" class="axis-label">${lastLabel}</text>
    <line x1="0" x2="0" y1="${padT}" y2="${padT + plotH}" class="crosshair" id="crosshair" style="opacity:0"/>
    <circle r="5" class="trend-dot" id="hoverDot" style="opacity:0"/>
    <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent" id="chartOverlay" style="cursor:crosshair"/>
  </svg>
  <script>
    (function(){
      var svg = document.getElementById("chartSvg");
      var overlay = document.getElementById("chartOverlay");
      var crosshair = document.getElementById("crosshair");
      var hoverDot = document.getElementById("hoverDot");
      var tooltip = document.getElementById("tooltip");
      var points = ${JSON.stringify(pointsForJs)};
      var W = ${W}, padL = ${padL}, plotW = ${plotW};
      overlay.addEventListener("pointermove", function(ev){
        var rect = svg.getBoundingClientRect();
        var relX = (ev.clientX - rect.left) * (W / rect.width);
        var idx = Math.round(((relX - padL) / plotW) * (points.length - 1));
        idx = Math.max(0, Math.min(points.length - 1, idx));
        var p = points[idx];
        crosshair.setAttribute("x1", p.x); crosshair.setAttribute("x2", p.x);
        crosshair.style.opacity = 1;
        hoverDot.setAttribute("cx", p.x); hoverDot.setAttribute("cy", p.y);
        hoverDot.style.opacity = 1;
        tooltip.innerHTML = p.label + " <strong>" + p.value.toLocaleString("en-US") + "</strong> views";
        tooltip.style.left = ev.clientX + "px";
        tooltip.style.top = (ev.clientY - 10) + "px";
        tooltip.classList.add("visible");
      });
      overlay.addEventListener("pointerleave", function(){
        crosshair.style.opacity = 0;
        hoverDot.style.opacity = 0;
        tooltip.classList.remove("visible");
      });
    })();
  </script>`;
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
  h1 { font-size: 24px; font-weight: 700; margin: 0 0 6px; }
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
`;

function buildWorkPage(enTitle, jaTitle, stat, jaPageExists, jaTotal) {
  const { total, peak, monthlySeries } = stat;
  const peakText = peak
    ? `The most-viewed day was ${formatDateEn(peak.date)}, with ${formatViews(peak.views)} views.`
    : "";
  const compareText = jaTotal
    ? ` For comparison, the Japanese Wikipedia article has been viewed ${formatViews(jaTotal)} times.`
    : "";
  const description = `The English Wikipedia article for "${enTitle}" has been viewed a total of ${formatViews(total)} times since July 2015. ${peakText}${compareText}`;
  const wikiUrl = "https://en.wikipedia.org/wiki/" + articleToApiPath(enTitle);
  const jaLink = jaPageExists
    ? `<a href="../../works/${escapeHtml(safeFileName(jaTitle))}.html">View Japanese-language stats${jaTotal ? ` (${formatViews(jaTotal)} views)` : ""}</a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(enTitle)} - Wikipedia Pageview Trends</title>
<meta name="description" content="${escapeHtml(description)}">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="top-link"><a href="../index.html">&larr; Back to ranking</a></div>
  <div class="breadcrumb"><a href="../index.html">Anime Wikipedia Pageview Ranking</a> &gt; ${escapeHtml(enTitle)}</div>
  <h1>${escapeHtml(enTitle)}</h1>
  <p class="stats">
    The English Wikipedia article for "<strong>${escapeHtml(enTitle)}</strong>" has been viewed a total of <strong>${formatViews(total)} times</strong> since July 2015.
    ${peakText}
    ${compareText}
  </p>
  <div class="chart-wrap">
    ${buildMonthlyChartSvg(monthlySeries)}
  </div>
  <div class="links">
    <a href="${wikiUrl}" target="_blank" rel="noopener noreferrer">Read the article on Wikipedia</a>
    <a href="../index.html">Back to ranking</a>
    ${jaLink}
  </div>
  <p class="note">
    Data from the Wikimedia Pageviews API (en.wikipedia, all-access, human traffic only).
    Views before July 2015 are not available from the API.
  </p>
</div>
<div class="tooltip" id="tooltip"></div>
</body>
</html>
`;
}

function buildIndexPage(entries) {
  const sorted = [...entries].sort((a, b) => b.total - a.total);
  const rows = sorted
    .map(
      (e, i) =>
        `<li><a href="${escapeHtml(safeFileName(e.enTitle))}.html">${escapeHtml(e.enTitle)}</a> — ${formatViews(e.total)} total views</li>`
    )
    .join("\n    ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Anime Works - Wikipedia Pageview Ranking</title>
<meta name="description" content="A ranking of anime series by English Wikipedia pageviews, with per-title trend charts.">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="top-link"><a href="../index.html">&larr; Back to ranking</a></div>
  <div class="breadcrumb"><a href="../index.html">Anime Wikipedia Pageview Ranking</a> &gt; Works</div>
  <h1>Works</h1>
  <ol class="stats">
    ${rows}
  </ol>
  <div class="links"><a href="../index.html">Back to ranking</a></div>
</div>
</body>
</html>
`;
}

async function writeSitemap(entries) {
  const enUrls = [
    `${SITE_URL}/en/index.html`,
    `${SITE_URL}/en/works/index.html`,
    ...entries.map((e) => `${SITE_URL}/en/works/${encodeURIComponent(safeFileName(e.enTitle))}.html`),
  ];
  const enLines = enUrls.map((u) => `  <url><loc>${u}</loc></url>`);

  let existingLines = [];
  try {
    const existing = await readFile(path.join(OUT_DIR, "sitemap.xml"), "utf-8");
    existingLines = existing
      .split("\n")
      .filter((line) => line.includes("<url>") && !line.includes("/en/"));
  } catch {
    existingLines = [];
  }

  const body = [...enLines, ...existingLines].join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  await writeFile(path.join(OUT_DIR, "sitemap.xml"), xml, "utf-8");
}

async function main() {
  const raw = await readFile(EN_TITLES_FILE, "utf-8");
  const jaToEn = JSON.parse(raw);
  const pairs = Object.entries(jaToEn); // [jaTitle, enTitle][]

  let jaStatsMap = new Map();
  try {
    const jaStatsRaw = await readFile(JA_STATS_FILE, "utf-8");
    jaStatsMap = new Map(JSON.parse(jaStatsRaw).map((e) => [e.title, e.total]));
  } catch {
    console.warn("data/work-stats.json が見つからないため、日本語版の累計閲覧数の比較表示は省略します。");
  }

  console.log(`対象作品数(英語版記事あり): ${pairs.length}`);
  await mkdir(EN_WORKS_DIR, { recursive: true });

  console.log("Wikipedia Pageviews API(en.wikipedia)から取得中(キャッシュ差分方式)...");
  const endDate = fmtDate(todayMinusLag());
  let apiFetchCount = 0;
  const results = await runPool(
    pairs,
    ([, enTitle]) =>
      getDailyHistory("en.wikipedia", enTitle, API_START, endDate, (article, s, e) => {
        apiFetchCount++;
        console.log(`  [API取得] ${article} (${s}-${e})`);
        return fetchDailyHistoryRange(article, s, e);
      }),
    CONCURRENCY,
    (done, total, pair) => {
      process.stdout.write(`  [${done}/${total}] ${pair[1]}\r\n`);
    }
  );
  console.log(`APIへの実リクエスト件数: ${apiFetchCount} / ${pairs.length}件`);

  const failed = [];
  const entries = [];
  pairs.forEach(([jaTitle, enTitle], i) => {
    const r = results[i];
    if (!r.ok) {
      failed.push({ enTitle, error: r.error ? r.error.message : "unknown" });
      return;
    }
    const items = r.value;
    const total = computeTotal(items);
    const peak = computePeak(items);
    const monthlySeries = computeMonthlySeries(items);
    entries.push({ jaTitle, enTitle, total, peak, monthlySeries });
  });

  if (failed.length > 0) {
    console.warn("取得失敗:", failed);
  }

  console.log("静的ページを生成中...");
  for (const e of entries) {
    const jaTotal = jaStatsMap.get(e.jaTitle) || null;
    const html = buildWorkPage(e.enTitle, e.jaTitle, e, true, jaTotal);
    const fileName = safeFileName(e.enTitle) + ".html";
    await writeFile(path.join(EN_WORKS_DIR, fileName), html, "utf-8");
  }

  await writeFile(path.join(EN_WORKS_DIR, "index.html"), buildIndexPage(entries), "utf-8");

  const enStats = {};
  for (const e of entries) {
    enStats[e.jaTitle] = { enTitle: e.enTitle, total: e.total };
  }
  await writeFile(EN_STATS_FILE, JSON.stringify(enStats, null, 2), "utf-8");
  await writeSitemap(entries);
  await copyFile(path.resolve("index-en.html"), path.join(EN_DIR, "index.html"));

  console.log(`完了: ${entries.length}件の英語版作品ページを dist/en/works/ に生成しました。`);
  if (failed.length > 0) {
    console.log(`取得失敗: ${failed.map((f) => f.enTitle).join(", ")}`);
  }

  const sample = entries.slice(0, 3);
  for (const s of sample) {
    console.log(
      `  サンプル: ${s.enTitle} / 累計=${s.total} / ピーク=${s.peak ? `${s.peak.date.toISOString().slice(0, 10)} (${s.peak.views})` : "なし"}`
    );
  }

  closeCache();
}

main().catch((e) => {
  console.error("ビルド失敗:", e);
  process.exit(1);
});
