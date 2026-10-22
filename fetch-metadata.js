// 作品ごとの制作会社(P272)・原作(P144)をWikidataから取得し、data/metadata.json に書き出す。
// 対象は data/all-anime-list.json の全件(当初は本編37作品のみのハードコードだったが、
// 制作会社ランキング・原作別ランキングのデータが37件分しか無かったため全件対応に変更)。
// node fetch-metadata.js

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const WBAPI_ENDPOINT = "https://www.wikidata.org/w/api.php";
const USER_AGENT = "anime-pageviews-ranking-bot/1.0 (personal project)";
const ALL_ANIME_LIST_FILE = path.resolve("data", "all-anime-list.json");
const CHUNK_SIZE = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWbgetentities(url, attempt = 0) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 429 || res.status === 503) {
    if (attempt >= 7) throw new Error(`wbgetentities HTTP ${res.status} (retries exhausted)`);
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Math.min(retryAfter > 0 ? retryAfter * 1000 : 1000 * Math.pow(2, attempt), 60000);
    await sleep(waitMs);
    return fetchWbgetentities(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`wbgetentities HTTP ${res.status}`);
  return res.json();
}

async function resolveQidsViaApi(titles) {
  const titleToQid = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    const titlesParam = chunk.map((t) => encodeURIComponent(t)).join("|");
    const url = `${WBAPI_ENDPOINT}?action=wbgetentities&sites=jawiki&titles=${titlesParam}&format=json&props=sitelinks&sitefilter=jawiki`;
    const data = await fetchWbgetentities(url);
    for (const key of Object.keys(data.entities || {})) {
      const entity = data.entities[key];
      if (entity.missing !== undefined) continue;
      const qid = entity.id;
      const jawikiTitle = entity.sitelinks && entity.sitelinks.jawiki ? entity.sitelinks.jawiki.title : null;
      if (!jawikiTitle) continue;
      const matched = chunk.find((t) => t === jawikiTitle);
      if (matched) titleToQid.set(matched, qid);
    }
    console.log(`  QID解決 ${Math.min(i + 50, titles.length)}/${titles.length}件`);
    await sleep(500);
  }
  return titleToQid;
}

async function runSparqlPost(query, attempt = 0) {
  let res;
  try {
    res = await fetch(SPARQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/sparql-query; charset=utf-8",
        Accept: "application/sparql-results+json",
        "User-Agent": USER_AGENT,
      },
      body: query,
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    if (attempt >= 5) throw new Error(`SPARQL failed (retries exhausted): ${e.message}`);
    await sleep(3000 * Math.pow(2, attempt));
    return runSparqlPost(query, attempt + 1);
  }
  if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
    if (attempt >= 8) throw new Error(`SPARQL HTTP ${res.status} (retries exhausted)`);
    await sleep(Math.min(3000 * Math.pow(2, attempt), 60000));
    return runSparqlPost(query, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SPARQL HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.results.bindings;
}

function qidOf(uri) {
  return uri.replace("http://www.wikidata.org/entity/", "");
}

function classifySourceType(workTypeLabels) {
  // workTypeLabels は作品自身のP31(instance of)ラベル群。
  // Wikipediaの記事がそのまま原作(漫画/小説等)の項目を指しているケースが多いため、
  // 「作品自身が何であるか」で判定する(基になった別作品の有無では判定しない)。
  for (const label of workTypeLabels) {
    if (label.includes("漫画")) return "漫画";
  }
  for (const label of workTypeLabels) {
    if (label.includes("ライトノベル")) return "ライトノベル";
  }
  for (const label of workTypeLabels) {
    if (label.includes("小説")) return "小説";
  }
  for (const label of workTypeLabels) {
    if (label.includes("ゲーム")) return "ゲーム";
  }
  for (const label of workTypeLabels) {
    if (label.includes("アニメ")) return "オリジナル";
  }
  return workTypeLabels.length > 0 ? "その他" : "オリジナル";
}

async function fetchChunkRows(qidChunk) {
  const workValues = qidChunk.map((q) => `wd:${q}`).join(" ");

  const ownRows = await runSparqlPost(
    `SELECT ?work ?workTypeLabel ?studioLabel WHERE {
      VALUES ?work { ${workValues} }
      OPTIONAL { ?work wdt:P31 ?workType. }
      OPTIONAL { ?work wdt:P272 ?studio. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en". }
    }`
  );
  await sleep(500);

  const adaptationRows = await runSparqlPost(
    `SELECT ?work ?adaptationTypeLabel ?studioLabel WHERE {
      VALUES ?work { ${workValues} }
      ?adaptation wdt:P144 ?work.
      OPTIONAL { ?adaptation wdt:P31 ?adaptationType. }
      OPTIONAL { ?adaptation wdt:P272 ?studio. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en". }
    }`
  );
  await sleep(500);

  return { ownRows, adaptationRows };
}

async function main() {
  const animeList = JSON.parse(await readFile(ALL_ANIME_LIST_FILE, "utf-8"));
  console.log(`作品${animeList.length}件のQIDを解決中(wbgetentities)...`);
  const workQidMap = await resolveQidsViaApi(animeList);
  console.log(`QID解決: ${workQidMap.size}/${animeList.length}件`);
  const missing = animeList.filter((t) => !workQidMap.has(t));
  if (missing.length) console.warn(`QID未解決: ${missing.length}件(スキップ)`);

  const qidToTitle = new Map(Array.from(workQidMap.entries()).map(([t, q]) => [q, t]));
  const allQids = Array.from(workQidMap.values());

  const workTypeLabelsByWork = new Map();
  const ownStudiosByWork = new Map();
  const adaptationStudiosByWork = new Map();
  for (const title of animeList) {
    workTypeLabelsByWork.set(title, new Set());
    ownStudiosByWork.set(title, new Set());
    adaptationStudiosByWork.set(title, new Set());
  }

  console.log(`作品自身の種別(P31)・制作会社(P272)、アニメ化作品の逆引き(P144)をSPARQLで取得中(${CHUNK_SIZE}件ずつ)...`);
  for (let i = 0; i < allQids.length; i += CHUNK_SIZE) {
    const chunk = allQids.slice(i, i + CHUNK_SIZE);
    const { ownRows, adaptationRows } = await fetchChunkRows(chunk);

    for (const row of ownRows) {
      if (!row.work) continue;
      const title = qidToTitle.get(qidOf(row.work.value));
      if (!title) continue;
      if (row.workTypeLabel) workTypeLabelsByWork.get(title).add(row.workTypeLabel.value);
      if (row.studioLabel) ownStudiosByWork.get(title).add(row.studioLabel.value);
    }
    for (const row of adaptationRows) {
      if (!row.work) continue;
      const title = qidToTitle.get(qidOf(row.work.value));
      if (!title) continue;
      if (row.studioLabel) adaptationStudiosByWork.get(title).add(row.studioLabel.value);
    }
    console.log(`  ${Math.min(i + CHUNK_SIZE, allQids.length)}/${allQids.length}件`);
  }

  const metadata = {};
  for (const title of animeList) {
    if (!workQidMap.has(title)) continue; // QID未解決はスキップ
    const workTypeLabels = Array.from(workTypeLabelsByWork.get(title));
    const ownStudios = Array.from(ownStudiosByWork.get(title));
    const adaptationStudios = Array.from(adaptationStudiosByWork.get(title));
    const studios = ownStudios.length > 0 ? ownStudios : adaptationStudios;
    const sourceType = classifySourceType(workTypeLabels);
    metadata[title] = {
      studios: studios.length > 0 ? studios : null,
      sourceType,
    };
  }

  await writeFile(path.resolve("data", "metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");

  const studioCounts = new Map();
  const sourceCounts = new Map();
  for (const title of Object.keys(metadata)) {
    const m = metadata[title];
    if (m.studios) {
      for (const s of m.studios) studioCounts.set(s, (studioCounts.get(s) || 0) + 1);
    }
    sourceCounts.set(m.sourceType, (sourceCounts.get(m.sourceType) || 0) + 1);
  }

  console.log(`完了: ${Object.keys(metadata).length}/${animeList.length}件の作品にメタデータを付与しました。`);
  console.log(`制作会社数: ${studioCounts.size}件`);
  console.log("原作種類ごとの件数:", Object.fromEntries(sourceCounts));
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
