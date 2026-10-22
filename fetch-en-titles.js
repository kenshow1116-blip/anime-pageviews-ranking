// 日本語版Wikipediaタイトル→英語版Wikipediaタイトルを解決する。
// アニメ(data/all-anime-list.json)・漫画(data/all-manga-list.json)・
// 声優(data/all-seiyuu-list.json)の3リストそれぞれに対して実行し、
// data/en-titles.json / en-manga-titles.json / en-seiyuu-titles.json に書き出す。
// (当初はアニメ本編37件のみのハードコードだったが、海外ランキングをアニメ全件+
// 声優・漫画にも展開するため全件対応に変更。fetch-metadata.jsと同じ経緯。2026-10-17)
// node fetch-en-titles.js

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const WBAPI_ENDPOINT = "https://www.wikidata.org/w/api.php";
const EN_API_ENDPOINT = "https://en.wikipedia.org/w/api.php";
const USER_AGENT = "anime-pageviews-ranking-bot/1.0 (personal project)";
const CHUNK_SIZE = 50;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, attempt = 0) {
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    if (attempt >= 6) throw new Error(`fetch failed (retries exhausted): ${e.message}`);
    await sleep(Math.min(2000 * Math.pow(2, attempt), 60000));
    return fetchJsonWithRetry(url, attempt + 1);
  }
  if (res.status === 429 || res.status === 503) {
    if (attempt >= 7) throw new Error(`HTTP ${res.status} (retries exhausted)`);
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Math.min(retryAfter > 0 ? retryAfter * 1000 : 2000 * Math.pow(2, attempt), 60000);
    await sleep(waitMs);
    return fetchJsonWithRetry(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function resolveEnglishTitles(titles) {
  const jaToEn = new Map();
  for (let i = 0; i < titles.length; i += CHUNK_SIZE) {
    const chunk = titles.slice(i, i + CHUNK_SIZE);
    const titlesParam = chunk.map((t) => encodeURIComponent(t)).join("|");
    const url = `${WBAPI_ENDPOINT}?action=wbgetentities&sites=jawiki&titles=${titlesParam}&format=json&props=sitelinks&sitefilter=jawiki%7Cenwiki`;
    const data = await fetchJsonWithRetry(url);
    for (const key of Object.keys(data.entities || {})) {
      const entity = data.entities[key];
      if (entity.missing !== undefined) continue;
      const jawikiTitle = entity.sitelinks && entity.sitelinks.jawiki ? entity.sitelinks.jawiki.title : null;
      const enwikiTitle = entity.sitelinks && entity.sitelinks.enwiki ? entity.sitelinks.enwiki.title : null;
      if (!jawikiTitle) continue;
      const matched = chunk.find((t) => t === jawikiTitle);
      if (matched && enwikiTitle) jaToEn.set(matched, enwikiTitle);
    }
    console.log(`  英語版タイトル解決 ${Math.min(i + CHUNK_SIZE, titles.length)}/${titles.length}件`);
    await sleep(300);
  }
  return jaToEn;
}

async function resolveRedirects(enTitles) {
  const resolved = new Map(enTitles.map((t) => [t, t]));
  for (let i = 0; i < enTitles.length; i += CHUNK_SIZE) {
    const chunk = enTitles.slice(i, i + CHUNK_SIZE);
    const titlesParam = chunk.map((t) => encodeURIComponent(t)).join("|");
    const url = `${EN_API_ENDPOINT}?action=query&titles=${titlesParam}&redirects=1&format=json`;
    const data = await fetchJsonWithRetry(url);
    const redirects = (data.query && data.query.redirects) || [];
    for (const r of redirects) {
      resolved.set(r.from, r.to);
    }
    await sleep(300);
  }
  return resolved;
}

async function resolveListToFile(listFile, outFile, label) {
  const titles = JSON.parse(await readFile(path.resolve("data", listFile), "utf-8"));
  console.log(`=== ${label}: ${titles.length}件の英語版タイトルを解決中(wbgetentities) ===`);
  const jaToEn = await resolveEnglishTitles(titles);
  console.log(`${label}: 英語版記事あり ${jaToEn.size}/${titles.length}件`);

  console.log(`${label}: リダイレクト確認中(en.wikipedia)...`);
  const enTitlesRaw = Array.from(jaToEn.values());
  const redirectMap = await resolveRedirects(enTitlesRaw);

  const result = {};
  for (const [ja, en] of jaToEn.entries()) {
    result[ja] = redirectMap.get(en) || en;
  }

  await writeFile(path.resolve("data", outFile), JSON.stringify(result, null, 2), "utf-8");
  console.log(`${label}: data/${outFile} に ${Object.keys(result).length}件書き出しました。`);
}

async function main() {
  await mkdir(path.resolve("data"), { recursive: true });
  await resolveListToFile("all-anime-list.json", "en-titles.json", "アニメ");
  await resolveListToFile("all-manga-list.json", "en-manga-titles.json", "漫画");
  await resolveListToFile("all-seiyuu-list.json", "en-seiyuu-titles.json", "声優");
  console.log("完了: 3リスト全ての英語版タイトル解決が終わりました。");
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
