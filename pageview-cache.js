// Wikipedia Pageviews APIの日次データをSQLiteにキャッシュする共有モジュール。
// 全ビルドスクリプト(build.js / build-en.js / build-seiyuu.js)から使う。
// 初回は不足分を丸ごと取得し、以降は「キャッシュの最新日付の翌日〜end」の差分だけ取得する。

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const DB_PATH = path.resolve("data", "pageviews.db");

let db = null;
let stmts = null;

function ensureDb() {
  if (db) return db;
  mkdirSync(path.resolve("data"), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  // synchronous=FULL(既定)を維持する: NORMALだとプロセスを強制終了した際に
  // 直近コミット済みのデータがディスクに残らず、同じ記事を無駄に再フェッチする
  // 問題が発生した(2026-10-05に発覚)。
  db.exec("PRAGMA busy_timeout = 30000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_views (
      project TEXT NOT NULL,
      article TEXT NOT NULL,
      date TEXT NOT NULL,
      views INTEGER NOT NULL,
      PRIMARY KEY (project, article, date)
    );
  `);
  stmts = {
    maxDate: db.prepare("SELECT MAX(date) AS maxDate FROM daily_views WHERE project = ? AND article = ?"),
    upsert: db.prepare("INSERT OR REPLACE INTO daily_views (project, article, date, views) VALUES (?, ?, ?, ?)"),
    range: db.prepare(
      "SELECT date, views FROM daily_views WHERE project = ? AND article = ? AND date >= ? AND date <= ? ORDER BY date ASC"
    ),
  };
  return db;
}

function addDaysToYmd(ymd, days) {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// project: "ja.wikipedia" | "en.wikipedia" など
// article: APIに渡す生のタイトル文字列(エンコード前)
// apiStartDate / endDate: "YYYYMMDD"
// fetchRangeFn(article, startDate, endDate): 不足分だけ取得する関数。[{ts, views}]を返す非同期関数。
// 戻り値: [{ts: "YYYYMMDDHH", views}] (apiStartDate〜endDateの範囲、キャッシュ+新規取得分をマージ済み)
export async function getDailyHistory(project, article, apiStartDate, endDate, fetchRangeFn) {
  ensureDb();
  const row = stmts.maxDate.get(project, article);
  const cachedMax = row && row.maxDate ? row.maxDate : null;

  if (!cachedMax || cachedMax < endDate) {
    const fetchStart = cachedMax ? addDaysToYmd(cachedMax, 1) : apiStartDate;
    if (fetchStart <= endDate) {
      const items = await fetchRangeFn(article, fetchStart, endDate);
      db.exec("BEGIN");
      try {
        for (const it of items) {
          const date = it.ts.slice(0, 8);
          stmts.upsert.run(project, article, date, it.views);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  const rows = stmts.range.all(project, article, apiStartDate, endDate);
  return rows.map((r) => ({ ts: `${r.date}00`, views: r.views }));
}

// cachedMaxをフェッチなしで返す(nullなら一度も取得したことがない記事)。
export function getCachedMax(project, article) {
  ensureDb();
  const row = stmts.maxDate.get(project, article);
  return row && row.maxDate ? row.maxDate : null;
}

// キャッシュにある分だけをフェッチなしで返す(直近1日分の欠落があっても気にしない用途向け)。
// 大量の新規記事を初回バックフィルする際、既に一度取得済みの記事について「最新日まで
// 埋まっているか」のAPIリクエストを再起動ごとに繰り返すと遅すぎるため、
// 一度でも取得済みならその時点のキャッシュをそのまま使い、残りの数日分の欠落は
// 次回の通常の日次更新(getDailyHistory)で自然に埋める、という割り切りに使う。
export function getCachedRangeOnly(project, article, apiStartDate, endDate) {
  ensureDb();
  const rows = stmts.range.all(project, article, apiStartDate, endDate);
  return rows.map((r) => ({ ts: `${r.date}00`, views: r.views }));
}

export function closeCache() {
  if (db) {
    db.close();
    db = null;
    stmts = null;
  }
}
