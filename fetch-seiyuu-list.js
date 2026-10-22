// Wikidata SPARQLから日本の声優を役数(P725で担当した作品数)降順で抽出し、
// data/seiyuu-list.json に書き出す。
// node fetch-seiyuu-list.js

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "anime-pageviews-ranking-bot/1.0 (personal project)";
const OUT_DIR = path.resolve("data");
const OUT_FILE = path.join(OUT_DIR, "seiyuu-list.json");
const TARGET_COUNT = 40;

// 日本国籍(Q17)を持つ、P725(声の出演)で記録された人物を役数降順で抽出
const QUERY_STRICT = `
SELECT ?person ?sitelinkTitle (COUNT(DISTINCT ?work) AS ?roleCount) WHERE {
  ?work wdt:P725 ?person.
  ?person wdt:P27 wd:Q17.
  ?article schema:about ?person;
           schema:isPartOf <https://ja.wikipedia.org/>;
           schema:name ?sitelinkTitle.
}
GROUP BY ?person ?sitelinkTitle
ORDER BY DESC(?roleCount)
LIMIT 80
`;

// 国籍フィルタを外した版(ja.wikipedia記事があればOK)
const QUERY_LOOSE = `
SELECT ?person ?sitelinkTitle (COUNT(DISTINCT ?work) AS ?roleCount) WHERE {
  ?work wdt:P725 ?person.
  ?article schema:about ?person;
           schema:isPartOf <https://ja.wikipedia.org/>;
           schema:name ?sitelinkTitle.
}
GROUP BY ?person ?sitelinkTitle
ORDER BY DESC(?roleCount)
LIMIT 100
`;

// 職業=声優(Q245068)でja.wikipedia記事があれば拾う版(P725の有無に依存しない最終フォールバック)
const QUERY_OCCUPATION = `
SELECT ?person ?sitelinkTitle (COUNT(DISTINCT ?work) AS ?roleCount) WHERE {
  ?person wdt:P106 wd:Q245068.
  ?article schema:about ?person;
           schema:isPartOf <https://ja.wikipedia.org/>;
           schema:name ?sitelinkTitle.
  OPTIONAL { ?work wdt:P725 ?person. }
}
GROUP BY ?person ?sitelinkTitle
ORDER BY DESC(?roleCount)
LIMIT 100
`;

async function runQuery(query, label) {
  const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  console.log(`SPARQL実行中(${label})...`);
  const res = await fetch(url, {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) {
    throw new Error(`SPARQL HTTP ${res.status} (${label})`);
  }
  const data = await res.json();
  const bindings = data.results.bindings;
  console.log(`  -> ${bindings.length}件`);
  return bindings;
}

function dedupeAndSort(bindings) {
  const byPerson = new Map();
  for (const b of bindings) {
    const person = b.person.value;
    const name = b.sitelinkTitle.value;
    const roleCount = Number(b.roleCount.value);
    const existing = byPerson.get(person);
    if (!existing || roleCount > existing.roleCount) {
      byPerson.set(person, { name, roleCount });
    }
  }
  return Array.from(byPerson.values()).sort((a, b) => b.roleCount - a.roleCount);
}

async function main() {
  let bindings = await runQuery(QUERY_STRICT, "strict: P27=Q17 + P725");
  let list = dedupeAndSort(bindings);

  if (list.length < 20) {
    console.log("strict版が20件未満のため、国籍フィルタを外して再試行します。");
    bindings = await runQuery(QUERY_LOOSE, "loose: P725のみ");
    list = dedupeAndSort(bindings);
  }

  if (list.length < 20) {
    console.log("P725ベースでも20件未満のため、職業=声優(Q245068)ベースで再試行します。");
    bindings = await runQuery(QUERY_OCCUPATION, "occupation: P106=Q245068");
    list = dedupeAndSort(bindings);
  }

  const top = list.slice(0, TARGET_COUNT);

  console.log(`抽出件数: ${list.length}件 / 上位${top.length}件を採用`);
  console.log("上位10件:");
  top.slice(0, 10).forEach((e, i) => console.log(`  ${i + 1}. ${e.name} (roleCount=${e.roleCount})`));

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(top, null, 2), "utf-8");
  console.log(`書き出し完了: ${OUT_FILE}`);
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
