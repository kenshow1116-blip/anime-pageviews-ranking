// Wikimediaの時間別pageviewsダンプ(dumps.wikimedia.org/other/pageviews/)から
// 指定日24時間分を取得し、対象記事(アニメ全件+声優全件)のja.wikipedia閲覧数
// (デスクトップ"ja"+モバイル"ja.m"の合算)をpageviews.dbに書き込む。
// 個別記事ごとにWikimedia REST APIを叩かずに済むため、大量の記事を一括更新する
// 日次更新で429レート制限を避けられる。
//
// 1時間分の取得は fetch-hour-from-dump.js に子プロセスとして委譲する。同一プロセス内で
// 24時間分を素直にループすると、何らかのリソース蓄積(詳細未特定)で徐々に遅くなる現象が
// 確認されたため、1時間ごとに使い捨てのプロセスにしてリセットしている。
//
// 使い方: node fetch-daily-from-dump.js [YYYYMMDD]  (省略時はUTC基準の前日)

import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);
const DB_PATH = path.resolve("data", "pageviews.db");

// UTC基準の「今日」の日付文字列。対象日がこれと一致する場合はdist/data/hourly-today.jsonを、
// 「前日」(=この日次更新が確定済みとして処理する日、通常は夜間の本更新で丸ごと取得する日)と
// 一致する場合はdist/data/hourly-yesterday.jsonを書き出す。クライアント側はこの2ファイルを
// 組み合わせて「直近24時間」(当日0時〜現在 + 前日の残り時間帯)を厳密に計算できる。
function currentUtcDateStr() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function yesterdayUtcDateStr() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// ダンプファイルはUTC基準の日付・時間で生成され、生成自体にも数時間の遅延があるため、
// ローカル(JST)の「前日」をそのまま使うと、UTC基準ではまだ進行中の日になってしまい
// 後半の時間帯のファイルが存在しない(2026-10-07に実際に発生)。UTC基準で「前日」を
// 計算することで、24時間分のファイルが確実に揃っていることを保証する。
function defaultUtcLagDate() {
  const now = new Date();
  const utcToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  utcToday.setUTCDate(utcToday.getUTCDate() - 1);
  const y = utcToday.getUTCFullYear();
  const m = String(utcToday.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utcToday.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

// タイトル中のスペースをアンダースコアに変換する(ダンプ内の表記に合わせる)。
function toDumpTitle(title) {
  return title.replace(/ /g, "_");
}

async function main() {
  const dateArg = process.argv[2];
  const dateYmd = dateArg || defaultUtcLagDate();
  console.log(`対象日: ${dateYmd}`);

  const animeList = JSON.parse(await readFile(path.resolve("data", "all-anime-list.json"), "utf-8"));
  const seiyuuList = JSON.parse(await readFile(path.resolve("data", "all-seiyuu-list.json"), "utf-8"));
  const mangaList = JSON.parse(await readFile(path.resolve("data", "all-manga-list.json"), "utf-8"));
  const allTitles = [...animeList, ...seiyuuList, ...mangaList];

  const dumpTitleToOriginal = new Map();
  for (const title of allTitles) dumpTitleToOriginal.set(toDumpTitle(title), title);
  const targetDumpTitles = Array.from(dumpTitleToOriginal.keys());
  console.log(`対象記事数: ${allTitles.length}件(アニメ${animeList.length} + 声優${seiyuuList.length} + 漫画${mangaList.length})`);

  const titlesFile = path.join(os.tmpdir(), `dump-target-titles-${process.pid}.json`);
  await writeFile(titlesFile, JSON.stringify(targetDumpTitles), "utf-8");

  const totals = new Map();
  const hourlyByDumpTitle = new Map(); // dumpTitle -> availableHoursと対応する時間別閲覧数の配列
  const availableHours = [];
  let missingHours = 0;
  try {
    for (let hour = 0; hour < 24; hour++) {
      const t0 = Date.now();
      const { stdout } = await execFileAsync(
        "node",
        [path.resolve("fetch-hour-from-dump.js"), dateYmd, String(hour), titlesFile],
        { maxBuffer: 100 * 1024 * 1024 }
      );
      const counts = JSON.parse(stdout);
      if (counts === null) {
        missingHours++;
        console.log(`  ${hour}時: ファイルなし(スキップ)`);
        continue;
      }
      const entries = Object.entries(counts);
      for (const [dumpTitle, views] of entries) {
        totals.set(dumpTitle, (totals.get(dumpTitle) || 0) + views);
      }
      availableHours.push(hour);
      for (const dumpTitle of targetDumpTitles) {
        let arr = hourlyByDumpTitle.get(dumpTitle);
        if (!arr) {
          arr = [];
          hourlyByDumpTitle.set(dumpTitle, arr);
        }
        arr.push(counts[dumpTitle] || 0);
      }
      console.log(`  ${hour}時: 一致${entries.length}件 (${Date.now() - t0}ms)`);
    }
  } finally {
    await unlink(titlesFile).catch(() => {});
  }

  if (missingHours === 24) {
    console.error("全時間帯のファイルが取得できませんでした。日付がまだ早すぎる可能性があります。");
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH);
  const upsert = db.prepare(
    "INSERT OR REPLACE INTO daily_views (project, article, date, views) VALUES (?, ?, ?, ?)"
  );
  db.exec("BEGIN");
  try {
    for (const title of allTitles) {
      const dumpTitle = toDumpTitle(title);
      const views = totals.get(dumpTitle) || 0;
      upsert.run("ja.wikipedia", title, dateYmd, views);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  db.close();

  const matchedCount = allTitles.filter((t) => totals.has(toDumpTitle(t))).length;
  console.log(
    `完了: ${dateYmd}分を${allTitles.length}件に書き込みました(ダンプ内で実際にヒットしたのは${matchedCount}件、残りは0件として記録)。`
  );

  let hourlyFileName = null;
  if (dateYmd === currentUtcDateStr()) hourlyFileName = "hourly-today.json";
  else if (dateYmd === yesterdayUtcDateStr()) hourlyFileName = "hourly-yesterday.json";

  if (hourlyFileName) {
    const hourlyPayload = { date: dateYmd, hours: availableHours, views: {} };
    for (const title of allTitles) {
      const dumpTitle = toDumpTitle(title);
      hourlyPayload.views[title] = hourlyByDumpTitle.get(dumpTitle) || availableHours.map(() => 0);
    }
    const outDir = path.resolve("dist", "data");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, hourlyFileName), JSON.stringify(hourlyPayload), "utf-8");
    console.log(`時間別データを dist/data/${hourlyFileName} に書き出しました(対象日=${dateYmd}, 利用可能時間: ${availableHours.length}時間)。`);
  }
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
