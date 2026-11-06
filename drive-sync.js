// Googleドライブ上の1ファイル(SQLiteキャッシュ)をダウンロード/アップロードする。
// サービスアカウントではなく、OAuth 2.0のリフレッシュトークンで認証する
// (組織ポリシーでサービスアカウント鍵の発行がブロックされていたため)。
// スコープは drive.file のみ(このアプリ自身が作成したファイルにしかアクセスできない)。
// そのためDrive上のファイルは、ブラウザから手でアップロードしたものではなく、
// 必ずこのスクリプトの create で作ること(手でアップロードしたファイルは drive.file では読めない)。
//
// Drive上には gzip 圧縮した状態で置く(約10GBのDBを数GBに縮め、転送時間とDrive容量を節約する)。
//
// 認証情報は環境変数から読む。未設定のものは .secrets/google-oauth.json(gitignore済み、
// scripts-scratch/get-refresh-token.mjs が書き出す)から補う。
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN / GOOGLE_DRIVE_FILE_ID
// 使い方:
//   node drive-sync.js create   <localDbPath>   初回のみ。Driveに新規作成してファイルIDを表示・保存する
//   node drive-sync.js upload   <localDbPath>   既存ファイル(GOOGLE_DRIVE_FILE_ID)を上書きする
//   node drive-sync.js download <localDbPath>   Driveから取ってきて展開する

import { createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { stat, unlink, open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import path from "node:path";

const SECRETS_FILE = path.resolve(".secrets", "google-oauth.json");
const fileSecrets = existsSync(SECRETS_FILE) ? JSON.parse(readFileSync(SECRETS_FILE, "utf8")) : {};

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || fileSecrets.client_id;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || fileSecrets.client_secret;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || fileSecrets.refresh_token;
const FILE_ID = process.env.GOOGLE_DRIVE_FILE_ID || fileSecrets.drive_file_id;

const DRIVE_FILE_NAME = "anime-pageviews-ranking-pageviews.db.gz";
const CHUNK_SIZE = 64 * 1024 * 1024; // resumable uploadのチャンクは256KiBの倍数である必要がある
const MAX_RETRIES = 6;

function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

async function getAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text();
    if (body.includes("invalid_grant")) {
      throw new Error(
        "リフレッシュトークンが無効です(期限切れ・取り消し)。Google Cloudの公開ステータスが「テスト」だと7日で失効します。" +
          "get-refresh-token.mjs で取り直してください。"
      );
    }
    throw new Error(`アクセストークン取得失敗: HTTP ${res.status} ${body}`);
  }
  return (await res.json()).access_token;
}

// WALに溜まった変更を本体に書き戻してから圧縮する(WALを置き去りにすると直近の更新が消える)
async function checkpoint(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
}

async function gzipTo(srcPath, gzPath) {
  log(`圧縮中: ${srcPath} -> ${gzPath}`);
  await pipeline(createReadStream(srcPath), createGzip({ level: 4 }), createWriteStream(gzPath));
  const [a, b] = await Promise.all([stat(srcPath), stat(gzPath)]);
  log(`圧縮完了: ${(a.size / 1e9).toFixed(2)}GB -> ${(b.size / 1e9).toFixed(2)}GB`);
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

// resumable uploadを64MBずつ送る。途中で失敗しても、そのチャンクから再開できる。
async function resumableUpload(initUrl, method, metadata, gzPath) {
  const token = await getAccessToken();
  const { size } = await stat(gzPath);
  const initRes = await fetch(initUrl, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
      "X-Upload-Content-Type": "application/gzip",
      "X-Upload-Content-Length": String(size),
    },
    body: JSON.stringify(metadata),
    signal: AbortSignal.timeout(60_000),
  });
  if (!initRes.ok) throw new Error(`アップロード初期化失敗: HTTP ${initRes.status} ${await initRes.text()}`);
  const sessionUrl = initRes.headers.get("location");
  if (!sessionUrl) throw new Error("アップロードURLが取得できませんでした。");

  const fh = await open(gzPath, "r");
  try {
    let offset = 0;
    while (offset < size) {
      const end = Math.min(offset + CHUNK_SIZE, size);
      const buf = Buffer.alloc(end - offset);
      await fh.read(buf, 0, buf.length, offset);

      let res;
      for (let attempt = 1; ; attempt++) {
        try {
          res = await fetch(sessionUrl, {
            method: "PUT",
            headers: { "Content-Length": String(buf.length), "Content-Range": `bytes ${offset}-${end - 1}/${size}` },
            body: buf,
            signal: AbortSignal.timeout(10 * 60_000),
          });
          if (res.status === 308 || res.ok) break;
          if (res.status < 500 && res.status !== 429) {
            throw new Error(`アップロード失敗: HTTP ${res.status} ${await res.text()}`);
          }
          throw new Error(`一時的なエラー: HTTP ${res.status}`);
        } catch (e) {
          if (attempt >= MAX_RETRIES || String(e.message).startsWith("アップロード失敗")) throw e;
          log(`チャンク送信を再試行します(${attempt}/${MAX_RETRIES}): ${e.message}`);
          await sleep(2 ** attempt * 1000);
          // サーバー側がどこまで受け取ったかを問い合わせて、そこから再開する
          const q = await fetch(sessionUrl, {
            method: "PUT",
            headers: { "Content-Length": "0", "Content-Range": `bytes */${size}` },
            signal: AbortSignal.timeout(60_000),
          });
          if (q.ok) return await q.json();
          const range = q.headers.get("range");
          const received = range ? Number(range.split("-")[1]) + 1 : 0;
          if (received !== offset) {
            offset = received;
            break; // 外側のループで、受け取り済みの位置から読み直す
          }
        }
      }
      if (res && res.ok) {
        log(`アップロード完了: ${(size / 1e9).toFixed(2)}GB`);
        return await res.json();
      }
      if (res && res.status === 308) {
        const range = res.headers.get("range");
        offset = range ? Number(range.split("-")[1]) + 1 : end;
        log(`送信済み ${(offset / 1e9).toFixed(2)} / ${(size / 1e9).toFixed(2)} GB`);
      }
    }
    throw new Error("アップロードが完了応答なしで終了しました。");
  } finally {
    await fh.close();
  }
}

async function uploadCompressed(dbPath, { create }) {
  await checkpoint(dbPath);
  const gzPath = `${dbPath}.upload.gz`;
  try {
    await gzipTo(dbPath, gzPath);
    if (create) {
      const file = await resumableUpload(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size",
        "POST",
        { name: DRIVE_FILE_NAME, mimeType: "application/gzip" },
        gzPath
      );
      log(`Driveに作成しました: name=${file.name} id=${file.id}`);
      if (existsSync(SECRETS_FILE)) {
        writeFileSync(SECRETS_FILE, JSON.stringify({ ...fileSecrets, drive_file_id: file.id }, null, 2));
        log(`ファイルIDを ${SECRETS_FILE} に保存しました。`);
      }
      console.log(`\nGitHub Secrets の GOOGLE_DRIVE_FILE_ID に登録する値: ${file.id}`);
    } else {
      await resumableUpload(
        `https://www.googleapis.com/upload/drive/v3/files/${FILE_ID}?uploadType=resumable&fields=id,size`,
        "PATCH",
        {},
        gzPath
      );
    }
  } finally {
    await unlink(gzPath).catch(() => {});
  }
}

async function download(dbPath) {
  const token = await getAccessToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${FILE_ID}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`ダウンロード失敗: HTTP ${res.status} ${await res.text()}`);
  mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  log("ダウンロードしながら展開中...");
  await pipeline(res.body, createGunzip(), createWriteStream(dbPath));
  const { size } = await stat(dbPath);
  log(`ダウンロード完了: ${dbPath} (${(size / 1e9).toFixed(2)}GB)`);
}

async function main() {
  const [, , mode, localPath] = process.argv;
  if (!mode || !localPath) {
    console.error("使い方: node drive-sync.js create|upload|download <localDbPath>");
    process.exit(1);
  }
  const missing = Object.entries({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (mode !== "create" && !FILE_ID) missing.push("GOOGLE_DRIVE_FILE_ID");
  if (missing.length) throw new Error(`認証情報が未設定です: ${missing.join(", ")}`);

  if (mode === "create") await uploadCompressed(localPath, { create: true });
  else if (mode === "upload") await uploadCompressed(localPath, { create: false });
  else if (mode === "download") await download(localPath);
  else throw new Error(`不明なモード: ${mode}`);
}

main().catch((e) => {
  console.error("失敗:", e.message || e);
  process.exit(1);
});
