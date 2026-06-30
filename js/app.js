// UI 编排：数据源切换、加载行情、运行回测。

let candles = null;

const $ = (id) => document.getElementById(id);

// 主题：深/浅色切换，localStorage 记住选择，默认深色。
function applyTheme(theme) {
  const isLight = theme === "light";
  document.documentElement.setAttribute("data-theme", isLight ? "light" : "dark");
  $("themeToggle").textContent = isLight ? "☀️ 浅色" : "🌙 深色";
  if (typeof refreshThemeColors === "function") refreshThemeColors();
}
const _savedTheme = localStorage.getItem("theme") || "dark";
applyTheme(_savedTheme);
$("themeToggle").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  localStorage.setItem("theme", next);
  applyTheme(next);
  if (typeof rerenderAllCharts === "function") rerenderAllCharts();
});

// 默认结束日期为今天
$("endDate").value = new Date().toISOString().slice(0, 10);

// 数据源切换：内置/API 显示 API 字段（内置也用日期范围裁剪），文件显示上传字段
function syncSourceFields() {
  const v = $("source").value;
  $("apiFields").classList.toggle("hidden", v === "file");
  $("fileFields").classList.toggle("hidden", v !== "file");
  // 内置数据不需要交易对/周期，仅用日期范围裁剪；隐去交易对与周期
  const isBuiltin = v === "builtin";
  $("symbol").closest("label").classList.toggle("hidden", isBuiltin);
  $("interval").closest("label").classList.toggle("hidden", isBuiltin);
}
$("source").addEventListener("change", syncSourceFields);
syncSourceFields();

// 对数刻度开关
$("logScale").addEventListener("change", () => setLogScale($("logScale").checked));

// 手续费开关：勾选后费率输入框可编辑，否则禁用
$("feeEnabled").addEventListener("change", () => {
  $("feeRate").disabled = !$("feeEnabled").checked;
});

// 回合分析栏目的单/双均线输入随上方「均线模式」显隐
function syncAnalyzeFields() {
  const isDouble = $("maMode").value === "double";
  $("singlePeriodField").classList.toggle("hidden", isDouble);
  $("shortPeriodField").classList.toggle("hidden", !isDouble);
  $("longPeriodField").classList.toggle("hidden", !isDouble);
}
$("maMode").addEventListener("change", syncAnalyzeFields);
syncAnalyzeFields();

function setDataStatus(msg, isError) {
  const el = $("dataStatus");
  el.textContent = msg;
  el.style.color = isError ? "#ef5350" : "#26a69a";
}

// 加载行情
$("loadBtn").addEventListener("click", async () => {
  $("loadBtn").disabled = true;
  $("runBtn").disabled = true;
  $("analyzeBtn").disabled = true;
  setDataStatus("加载中…", false);
  try {
    if ($("source").value === "builtin") {
      const all = await loadBuiltinBtc(true);
      // 用日期范围裁剪（留空则用全部）
      const startMs = Date.parse($("startDate").value);
      const endMs = Date.parse($("endDate").value) + 86400000;
      candles = all.filter((c) =>
        (isNaN(startMs) || c.time >= startMs) && (isNaN(endMs) || c.time < endMs)
      );
    } else if ($("source").value === "api") {
      const symbol = $("symbol").value.trim().toUpperCase();
      const interval = $("interval").value;
      const startMs = Date.parse($("startDate").value);
      const endMs = Date.parse($("endDate").value) + 86400000;
      if (isNaN(startMs) || isNaN(endMs)) throw new Error("请选择有效的起止日期");
      candles = await fetchBinanceKlines(symbol, interval, startMs, endMs);
    } else {
      const file = $("fileInput").files[0];
      if (!file) throw new Error("请先选择文件");
      candles = await parseFile(file);
    }
    if (!candles || candles.length < 10) throw new Error("数据量过少，无法回测");
    const srcNote = $("source").value === "builtin"
      ? "，内置历史 + API 补最新"
      : ($("source").value === "api" && typeof _workingHost === "string"
        ? `，数据源 ${_workingHost.replace("https://", "")}`
        : "");
    setDataStatus(`已加载 ${candles.length} 根 K 线（${candles[0].date} ~ ${candles[candles.length - 1].date}）${srcNote}`, false);
    $("runBtn").disabled = false;
    $("analyzeBtn").disabled = false;
  } catch (err) {
    candles = null;
    setDataStatus("加载失败：" + err.message, true);
  } finally {
    $("loadBtn").disabled = false;
  }
});

// 运行回测
$("runBtn").addEventListener("click", () => {
  if (!candles) return;
  $("runStatus").textContent = "计算中…";
  $("runStatus").style.color = "#8b98a5";

  // 让浏览器先刷新状态文字再跑（避免阻塞 UI）
  setTimeout(() => {
    try {
      const cfg = {
        initialCash: parseFloat($("initialCash").value) || 10000,
        dcaAmount: parseFloat($("dcaAmount").value) || 100,
        maType: $("maType").value,
        maMode: $("maMode").value,
        periodMin: parseInt($("periodMin").value) || 5,
        periodMax: parseInt($("periodMax").value) || 250,
        periodStep: parseInt($("periodStep").value) || 1,
        ahrThreshold: parseFloat($("ahrThreshold").value) || 1.2,
        // 手续费：勾选才生效，输入为百分比（0.1 = 0.1%），转成小数费率
        feeRate: $("feeEnabled").checked ? (parseFloat($("feeRate").value) || 0) / 100 : 0,
      };
      if (cfg.periodMax <= cfg.periodMin) throw new Error("周期上限需大于下限");

      const t0 = performance.now();
      const result = runBacktest(candles, cfg);
      const ms = Math.round(performance.now() - t0);

      renderResults(result);
      $("runStatus").textContent = `完成（${ms} ms）`;
      $("runStatus").style.color = "#26a69a";
      $("resultsPanel").scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      $("runStatus").textContent = "失败：" + err.message;
      $("runStatus").style.color = "#ef5350";
    }
  }, 30);
});

// 自定义参数回合分析
$("analyzeBtn").addEventListener("click", () => {
  if (!candles) return;
  $("analyzeStatus").textContent = "计算中…";
  $("analyzeStatus").style.color = "#8b98a5";

  setTimeout(() => {
    try {
      const maMode = $("maMode").value;
      const cfg = {
        maType: $("analyzeMaType").value,
        maMode,
        initialCash: parseFloat($("initialCash").value) || 10000,
        feeRate: $("feeEnabled").checked ? (parseFloat($("feeRate").value) || 0) / 100 : 0,
      };
      if (maMode === "double") {
        cfg.shortPeriod = parseInt($("shortPeriod").value);
        cfg.longPeriod = parseInt($("longPeriod").value);
        if (!cfg.shortPeriod || !cfg.longPeriod) throw new Error("请填写短/长周期");
        if (cfg.shortPeriod >= cfg.longPeriod) throw new Error("短周期需小于长周期");
      } else {
        cfg.singlePeriod = parseInt($("singlePeriod").value);
        if (!cfg.singlePeriod || cfg.singlePeriod < 2) throw new Error("请填写有效的均线周期（≥2）");
      }

      const t0 = performance.now();
      const result = analyzeParam(candles, cfg);
      const ms = Math.round(performance.now() - t0);

      renderAnalyze(result);
      $("analyzeStatus").textContent = `完成（${ms} ms，${result.summary.roundCount} 回合）`;
      $("analyzeStatus").style.color = "#26a69a";
      $("analyzeResults").scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      $("analyzeStatus").textContent = "失败：" + err.message;
      $("analyzeStatus").style.color = "#ef5350";
    }
  }, 30);
});
