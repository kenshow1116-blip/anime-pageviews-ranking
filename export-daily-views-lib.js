// pageviews.db(SQLite)から対象リスト(作品 or 声優)の日次閲覧数を読み出し、
// ブラウザ側がWikipedia APIを直接叩かずに済むよう、静的JSONとして dist/data/ に書き出す共通ロジック。
// - <outPrefix>.json: 全データ本体(初回訪問時のみ使う。形式はFULL_FORMATの説明を参照)
// - <outPrefix>-delta.json: 直近DELTA_DAYS日分だけの軽量ファイル(通常の再訪問時に使う)
// - <outPrefix>-meta.json: endDate/deltaStartDateを持つ軽量ファイル(差分判定用)

import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const DB_PATH = path.resolve("data", "pageviews.db");
const OUT_DIR = path.resolve("dist", "data");
const API_START = "20150701";
// 当日分を速報値として見せるため0にしている(当日の未取得時間帯は単に0件として出る)。
// 個別ページ(build.js等)側のLAG_DAYS=1とは独立していて、そちらは夜間の本ビルドで
// 新規記事を丸ごとバックフィルする際の対象範囲(完全な「前日まで」)を指すため変更不要。
const LAG_DAYS = 0;
const DELTA_DAYS = 35; // この日数より長く訪問が空いた場合のみフル再ダウンロードにフォールバックする

// フル版JSONは累積値ではなく「生の日次値＋先頭の0を省略」の形で書き出す。
// 累積値は桁数が大きく(数百万)、記事ができる前の期間も0が延々と並ぶため、
// サイト容量(GitHub Pagesの上限1GB)を圧迫していた。生の日次値なら大半が1〜3桁で済む。
// 形式: [先頭で省略した0の個数, 生の日次値...]。データが全く無い記事は空配列。
// ブラウザ側(各ranking.htmlのdecodeDailyViewsPayload)で従来どおりの累積配列に戻してから使う。
const FULL_FORMAT = "raw-trimmed";
function encodeTrimmedRaw(raw) {
  const first = raw.findIndex((v) => v !== 0);
  if (first < 0) return [];
  return [first, ...raw.slice(first)];
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function parseYmd(ymd) {
  return new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
}

function daysBetweenInclusive(start, end) {
  return Math.round((parseYmd(end) - parseYmd(start)) / 86400000) + 1;
}

// ---- ランキング初期表示用スナップショット ----
// ランキングページは本来、全期間の日次データ(数十〜百数十MB)をブラウザで受け取り、その場で
// 期間ごとの合計を計算して並べている。初めての訪問者ほど待たされるので、「最新日を基準にした
// ライブ表示」で使う値だけをビルド時に計算して小さなJSON(<outPrefix>-snapshot.json)に書き出す。
// 計算ルールは各ranking.htmlのcomputeMetricFromMap/sumRangeFromRec/loadRankingと完全に同じにすること。
// 基準日(ブラウザ側のtodayMinusLag)は、ビルド当日(endDate)とその翌日のどちらにもなりうる
// (UTCの日付が変わってから次のビルドまでの間は翌日)ため、両方を用意する。
const SNAPSHOT_ROLLING = { y1: 365, m1: 30, w1: 7 };

function snapshotMetrics(cum, r) {
  const last = cum.length - 1;
  const cumAt = (i) => (i < 0 || last < 0 ? 0 : cum[Math.min(i, last)]);
  const rangeSum = (startIdx, days) => {
    const endIdx = startIdx + days - 1;
    if (endIdx < 0 || days <= 0 || last < 0) return 0;
    return cumAt(endIdx) - cumAt(startIdx - 1);
  };
  const out = { all: r < 0 ? 0 : cumAt(r) };
  // ライブ表示のローリング期間は基準日当日を含めず、前日を終点にする
  for (const [k, days] of Object.entries(SNAPSHOT_ROLLING)) out[k] = rangeSum(r - 1 - (days - 1), days);
  // 急上昇: 直近7日(基準日を含む)とその前の7日
  out.sr = rangeSum(r - 6, 7);
  out.sp = rangeSum(r - 13, 7);
  return out;
}

function createSnapshotBuilder(totalDays, dateKeys) {
  const endIdx = totalDays - 1;
  const refIdxs = [endIdx, endIdx + 1];
  const refYmds = refIdxs.map((i) => {
    if (i < dateKeys.length) return dateKeys[i];
    const d = parseYmd(dateKeys[dateKeys.length - 1]);
    d.setDate(d.getDate() + (i - (dateKeys.length - 1)));
    return fmtDate(d);
  });
  const refs = refYmds.map(() => ({
    cur: { all: [], y1: [], m1: [], w1: [], sr: [], sp: [] },
    prev: { all: [], y1: [], m1: [], w1: [], sd: [] },
  }));
  return {
    add(raw) {
      const cum = new Array(raw.length);
      let running = 0;
      for (let i = 0; i < raw.length; i++) cum[i] = running += raw[i];
      refIdxs.forEach((r, k) => {
        const cur = snapshotMetrics(cum, r);
        const before = snapshotMetrics(cum, r - 1);
        const ref = refs[k];
        for (const key of Object.keys(ref.cur)) ref.cur[key].push(cur[key]);
        // 前日比の順位用。累計は「基準日の値 - 基準日単体の閲覧数」(ブラウザ側と同じ式)
        const last = cum.length - 1;
        let todayViews = 0;
        if (last >= 0) {
          const c = Math.min(r, last);
          todayViews = (cum[c] || 0) - (c > 0 ? cum[c - 1] || 0 : 0);
        }
        ref.prev.all.push(cur.all - todayViews);
        for (const key of Object.keys(SNAPSHOT_ROLLING)) ref.prev[key].push(before[key]);
        ref.prev.sd.push(before.sr - before.sp);
      });
    },
    toJSON(endDate, titles) {
      const out = { endDate, titles, refs: {} };
      refYmds.forEach((ymd, k) => (out.refs[ymd] = refs[k]));
      return out;
    },
  };
}

async function writeSnapshot(outPrefix, builder, endDate, titles) {
  await writeFile(path.join(OUT_DIR, `${outPrefix}-snapshot.json`), JSON.stringify(builder.toJSON(endDate, titles)), "utf-8");
}

// listFile: 対象タイトル一覧のJSONファイルパス(文字列配列)。titlesを直接渡す場合は省略可。
// titles: 対象タイトル一覧を配列で直接渡す場合(listFileより優先)。
// outPrefix: 出力ファイル名の接頭辞("daily-views" / "seiyuu-daily-views"など)
// project: SQLiteキャッシュのproject列("ja.wikipedia" | "en.wikipedia")。省略時はja.wikipedia。
// titleMap: 表示用タイトル(JSONのキー・リンク先)と実際にDB検索に使うタイトルが異なる場合の対応表
//   (例: 海外ランキングでは表示は日本語タイトルだが、検索は英語版タイトルを使う)。
//   { 表示タイトル: 検索タイトル } の形。省略時は表示タイトルそのものを検索にも使う。
export async function exportDailyViews({ listFile, titles, outPrefix, project = "ja.wikipedia", titleMap = null }) {
  const titleList = titles || JSON.parse(await readFile(listFile, "utf-8"));

  // WikipediaのpageviewsダンプはUTC日付基準で公開されるため、「今日」もJST(ローカル時刻)
  // ではなくUTCの日付に合わせる(ズレるとJST午前中にまだ存在しないUTC日が「今日」として
  // 0件扱いで混ざり、クライアント側で「今日が全く更新されない」ように見えてしまう)。
  const now = new Date();
  const today = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  today.setDate(today.getDate() - LAG_DAYS);
  const endDate = fmtDate(today);
  const totalDays = daysBetweenInclusive(API_START, endDate);

  console.log(`対象件数: ${titleList.length} / 期間: ${API_START}-${endDate} (${totalDays}日間)`);

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const stmt = db.prepare(
    "SELECT date, views FROM daily_views WHERE project = ? AND article = ? AND date >= ? AND date <= ? ORDER BY date ASC"
  );

  const startDateObj = parseYmd(API_START);
  const dateKeys = new Array(totalDays);
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startDateObj);
    d.setDate(d.getDate() + i);
    dateKeys[i] = fmtDate(d);
  }

  // viewsは生の日次閲覧数ではなく累積合計(prefix sum)として書き出す。
  // クライアント側でどの期間・どの基準日でも2点の差分だけで合計を出せるようにし、
  // 「累計」のたびに全期間を毎回ループし直す重い処理を避けるため。
  // 生の日次値は全期間分を別途保持すると(累積と合わせて)件数の多いサイトでメモリを
  // 使い切ってしまうため、delta用に必要な直近分だけその場で切り出して保持する。
  const deltaStartIdx = Math.max(0, totalDays - DELTA_DAYS);
  const views = {};
  const deltaViews = {};
  const snapshot = createSnapshotBuilder(totalDays, dateKeys);
  let missing = 0;
  for (const title of titleList) {
    const lookupTitle = titleMap ? titleMap[title] : title;
    const rows = lookupTitle ? stmt.all(project, lookupTitle, API_START, endDate) : [];
    if (rows.length === 0) missing++;
    const map = new Map(rows.map((r) => [r.date, r.views]));
    const raw = dateKeys.map((ymd) => map.get(ymd) || 0);
    deltaViews[title] = raw.slice(deltaStartIdx);
    views[title] = encodeTrimmedRaw(raw);
    snapshot.add(raw);
  }
  db.close();

  if (missing > 0) {
    console.warn(`警告: ${missing}件はキャッシュに日次データが見つかりませんでした(タイトル不一致の可能性)`);
  }

  await mkdir(OUT_DIR, { recursive: true });

  const payload = { startDate: API_START, endDate, titles: titleList, views, format: FULL_FORMAT };
  await writeFile(path.join(OUT_DIR, `${outPrefix}.json`), JSON.stringify(payload), "utf-8");

  // delta側は累積ではなく生の日次値のまま(クライアント側で既存の累積に積み上げてマージする)。
  const deltaStartDate = dateKeys[deltaStartIdx];
  const deltaPayload = { startDate: deltaStartDate, endDate, titles: titleList, views: deltaViews, format: "raw" };
  await writeFile(path.join(OUT_DIR, `${outPrefix}-delta.json`), JSON.stringify(deltaPayload), "utf-8");

  await writeFile(
    path.join(OUT_DIR, `${outPrefix}-meta.json`),
    JSON.stringify({ endDate, deltaStartDate }),
    "utf-8"
  );
  await writeSnapshot(outPrefix, snapshot, endDate, titleList);

  console.log(`書き出し完了: dist/data/${outPrefix}.json (endDate=${endDate}, deltaStartDate=${deltaStartDate})`);
}

// 制作会社ランキング用: 制作会社ごとの日次閲覧数を、所属作品(ja.wikipedia)の
// 生の日次値を足し合わせて合成する(会社自体は記事を持たないため)。
// studioToWorks: { 制作会社名: [作品タイトル, ...] } (1作品が複数社に属すこともある)
export async function exportStudioDailyViews({ studioToWorks, outPrefix }) {
  const studioList = Object.keys(studioToWorks);

  const now = new Date();
  const today = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  today.setDate(today.getDate() - LAG_DAYS);
  const endDate = fmtDate(today);
  const totalDays = daysBetweenInclusive(API_START, endDate);

  console.log(`対象制作会社数: ${studioList.length} / 期間: ${API_START}-${endDate} (${totalDays}日間)`);

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const stmt = db.prepare(
    "SELECT date, views FROM daily_views WHERE project = 'ja.wikipedia' AND article = ? AND date >= ? AND date <= ? ORDER BY date ASC"
  );

  const startDateObj = parseYmd(API_START);
  const dateKeys = new Array(totalDays);
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startDateObj);
    d.setDate(d.getDate() + i);
    dateKeys[i] = fmtDate(d);
  }

  const deltaStartIdx = Math.max(0, totalDays - DELTA_DAYS);
  const views = {};
  const deltaViews = {};
  const snapshot = createSnapshotBuilder(totalDays, dateKeys);
  const workRawCache = new Map(); // 複数社に属す作品の再クエリを避けるキャッシュ

  for (const studio of studioList) {
    const raw = new Array(totalDays).fill(0);
    for (const work of studioToWorks[studio]) {
      let workRaw = workRawCache.get(work);
      if (!workRaw) {
        const rows = stmt.all(work, API_START, endDate);
        const map = new Map(rows.map((r) => [r.date, r.views]));
        workRaw = dateKeys.map((ymd) => map.get(ymd) || 0);
        workRawCache.set(work, workRaw);
      }
      for (let i = 0; i < totalDays; i++) raw[i] += workRaw[i];
    }
    deltaViews[studio] = raw.slice(deltaStartIdx);
    views[studio] = encodeTrimmedRaw(raw);
    snapshot.add(raw);
  }
  db.close();

  await mkdir(OUT_DIR, { recursive: true });

  const payload = { startDate: API_START, endDate, titles: studioList, views, format: FULL_FORMAT };
  await writeFile(path.join(OUT_DIR, `${outPrefix}.json`), JSON.stringify(payload), "utf-8");

  const deltaStartDate = dateKeys[deltaStartIdx];
  const deltaPayload = { startDate: deltaStartDate, endDate, titles: studioList, views: deltaViews, format: "raw" };
  await writeFile(path.join(OUT_DIR, `${outPrefix}-delta.json`), JSON.stringify(deltaPayload), "utf-8");

  await writeFile(
    path.join(OUT_DIR, `${outPrefix}-meta.json`),
    JSON.stringify({ endDate, deltaStartDate }),
    "utf-8"
  );
  await writeSnapshot(outPrefix, snapshot, endDate, studioList);

  console.log(`書き出し完了: dist/data/${outPrefix}.json (endDate=${endDate}, deltaStartDate=${deltaStartDate})`);
}
