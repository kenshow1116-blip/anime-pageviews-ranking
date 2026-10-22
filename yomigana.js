// 一覧ページ(アニメ/漫画/声優)を50音の行ごとにグルーピングして並べるための共有モジュール。
// data/yomigana.json(fetch-yomigana.jsが生成するtitle -> DEFAULTSORT文字列のキャッシュ)を使う。
// DEFAULTSORTは日本語版Wikipediaの記事にほぼ必ず設定されており、ローマ字タイトルの作品も
// 多くは読み仮名(ひらがな)に変換された値が入っている(例: "AVENGER" -> "あうえんしやあ")。
// ひらがなのUnicodeコードポイントは50音順に並んでいるため、単純な文字列比較で
// 正しい並び順になる。

import { readFile } from "node:fs/promises";
import path from "node:path";

const YOMIGANA_FILE = path.resolve("data", "yomigana.json");

export async function loadYomiganaMap() {
  try {
    const raw = JSON.parse(await readFile(YOMIGANA_FILE, "utf-8"));
    return new Map(Object.entries(raw).filter(([, v]) => v));
  } catch {
    return new Map();
  }
}

// カタカナをひらがなに変換する(DEFAULTSORTがカタカナ表記の場合の保険)。
function katakanaToHiragana(s) {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// 読み仮名が無い場合は生のタイトルをフォールバックに使う(あ行〜わ行には入らず「その他」行になる)。
export function getSortKey(title, yomiganaMap) {
  const raw = yomiganaMap.get(title) || title;
  return katakanaToHiragana(raw);
}

const ROW_ORDER = ["あ", "か", "さ", "た", "な", "は", "ま", "や", "ら", "わ", "その他"];

const ROW_TABLE = {
  あ: "あ", い: "あ", う: "あ", え: "あ", お: "あ",
  ぁ: "あ", ぃ: "あ", ぅ: "あ", ぇ: "あ", ぉ: "あ",
  か: "か", き: "か", く: "か", け: "か", こ: "か",
  が: "か", ぎ: "か", ぐ: "か", げ: "か", ご: "か",
  さ: "さ", し: "さ", す: "さ", せ: "さ", そ: "さ",
  ざ: "さ", じ: "さ", ず: "さ", ぜ: "さ", ぞ: "さ",
  た: "た", ち: "た", つ: "た", て: "た", と: "た",
  だ: "た", ぢ: "た", づ: "た", で: "た", ど: "た", っ: "た",
  な: "な", に: "な", ぬ: "な", ね: "な", の: "な",
  は: "は", ひ: "は", ふ: "は", へ: "は", ほ: "は",
  ば: "は", び: "は", ぶ: "は", べ: "は", ぼ: "は",
  ぱ: "は", ぴ: "は", ぷ: "は", ぺ: "は", ぽ: "は",
  ま: "ま", み: "ま", む: "ま", め: "ま", も: "ま",
  や: "や", ゆ: "や", よ: "や", ゃ: "や", ゅ: "や", ょ: "や",
  ら: "ら", り: "ら", る: "ら", れ: "ら", ろ: "ら",
  わ: "わ", ゐ: "わ", ゑ: "わ", を: "わ", ん: "わ",
};

// sortKey(ひらがな化済み)の先頭文字から行(あ/か/さ.../わ/その他)を判定する。
export function getRow(sortKey) {
  const head = sortKey.charAt(0);
  return ROW_TABLE[head] || "その他";
}

// entries: [{..., title: string}] のような、titleプロパティを持つ配列を想定。
// 戻り値: [{ row: "あ", items: [...sortKey昇順] }, ...] (存在する行のみ、ROW_ORDER順)
export function groupByRow(entries, yomiganaMap, titleOf = (e) => e.title) {
  const withKey = entries.map((e) => {
    const sortKey = getSortKey(titleOf(e), yomiganaMap);
    return { entry: e, sortKey, row: getRow(sortKey) };
  });
  withKey.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  const buckets = new Map();
  for (const w of withKey) {
    if (!buckets.has(w.row)) buckets.set(w.row, []);
    buckets.get(w.row).push(w.entry);
  }
  return ROW_ORDER.filter((row) => buckets.has(row)).map((row) => ({ row, items: buckets.get(row) }));
}

export const KANA_NAV_CSS = `
  .kana-nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 16px 0 24px; }
  .kana-nav a {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: 8px;
    background: var(--surface-1); border: 1px solid var(--border);
    color: var(--accent); text-decoration: none; font-size: 13px; font-weight: 600;
  }
  .kana-nav a:hover { background: var(--accent); color: #fff; }
  .kana-nav a.active { background: var(--accent); color: #fff; }
  .row-heading {
    font-size: 15px; font-weight: 700; color: var(--text-secondary);
    margin: 28px 0 8px; padding-top: 12px; border-top: 1px solid var(--gridline);
  }
  .row-heading:first-of-type { border-top: none; padding-top: 0; }
  .row-toc { list-style: none; margin: 0 0 24px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .row-toc a {
    display: flex; justify-content: space-between; padding: 10px 14px;
    border: 1px solid var(--border); border-radius: 8px; background: var(--surface-1);
    color: var(--text-primary); text-decoration: none; font-weight: 600;
  }
  .row-toc a:hover { background: var(--gridline); }
  .row-toc span { color: var(--text-secondary); font-weight: 400; font-size: 13px; }
`;

// 行ごとに分けた一覧ページの(生の)ファイル名(例: "list-あ.html")。ディスクへの書き込みパスに使う。
export function rowPageFileName(row) {
  return `list-${row}.html`;
}

// URL/href用。ファイル名そのものをパーセントエンコードする(sitemapのURLにもこちらを使う)。
export function rowPageHref(row) {
  return encodeURIComponent(rowPageFileName(row));
}

// activeRowを指定すると、その行のリンクに.activeクラスを付ける(行ページ側での現在地表示用)。
export function buildKanaNav(groups, activeRow = null) {
  return `<nav class="kana-nav">${groups
    .map(
      (g) =>
        `<a href="${rowPageHref(g.row)}"${g.row === activeRow ? ' class="active"' : ""}>${
          g.row === "その他" ? "他" : g.row
        }</a>`
    )
    .join("")}</nav>`;
}

// 一覧トップページ用: 行ごとの件数付きリンク一覧。
export function buildRowToc(groups) {
  return `<ul class="row-toc">${groups
    .map(
      (g) =>
        `<li><a href="${rowPageHref(g.row)}">${g.row === "その他" ? "その他" : `${g.row}行`}<span>${g.items.length}件</span></a></li>`
    )
    .join("")}</ul>`;
}
