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
// 使い方: node fetch-daily-from-dump.js [YYYYMMDD]
//   日付省略時は、UTC基準の前日を含む直近LOOKBACK_DAYS日のうち、24時間分そろって取得済みと
//   記録されていない日(dump_daysテーブル)を、前日を先頭に新しい順で最大MAX_DAYS_PER_RUN日取得する。1日だけ見る方式だと、更新が失敗した日やGitHub Actionsの
//   スケジュールがずれて飛ばされた日が永久に0件のまま残っていた(2026-11-04/11-08で発生)。

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

const LOOKBACK_DAYS = 45;

function addDaysYmd(ymd, n) {
  const d = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))));
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

// 1回の実行で取り直す日数の上限(1日あたり約5分)。初回は過去の欠けた日がまとめて見つかるため、
// 数日かけて少しずつ埋める。
const MAX_DAYS_PER_RUN = 10;
// これより古い日で一部の時間帯だけファイルが無い場合は、Wikimedia側で恒久的に欠けているとみなし、
// あるだけの時間帯で確定させる(新しい日はダンプ公開待ちの可能性があるので保存せず次回に回す)。
const SETTLE_DAYS = 3;
const MAX_MISSING_HOURS_TO_SETTLE = 2;

function ensureDumpDaysTable(db) {
  // 24時間分そろって取得できた日を記録する。行数だけでは、途中で止まって数時間分しか入っていない日
  // (旧ローカル運用で2026-10〜11月に多発)を見分けられないため。
  db.exec("CREATE TABLE IF NOT EXISTS dump_days (date TEXT PRIMARY KEY, hours INTEGER NOT NULL, fetched_at TEXT NOT NULL)");
}

// 直近LOOKBACK_DAYS日のうち、ダンプから確定取得済みとして記録されていない日を返す。
// 前日を最優先し、残りは新しい日から順に、最大MAX_DAYS_PER_RUN日。
function findMissingDates() {
  const latest = defaultUtcLagDate();
  const first = addDaysYmd(latest, -(LOOKBACK_DAYS - 1));
  const db = new DatabaseSync(DB_PATH);
  ensureDumpDaysTable(db);
  const rows = db.prepare("SELECT date, hours FROM dump_days WHERE date >= ? AND date <= ?").all(first, latest);
  db.close();
  const hoursByDate = new Map(rows.map((r) => [r.date, r.hours]));
  const settleLimit = addDaysYmd(latest, -SETTLE_DAYS);
  const missing = [];
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const ymd = addDaysYmd(latest, -i);
    const hours = hoursByDate.get(ymd);
    const done = hours === 24 || (hours !== undefined && ymd <= settleLimit);
    if (!done) missing.push(ymd);
  }
  return missing.slice(0, MAX_DAYS_PER_RUN);
}

async function loadTitles() {
  const animeList = JSON.parse(await readFile(path.resolve("data", "all-anime-list.json"), "utf-8"));
  const seiyuuList = JSON.parse(await readFile(path.resolve("data", "all-seiyuu-list.json"), "utf-8"));
  const mangaList = JSON.parse(await readFile(path.resolve("data", "all-manga-list.json"), "utf-8"));
  const allTitles = [...animeList, ...seiyuuList, ...mangaList];
  console.log(`対象記事数: ${allTitles.length}件(アニメ${animeList.length} + 声優${seiyuuList.length} + 漫画${mangaList.length})`);
  return allTitles;
}

async function processDate(dateYmd, allTitles) {
  console.log(`対象日: ${dateYmd}`);

  const dumpTitleToOriginal = new Map();
  for (const title of allTitles) dumpTitleToOriginal.set(toDumpTitle(title), title);
  const targetDumpTitles = Array.from(dumpTitleToOriginal.keys());

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
    throw new Error(`${dateYmd}: 全時間帯のファイルが取得できませんでした。日付がまだ早すぎる可能性があります。`);
  }
  // 一部の時間帯が欠けたまま保存すると、その日の閲覧数が大幅に少ないまま残ってしまう。
  // 新しい日はダンプの公開待ちとみなして保存せず、次回の実行で取り直す。
  const settled = dateYmd <= addDaysYmd(defaultUtcLagDate(), -SETTLE_DAYS);
  if (missingHours > 0 && !(settled && missingHours <= MAX_MISSING_HOURS_TO_SETTLE)) {
    throw new Error(`${dateYmd}: ${missingHours}時間分のファイルがまだありません(保存せず次回に取り直します)。`);
  }

  const db = new DatabaseSync(DB_PATH);
  ensureDumpDaysTable(db);
  const markDay = db.prepare("INSERT OR REPLACE INTO dump_days (date, hours, fetched_at) VALUES (?, ?, ?)");
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
    markDay.run(dateYmd, availableHours.length, new Date().toISOString());
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

async function main() {
  const allTitles = await loadTitles();
  const dateArg = process.argv[2];
  const dates = dateArg ? [dateArg] : findMissingDates();
  if (dates.length === 0) {
    console.log("直近の日付はすべて取得済みです。");
    return;
  }
  console.log(`取得する日付: ${dates.join(", ")}`);
  const failed = [];
  for (const dateYmd of dates) {
    try {
      await processDate(dateYmd, allTitles);
    } catch (e) {
      // 1日分の失敗で他の日まで止めない(失敗した日は次回の実行で再挑戦される)
      console.error(`${dateYmd} の取得に失敗:`, e.message || e);
      failed.push(dateYmd);
    }
  }
  if (failed.length > 0) {
    console.error(`取得できなかった日: ${failed.join(", ")}(次回の実行で再挑戦します)`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
