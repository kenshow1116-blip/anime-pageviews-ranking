// occupation絞り込みで除外された声優(旧4911件 - 新4168件)について、
// - pageviews.db(SQLite)から日次閲覧数レコードを削除
// - dist/seiyuu/配下の孤立した個別ページ(HTML)を削除
// する後片付けスクリプト。
// node cleanup-excluded-seiyuu.js

import { DatabaseSync } from "node:sqlite";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

const DB_PATH = path.resolve("data", "pageviews.db");
const OLD_LIST_FILE = path.resolve("data", "all-seiyuu-list.json.bak");
const NEW_LIST_FILE = path.resolve("data", "all-seiyuu-list.json");
const SEIYUU_DIR = path.resolve("dist", "seiyuu");

function safeFileName(title) {
  return title.replace(/[\\/:*?"<>|]/g, "_");
}

async function main() {
  const oldList = JSON.parse(await readFile(OLD_LIST_FILE, "utf-8"));
  const newList = JSON.parse(await readFile(NEW_LIST_FILE, "utf-8"));
  const newSet = new Set(newList);
  const excluded = oldList.filter((name) => !newSet.has(name));

  console.log(`旧リスト: ${oldList.length}件 / 新リスト: ${newList.length}件 / 除外対象: ${excluded.length}件`);

  if (excluded.length === 0) {
    console.log("除外対象なし。終了します。");
    return;
  }

  const db = new DatabaseSync(DB_PATH);
  const deleteStmt = db.prepare("DELETE FROM daily_views WHERE project = ? AND article = ?");

  let dbDeletedCount = 0;
  let fileDeletedCount = 0;
  let fileMissingCount = 0;

  db.exec("BEGIN");
  try {
    for (const name of excluded) {
      const result = deleteStmt.run("ja.wikipedia", name);
      if (result.changes > 0) dbDeletedCount++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  db.close();

  for (const name of excluded) {
    const filePath = path.join(SEIYUU_DIR, safeFileName(name) + ".html");
    try {
      await unlink(filePath);
      fileDeletedCount++;
    } catch {
      fileMissingCount++;
    }
  }

  console.log(`完了: DB削除=${dbDeletedCount}件分(記事単位) / ページ削除=${fileDeletedCount}件 / 元々ファイルなし=${fileMissingCount}件`);
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
