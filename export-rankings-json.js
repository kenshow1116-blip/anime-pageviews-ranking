// ランキングページ用の静的JSON(アニメ/声優/漫画の3種)だけを再書き出す軽量スクリプト。
// 個別ページのHTML再生成(build.js/build-seiyuu.js/build-manga.js)は行わない。
// 当日の速報値を数時間おきに反映するための run-intraday-update.ps1 から呼ばれる想定。
// node export-rankings-json.js

import path from "node:path";
import { exportDailyViews } from "./export-daily-views-lib.js";

async function main() {
  await exportDailyViews({ listFile: path.resolve("data", "all-anime-list.json"), outPrefix: "daily-views" });
  await exportDailyViews({ listFile: path.resolve("data", "all-seiyuu-list.json"), outPrefix: "seiyuu-daily-views" });
  await exportDailyViews({ listFile: path.resolve("data", "all-manga-list.json"), outPrefix: "manga-daily-views" });
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
