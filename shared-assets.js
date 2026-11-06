// 全ページ共通のCSS/JSを dist/assets/ に1回だけ書き出し、ページからはリンクで参照する。
// 以前は各ページに<style>/<script>として埋め込んでいたため、約2万ページ×約31KBの重複で
// 公開サイトが931MBに達し、GitHub Pagesの上限(1GB)に迫っていた。
//
// ファイル名に内容のハッシュを付けるので、中身を変えればURLも変わり、ブラウザの古いキャッシュが使われない。
// 個別ページはすべて dist/<section>/xxx.html の1階層下にあるため、参照パスは "../assets/..." になる。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ASSETS_DIR = path.resolve("dist", "assets");
const written = new Map();

export function assetHref(name, ext, content, prefix = "../") {
  const key = `${name}.${ext}\0${content}`;
  let fileName = written.get(key);
  if (!fileName) {
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 10);
    fileName = `${name}.${hash}.${ext}`;
    mkdirSync(ASSETS_DIR, { recursive: true });
    writeFileSync(path.join(ASSETS_DIR, fileName), content, "utf-8");
    written.set(key, fileName);
  }
  return `${prefix}assets/${fileName}`;
}

// <style>${CSS}</style> の置き換え用
export function stylesheetTag(name, css) {
  return `<link rel="stylesheet" href="${assetHref(name, "css", css)}">`;
}
