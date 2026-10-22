// 各一覧ページ(アニメ/漫画/声優)をあいうえお順に並べるための読み仮名データを取得する。
// 日本語版Wikipediaの各記事に設定されているDEFAULTSORT(多くの日本語記事に読み仮名で
// 設定されている)を pageprops(ppprop=defaultsort) 経由で取得し、data/yomigana.json に
// title -> DEFAULTSORT文字列(取得できなければnull) の形でキャッシュする。
// (当初はprop=categories&clprop=sortkeyprefixで一括取得しようとしたが、cllimitが
// 「バッチ全体で共有される上限」であり複数タイトルを一括指定すると実質1件目しか
// 返らないという仕様上の罠があった。pagepropsはページ単位の単純な値なので
// 一括クエリしても欠落しない。2026-10-17判明。)
// 既存キャッシュにある記事は再取得しない(読みは変わらないので差分更新で十分)。
// node fetch-yomigana.js

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const WBAPI_ENDPOINT = "https://ja.wikipedia.org/w/api.php";
const USER_AGENT = "anime-pageviews-ranking-bot/1.0 (personal project)";
const CHUNK_SIZE = 50;
const CACHE_FILE = path.resolve("data", "yomigana.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadAllTitles() {
  const files = ["all-anime-list.json", "all-manga-list.json", "all-seiyuu-list.json"];
  const titleSet = new Set();
  for (const f of files) {
    const list = JSON.parse(await readFile(path.resolve("data", f), "utf-8"));
    for (const t of list) titleSet.add(t);
  }
  return Array.from(titleSet);
}

async function loadCache() {
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function fetchChunk(titles, attempt = 0) {
  const titlesParam = titles.map((t) => encodeURIComponent(t)).join("|");
  const url = `${WBAPI_ENDPOINT}?action=query&titles=${titlesParam}&prop=pageprops&ppprop=defaultsort&redirects=1&format=json&formatversion=2`;
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    if (attempt >= 6) throw new Error(`fetch failed (retries exhausted): ${e.message}`);
    await sleep(Math.min(2000 * Math.pow(2, attempt), 60000));
    return fetchChunk(titles, attempt + 1);
  }
  if (res.status === 429 || res.status === 503) {
    if (attempt >= 7) throw new Error(`HTTP ${res.status} (retries exhausted)`);
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Math.min(retryAfter > 0 ? retryAfter * 1000 : 2000 * Math.pow(2, attempt), 60000);
    await sleep(waitMs);
    return fetchChunk(titles, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const allTitles = await loadAllTitles();
  const cache = await loadCache();
  const targets = allTitles.filter((t) => !(t in cache));

  console.log(`対象タイトル総数: ${allTitles.length}件(キャッシュ済み: ${allTitles.length - targets.length}件、新規取得対象: ${targets.length}件)`);

  let processed = 0;
  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    const chunk = targets.slice(i, i + CHUNK_SIZE);
    const data = await fetchChunk(chunk);
    const pages = (data.query && data.query.pages) || [];

    // リダイレクト・正規化の解決: 返ってきたpage.titleが元のタイトルと異なる場合も、
    // normalized/redirectsのfrom/toで元タイトルに逆引きする。
    const resolvedTitleToOriginal = new Map(chunk.map((t) => [t, t]));
    for (const r of (data.query && data.query.normalized) || []) {
      if (resolvedTitleToOriginal.has(r.from)) resolvedTitleToOriginal.set(r.to, r.from);
    }
    for (const r of (data.query && data.query.redirects) || []) {
      const origin = resolvedTitleToOriginal.get(r.from) || r.from;
      resolvedTitleToOriginal.set(r.to, origin);
    }

    const foundOriginals = new Set();
    for (const page of pages) {
      const original = resolvedTitleToOriginal.get(page.title) || page.title;
      foundOriginals.add(original);
      const defaultsort = page.pageprops && page.pageprops.defaultsort ? page.pageprops.defaultsort : null;
      cache[original] = defaultsort;
    }
    // レスポンスに現れなかった(記事自体が見つからない等)タイトルもnullとして記録し、
    // 次回以降の再取得対象から外す。
    for (const t of chunk) {
      if (!foundOriginals.has(t) && !(t in cache)) cache[t] = null;
    }

    processed = Math.min(i + CHUNK_SIZE, targets.length);
    console.log(`  ${processed}/${targets.length}件`);
    await writeFile(CACHE_FILE, JSON.stringify(cache), "utf-8");
    await sleep(500);
  }

  const withReading = Object.values(cache).filter((v) => v !== null).length;
  console.log(`完了: キャッシュ総数${Object.keys(cache).length}件(読み仮名あり: ${withReading}件)`);
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
