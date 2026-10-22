// 1時間分のpageviewsダンプだけを処理する単機能ワーカー。
// fetch-daily-from-dump.js から子プロセスとして呼ばれ、結果を標準出力にJSONで返す。
// (同一プロセス内で24時間分ループすると、何らかのリソース蓄積で徐々に遅くなる現象が
// 確認されたため、1時間ごとに使い捨てのプロセスにしてリセットする)
// 使い方: node fetch-hour-from-dump.js <YYYYMMDD> <hour> <targetDumpTitlesJsonFile>

import { readFile } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

const USER_AGENT = "anime-pageviews-ranking-bot/1.0 (personal project)";
const MAX_ATTEMPTS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dumpUrl(dateYmd, hour) {
  const y = dateYmd.slice(0, 4);
  const m = dateYmd.slice(4, 6);
  const hh = String(hour).padStart(2, "0");
  return `https://dumps.wikimedia.org/other/pageviews/${y}/${y}-${m}/pageviews-${dateYmd}-${hh}0000.gz`;
}

async function fetchHourCounts(dateYmd, hour, targetDumpTitles, attempt = 0) {
  const url = dumpUrl(dateYmd, hour);
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    if (attempt >= MAX_ATTEMPTS) throw new Error(`fetch failed (retries exhausted): ${e.message}`);
    await sleep(3000 * Math.pow(2, attempt));
    return fetchHourCounts(dateYmd, hour, targetDumpTitles, attempt + 1);
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    if (attempt >= MAX_ATTEMPTS) throw new Error(`HTTP ${res.status} (retries exhausted)`);
    await sleep(3000 * Math.pow(2, attempt));
    return fetchHourCounts(dateYmd, hour, targetDumpTitles, attempt + 1);
  }

  const counts = {};
  const nodeStream = Readable.fromWeb(res.body);
  const rl = createInterface({ input: nodeStream.pipe(createGunzip()) });
  for await (const line of rl) {
    if (line.length < 4) continue;
    if (line.charCodeAt(0) !== 106 /* 'j' */) continue;
    if (!(line.startsWith("ja ") || line.startsWith("ja.m "))) continue;

    const sp1 = line.indexOf(" ");
    const rest1 = line.slice(sp1 + 1);
    const sp2 = rest1.indexOf(" ");
    if (sp2 < 0) continue;
    const dumpTitle = rest1.slice(0, sp2);
    if (!targetDumpTitles.has(dumpTitle)) continue;

    const rest2 = rest1.slice(sp2 + 1);
    const sp3 = rest2.indexOf(" ");
    const views = Number(sp3 >= 0 ? rest2.slice(0, sp3) : rest2);
    if (!Number.isFinite(views)) continue;

    counts[dumpTitle] = (counts[dumpTitle] || 0) + views;
  }
  return counts;
}

async function main() {
  const [dateYmd, hourStr, titlesFile] = process.argv.slice(2);
  const hour = Number(hourStr);
  const titlesList = JSON.parse(await readFile(titlesFile, "utf-8"));
  const targetDumpTitles = new Set(titlesList);

  const counts = await fetchHourCounts(dateYmd, hour, targetDumpTitles);
  process.stdout.write(JSON.stringify(counts));
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
