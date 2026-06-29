// 图表与表格渲染。

let timingChartInstance = null;
let dcaChartInstance = null;
let _lastResult = null; // 供明细弹窗按 key 取回策略数据

const COLORS = {
  best_ma: "#f7931a",
  best_ema: "#ffd166",
  weekly: "#26a69a",
  monthly: "#42a5f5",
  ahr999: "#ab47bc",
  buyhold: "#8b98a5",
  btc: "#5c6b7a",
};

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

// 资产 Y 轴：随 _logScale 在线性/对数间切换。对数轴下 0 值无意义，min 设 1。
function equityYAxis(name) {
  return {
    type: _logScale ? "log" : "value",
    name,
    nameTextStyle: { color: "#8b98a5" },
    min: _logScale ? 1 : undefined,
    axisLabel: { color: "#8b98a5", formatter: (v) => money(v) },
    splitLine: { lineStyle: { color: "#2a3441" } },
  };
}

// 单 Y 轴图（定投图用）。
function singleAxisOption(dates, series) {
  return {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "-" : money(v)) },
    legend: { textStyle: { color: "#e6edf3" }, top: 0 },
    grid: { left: 70, right: 24, top: 40, bottom: 50 },
    xAxis: { type: "category", data: dates, axisLabel: { color: "#8b98a5" } },
    yAxis: equityYAxis("资产"),
    dataZoom: [{ type: "inside" }, { type: "slider", bottom: 8, height: 18 }],
    series,
  };
}

// 双 Y 轴图（择时图用）：左轴资产，右轴 BTC 价格。
function timingChartOption(dates, series) {
  return {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "-" : money(v)) },
    legend: { textStyle: { color: "#e6edf3" }, top: 0 },
    grid: { left: 70, right: 70, top: 40, bottom: 50 },
    xAxis: { type: "category", data: dates, axisLabel: { color: "#8b98a5" } },
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
    dataZoom: [{ type: "inside" }, { type: "slider", bottom: 8, height: 18 }],
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

  // 买卖点标注（挂在 K 线 series 上）
  const dateIndex = new Map(dates.map((d, i) => [d, i]));
  const markData = strategy.trades.map((t) => ({
    name: t.side === "buy" ? "买入" : "卖出",
    coord: [t.date, t.price],
    value: t.side === "buy" ? "B" : "S",
    itemStyle: { color: t.side === "buy" ? "#26a69a" : "#ef5350" },
    symbol: t.side === "buy" ? "arrow" : "pin",
    symbolRotate: t.side === "buy" ? 0 : 180,
  })).filter((m) => dateIndex.has(m.coord[0]));
  series[0].markPoint = {
    symbolSize: 22,
    label: { color: "#fff", fontSize: 10, formatter: (p) => p.value },
    data: markData,
  };

  tradeChartInstance.setOption({
    backgroundColor: "transparent",
    tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
    legend: { textStyle: { color: "#e6edf3" }, top: 0 },
    grid: { left: 64, right: 20, top: 32, bottom: 50 },
    xAxis: { type: "category", data: dates, axisLabel: { color: "#8b98a5" }, scale: true },
    yAxis: {
      scale: true,
      axisLabel: { color: "#8b98a5", formatter: (v) => money(v) },
      splitLine: { lineStyle: { color: "#2a3441" } },
    },
    dataZoom: [{ type: "inside" }, { type: "slider", bottom: 8, height: 16 }],
    series,
  });
  setTimeout(() => tradeChartInstance && tradeChartInstance.resize(), 50);
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

function renderResults(result) {
  _lastResult = result;
  document.getElementById("resultsPanel").style.display = "block";
  renderSummaryTable(result);
  renderTimingChart(result);
  renderDcaChart(result);
  renderRankTable(result);
}

window.addEventListener("resize", () => {
  if (timingChartInstance) timingChartInstance.resize();
  if (dcaChartInstance) dcaChartInstance.resize();
});
