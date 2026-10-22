// 声優向けの日次閲覧数エクスポート。実体は export-daily-views-lib.js。
// node export-seiyuu-daily-views.js で実行、build-seiyuu.js の後に続けて実行する。
import { exportDailyViews } from "./export-daily-views-lib.js";
import path from "node:path";

exportDailyViews({
  listFile: path.resolve("data", "all-seiyuu-list.json"),
  outPrefix: "seiyuu-daily-views",
}).catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
