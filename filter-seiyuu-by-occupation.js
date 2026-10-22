// 既存のdata/all-seiyuu-list.json.bak(P725ベースで取得済み・リダイレクトチェック済みの4911件)に対して、
// Wikidataの職業(P106)が声優(Q622807)の人物だけに絞り込む。
// 全件を再取得・再リダイレクトチェックする必要はなく、既存リストへのVALUES句一括問い合わせで済む。
// node filter-seiyuu-by-occupation.js

import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "anime-pageviews-ranking-bot/1.0 (personal project)";
const CHUNK_SIZE = 200;
const BACKUP_FILE = path.resolve("data", "all-seiyuu-list.json.bak");
const OUT_FILE = path.resolve("data", "all-seiyuu-list.json");
const SEIYUU_LIST_FILE = path.resolve("data", "seiyuu-list.json");
const PROGRESS_FILE = path.resolve("data", "seiyuu-occupation-filter-progress.json");

async function loadProgress() {
  try {
    return JSON.parse(await readFile(PROGRESS_FILE, "utf-8"));
  } catch {
    return { processedCount: 0, foundNames: [] };
  }
}

async function saveProgress(processedCount, foundNamesSet) {
  await writeFile(
    PROGRESS_FILE,
    JSON.stringify({ processedCount, foundNames: Array.from(foundNamesSet) }),
    "utf-8"
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function escapeSparqlString(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function checkChunk(names) {
  const values = names.map((n) => `"${escapeSparqlString(n)}"@ja`).join(" ");
  const query = `
    SELECT DISTINCT ?title WHERE {
      VALUES ?title { ${values} }
      ?article schema:isPartOf <https://ja.wikipedia.org/>; schema:name ?title; schema:about ?person.
      ?person wdt:P106 wd:Q622807.
    }
  `;
  const rows = await runSparqlPost(query);
  return new Set(rows.map((r) => r.title.value));
}

async function main() {
  const allList = JSON.parse(await readFile(BACKUP_FILE, "utf-8"));
  const progress = await loadProgress();
  const voiceActorNames = new Set(progress.foundNames);

  if (progress.processedCount > 0) {
    console.log(`前回の続きから再開: ${progress.processedCount}/${allList.length}件まで処理済み(該当: ${voiceActorNames.size}件)`);
  } else {
    console.log(`既存リスト: ${allList.length}件。職業=声優(Q622807)で絞り込み中...`);
  }

  for (let i = progress.processedCount; i < allList.length; i += CHUNK_SIZE) {
    const chunk = allList.slice(i, i + CHUNK_SIZE);
    const result = await checkChunk(chunk);
    for (const name of result) voiceActorNames.add(name);
    const processedCount = Math.min(i + CHUNK_SIZE, allList.length);
    console.log(`  確認済み ${processedCount}/${allList.length} 件 (該当: ${voiceActorNames.size}件)`);
    await saveProgress(processedCount, voiceActorNames);
    await sleep(500);
  }

  // 既存の厳選40名は必ず含める(occupation条件に関わらず)
  try {
    const existingRaw = await readFile(SEIYUU_LIST_FILE, "utf-8");
    const existingNames = JSON.parse(existingRaw).map((e) => e.name);
    for (const n of existingNames) voiceActorNames.add(n);
  } catch {
    console.warn("既存のseiyuu-list.jsonが読めませんでした(なければ無視してよい)");
  }

  const finalList = Array.from(voiceActorNames).sort();
  await writeFile(OUT_FILE, JSON.stringify(finalList, null, 2), "utf-8");
  await unlink(PROGRESS_FILE).catch(() => {});
  console.log(`完了: ${finalList.length}件(除外: ${allList.length - finalList.length}件) を ${OUT_FILE} に書き出しました。`);
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
