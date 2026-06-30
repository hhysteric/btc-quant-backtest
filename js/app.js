// UI 编排：数据源切换、加载行情、运行回测。

let candles = null;        // 策略回测视图的行情
let analyzeCandles = null; // 单参数回合分析视图的行情（独立加载）
let crossCandles = null;   // MA/EMA 交叉回合分析视图的行情（独立加载）
let optimizeCandles = null; // MA/EMA 交叉策略回测视图的行情（独立加载）

const $ = (id) => document.getElementById(id);

// 顶部标签页：在「策略回测」与「单参数回合分析」两个视图间切换
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const view = btn.dataset.view;
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    $("backtestView").classList.toggle("hidden", view !== "backtest");
    $("analyzeView").classList.toggle("hidden", view !== "analyze");
    $("crossView").classList.toggle("hidden", view !== "cross");
    $("optimizeView").classList.toggle("hidden", view !== "optimize");
    if (typeof rerenderAllCharts === "function") rerenderAllCharts();
  });
});

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

// 默认结束日期为今天（两个视图各一份）
const _today = new Date().toISOString().slice(0, 10);
$("endDate").value = _today;
$("aEndDate").value = _today;
$("xEndDate").value = _today;
$("oEndDate").value = _today;

// 数据源切换：内置/API 显示 API 字段（内置也用日期范围裁剪），文件显示上传字段。
// prefix 区分两个视图的元素 id（回测视图无前缀，分析视图前缀 "a"）。
function makeSyncSourceFields(prefix) {
  const id = (base) => prefix + (prefix ? base[0].toUpperCase() + base.slice(1) : base);
  return function () {
    const v = $(id("source")).value;
    $(id("apiFields")).classList.toggle("hidden", v === "file");
    $(id("fileFields")).classList.toggle("hidden", v !== "file");
    const isBuiltin = v === "builtin";
    $(id("symbol")).closest("label").classList.toggle("hidden", isBuiltin);
    $(id("interval")).closest("label").classList.toggle("hidden", isBuiltin);
  };
}
const syncSourceFields = makeSyncSourceFields("");
const syncAnalyzeSourceFields = makeSyncSourceFields("a");
const syncCrossSourceFields = makeSyncSourceFields("x");
const syncOptimizeSourceFields = makeSyncSourceFields("o");
$("source").addEventListener("change", syncSourceFields);
$("aSource").addEventListener("change", syncAnalyzeSourceFields);
$("xSource").addEventListener("change", syncCrossSourceFields);
$("oSource").addEventListener("change", syncOptimizeSourceFields);
syncSourceFields();
syncAnalyzeSourceFields();
syncCrossSourceFields();
syncOptimizeSourceFields();

// 对数刻度开关
$("logScale").addEventListener("change", () => setLogScale($("logScale").checked));
$("rollingLogScale").addEventListener("change", () => setRollingLog($("rollingLogScale").checked));
$("analyzeLogScale").addEventListener("change", () => setAnalyzeLog($("analyzeLogScale").checked));
$("oLogScale").addEventListener("change", () => setOLog($("oLogScale").checked));
$("oRollingLog").addEventListener("change", () => setORollingLog($("oRollingLog").checked));

// 连赢/连亏区间背景开关；「含单次盈亏」仅在背景开启时有意义，随主开关启用/禁用。
$("analyzeBands").addEventListener("change", () => {
  const on = $("analyzeBands").checked;
  $("analyzeBandsSingle").disabled = !on;
  setAnalyzeBands(on);
});
$("analyzeBandsSingle").addEventListener("change", () => setAnalyzeBandsSingle($("analyzeBandsSingle").checked));
$("analyzeBandsSingle").disabled = true;

// 交叉板块的对数刻度 / 连赢连亏背景开关（与分析板块各自独立）。
$("crossLogScale").addEventListener("change", () => setCrossLog($("crossLogScale").checked));
$("crossBands").addEventListener("change", () => {
  const on = $("crossBands").checked;
  $("crossBandsSingle").disabled = !on;
  setCrossBands(on);
});
$("crossBandsSingle").addEventListener("change", () => setCrossBandsSingle($("crossBandsSingle").checked));
$("crossBandsSingle").disabled = true;

// 手续费开关：勾选后费率输入框可编辑，否则禁用（两个视图各一）
$("feeEnabled").addEventListener("change", () => {
  $("feeRate").disabled = !$("feeEnabled").checked;
});
$("aFeeEnabled").addEventListener("change", () => {
  $("aFeeRate").disabled = !$("aFeeEnabled").checked;
});
$("xFeeEnabled").addEventListener("change", () => {
  $("xFeeRate").disabled = !$("xFeeEnabled").checked;
});
$("oFeeEnabled").addEventListener("change", () => {
  $("oFeeRate").disabled = !$("oFeeEnabled").checked;
});

// 回合分析视图的单/双均线输入随本视图「均线模式」显隐
function syncAnalyzeFields() {
  const isDouble = $("analyzeMaMode").value === "double";
  $("singlePeriodField").classList.toggle("hidden", isDouble);
  $("shortPeriodField").classList.toggle("hidden", !isDouble);
  $("longPeriodField").classList.toggle("hidden", !isDouble);
}
$("analyzeMaMode").addEventListener("change", syncAnalyzeFields);
syncAnalyzeFields();

function setStatus(elId, msg, isError) {
  const el = $(elId);
  el.textContent = msg;
  el.style.color = isError ? "#ef5350" : "#26a69a";
}
function setDataStatus(msg, isError) { setStatus("dataStatus", msg, isError); }

// 按视图前缀读取数据源字段并加载行情，返回 candle 数组。
// prefix="" 为回测视图，prefix="a" 为分析视图。
async function loadCandlesFor(prefix) {
  const id = (base) => prefix + (prefix ? base[0].toUpperCase() + base.slice(1) : base);
  const src = $(id("source")).value;
  if (src === "builtin") {
    const all = await loadBuiltinBtc(true);
    const startMs = Date.parse($(id("startDate")).value);
    const endMs = Date.parse($(id("endDate")).value) + 86400000;
    return all.filter((c) =>
      (isNaN(startMs) || c.time >= startMs) && (isNaN(endMs) || c.time < endMs)
    );
  } else if (src === "api") {
    const symbol = $(id("symbol")).value.trim().toUpperCase();
    const interval = $(id("interval")).value;
    const startMs = Date.parse($(id("startDate")).value);
    const endMs = Date.parse($(id("endDate")).value) + 86400000;
    if (isNaN(startMs) || isNaN(endMs)) throw new Error("请选择有效的起止日期");
    return await fetchBinanceKlines(symbol, interval, startMs, endMs);
  } else {
    const file = $(id("fileInput")).files[0];
    if (!file) throw new Error("请先选择文件");
    return await parseFile(file);
  }
}

function srcNoteFor(prefix) {
  const id = (base) => prefix + (prefix ? base[0].toUpperCase() + base.slice(1) : base);
  const src = $(id("source")).value;
  if (src === "builtin") return "，内置历史 + API 补最新";
  if (src === "api" && typeof _workingHost === "string") return `，数据源 ${_workingHost.replace("https://", "")}`;
  return "";
}

// 回测视图：加载行情
$("loadBtn").addEventListener("click", async () => {
  $("loadBtn").disabled = true;
  $("runBtn").disabled = true;
  setDataStatus("加载中…", false);
  try {
    candles = await loadCandlesFor("");
    if (!candles || candles.length < 10) throw new Error("数据量过少，无法回测");
    setDataStatus(`已加载 ${candles.length} 根 K 线（${candles[0].date} ~ ${candles[candles.length - 1].date}）${srcNoteFor("")}`, false);
    $("runBtn").disabled = false;
  } catch (err) {
    candles = null;
    setDataStatus("加载失败：" + err.message, true);
  } finally {
    $("loadBtn").disabled = false;
  }
});

// 分析视图：独立加载行情
$("aLoadBtn").addEventListener("click", async () => {
  $("aLoadBtn").disabled = true;
  $("analyzeBtn").disabled = true;
  setStatus("aDataStatus", "加载中…", false);
  try {
    analyzeCandles = await loadCandlesFor("a");
    if (!analyzeCandles || analyzeCandles.length < 10) throw new Error("数据量过少，无法分析");
    setStatus("aDataStatus", `已加载 ${analyzeCandles.length} 根 K 线（${analyzeCandles[0].date} ~ ${analyzeCandles[analyzeCandles.length - 1].date}）${srcNoteFor("a")}`, false);
    $("analyzeBtn").disabled = false;
  } catch (err) {
    analyzeCandles = null;
    setStatus("aDataStatus", "加载失败：" + err.message, true);
  } finally {
    $("aLoadBtn").disabled = false;
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
  if (!analyzeCandles) return;
  $("analyzeStatus").textContent = "计算中…";
  $("analyzeStatus").style.color = "#8b98a5";

  setTimeout(() => {
    try {
      const maMode = $("analyzeMaMode").value;
      const cfg = {
        maType: $("analyzeMaType").value,
        maMode,
        initialCash: parseFloat($("aInitialCash").value) || 10000,
        feeRate: $("aFeeEnabled").checked ? (parseFloat($("aFeeRate").value) || 0) / 100 : 0,
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
      const result = analyzeParam(analyzeCandles, cfg);
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

// 交叉视图：独立加载行情
$("xLoadBtn").addEventListener("click", async () => {
  $("xLoadBtn").disabled = true;
  $("crossBtn").disabled = true;
  setStatus("xDataStatus", "加载中…", false);
  try {
    crossCandles = await loadCandlesFor("x");
    if (!crossCandles || crossCandles.length < 10) throw new Error("数据量过少，无法分析");
    setStatus("xDataStatus", `已加载 ${crossCandles.length} 根 K 线（${crossCandles[0].date} ~ ${crossCandles[crossCandles.length - 1].date}）${srcNoteFor("x")}`, false);
    $("crossBtn").disabled = false;
  } catch (err) {
    crossCandles = null;
    setStatus("xDataStatus", "加载失败：" + err.message, true);
  } finally {
    $("xLoadBtn").disabled = false;
  }
});

// MA/EMA 交叉回合分析
$("crossBtn").addEventListener("click", () => {
  if (!crossCandles) return;
  $("crossStatus").textContent = "计算中…";
  $("crossStatus").style.color = "#8b98a5";

  setTimeout(() => {
    try {
      const cfg = {
        fastType: $("fastType").value,
        fastPeriod: parseInt($("fastPeriod").value),
        slowType: $("slowType").value,
        slowPeriod: parseInt($("slowPeriod").value),
        initialCash: parseFloat($("xInitialCash").value) || 10000,
        feeRate: $("xFeeEnabled").checked ? (parseFloat($("xFeeRate").value) || 0) / 100 : 0,
      };
      if (!cfg.fastPeriod || cfg.fastPeriod < 2) throw new Error("请填写有效的快线周期（≥2）");
      if (!cfg.slowPeriod || cfg.slowPeriod < 2) throw new Error("请填写有效的慢线周期（≥2）");
      if (cfg.fastPeriod >= cfg.slowPeriod) throw new Error("快线周期需小于慢线周期");

      const t0 = performance.now();
      const result = analyzeCross(crossCandles, cfg);
      const ms = Math.round(performance.now() - t0);

      renderCross(result);
      $("crossStatus").textContent = `完成（${ms} ms，${result.summary.roundCount} 回合）`;
      $("crossStatus").style.color = "#26a69a";
      $("crossResults").scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      $("crossStatus").textContent = "失败：" + err.message;
      $("crossStatus").style.color = "#ef5350";
    }
  }, 30);
});

// 交叉策略回测视图：独立加载行情
$("oLoadBtn").addEventListener("click", async () => {
  $("oLoadBtn").disabled = true;
  $("optimizeBtn").disabled = true;
  setStatus("oDataStatus", "加载中…", false);
  try {
    optimizeCandles = await loadCandlesFor("o");
    if (!optimizeCandles || optimizeCandles.length < 10) throw new Error("数据量过少，无法回测");
    setStatus("oDataStatus", `已加载 ${optimizeCandles.length} 根 K 线（${optimizeCandles[0].date} ~ ${optimizeCandles[optimizeCandles.length - 1].date}）${srcNoteFor("o")}`, false);
    $("optimizeBtn").disabled = false;
  } catch (err) {
    optimizeCandles = null;
    setStatus("oDataStatus", "加载失败：" + err.message, true);
  } finally {
    $("oLoadBtn").disabled = false;
  }
});

// 运行交叉策略寻优
$("optimizeBtn").addEventListener("click", () => {
  if (!optimizeCandles) return;
  $("optimizeStatus").textContent = "计算中…";
  $("optimizeStatus").style.color = "#8b98a5";

  setTimeout(() => {
    try {
      const cfg = {
        initialCash: parseFloat($("oInitialCash").value) || 10000,
        fastMin: parseInt($("oFastMin").value) || 5,
        fastMax: parseInt($("oFastMax").value) || 60,
        fastStep: parseInt($("oFastStep").value) || 5,
        slowMin: parseInt($("oSlowMin").value) || 20,
        slowMax: parseInt($("oSlowMax").value) || 200,
        slowStep: parseInt($("oSlowStep").value) || 10,
        feeRate: $("oFeeEnabled").checked ? (parseFloat($("oFeeRate").value) || 0) / 100 : 0,
      };
      if (cfg.fastMax <= cfg.fastMin) throw new Error("快线周期上限需大于下限");
      if (cfg.slowMax <= cfg.slowMin) throw new Error("慢线周期上限需大于下限");
      if (cfg.fastStep < 1 || cfg.slowStep < 1) throw new Error("步长需 ≥ 1");
      if (cfg.slowMax <= cfg.fastMin) throw new Error("慢线周期范围需高于快线下限（否则无有效配对）");

      const t0 = performance.now();
      const result = runCrossBacktest(optimizeCandles, cfg);
      const ms = Math.round(performance.now() - t0);

      renderOptimize(result);
      const bestLabel = result.best && result.best.cross ? result.best.cross.label : "无";
      $("optimizeStatus").textContent = `完成（${ms} ms，最优 ${bestLabel}）`;
      $("optimizeStatus").style.color = "#26a69a";
      $("optimizeResults").scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      $("optimizeStatus").textContent = "失败：" + err.message;
      $("optimizeStatus").style.color = "#ef5350";
    }
  }, 30);
});
