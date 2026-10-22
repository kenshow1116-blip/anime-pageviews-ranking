// 作品(アニメ)向けの日次閲覧数エクスポート。実体は export-daily-views-lib.js。
// node export-daily-views.js で実行、build.js の後に続けて実行する。
import { exportDailyViews } from "./export-daily-views-lib.js";
import path from "node:path";

exportDailyViews({
  listFile: path.resolve("data", "all-anime-list.json"),
  outPrefix: "daily-views",
}).catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
