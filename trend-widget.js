// 作品・声優の個別ページに埋め込む、ランキングページ(index.html / seiyuu-ranking.html)と
// 同仕様のインタラクティブ推移ウィジェット(期間切り替え・基準日指定・IndexedDBキャッシュ・
// ジグザグ推移グラフ)を1記事分に特化して提供する。build.js / build-seiyuu.js から共通で使う。

export const TREND_WIDGET_CSS = `
  .tw-period-row { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
  .tw-period-btn { padding: 6px 12px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-1); color: var(--text-secondary); font-size: 12px; cursor: pointer; }
  .tw-period-btn:hover { background: var(--gridline); }
  .tw-period-btn.active { background: var(--accent); border-color: var(--accent); color: #ffffff; font-weight: 600; }
  .tw-date-row { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; font-size: 12px; color: var(--text-secondary); flex-wrap: wrap; }
  .tw-date-row button { padding: 5px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-1); color: var(--text-secondary); font-size: 12px; cursor: pointer; }
  .tw-date-row button:hover { background: var(--gridline); }
  .tw-date-segment { position: relative; padding: 5px 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-1); color: var(--text-primary); font-size: 12px; font-weight: 600; cursor: pointer; font-variant-numeric: tabular-nums; }
  .tw-date-segment:hover { background: var(--gridline); }
  .tw-seg-caret { margin-left: 3px; font-size: 9px; color: var(--text-muted); }
  .tw-segment-dropdown { position: absolute; top: 100%; left: 0; margin-top: 4px; max-height: 200px; overflow-y: auto; background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.18); z-index: 50; min-width: 68px; }
  .tw-segment-option { padding: 5px 10px; font-size: 12px; color: var(--text-primary); cursor: pointer; white-space: nowrap; }
  .tw-segment-option:hover { background: var(--gridline); }
  .tw-segment-option.selected { background: var(--accent); color: #ffffff; }
  .tw-date-hint { color: var(--accent); font-weight: 600; }
  .tw-stat-line { font-size: 14px; color: var(--text-primary); margin: 4px 0 12px; }
  .tw-stat-line strong { color: var(--accent); }
`;

// title: Wikipedia記事タイトル(生文字列)
// project: "ja.wikipedia" | "en.wikipedia" など
// idbDbName / idbStoreName: ランキングページ側と同じ値を指定するとブラウザキャッシュを共有できる
// widgetId: 1ページに複数ウィジェットを置く場合の要素ID接頭辞(通常は既定値のままでよい)
export function buildTrendWidget({
  title,
  project = "ja.wikipedia",
  idbDbName,
  idbStoreName = "dailyViews",
  apiStart = "20150701",
  widgetId = "tw",
}) {
  const html = `
  <div class="tw-period-row" id="${widgetId}-periodRow"></div>
  <div class="tw-date-row">
    <label>基準日:</label>
    <button type="button" class="tw-date-segment" id="${widgetId}-yearSeg"></button>
    <span>/</span>
    <button type="button" class="tw-date-segment" id="${widgetId}-monthSeg"></button>
    <span>/</span>
    <button type="button" class="tw-date-segment" id="${widgetId}-daySeg"></button>
    <button type="button" id="${widgetId}-liveBtn">最新に戻す</button>
    <span class="tw-date-hint" id="${widgetId}-dateHint"></span>
  </div>
  <p class="tw-stat-line" id="${widgetId}-statLine">読み込み中...</p>
  <div class="chart-wrap" id="${widgetId}-chartWrap"></div>`;

  const script = `<script>
  (function(){
    var TITLE = ${JSON.stringify(title)};
    var PROJECT = ${JSON.stringify(project)};
    var API_START = ${JSON.stringify(apiStart)};
    var IDB_NAME = ${JSON.stringify(idbDbName)};
    var IDB_STORE = ${JSON.stringify(idbStoreName)};
    var WID = ${JSON.stringify(widgetId)};
    var LAG_DAYS = 0;

    var PERIODS = [
      { key: "all", label: "累計" },
      { key: "y1", label: "直近1年" },
      { key: "m1", label: "直近1か月" },
      { key: "w1", label: "直近1週間" },
      { key: "surge", label: "急上昇" }
    ];
    // ライブ表示(historicalDateなし)では基準日当日を含めず、確定済みの最新日(基準日の前日)を
    // 終点にする。当日を含めると日が変わった直後は値がほぼ0になり、意味のない表示になってしまう
    // ため。過去日付を指定して見ているときは、その日はもう確定済みなので当日を含めてよい。
    var ROLLING_DAYS = { w1: 7, m1: 30, y1: 365 };

    var currentPeriod = "all";
    var historicalDate = null;
    var dayMap = new Map();
    var mapLoadedForDate = null;
    var idbPromise = null;

    function $(id) { return document.getElementById(WID + "-" + id); }

    function fmtDate(d) {
      var y = d.getFullYear();
      var m = String(d.getMonth() + 1).padStart(2, "0");
      var day = String(d.getDate()).padStart(2, "0");
      return "" + y + m + day;
    }
    // WikipediaのpageviewsダンプはどれもがUTC日付基準で公開されるため、
    // 「今日」の判定もJST(ローカル時刻)ではなくUTCの日付に合わせる。
    function todayMinusLag() {
      var now = new Date();
      var d = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      d.setDate(d.getDate() - LAG_DAYS);
      return d;
    }
    function dateToYmd(d) { return fmtDate(d); }
    function articleToApiPath(t) { return encodeURIComponent(t.replace(/ /g, "_")); }
    function formatViews(n) { return n.toLocaleString("ja-JP"); }

    function addDaysToYmd(ymd, days) {
      var y = Number(ymd.slice(0, 4));
      var m = Number(ymd.slice(4, 6));
      var dd = Number(ymd.slice(6, 8));
      var date = new Date(y, m - 1, dd);
      date.setDate(date.getDate() + days);
      return fmtDate(date);
    }

    function openIdb() {
      return new Promise(function(resolve, reject){
        var req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function(){
          var db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: "title" });
          }
        };
        req.onsuccess = function(){ resolve(req.result); };
        req.onerror = function(){ reject(req.error); };
      });
    }
    function getIdb() { if (!idbPromise) idbPromise = openIdb(); return idbPromise; }

    function idbGet(title) {
      return getIdb().then(function(db){
        return new Promise(function(resolve, reject){
          var tx = db.transaction(IDB_STORE, "readonly");
          var req = tx.objectStore(IDB_STORE).get(title);
          req.onsuccess = function(){ resolve(req.result || null); };
          req.onerror = function(){ reject(req.error); };
        });
      }).catch(function(){ return null; });
    }
    function idbPut(record) {
      return getIdb().then(function(db){
        return new Promise(function(resolve, reject){
          var tx = db.transaction(IDB_STORE, "readwrite");
          tx.objectStore(IDB_STORE).put(record);
          tx.oncomplete = function(){ resolve(); };
          tx.onerror = function(){ reject(tx.error); };
        });
      }).catch(function(){});
    }

    function fetchSeries(granularity, start, end) {
      var article = articleToApiPath(TITLE);
      var url = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/" + PROJECT + "/all-access/user/" + article + "/" + granularity + "/" + start + "/" + end;
      return fetch(url).then(function(res){
        if (res.status === 404) return [];
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json().then(function(data){
          return (data.items || []).map(function(it){ return { timestamp: it.timestamp, views: it.views || 0 }; });
        });
      });
    }

    function getOrFetchDailyMap(refDateStr) {
      return idbGet(TITLE).then(function(cached){
        var dataObj = cached ? cached.data : {};
        var cachedMaxDate = cached ? cached.maxDate : null;
        if (!cachedMaxDate || cachedMaxDate < refDateStr) {
          var fetchStart = cachedMaxDate ? addDaysToYmd(cachedMaxDate, 1) : API_START;
          if (fetchStart <= refDateStr) {
            return fetchSeries("daily", fetchStart, refDateStr).then(function(items){
              items.forEach(function(it){ dataObj[it.timestamp.slice(0, 8)] = it.views; });
              var keys = Object.keys(dataObj);
              var newMaxDate = keys.length > 0 ? keys.reduce(function(a, b){ return a > b ? a : b; }) : cachedMaxDate;
              if (newMaxDate) {
                return idbPut({ title: TITLE, maxDate: newMaxDate, data: dataObj }).then(function(){
                  return new Map(Object.entries(dataObj));
                });
              }
              return new Map(Object.entries(dataObj));
            });
          }
        }
        return new Map(Object.entries(dataObj));
      });
    }

    function sumRangeFromMap(map, fromDate, days) {
      var total = 0;
      for (var i = 0; i < days; i++) {
        var d = new Date(fromDate);
        d.setDate(d.getDate() + i);
        total += map.get(dateToYmd(d)) || 0;
      }
      return total;
    }
    function computeMetricFromMap(map, periodKey, refDate) {
      if (periodKey === "all") {
        var refYmd = dateToYmd(refDate);
        var total = 0;
        map.forEach(function(v, key){ if (key <= refYmd) total += v; });
        return total;
      }
      if (periodKey === "surge") {
        var recentStart = new Date(refDate); recentStart.setDate(recentStart.getDate() - 6);
        var prevEnd = new Date(refDate); prevEnd.setDate(prevEnd.getDate() - 7);
        var prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - 6);
        var recentWeek = sumRangeFromMap(map, recentStart, 7);
        var prevWeek = sumRangeFromMap(map, prevStart, 7);
        var delta = recentWeek - prevWeek;
        var pct = prevWeek > 0 ? (delta / prevWeek) * 100 : (recentWeek > 0 ? null : 0);
        return { recentWeek: recentWeek, prevWeek: prevWeek, delta: delta, pct: pct };
      }
      // w1/m1/y1はすべて「直近N日間」のローリングウィンドウ。ライブ表示では基準日(当日)を
      // 含めず前日を終点にする(当日はまだ確定していないため)。過去日付を見ているときは
      // その日はもう確定済みなので、指定した日付自体を含めて終点にする。
      var days = ROLLING_DAYS[periodKey];
      var end = new Date(refDate);
      if (!historicalDate) end.setDate(end.getDate() - 1);
      var start = new Date(end);
      start.setDate(start.getDate() - (days - 1));
      return sumRangeFromMap(map, start, days);
    }

    function monthLabel(date) { return date.getFullYear() + "/" + String(date.getMonth() + 1).padStart(2, "0"); }
    function dayLabel(date) { return (date.getMonth() + 1) + "/" + date.getDate(); }
    function hourLabel(date) { return date.getHours() + "時"; }
    function niceCeil(v) {
      if (v <= 0) return 1;
      var magnitude = Math.pow(10, Math.floor(Math.log10(v)));
      var steps = [1, 2, 5, 10];
      for (var i = 0; i < steps.length; i++) { if (v <= steps[i] * magnitude) return steps[i] * magnitude; }
      return 10 * magnitude;
    }
    function buildDailySeriesFromMap(map, start, end) {
      var series = [];
      var cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      var last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      while (cur <= last) {
        series.push({ date: new Date(cur), value: map.get(dateToYmd(cur)) || 0 });
        cur.setDate(cur.getDate() + 1);
      }
      return series;
    }
    function buildMonthlySeriesFromMap(map, refDate) {
      var refYmd = dateToYmd(refDate);
      var byMonth = new Map();
      map.forEach(function(v, key){
        if (key > refYmd) return;
        var mk = key.slice(0, 6);
        byMonth.set(mk, (byMonth.get(mk) || 0) + v);
      });
      var keys = Array.from(byMonth.keys()).sort();
      return keys.map(function(key){
        var y = Number(key.slice(0, 4));
        var m = Number(key.slice(4, 6));
        return { date: new Date(y, m - 1, 1), value: byMonth.get(key) };
      });
    }
    function buildTrendSeriesForCurrentPeriod() {
      var refDate = historicalDate || todayMinusLag();
      if (currentPeriod === "all") return { series: buildMonthlySeriesFromMap(dayMap, refDate), mode: "cumulative" };
      if (ROLLING_DAYS.hasOwnProperty(currentPeriod)) {
        // computeMetricFromMapと同じルールに合わせる。
        var end = new Date(refDate);
        if (!historicalDate) end.setDate(end.getDate() - 1);
        var days = ROLLING_DAYS[currentPeriod];
        var start = new Date(end);
        start.setDate(start.getDate() - (days - 1));
        return { series: buildDailySeriesFromMap(dayMap, start, end), mode: "daily" };
      }
      // surgeなど比較系は直近14日を表示して文脈を見せる
      var sd = new Date(refDate); sd.setDate(sd.getDate() - 13);
      return { series: buildDailySeriesFromMap(dayMap, sd, refDate), mode: "daily" };
    }

    function buildLineChart(series, mode) {
      var W = 600, H = 170, padL = 46, padR = 12, padT = 12, padB = 26;
      var plotW = W - padL - padR, plotH = H - padT - padB;
      var n = series.length;
      var svgNS = "http://www.w3.org/2000/svg";
      var svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", String(H));
      svg.classList.add("trend-svg");
      if (n === 0) {
        var empty = document.createElementNS(svgNS, "text");
        empty.setAttribute("x", String(W / 2));
        empty.setAttribute("y", String(H / 2));
        empty.setAttribute("text-anchor", "middle");
        empty.setAttribute("class", "axis-label");
        empty.textContent = "データなし";
        svg.appendChild(empty);
        return svg;
      }
      var values = series.map(function(p){ return p.value; });
      var maxV = niceCeil(Math.max.apply(null, [1].concat(values)));
      function xAt(i) { return padL + (n <= 1 ? 0 : (i / (n - 1)) * plotW); }
      function yAt(v) { return padT + plotH - (v / maxV) * plotH; }

      [0, 0.5, 1].forEach(function(frac){
        var y = padT + plotH * (1 - frac);
        var line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", String(padL)); line.setAttribute("x2", String(W - padR));
        line.setAttribute("y1", String(y)); line.setAttribute("y2", String(y));
        line.setAttribute("class", "grid-line");
        svg.appendChild(line);
        var label = document.createElementNS(svgNS, "text");
        label.setAttribute("x", String(padL - 6)); label.setAttribute("y", String(y + 3));
        label.setAttribute("text-anchor", "end"); label.setAttribute("class", "axis-label");
        label.textContent = Math.round(maxV * frac).toLocaleString("ja-JP");
        svg.appendChild(label);
      });

      var d = "M " + xAt(0) + " " + yAt(values[0]);
      for (var i = 1; i < n; i++) d += " L " + xAt(i) + " " + yAt(values[i]);
      var areaD = d + " L " + xAt(n - 1) + " " + (padT + plotH) + " L " + xAt(0) + " " + (padT + plotH) + " Z";

      var areaPath = document.createElementNS(svgNS, "path");
      areaPath.setAttribute("d", areaD); areaPath.setAttribute("class", "trend-area");
      svg.appendChild(areaPath);

      var linePath = document.createElementNS(svgNS, "path");
      linePath.setAttribute("d", d); linePath.setAttribute("class", "trend-line");
      svg.appendChild(linePath);

      var endDot = document.createElementNS(svgNS, "circle");
      endDot.setAttribute("cx", String(xAt(n - 1))); endDot.setAttribute("cy", String(yAt(values[n - 1])));
      endDot.setAttribute("r", "4"); endDot.setAttribute("class", "trend-dot");
      svg.appendChild(endDot);

      var labelFn = mode === "cumulative" ? monthLabel : (mode === "hourly" ? hourLabel : dayLabel);
      var firstLabel = document.createElementNS(svgNS, "text");
      firstLabel.setAttribute("x", String(padL)); firstLabel.setAttribute("y", String(H - 6));
      firstLabel.setAttribute("text-anchor", "start"); firstLabel.setAttribute("class", "axis-label");
      firstLabel.textContent = labelFn(series[0].date);
      svg.appendChild(firstLabel);

      var lastLabel = document.createElementNS(svgNS, "text");
      lastLabel.setAttribute("x", String(W - padR)); lastLabel.setAttribute("y", String(H - 6));
      lastLabel.setAttribute("text-anchor", "end"); lastLabel.setAttribute("class", "axis-label");
      lastLabel.textContent = labelFn(series[n - 1].date);
      svg.appendChild(lastLabel);

      var crosshair = document.createElementNS(svgNS, "line");
      crosshair.setAttribute("y1", String(padT)); crosshair.setAttribute("y2", String(padT + plotH));
      crosshair.setAttribute("class", "crosshair"); crosshair.style.opacity = "0";
      svg.appendChild(crosshair);

      var hoverDot = document.createElementNS(svgNS, "circle");
      hoverDot.setAttribute("r", "5"); hoverDot.setAttribute("class", "trend-dot"); hoverDot.style.opacity = "0";
      svg.appendChild(hoverDot);

      var overlay = document.createElementNS(svgNS, "rect");
      overlay.setAttribute("x", String(padL)); overlay.setAttribute("y", String(padT));
      overlay.setAttribute("width", String(plotW)); overlay.setAttribute("height", String(plotH));
      overlay.setAttribute("fill", "transparent"); overlay.style.cursor = "crosshair";
      svg.appendChild(overlay);

      var tooltip = document.getElementById("tooltip");
      overlay.addEventListener("pointermove", function(ev){
        var rect = svg.getBoundingClientRect();
        var relX = (ev.clientX - rect.left) * (W / rect.width);
        var idx = Math.round(((relX - padL) / plotW) * (n - 1));
        idx = Math.max(0, Math.min(n - 1, idx));
        var px = xAt(idx), py = yAt(values[idx]);
        crosshair.setAttribute("x1", String(px)); crosshair.setAttribute("x2", String(px)); crosshair.style.opacity = "1";
        hoverDot.setAttribute("cx", String(px)); hoverDot.setAttribute("cy", String(py)); hoverDot.style.opacity = "1";
        if (tooltip) {
          tooltip.innerHTML = labelFn(series[idx].date) + " <strong>" + values[idx].toLocaleString("ja-JP") + "</strong> 回";
          tooltip.style.left = ev.clientX + "px";
          tooltip.style.top = (ev.clientY - 10) + "px";
          tooltip.classList.add("visible");
        }
      });
      overlay.addEventListener("pointerleave", function(){
        crosshair.style.opacity = "0"; hoverDot.style.opacity = "0";
        if (tooltip) tooltip.classList.remove("visible");
      });

      return svg;
    }

    function daysInMonth(year, monthIndex0) { return new Date(year, monthIndex0 + 1, 0).getDate(); }

    function closeAllDropdowns() {
      document.querySelectorAll(".tw-segment-dropdown").forEach(function(el){ el.remove(); });
    }

    function openSegmentDropdown(segmentEl, options, currentValue, onSelect) {
      var already = segmentEl.querySelector(".tw-segment-dropdown");
      closeAllDropdowns();
      if (already) return;
      var dropdown = document.createElement("div");
      dropdown.className = "tw-segment-dropdown";
      options.forEach(function(opt){
        var item = document.createElement("div");
        item.className = "tw-segment-option" + (opt === currentValue ? " selected" : "");
        item.textContent = String(opt);
        item.addEventListener("click", function(e){
          e.stopPropagation();
          onSelect(opt);
          closeAllDropdowns();
        });
        dropdown.appendChild(item);
      });
      segmentEl.appendChild(dropdown);
    }

    function renderDateSegments() {
      var refDate = historicalDate || todayMinusLag();
      var caret = "<span class=\\"tw-seg-caret\\">▾</span>";
      $("yearSeg").innerHTML = refDate.getFullYear() + "年" + caret;
      $("monthSeg").innerHTML = (refDate.getMonth() + 1) + "月" + caret;
      $("daySeg").innerHTML = refDate.getDate() + "日" + caret;
    }

    function getPeriodLabel(periodKey) {
      var found = PERIODS.filter(function(p){ return p.key === periodKey; })[0];
      return found.label;
    }

    function renderPeriodRow() {
      var row = $("periodRow");
      row.innerHTML = "";
      PERIODS.forEach(function(p){
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tw-period-btn" + (p.key === currentPeriod ? " active" : "");
        btn.textContent = getPeriodLabel(p.key);
        btn.addEventListener("click", function(){
          if (p.key === currentPeriod) return;
          currentPeriod = p.key;
          renderPeriodRow();
          renderStatAndChart();
        });
        row.appendChild(btn);
      });
    }

    function renderStatAndChart() {
      var refDate = historicalDate || todayMinusLag();
      var value = computeMetricFromMap(dayMap, currentPeriod, refDate);
      var statLine = $("statLine");
      var label = getPeriodLabel(currentPeriod);
      if (currentPeriod === "surge") {
        var recentWeek = value.recentWeek, delta = value.delta, pct = value.pct;
        var up = delta > 0;
        var sign = up ? "+" : "";
        var pctText = pct === null ? "" : " (" + sign + pct.toFixed(0) + "%)";
        var deltaText = delta === 0 ? "±0" : (up ? "▲" : "▼") + sign + formatViews(delta);
        statLine.innerHTML = "直近7日は<strong>" + formatViews(recentWeek) + "回</strong>、前週比" + deltaText + pctText;
      } else {
        statLine.innerHTML = label + "の合計: <strong>" + formatViews(value) + "回</strong>";
      }
      var chartWrap = $("chartWrap");
      chartWrap.innerHTML = "";
      var built = buildTrendSeriesForCurrentPeriod();
      chartWrap.appendChild(buildLineChart(built.series, built.mode));
    }

    function loadAndRender() {
      var refDate = historicalDate || todayMinusLag();
      var refDateStr = dateToYmd(refDate);
      var needFetch = mapLoadedForDate !== refDateStr;
      if (needFetch) $("statLine").textContent = "読み込み中...";
      (needFetch ? getOrFetchDailyMap(refDateStr) : Promise.resolve(dayMap)).then(function(map){
        dayMap = map;
        mapLoadedForDate = refDateStr;
        renderPeriodRow();
        renderStatAndChart();
      });
    }

    function applyHistoricalDate(newDate) {
      var end = todayMinusLag();
      historicalDate = newDate > end ? end : newDate;
      $("dateHint").textContent = "過去日付を表示中";
      renderDateSegments();
      loadAndRender();
    }

    document.addEventListener("click", function(e){
      if (!e.target.closest(".tw-date-segment")) closeAllDropdowns();
    });

    $("yearSeg").addEventListener("click", function(e){
      e.stopPropagation();
      var refDate = historicalDate || todayMinusLag();
      var maxYear = todayMinusLag().getFullYear();
      var years = [];
      for (var y = maxYear; y >= 2015; y--) years.push(y);
      openSegmentDropdown($("yearSeg"), years, refDate.getFullYear(), function(y){
        var dim = daysInMonth(y, refDate.getMonth());
        applyHistoricalDate(new Date(y, refDate.getMonth(), Math.min(refDate.getDate(), dim)));
      });
    });
    $("monthSeg").addEventListener("click", function(e){
      e.stopPropagation();
      var refDate = historicalDate || todayMinusLag();
      var months = [1,2,3,4,5,6,7,8,9,10,11,12];
      openSegmentDropdown($("monthSeg"), months, refDate.getMonth() + 1, function(m){
        var dim = daysInMonth(refDate.getFullYear(), m - 1);
        applyHistoricalDate(new Date(refDate.getFullYear(), m - 1, Math.min(refDate.getDate(), dim)));
      });
    });
    $("daySeg").addEventListener("click", function(e){
      e.stopPropagation();
      var refDate = historicalDate || todayMinusLag();
      var dim = daysInMonth(refDate.getFullYear(), refDate.getMonth());
      var days = Array.from({ length: dim }, function(_, i){ return i + 1; });
      openSegmentDropdown($("daySeg"), days, refDate.getDate(), function(d){
        applyHistoricalDate(new Date(refDate.getFullYear(), refDate.getMonth(), d));
      });
    });
    $("liveBtn").addEventListener("click", function(){
      if (!historicalDate) return;
      historicalDate = null;
      $("dateHint").textContent = "";
      renderDateSegments();
      loadAndRender();
    });

    renderDateSegments();
    loadAndRender();
  })();
  </script>`;

  return html + script;
}
