// Googleドライブ上の1ファイル(SQLiteキャッシュ)をダウンロード/アップロードする。
// サービスアカウントではなく、OAuth 2.0のリフレッシュトークンで認証する
// (組織ポリシーでサービスアカウント鍵の発行がブロックされていたため)。
// スコープは drive.file のみ(このアプリ自身が作成したファイルにしかアクセスできない)。
//
// 環境変数:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN / GOOGLE_DRIVE_FILE_ID
// 使い方:
//   node drive-sync.js download <localFilePath>
//   node drive-sync.js upload <localFilePath>

import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const FILE_ID = process.env.GOOGLE_DRIVE_FILE_ID;

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
  });
  if (!res.ok) throw new Error(`アクセストークン取得失敗: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function download(localPath) {
  const token = await getAccessToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${FILE_ID}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`ダウンロード失敗: HTTP ${res.status} ${await res.text()}`);
  await pipeline(res.body, createWriteStream(localPath));
  console.log(`ダウンロード完了: ${localPath}`);
}

// Google Driveのresumable upload方式を使う(数GB級のファイルでも安定して送れる)。
async function upload(localPath) {
  const token = await getAccessToken();
  const fileStat = await stat(localPath);

  const initRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${FILE_ID}?uploadType=resumable`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Upload-Content-Length": String(fileStat.size),
    },
    body: "{}",
  });
  if (!initRes.ok) throw new Error(`アップロード初期化失敗: HTTP ${initRes.status} ${await initRes.text()}`);
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("アップロードURLが取得できませんでした。");

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Length": String(fileStat.size) },
    body: createReadStream(localPath),
    duplex: "half",
  });
  if (!putRes.ok) throw new Error(`アップロード失敗: HTTP ${putRes.status} ${await putRes.text()}`);
  console.log(`アップロード完了: ${localPath}`);
}

async function main() {
  const [, , mode, localPath] = process.argv;
  if (!mode || !localPath) {
    console.error("使い方: node drive-sync.js download|upload <localFilePath>");
    process.exit(1);
  }
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !FILE_ID) {
    throw new Error(
      "環境変数(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_DRIVE_FILE_ID)が未設定です。"
    );
  }
  if (mode === "download") {
    await download(localPath);
  } else if (mode === "upload") {
    await upload(localPath);
  } else {
    throw new Error(`不明なモード: ${mode}`);
  }
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
