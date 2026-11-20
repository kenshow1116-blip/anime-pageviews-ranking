// 閲覧数DB(data/pageviews.db、約10GB)を、このリポジトリのGitHub Release「db-cache」に
// gzip圧縮(約1.4GB)して置き、GitHub Actionsの実行ごとに取得・書き戻すためのスクリプト。
//
// 以前はGoogleドライブに置いていたが、Googleの認証(リフレッシュトークン)が7日で失効して
// 1週間更新が止まった(2026-11-14〜20)。GitHub Actionsに自動で渡されるGITHUB_TOKENだけで
// 読み書きできるので、期限切れになる鍵を持たずに済む。
// - Releaseの添付ファイルは1つ2GiBまで(圧縮後1.4GB、年数%ずつ増える程度)
// - 公開リポジトリなので添付ファイルも公開になるが、中身はWikipediaの公開閲覧数データのみ
// - 書き戻しは「新しいファイルを別名でアップロード → 成功してから古いものを削除」の順にし、
//   途中で失敗しても前回のデータが必ず1つ残るようにする(直近2世代を保持)
//
// 使い方(GITHUB_TOKEN と GITHUB_REPOSITORY=owner/name が必要。Actionsでは自動で設定される):
//   node release-sync.js download <localDbPath>   取得して展開(Releaseに未登録なら終了コード3)
//   node release-sync.js upload <localDbPath>     圧縮してアップロード

import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import https from "node:https";
import path from "node:path";
import os from "node:os";

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const TAG = "db-cache";
const ASSET_PREFIX = "pageviews-";
const ASSET_SUFFIX = ".db.gz";
const KEEP_ASSETS = 2;
const NOT_FOUND_EXIT = 3;

function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

async function api(method, url, body) {
  const res = await fetch(url.startsWith("http") ? url : `https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? {} : res.json();
}

async function getRelease({ create }) {
  const rel = await api("GET", `/repos/${REPO}/releases/tags/${TAG}`);
  if (rel || !create) return rel;
  log(`Release「${TAG}」を作成します`);
  return api("POST", `/repos/${REPO}/releases`, {
    tag_name: TAG,
    name: "閲覧数DBキャッシュ(自動更新・手動で触らない)",
    body: "GitHub Actionsの日次更新が使う閲覧数データベース(Wikipediaの公開閲覧数データ)の保管場所です。release-sync.jsが自動で読み書きします。",
    prerelease: true,
  });
}

function dbAssets(release) {
  return (release.assets || [])
    .filter((a) => a.name.startsWith(ASSET_PREFIX) && a.name.endsWith(ASSET_SUFFIX) && a.state === "uploaded")
    .sort((a, b) => b.name.localeCompare(a.name)); // 名前に日時が入っているので新しい順
}

async function download(dbPath) {
  const release = await getRelease({ create: false });
  const latest = release && dbAssets(release)[0];
  if (!latest) {
    log(`Release「${TAG}」にDBがまだありません`);
    process.exit(NOT_FOUND_EXIT);
  }
  log(`取得: ${latest.name} (${(latest.size / 1e9).toFixed(2)}GB)`);
  const res = await fetch(latest.url, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/octet-stream" },
  });
  if (!res.ok) throw new Error(`ダウンロード失敗: HTTP ${res.status}`);
  mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  await pipeline(res.body, createGunzip(), createWriteStream(dbPath));
  const { size } = await stat(dbPath);
  log(`ダウンロード完了: ${dbPath} (${(size / 1e9).toFixed(2)}GB)`);
}

// WALに溜まった変更を本体に書き戻してから圧縮する(WALを置き去りにすると直近の更新が消える)
async function checkpoint(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
}

function uploadFile(uploadUrl, filePath, size) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      uploadUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/gzip",
          "Content-Length": size,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(text));
          else reject(new Error(`アップロード失敗: HTTP ${res.statusCode} ${text.slice(0, 500)}`));
        });
      }
    );
    req.on("error", reject);
    createReadStream(filePath).on("error", reject).pipe(req);
  });
}

async function upload(dbPath) {
  await checkpoint(dbPath);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const name = `${ASSET_PREFIX}${stamp}${ASSET_SUFFIX}`;
  const gzPath = path.join(os.tmpdir(), name);
  try {
    log(`圧縮中: ${dbPath} -> ${gzPath}`);
    await pipeline(createReadStream(dbPath), createGzip({ level: 4 }), createWriteStream(gzPath));
    const { size } = await stat(gzPath);
    log(`圧縮完了: ${(size / 1e9).toFixed(2)}GB`);
    if (size >= 2 * 1024 ** 3) throw new Error("圧縮後のサイズがReleaseの上限(2GiB)を超えています。分割アップロードの対応が必要です。");

    const release = await getRelease({ create: true });
    const uploadUrl = release.upload_url.replace(/\{.*\}$/, "") + `?name=${encodeURIComponent(name)}`;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        log(`アップロード中: ${name} (試行${attempt})`);
        await uploadFile(uploadUrl, gzPath, size);
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        log(`アップロード失敗(試行${attempt}): ${e.message}`);
        // 途中で切れた不完全なファイルが残っていたら消してから再試行する
        const rel = await getRelease({ create: false });
        const partial = (rel.assets || []).find((a) => a.name === name);
        if (partial) await api("DELETE", `/repos/${REPO}/releases/assets/${partial.id}`);
        await new Promise((r) => setTimeout(r, 10000 * attempt));
      }
    }
    if (lastError) throw lastError;
    log("アップロード完了");

    // 新しいものが揃ってから、古い世代を削除する
    const after = await getRelease({ create: false });
    for (const old of dbAssets(after).slice(KEEP_ASSETS)) {
      log(`古いDBを削除: ${old.name}`);
      await api("DELETE", `/repos/${REPO}/releases/assets/${old.id}`);
    }
  } finally {
    await unlink(gzPath).catch(() => {});
  }
}

async function main() {
  const [, , mode, localPath] = process.argv;
  if (!mode || !localPath) {
    console.error("使い方: node release-sync.js download|upload <localDbPath>");
    process.exit(1);
  }
  if (!TOKEN || !REPO) throw new Error("GITHUB_TOKEN と GITHUB_REPOSITORY が必要です(GitHub Actions内で実行してください)");
  if (mode === "download") await download(localPath);
  else if (mode === "upload") await upload(localPath);
  else throw new Error(`不明なモード: ${mode}`);
}

main().catch((e) => {
  console.error("失敗:", e.message || e);
  process.exit(1);
});
