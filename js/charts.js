// 图表与表格渲染。

let timingChartInstance = null;
let dcaChartInstance = null;
let _lastResult = null; // 供明细弹窗按 key 取回策略数据
let _lastAnalyze = null; // 自定义参数回合分析结果（供主题切换重绘）

const COLORS = {
  best_ma: "#f7931a",
  best_ema: "#ffd166",
  weekly: "#26a69a",
  monthly: "#42a5f5",
  ahr999: "#ab47bc",
  buyhold: "#8b98a5",
  btc: "#5c6b7a",
};

// Rolling 图专用配色：MA/EMA 区分度更高（橙 vs 青蓝），并单列 BTC 价格色。
const ROLLING_COLORS = { ma: "#f7931a", ema: "#29b6f6", btc: "#8b98a5" };

// 买卖标注配色：买入绿、卖出红（深浅色下均为高饱和色，白字清晰）。
const TRADE_COLORS = { buy: "#16a34a", sell: "#dc2626" };

// 构造买卖点 markPoint 配置：买入在 K 线「下方」朝上的箭头，卖出在「上方」朝下的箭头，
// 一上一下错开，避免与 K 线重叠。两个 series 共用，确保两张图风格一致。
function buildTradeMarkPoint(trades, dates) {
  const dateIndex = new Map(dates.map((d, i) => [d, i]));
  const data = trades.map((t) => {
    const isBuy = t.side === "buy";
    return {
      name: isBuy ? "买入" : "卖出",
      coord: [t.date, t.price],
      // 箭头：买入朝上(默认)放在 K 线下方，卖出朝下(翻转)放在 K 线上方，一上一下错开。
      symbol: "arrow",
      symbolRotate: isBuy ? 0 : 180,
      symbolSize: [12, 16],
      symbolOffset: isBuy ? [0, 22] : [0, -22],
      itemStyle: {
        color: isBuy ? TRADE_COLORS.buy : TRADE_COLORS.sell,
        borderColor: "#fff",
        borderWidth: 1,
      },
      // 文字放在箭头外侧（买在下方、卖在上方），不挤进箭头内。
      label: {
        show: true,
        position: isBuy ? "bottom" : "top",
        color: isBuy ? TRADE_COLORS.buy : TRADE_COLORS.sell,
        fontSize: 11,
        fontWeight: "bold",
        formatter: isBuy ? "买" : "卖",
      },
    };
  }).filter((m) => dateIndex.has(m.coord[0]));
  return { data };
}

// 主题相关颜色：从 CSS 变量读取，随深/浅色切换。图表配色据此刷新。
const THEME = { axis: "#8b98a5", grid: "#2a3441", legend: "#e6edf3" };
function refreshThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  const get = (v, fallback) => (cs.getPropertyValue(v).trim() || fallback);
  THEME.axis = get("--muted", "#8b98a5");
  THEME.grid = get("--border", "#2a3441");
  THEME.legend = get("--text", "#e6edf3");
}

// 切换主题后重绘所有图表，使坐标轴/网格/图例配色跟随。
function rerenderAllCharts() {
  refreshThemeColors();
  if (_lastResult) {
    renderTimingChart(_lastResult);
    renderDcaChart(_lastResult);
    renderRollingChart(_lastResult);
  }
  if (_lastAnalyze) renderAnalyzeChart(_lastAnalyze);
}

// 资产 Y 轴是否使用对数刻度（由页面开关控制）。
let _logScale = false;
function setLogScale(on) {
  _logScale = !!on;
  if (_lastResult) {
    renderTimingChart(_lastResult);
    renderDcaChart(_lastResult);
  }
}

function pct(x) {
  const v = (x * 100).toFixed(2) + "%";
  return x >= 0 ? `<span class="pos">+${v}</span>` : `<span class="neg">${v}</span>`;
}
function money(x) {
  return "$" + x.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function money2(x) {
  return "$" + x.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
function btc(x) {
  return x.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

// 统一的缩放配置：底部横向（时间）滑块 + 左侧纵向（数值）滑块，
// 并支持鼠标滚轮在横纵两个方向缩放、拖拽平移，便于细看曲线。
// yIndex 指定纵向缩放作用的 Y 轴序号（默认 0，即资产/数值轴）。
function zoomConfig(yIndex = 0) {
  return [
    // 滚轮缩放：横向 + 纵向（filterMode none 避免缩放时数据被裁掉）
    { type: "inside", xAxisIndex: 0, filterMode: "none" },
    { type: "inside", yAxisIndex: yIndex, filterMode: "none", zoomOnMouseWheel: "shift" },
    // 底部时间滑块
    { type: "slider", xAxisIndex: 0, bottom: 8, height: 18 },
    // 左侧数值滑块（贴最左，不与右轴冲突）
    { type: "slider", yAxisIndex: yIndex, left: 4, width: 14, filterMode: "none" },
  ];
}

// 资产 Y 轴：随 _logScale 在线性/对数间切换。对数轴下 0 值无意义，min 设 1。
function equityYAxis(name) {
  return {
    type: _logScale ? "log" : "value",
    name,
    nameTextStyle: { color: THEME.axis },
    min: _logScale ? 1 : undefined,
    axisLabel: { color: THEME.axis, formatter: (v) => money(v) },
    splitLine: { lineStyle: { color: THEME.grid } },
  };
}

// 单 Y 轴图（定投图用）。
function singleAxisOption(dates, series) {
  return {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "-" : money(v)) },
    legend: { textStyle: { color: THEME.legend }, top: 0 },
    grid: { left: 88, right: 24, top: 40, bottom: 50 },
    xAxis: { type: "category", data: dates, axisLabel: { color: THEME.axis } },
    yAxis: equityYAxis("资产"),
    dataZoom: zoomConfig(),
    series,
  };
}

// 双 Y 轴图（择时图用）：左轴资产，右轴 BTC 价格。
function timingChartOption(dates, series) {
  return {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "-" : money(v)) },
    legend: { textStyle: { color: THEME.legend }, top: 0 },
    grid: { left: 88, right: 70, top: 40, bottom: 50 },
    xAxis: { type: "category", data: dates, axisLabel: { color: THEME.axis } },
    yAxis: [
      equityYAxis("资产"),
      {
        type: _logScale ? "log" : "value",
        name: "BTC",
        position: "right",
        min: _logScale ? 1 : undefined,
        nameTextStyle: { color: COLORS.btc },
        axisLabel: { color: COLORS.btc, formatter: (v) => money(v) },
        splitLine: { show: false },
      },
    ],
    dataZoom: zoomConfig(0),
    series,
  };
}

// 安全获取/初始化图表实例，容器不存在时返回 null（防止 echarts.init(null) 崩溃）。
function ensureChart(id, current) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`图表容器 #${id} 不存在，可能是页面缓存未更新，请强制刷新（Ctrl+F5）`);
    return null;
  }
  return current || echarts.init(el);
}

// 择时组：最优 MA/EMA 与买入持有，同一初始资金的资产曲线 + BTC 走势（右Y轴）。
function renderTimingChart(result) {
  timingChartInstance = ensureChart("timingChart", timingChartInstance);
  if (!timingChartInstance) return;

  const dates = result.candles.map((c) => c.date);
  const series = result.strategies
    .filter((s) => s.kind === "timing")
    .map((s) => ({
      name: s.name,
      type: "line",
      showSymbol: false,
      yAxisIndex: 0,
      lineStyle: { width: s.key === "buyhold" ? 1.5 : 2, type: s.key === "buyhold" ? "dashed" : "solid" },
      itemStyle: { color: COLORS[s.key] },
      data: s.equity.map((v) => (v == null ? null : Math.round(v))),
    }));

  // 叠加 BTC 收盘价走势，走右侧第二 Y 轴
  series.push({
    name: "BTC 价格",
    type: "line",
    showSymbol: false,
    yAxisIndex: 1,
    lineStyle: { width: 1, color: COLORS.btc },
    itemStyle: { color: COLORS.btc },
    data: result.candles.map((c) => c.close),
  });

  timingChartInstance.setOption(timingChartOption(dates, series), true);
}

// 定投组：每个策略画两条线——账户市值（实线）与累计投入（虚线）。
function renderDcaChart(result) {
  dcaChartInstance = ensureChart("dcaChart", dcaChartInstance);
  if (!dcaChartInstance) return;

  const dates = result.candles.map((c) => c.date);
  const series = [];
  for (const s of result.strategies) {
    if (s.kind !== "dca") continue;
    const color = COLORS[s.key];
    series.push({
      name: `${s.name} 市值`,
      type: "line",
      showSymbol: false,
      lineStyle: { width: 2, color },
      itemStyle: { color },
      data: s.equity.map((v) => (v == null ? null : Math.round(v))),
    });
    series.push({
      name: `${s.name} 投入`,
      type: "line",
      showSymbol: false,
      lineStyle: { width: 1.2, type: "dashed", color },
      itemStyle: { color },
      data: (s.investedSeries || []).map((v) => (v == null ? null : Math.round(v))),
    });
  }

  dcaChartInstance.setOption(singleAxisOption(dates, series), true);
}

function renderSummaryTable(result) {
  let html = `<table><thead><tr>
    <th>策略</th><th>最终资产</th><th>总收益率</th><th>年化</th><th>最大回撤</th><th>买入次数</th><th>累计投入</th><th>明细</th>
    </tr></thead><tbody>`;

  for (const s of result.strategies) {
    const st = s.stats;
    const invested = st.invested != null ? money(st.invested) : "—（全仓）";
    const n = s.trades ? s.trades.length : 0;
    const detail = n > 0
      ? `<a href="#" class="detail-link" data-key="${s.key}">查看 (${n})</a>`
      : "—";
    html += `<tr>
      <td>${s.name}</td>
      <td>${money(st.finalEquity)}</td>
      <td>${pct(st.totalReturn)}</td>
      <td>${pct(st.annualized)}</td>
      <td><span class="neg">-${(st.maxDrawdown * 100).toFixed(1)}%</span></td>
      <td>${st.buyCount}</td>
      <td>${invested}</td>
      <td>${detail}</td>
    </tr>`;
  }
  html += "</tbody></table>";
  const container = document.getElementById("summaryTable");
  container.innerHTML = html;
  container.querySelectorAll(".detail-link").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openTradesModal(a.getAttribute("data-key"));
    });
  });
}

// 打开某策略的成交明细弹窗。
function openTradesModal(key) {
  const s = _lastResult && _lastResult.strategies.find((x) => x.key === key);
  if (!s || !s.trades) return;
  const isAhr = key === "ahr999";

  let head = `<th>#</th><th>日期</th><th>方向</th><th>价格</th><th>数量(BTC)</th><th>金额(USDT)</th>`;
  if (isAhr) head += `<th>ahr999</th><th>加权</th>`;
  head += `<th>持仓(BTC)</th><th>现金(USDT)</th><th>总资产</th>`;

  let rows = "";
  s.trades.forEach((t, i) => {
    const sideCls = t.side === "buy" ? "pos" : "neg";
    const sideTxt = t.side === "buy" ? "买入" : "卖出";
    let r = `<td>${i + 1}</td><td>${t.date}</td>` +
      `<td><span class="${sideCls}">${sideTxt}</span></td>` +
      `<td>${money2(t.price)}</td><td>${btc(t.qty)}</td><td>${money2(t.amount)}</td>`;
    if (isAhr) r += `<td>${t.ahr != null ? t.ahr.toFixed(3) : "—"}</td><td>${t.weight != null ? t.weight.toFixed(2) + "x" : "—"}</td>`;
    r += `<td>${btc(t.coinAfter)}</td>` +
      `<td>${t.cashAfter != null ? money2(t.cashAfter) : "—"}</td>` +
      `<td>${money2(t.equityAfter)}</td>`;
    rows += `<tr>${r}</tr>`;
  });

  const html = `
    <div class="modal-mask" id="tradesMask">
      <div class="modal">
        <div class="modal-head">
          <span>${s.name} — 成交明细（共 ${s.trades.length} 笔）</span>
          <button class="modal-close" id="tradesClose">✕</button>
        </div>
        <div class="modal-body">
          <div id="tradeChart" class="trade-chart"></div>
          <table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>
        </div>
      </div>
    </div>`;

  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);

  const mask = document.getElementById("tradesMask");
  const close = () => {
    if (tradeChartInstance) { tradeChartInstance.dispose(); tradeChartInstance = null; }
    mask.remove();
  };
  document.getElementById("tradesClose").addEventListener("click", close);
  mask.addEventListener("click", (e) => { if (e.target === mask) close(); });

  // 渲染 K 线 + 均线 + 买卖标注
  renderTradeChart(s);
}

let tradeChartInstance = null;

// 明细图：BTC 蜡烛图 + 该策略均线 + 买卖点标注。
function renderTradeChart(strategy) {
  const candles = _lastResult.candles;
  const el = document.getElementById("tradeChart");
  if (!el) return;
  // 模态框中容器刚插入，延迟一帧确保有尺寸
  tradeChartInstance = echarts.init(el);

  const dates = candles.map((c) => c.date);
  const ohlc = candles.map((c) => [c.open, c.close, c.low, c.high]); // ECharts: [open, close, low, high]

  const series = [{
    name: "BTC",
    type: "candlestick",
    data: ohlc,
    itemStyle: {
      color: "#26a69a", color0: "#ef5350",
      borderColor: "#26a69a", borderColor0: "#ef5350",
    },
  }];

  // 叠加策略均线（仅择时类有 maLines）
  const maColors = ["#f7931a", "#42a5f5"];
  (strategy.maLines || []).forEach((line, i) => {
    series.push({
      name: line.name,
      type: "line",
      showSymbol: false,
      lineStyle: { width: 1.5, color: maColors[i % maColors.length] },
      itemStyle: { color: maColors[i % maColors.length] },
      data: line.data.map((v) => (v == null ? null : +v.toFixed(2))),
    });
  });

  // 买卖点标注（挂在 K 线 series 上）：买入朝上在下方、卖出朝下在上方，一上一下错开。
  series[0].markPoint = buildTradeMarkPoint(strategy.trades, dates);

  tradeChartInstance.setOption({
    backgroundColor: "transparent",
    tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
    legend: { textStyle: { color: THEME.legend }, top: 0 },
    grid: { left: 88, right: 20, top: 32, bottom: 50 },
    xAxis: { type: "category", data: dates, axisLabel: { color: THEME.axis }, scale: true },
    yAxis: {
      scale: true,
      axisLabel: { color: THEME.axis, formatter: (v) => money(v) },
      splitLine: { lineStyle: { color: THEME.grid } },
    },
    dataZoom: zoomConfig(0),
    series,
  });
  setTimeout(() => tradeChartInstance && tradeChartInstance.resize(), 50);
}

let rollingChartInstance = null;

// Rolling 4Y：纵轴为「窗口内最优均线周期」，展示最优参数随时间的变动。
// 单均线模式每个类型一条线（周期值）；双均线模式画短/长两条（虚线为长）。
// tooltip 额外显示该点对应收益率。
function renderRollingChart(result) {
  rollingChartInstance = ensureChart("rollingChart", rollingChartInstance);
  if (!rollingChartInstance) return;

  const r = result.rolling;
  if (!r) return;
  const dates = r.dates;
  const series = [];
  const labelMap = {}; // type -> 每根的最优参数标签
  const retMap = {};   // type -> 每根的最优收益率

  for (const type of ["ma", "ema"]) {
    if (!r[type]) continue;
    const tr = r[type];
    const TYPE = type.toUpperCase();
    const color = ROLLING_COLORS[type];
    labelMap[type] = tr.labels;
    retMap[type] = tr.returns;

    if (tr.single) {
      series.push({
        name: `最优 ${TYPE} 周期`,
        type: "line",
        step: "end",
        showSymbol: false,
        yAxisIndex: 0,
        lineStyle: { width: 2, color },
        itemStyle: { color },
        data: tr.periods.map((v) => (v == null ? null : v)),
      });
    } else {
      series.push({
        name: `最优 ${TYPE} 短周期`,
        type: "line",
        step: "end",
        showSymbol: false,
        yAxisIndex: 0,
        lineStyle: { width: 2, color },
        itemStyle: { color },
        data: tr.shortPeriods.map((v) => (v == null ? null : v)),
      });
      series.push({
        name: `最优 ${TYPE} 长周期`,
        type: "line",
        step: "end",
        showSymbol: false,
        yAxisIndex: 0,
        lineStyle: { width: 1.5, type: "dashed", color },
        itemStyle: { color },
        data: tr.longPeriods.map((v) => (v == null ? null : v)),
      });
    }
  }

  const hasPeriodData = series.some((s) => s.data.some((v) => v != null));

  // 叠加 BTC 收盘价走势（右 Y 轴），用于与最优周期变动对照。
  series.push({
    name: "BTC 价格",
    type: "line",
    showSymbol: false,
    yAxisIndex: 1,
    lineStyle: { width: 1, color: ROLLING_COLORS.btc },
    itemStyle: { color: ROLLING_COLORS.btc },
    data: result.candles.map((c) => c.close),
  });

  const hasData = hasPeriodData;
  rollingChartInstance.setOption({
    backgroundColor: "transparent",
    title: hasData ? undefined : {
      text: "数据不足 4 年，无法计算 Rolling 4Y",
      left: "center", top: "middle",
      textStyle: { color: THEME.axis, fontSize: 14, fontWeight: "normal" },
    },
    tooltip: {
      trigger: "axis",
      formatter: (params) => {
        if (!params.length) return "";
        const idx = params[0].dataIndex;
        let html = `${params[0].axisValue}`;
        // 同一 type 的短/长两条线只展示一次 label + 收益率
        const seen = new Set();
        for (const p of params) {
          if (p.seriesName === "BTC 价格") {
            html += `<br/>${p.marker}BTC：${p.value == null ? "-" : money(p.value)}`;
            continue;
          }
          const type = p.seriesName.includes("EMA") ? "ema" : "ma";
          if (seen.has(type)) continue;
          seen.add(type);
          const lbl = labelMap[type] && labelMap[type][idx];
          if (lbl == null) continue;
          const ret = retMap[type] && retMap[type][idx];
          const retTxt = ret == null ? "" : `，窗口收益 +${(ret * 100).toFixed(0)}%`;
          html += `<br/>${p.marker}${type.toUpperCase()}：最优 ${lbl}${retTxt}`;
        }
        return html;
      },
    },
    legend: { textStyle: { color: THEME.legend }, top: 0 },
    grid: { left: 88, right: 70, top: 40, bottom: 50 },
    xAxis: { type: "category", data: dates, axisLabel: { color: THEME.axis } },
    yAxis: [
      {
        type: "value",
        name: "最优周期",
        nameTextStyle: { color: THEME.axis },
        axisLabel: { color: THEME.axis },
        splitLine: { lineStyle: { color: THEME.grid } },
      },
      {
        type: "value",
        name: "BTC",
        position: "right",
        nameTextStyle: { color: ROLLING_COLORS.btc },
        axisLabel: { color: ROLLING_COLORS.btc, formatter: (v) => money(v) },
        splitLine: { show: false },
      },
    ],
    dataZoom: zoomConfig(0),
    series,
  }, true);
}

function renderRankTable(result) {
  const blocks = [];
  for (const type of Object.keys(result.rankings)) {
    const rows = result.rankings[type].slice(0, 10);
    let html = `<h4 style="margin:16px 0 8px;color:#8b98a5">${type.toUpperCase()} Top 10</h4>`;
    html += `<table><thead><tr><th>排名</th><th>参数</th><th>最终资产</th><th>总收益率</th><th>最大回撤</th><th>交易次数</th></tr></thead><tbody>`;
    rows.forEach((r, i) => {
      html += `<tr class="${i === 0 ? "best" : ""}">
        <td>${i + 1}</td>
        <td>${r.label}</td>
        <td>${money(r.stats.finalEquity)}</td>
        <td>${pct(r.stats.totalReturn)}</td>
        <td><span class="neg">-${(r.stats.maxDrawdown * 100).toFixed(1)}%</span></td>
        <td>${r.stats.buyCount}</td>
      </tr>`;
    });
    html += "</tbody></table>";
    blocks.push(html);
  }
  document.getElementById("rankTable").innerHTML = blocks.join("");
}

let analyzeChartInstance = null;

// 自定义参数回合分析：汇总卡片 + 买卖点图 + 逐回合表。
function renderAnalyze(result) {
  _lastAnalyze = result;
  document.getElementById("analyzeResults").style.display = "block";
  renderAnalyzeSummary(result);
  renderAnalyzeChart(result);
  renderRoundsTable(result);
}

function renderAnalyzeSummary(result) {
  const s = result.summary;
  const cell = (label, valHtml) =>
    `<div class="summary-card"><span class="summary-label">${label}</span><span class="summary-val">${valHtml}</span></div>`;
  const holdNote = s.holdingOpen ? "（末回合持仓中）" : "";
  const erVal = s.er == null
    ? "—"
    : `${s.er.toFixed(2)}<span class="summary-label" style="font-size:11px"> （${s.er >= 0.5 ? "趋势" : s.er >= 0.3 ? "中性" : "震荡"}）</span>`;
  const html = `<div class="summary-cards">
    ${cell("参数", s.label)}
    ${cell("总回报率", pct(s.totalReturn))}
    ${cell("最终资产", money(s.finalEquity))}
    ${cell("最大回撤", `<span class="neg">-${(s.maxDrawdown * 100).toFixed(1)}%</span>`)}
    ${cell(`趋势效率 ER(${s.erPeriod})`, erVal)}
    ${cell("回合数", `${s.roundCount}${holdNote}`)}
    ${cell("胜率（已平仓）", (s.winRate * 100).toFixed(1) + "%")}
    ${cell("平均回合收益", pct(s.avgRoundReturn))}
    ${cell("最佳回合", pct(s.maxRoundReturn))}
    ${cell("最差回合", pct(s.minRoundReturn))}
  </div>`;
  document.getElementById("analyzeSummary").innerHTML = html;
}

function renderRoundsTable(result) {
  const rounds = result.rounds;
  if (rounds.length === 0) {
    document.getElementById("roundsTable").innerHTML =
      `<p class="hint">该参数在所选区间内无完整买卖回合（可能始终未触发进出）。</p>`;
    return;
  }

  // 按「回合收益（账户）」正负号切分连续区间：>0 连赢、<0 连亏、=0 单独成段。
  const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

  // 先把回合分段成连续同向区间，记下每段起止与复利合计 ∏(1+ret)−1。
  const streaks = []; // { start, len, s, compound }
  let run = [];
  let runStart = 0;
  const closeRun = () => {
    if (run.length > 0) {
      streaks.push({
        start: runStart,
        len: run.length,
        s: sign(run[0].ret),
        compound: run.reduce((acc, r) => acc * (1 + r.ret), 1) - 1,
      });
    }
    run = [];
  };
  rounds.forEach((r, i) => {
    const s = sign(r.ret);
    if (run.length === 0 || (s !== 0 && sign(run[0].ret) === s)) {
      if (run.length === 0) runStart = i;
      run.push(r);
    } else {
      closeRun();
      runStart = i;
      run = [r];
    }
  });
  closeRun();

  // 每个回合 index → 它所属 streak 的「分组标记单元格」HTML（仅区间首行输出带 rowspan 的格子；
  // 长度 1 的区间显示占位，>=2 的区间合并单元格显示复利合计）。
  const groupCell = new Array(rounds.length).fill("");
  for (const st of streaks) {
    if (st.len >= 2) {
      const cls = st.s > 0 ? "pos" : "neg";
      const label = st.s > 0 ? `连赢 ${st.len}` : `连亏 ${st.len}`;
      groupCell[st.start] =
        `<td rowspan="${st.len}" class="streak-cell ${cls}">` +
        `<div class="streak-tag">${label}</div>` +
        `<div class="streak-sum"><strong>${pct(st.compound)}</strong></div></td>`;
    } else {
      groupCell[st.start] = `<td class="streak-cell"><span class="muted-dash">—</span></td>`;
    }
  }

  let html = `<table><thead><tr>
    <th>回合</th><th>买入日</th><th>买入价</th><th>卖出日</th><th>卖出价</th>
    <th>持有天数</th><th>价格涨跌</th><th>回合收益（账户）</th><th>状态</th><th>连赢/连亏区间</th>
    </tr></thead><tbody>`;

  rounds.forEach((r, i) => {
    html += `<tr class="${r.open ? "best" : ""}">
      <td>${i + 1}</td>
      <td>${r.entryDate}</td>
      <td>${money2(r.entryPrice)}</td>
      <td>${r.exitDate}</td>
      <td>${money2(r.exitPrice)}</td>
      <td>${r.holdDays}</td>
      <td>${pct(r.priceChange)}</td>
      <td>${pct(r.ret)}</td>
      <td>${r.open ? "持仓中" : "已平仓"}</td>${groupCell[i]}
    </tr>`;
  });

  html += "</tbody></table>";
  document.getElementById("roundsTable").innerHTML = html;
}

// 买卖点图：复用明细图的 K线 + 均线 + 进出标注模式。
function renderAnalyzeChart(result) {
  const el = document.getElementById("analyzeChart");
  if (!el) return;
  analyzeChartInstance = analyzeChartInstance || echarts.init(el);

  const candles = result.candles;
  const histDates = candles.map((c) => c.date);
  const futureDates = result.futureDates || [];
  const dates = histDates.concat(futureDates); // 历史 + 未来 100 天
  const nHist = histDates.length;
  // K 线只画历史；未来段补 null 占位以对齐 x 轴。
  const ohlc = candles.map((c) => [c.open, c.close, c.low, c.high])
    .concat(futureDates.map(() => [null, null, null, null]));

  const series = [{
    name: "BTC",
    type: "candlestick",
    data: ohlc,
    itemStyle: {
      color: "#26a69a", color0: "#ef5350",
      borderColor: "#26a69a", borderColor0: "#ef5350",
    },
  }];

  const maColors = ["#f7931a", "#42a5f5"];
  (result.maLines || []).forEach((line, i) => {
    const color = maColors[i % maColors.length];
    const hist = line.data.map((v) => (v == null ? null : +v.toFixed(2)));
    // 历史实线：历史段有值、未来段 null
    series.push({
      name: line.name,
      type: "line",
      showSymbol: false,
      lineStyle: { width: 1.5, color },
      itemStyle: { color },
      data: hist.concat(futureDates.map(() => null)),
    });
    // 未来虚线延伸：前置 null 占位至当前，再接未来段；首点接上历史末值以连续。
    if (line.future && line.future.length) {
      const lead = new Array(nHist).fill(null);
      if (nHist > 0) lead[nHist - 1] = hist[nHist - 1]; // 衔接历史末点
      series.push({
        name: line.name + " 延伸",
        type: "line",
        showSymbol: false,
        lineStyle: { width: 1.5, color, type: "dashed", opacity: 0.85 },
        itemStyle: { color },
        data: lead.concat(line.future.map((v) => (v == null ? null : +v.toFixed(2)))),
      });
    }
  });

  // 趋势效率 ER 曲线，挂右轴（0~1）。未来段无 ER，补 null。
  const erData = (result.erSeries || []).map((v) => (v == null ? null : +v.toFixed(3)))
    .concat(futureDates.map(() => null));
  series.push({
    name: "趋势效率 ER",
    type: "line",
    yAxisIndex: 1,
    showSymbol: false,
    lineStyle: { width: 1, color: "#ab47bc", opacity: 0.8 },
    itemStyle: { color: "#ab47bc" },
    areaStyle: { color: "#ab47bc", opacity: 0.06 },
    data: erData,
  });

  // 买卖点标注：买入朝上在下方、卖出朝下在上方，一上一下错开。
  series[0].markPoint = buildTradeMarkPoint(result.trades, dates);
  // 在「当前/未来」分界处画一条竖向参考线。
  if (futureDates.length && nHist > 0) {
    series[0].markLine = {
      symbol: "none",
      silent: true,
      lineStyle: { color: THEME.axis, type: "dashed", opacity: 0.6 },
      label: { color: THEME.axis, formatter: "今日", position: "insideEndTop", fontSize: 11 },
      data: [{ xAxis: histDates[nHist - 1] }],
    };
  }

  analyzeChartInstance.setOption({
    backgroundColor: "transparent",
    tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
    legend: { textStyle: { color: THEME.legend }, top: 0 },
    grid: { left: 88, right: 56, top: 32, bottom: 50 },
    xAxis: { type: "category", data: dates, axisLabel: { color: THEME.axis }, scale: true },
    yAxis: [
      {
        scale: true,
        axisLabel: { color: THEME.axis, formatter: (v) => money(v) },
        splitLine: { lineStyle: { color: THEME.grid } },
      },
      {
        name: "ER",
        min: 0, max: 1,
        position: "right",
        axisLabel: { color: THEME.axis, formatter: (v) => v.toFixed(1) },
        splitLine: { show: false },
        nameTextStyle: { color: THEME.axis },
      },
    ],
    dataZoom: zoomConfig(0),
    series,
  }, true);
  setTimeout(() => analyzeChartInstance && analyzeChartInstance.resize(), 50);
}

function renderResults(result) {
  _lastResult = result;
  document.getElementById("resultsPanel").style.display = "block";
  renderSummaryTable(result);
  renderTimingChart(result);
  renderDcaChart(result);
  renderRankTable(result);
  renderRollingChart(result);
}

window.addEventListener("resize", () => {
  if (timingChartInstance) timingChartInstance.resize();
  if (dcaChartInstance) dcaChartInstance.resize();
  if (rollingChartInstance) rollingChartInstance.resize();
  if (analyzeChartInstance) analyzeChartInstance.resize();
});
