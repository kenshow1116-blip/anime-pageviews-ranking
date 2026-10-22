// fetch-en-titles.jsが解決した日本語→英語版タイトル対応表を使い、
// 英語版Wikipediaの累計閲覧数(2015年7月〜)を取得して海外ランキング用の統計ファイルを書き出す。
// アニメ(en-titles.json)・漫画(en-manga-titles.json)・声優(en-seiyuu-titles.json)の3カテゴリ分。
// 既存のpageview-cache.js(同じSQLiteキャッシュ)を使うため、既に取得済みのタイトルは
// キャッシュそのまま使用でAPI通信なし。
// node fetch-overseas-stats.js

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDailyHistory, closeCache } from "./pageview-cache.js";

const USER_AGENT = "anime-pageviews-ranking-bot/1.0 (personal project)";
const API_START = "20150701";
const LAG_DAYS = 1;
const CONCURRENCY = 1;

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function todayMinusLag() {
  const now = new Date();
  const utcToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  utcToday.setUTCDate(utcToday.getUTCDate() - LAG_DAYS);
  return utcToday;
}

function articleToApiPath(title) {
  return encodeURIComponent(title.replace(/ /g, "_"));
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
      console.log(`  [429] ${title} attempt=${attempt} wait=${waitMs}ms`);
      await sleep(waitMs);
      return fetchDailyHistoryRange(title, startDate, endDate, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${title}`);
    const data = await res.json();
    await sleep(600);
    return (data.items || []).map((it) => ({ ts: it.timestamp, views: it.views || 0 }));
  } catch (e) {
    if (attempt >= MAX_ATTEMPTS) throw new Error(`failed for ${title} (retries exhausted): ${e.message}`);
    console.log(`  [ERR] ${title} attempt=${attempt}: ${e.message}`);
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

async function processCategory(titlesFile, statsFile, label) {
  let jaToEn;
  try {
    jaToEn = JSON.parse(await readFile(path.resolve("data", titlesFile), "utf-8"));
  } catch {
    console.warn(`${label}: data/${titlesFile} が見つからないためスキップします(先にfetch-en-titles.jsを実行してください)。`);
    return;
  }
  const pairs = Object.entries(jaToEn); // [jaTitle, enTitle][]
  console.log(`=== ${label}: 対象${pairs.length}件の英語版閲覧数を取得中(キャッシュ差分方式) ===`);

  const endDate = fmtDate(todayMinusLag());
  let apiFetchCount = 0;
  const results = await runPool(
    pairs,
    ([, enTitle]) =>
      getDailyHistory("en.wikipedia", enTitle, API_START, endDate, (article, s, e) => {
        apiFetchCount++;
        return fetchDailyHistoryRange(article, s, e);
      }),
    CONCURRENCY,
    (done, total) => {
      if (done % 50 === 0 || done === total) console.log(`  ${label}: ${done}/${total}件`);
    }
  );
  console.log(`${label}: APIへの実リクエスト件数: ${apiFetchCount} / ${pairs.length}件`);

  const stats = {};
  const failed = [];
  pairs.forEach(([jaTitle, enTitle], i) => {
    const r = results[i];
    if (!r.ok) {
      failed.push({ jaTitle, enTitle, error: r.error ? r.error.message : "unknown" });
      return;
    }
    stats[jaTitle] = { enTitle, total: computeTotal(r.value) };
  });
  if (failed.length > 0) console.warn(`${label}: 取得失敗 ${failed.length}件:`, failed.slice(0, 5));

  await writeFile(path.resolve("data", statsFile), JSON.stringify(stats, null, 2), "utf-8");
  console.log(`${label}: data/${statsFile} に ${Object.keys(stats).length}件書き出しました。`);
}

async function main() {
  await processCategory("en-titles.json", "en-work-stats.json", "アニメ");
  await processCategory("en-manga-titles.json", "en-manga-stats.json", "漫画");
  await processCategory("en-seiyuu-titles.json", "en-seiyuu-stats.json", "声優");
  closeCache();
  console.log("完了: 3カテゴリ全ての海外閲覧数統計を書き出しました。");
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
