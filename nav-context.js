// 作品・声優・漫画の個別ページに埋め込む、遷移元を正しく反映するためのスクリプト。
// ランキングページ(anime-ranking.html等)から来た場合、リンクに付けたクエリ文字列
// (?from=ranking&rankingPage=...&rankingLabel=...&period=...&date=...)を見て、
// パンくずと「ランキングに戻る」リンクを実際に来た場所(どのランキング・どの期間)に
// 書き換える。一覧ページ経由(fromパラメータなし)の場合は何もせず、ビルド時に
// 生成済みの「○○一覧 > 行」のパンくずのままにする(そちらは常に正しいため)。
export const NAV_CONTEXT_SCRIPT = `<script>
(function(){
  var params = new URLSearchParams(location.search);
  if (params.get("from") !== "ranking") return;
  var rankingPage = params.get("rankingPage");
  var rankingLabel = params.get("rankingLabel");
  var period = params.get("period") || "all";
  var date = params.get("date");
  if (!rankingPage || !rankingLabel) return;
  var periodLabels = { all: "累計", y1: "直近1年", m1: "直近1か月", w1: "直近1週間", surge: "急上昇" };
  var periodLabel = periodLabels[period] || "累計";
  var qs = "?period=" + encodeURIComponent(period) + (date ? "&date=" + encodeURIComponent(date) : "");
  var backHref = "../" + rankingPage + qs;

  var breadcrumb = document.querySelector(".breadcrumb");
  var h1 = document.querySelector("h1");
  if (breadcrumb && h1) {
    var titleText = h1.textContent;
    breadcrumb.textContent = "";
    var homeA = document.createElement("a");
    homeA.href = "../index.html";
    homeA.textContent = "ホーム";
    var rankA = document.createElement("a");
    rankA.href = backHref;
    rankA.textContent = rankingLabel + (period !== "all" ? "(" + periodLabel + ")" : "");
    breadcrumb.appendChild(homeA);
    breadcrumb.appendChild(document.createTextNode(" > "));
    breadcrumb.appendChild(rankA);
    breadcrumb.appendChild(document.createTextNode(" > " + titleText));
  }

  var links = document.querySelectorAll(".links a");
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute("href") || "";
    if (/-ranking\\.html$/.test(href)) {
      links[i].setAttribute("href", backHref);
    }
  }
})();
</script>`;
