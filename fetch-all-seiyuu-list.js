// 「全声優」拡大のため、Wikidataから ja.wikipedia 記事を持つ
// 日本国籍かつ実際にP725(声の出演)実績があり、かつ職業(P106)が声優(Q622807)の人物を
// 全件抽出し、リダイレクトチェック済みの名前一覧を data/all-seiyuu-list.json に書き出す。
// (P725のみだとゲスト出演した俳優・タレント等まで混ざるため、職業条件も併せて絞り込む)
// node fetch-all-seiyuu-list.js

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "anime-pageviews-ranking-bot/1.0 (personal project)";
const PAGE_SIZE = 400;
const OUT_FILE = path.resolve("data", "all-seiyuu-list.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSparql(query, attempt = 0) {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/sparql-results+json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    if (attempt >= 5) throw new Error(`SPARQL failed (retries exhausted): ${e.message}`);
    await sleep(3000 * Math.pow(2, attempt));
    return runSparql(query, attempt + 1);
  }
  if (res.status === 429 || res.status === 503) {
    if (attempt >= 5) throw new Error(`SPARQL HTTP ${res.status} (retries exhausted)`);
    await sleep(3000 * Math.pow(2, attempt));
    return runSparql(query, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SPARQL HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.results.bindings;
}

async function fetchPage(offset) {
  const query = `
    SELECT DISTINCT ?title WHERE {
      ?work wdt:P725 ?person.
      ?person wdt:P106 wd:Q622807.
      ?person wdt:P27 wd:Q17.
      ?article schema:about ?person; schema:isPartOf <https://ja.wikipedia.org/>; schema:name ?title.
    }
    ORDER BY ?person
    LIMIT ${PAGE_SIZE}
    OFFSET ${offset}
  `;
  return runSparql(query);
}

async function fetchAllTitles() {
  const titles = new Set();
  let offset = 0;
  while (true) {
    console.log(`  取得中... offset=${offset}`);
    const rows = await fetchPage(offset);
    for (const r of rows) titles.add(r.title.value);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(1000);
  }
  return Array.from(titles);
}

async function fetchRedirectsForChunk(chunk, attempt = 0) {
  const param = chunk.map((t) => encodeURIComponent(t)).join("|");
  const url = `https://ja.wikipedia.org/w/api.php?action=query&titles=${param}&redirects=1&format=json`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20000) });
    if (res.status === 429 || res.status === 503) {
      if (attempt >= 8) throw new Error(`HTTP ${res.status} (retries exhausted)`);
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(2000 * Math.pow(2, attempt), 60000);
      await sleep(waitMs);
      return fetchRedirectsForChunk(chunk, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (attempt >= 8) throw new Error(`failed (retries exhausted): ${e.message}`);
    await sleep(Math.min(2000 * Math.pow(2, attempt), 60000));
    return fetchRedirectsForChunk(chunk, attempt + 1);
  }
}

async function checkRedirectsBatch(titles) {
  const resolved = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    try {
      const data = await fetchRedirectsForChunk(chunk);
      const redirectMap = new Map();
      for (const r of data.query.redirects || []) redirectMap.set(r.from, r.to);
      for (const t of chunk) resolved.set(t, redirectMap.get(t) || t);
    } catch (e) {
      console.warn(`  リダイレクト確認に最終的に失敗、このバッチはそのまま使用: ${e.message}`);
      for (const t of chunk) resolved.set(t, t);
    }
    await sleep(1000);
    console.log(`  リダイレクト確認 ${Math.min(i + 50, titles.length)}/${titles.length}`);
  }
  return resolved;
}

async function main() {
  console.log("Wikidataから日本国籍×声優役を持つ人物のja.wikipedia記事を全件取得中...");
  const rawTitles = await fetchAllTitles();
  console.log(`取得件数(重複排除前): ${rawTitles.length}`);

  console.log("リダイレクトチェック中...");
  const resolvedMap = await checkRedirectsBatch(rawTitles);

  const finalSet = new Set();
  let redirectCount = 0;
  for (const [from, to] of resolvedMap) {
    if (from !== to) redirectCount++;
    finalSet.add(to);
  }

  // 既存の厳選40名(data/seiyuu-list.json)も必ず含める
  try {
    const existingRaw = await readFile(path.resolve("data", "seiyuu-list.json"), "utf-8");
    const existingNames = JSON.parse(existingRaw).map((e) => e.name);
    for (const n of existingNames) finalSet.add(n);
  } catch {
    console.warn("既存のseiyuu-list.jsonが読めませんでした(なければ無視してよい)");
  }

  const finalList = Array.from(finalSet).sort();

  await mkdir(path.resolve("data"), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(finalList, null, 2), "utf-8");

  console.log(`完了: ${finalList.length}件(リダイレクト解消: ${redirectCount}件) を ${OUT_FILE} に書き出しました。`);
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
