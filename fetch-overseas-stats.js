// fetch-en-titles.jsが解決した日本語→英語版タイトル対応表を使い、
// 英語版Wikipediaの累計閲覧数(2015年7月〜)を取得して海外ランキング用の統計ファイルを書き出す。
// アニメ(en-titles.json)・漫画(en-manga-titles.json)・声優(en-seiyuu-titles.json)の3カテゴリ分。
// 既存のpageview-cache.js(同じSQLiteキャッシュ)を使うため、既に取得済みのタイトルは
// キャッシュそのまま使用でAPI通信なし。
// node fetch-overseas-stats.js
//
// GitHub Actionsのジョブには時間制限(5時間50分)があり、途中で打ち切られると取得済みの分まで
// Driveに書き戻されず全部無駄になる(2026-11-08に実際に発生)。そのため:
// - 3カテゴリ分の英語版記事をまとめ、最終取得日が古い順(未取得が最優先)に取得する
// - 時間予算(既定270分、環境変数OVERSEAS_TIME_BUDGET_MINで変更可)を超えたら新規取得をやめ、
//   残りはキャッシュにある分だけで統計を書き出して正常終了する(続きは次回、古い順なので自然に回る)

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDailyHistory, getCachedMax, getCachedRangeOnly, closeCache } from "./pageview-cache.js";

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

const TIME_BUDGET_MS = Number(process.env.OVERSEAS_TIME_BUDGET_MIN || 270) * 60 * 1000;
const startedAt = Date.now();

const CATEGORIES = [
  { titlesFile: "en-titles.json", statsFile: "en-work-stats.json", label: "アニメ" },
  { titlesFile: "en-manga-titles.json", statsFile: "en-manga-stats.json", label: "漫画" },
  { titlesFile: "en-seiyuu-titles.json", statsFile: "en-seiyuu-stats.json", label: "声優" },
];

async function loadPairs(titlesFile, label) {
  try {
    return Object.entries(JSON.parse(await readFile(path.resolve("data", titlesFile), "utf-8"))); // [jaTitle, enTitle][]
  } catch {
    console.warn(`${label}: data/${titlesFile} が見つからないためスキップします(先にfetch-en-titles.jsを実行してください)。`);
    return null;
  }
}

async function main() {
  const endDate = fmtDate(todayMinusLag());
  const categories = [];
  for (const c of CATEGORIES) {
    const pairs = await loadPairs(c.titlesFile, c.label);
    if (pairs) categories.push({ ...c, pairs });
  }

  // 取得対象の英語版記事(カテゴリ間の重複は1回だけ)を、最終取得日が古い順に並べる
  const enTitles = Array.from(new Set(categories.flatMap((c) => c.pairs.map(([, en]) => en))));
  const withMax = enTitles.map((en) => ({ en, max: getCachedMax("en.wikipedia", en) }));
  const needFetch = withMax.filter((x) => !x.max || x.max < endDate);
  needFetch.sort((a, b) => (a.max || "").localeCompare(b.max || ""));
  console.log(`英語版記事 ${enTitles.length}件のうち、更新が必要なもの ${needFetch.length}件(最終取得日が古い順に取得)`);

  let apiFetchCount = 0;
  let skippedForTime = 0;
  const failed = [];
  await runPool(
    needFetch,
    async ({ en }) => {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        skippedForTime++;
        return;
      }
      await getDailyHistory("en.wikipedia", en, API_START, endDate, (article, s, e) => {
        apiFetchCount++;
        return fetchDailyHistoryRange(article, s, e);
      });
    },
    CONCURRENCY,
    (done, total, item) => {
      if (done % 100 === 0 || done === total) {
        const min = ((Date.now() - startedAt) / 60000).toFixed(0);
        console.log(`  ${done}/${total}件 (${min}分経過)`);
      }
    }
  ).then((results) => {
    results.forEach((r, i) => {
      if (!r.ok) failed.push({ enTitle: needFetch[i].en, error: r.error ? r.error.message : "unknown" });
    });
  });
  console.log(`APIへの実リクエスト件数: ${apiFetchCount}件 / 時間切れで次回に回した件数: ${skippedForTime}件`);
  if (failed.length > 0) console.warn(`取得失敗 ${failed.length}件:`, failed.slice(0, 5));

  // 統計はキャッシュにある分から計算する(時間切れ・失敗した記事は前回取得分までの累計になる)
  for (const { pairs, statsFile, label } of categories) {
    const stats = {};
    for (const [jaTitle, enTitle] of pairs) {
      const items = getCachedRangeOnly("en.wikipedia", enTitle, API_START, endDate) || [];
      stats[jaTitle] = { enTitle, total: computeTotal(items) };
    }
    await writeFile(path.resolve("data", statsFile), JSON.stringify(stats, null, 2), "utf-8");
    console.log(`${label}: data/${statsFile} に ${Object.keys(stats).length}件書き出しました。`);
  }
  closeCache();
  console.log("完了: 3カテゴリ全ての海外閲覧数統計を書き出しました。");
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
