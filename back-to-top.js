// 全ページ共通の「トップへ戻る」フローティングボタン。
// 少しスクロールすると右下に出現し、クリックでページ最上部までスムーズスクロールする。
// build.js / build-seiyuu.js / build-manga.js / build-categories.js の各ページテンプレートで
// PAGE_CSSにBACK_TO_TOP_CSSを、</body>直前にBACK_TO_TOP_HTML+BACK_TO_TOP_SCRIPTを追加する。

export const BACK_TO_TOP_CSS = `
  .back-to-top {
    position: fixed;
    right: 20px;
    bottom: 20px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--accent);
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
    opacity: 0;
    visibility: hidden;
    transform: translateY(8px);
    transition: opacity 0.2s ease, transform 0.2s ease;
    z-index: 100;
  }
  .back-to-top.visible { opacity: 1; visibility: visible; transform: translateY(0); }
  .back-to-top:hover { background: var(--accent); color: #ffffff; }
`;

export const BACK_TO_TOP_HTML = `<button type="button" id="backToTopBtn" class="back-to-top" aria-label="トップへ戻る" title="トップへ戻る">&uarr;</button>`;

export const BACK_TO_TOP_SCRIPT = `<script>
(function () {
  var btn = document.getElementById("backToTopBtn");
  if (!btn) return;
  var SHOW_AFTER_PX = 300;
  function onScroll() {
    if (window.scrollY > SHOW_AFTER_PX) btn.classList.add("visible");
    else btn.classList.remove("visible");
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  btn.addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
})();
</script>`;
