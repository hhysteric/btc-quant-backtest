// 图表与表格渲染。

let equityChartInstance = null;

const COLORS = {
  best_ma: "#f7931a",
  best_ema: "#ffd166",
  weekly: "#26a69a",
  monthly: "#42a5f5",
  ahr999: "#ab47bc",
  buyhold: "#8b98a5",
};

function pct(x) {
  const v = (x * 100).toFixed(2) + "%";
  return x >= 0 ? `<span class="pos">+${v}</span>` : `<span class="neg">${v}</span>`;
}
function money(x) {
  return "$" + x.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function renderEquityChart(result) {
  const el = document.getElementById("equityChart");
  if (!equityChartInstance) equityChartInstance = echarts.init(el, "dark");

  const dates = result.candles.map((c) => c.date);
  const series = result.strategies.map((s) => ({
    name: s.name,
    type: "line",
    showSymbol: false,
    smooth: false,
    lineStyle: { width: s.key === "buyhold" ? 1.5 : 2, type: s.key === "buyhold" ? "dashed" : "solid" },
    itemStyle: { color: COLORS[s.key] },
    data: s.equity.map((v) => (v == null ? null : Math.round(v))),
  }));

  equityChartInstance.setOption({
    backgroundColor: "transparent",
    tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "-" : money(v)) },
    legend: { textStyle: { color: "#e6edf3" }, top: 0 },
    grid: { left: 70, right: 24, top: 40, bottom: 50 },
    xAxis: { type: "category", data: dates, axisLabel: { color: "#8b98a5" } },
    yAxis: {
      type: "value",
      axisLabel: { color: "#8b98a5", formatter: (v) => money(v) },
      splitLine: { lineStyle: { color: "#2a3441" } },
    },
    dataZoom: [{ type: "inside" }, { type: "slider", bottom: 8, height: 18 }],
    series,
  });
}

function renderSummaryTable(result) {
  let html = `<table><thead><tr>
    <th>策略</th><th>最终资产</th><th>总收益率</th><th>年化</th><th>最大回撤</th><th>买入次数</th><th>累计投入</th>
    </tr></thead><tbody>`;

  for (const s of result.strategies) {
    const st = s.stats;
    const invested = st.invested != null ? money(st.invested) : "—（全仓）";
    html += `<tr>
      <td>${s.name}</td>
      <td>${money(st.finalEquity)}</td>
      <td>${pct(st.totalReturn)}</td>
      <td>${pct(st.annualized)}</td>
      <td><span class="neg">-${(st.maxDrawdown * 100).toFixed(1)}%</span></td>
      <td>${st.buyCount}</td>
      <td>${invested}</td>
    </tr>`;
  }
  html += "</tbody></table>";
  document.getElementById("summaryTable").innerHTML = html;
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
  document.getElementById("resultsPanel").style.display = "block";
  renderSummaryTable(result);
  renderEquityChart(result);
  renderRankTable(result);
}

window.addEventListener("resize", () => {
  if (equityChartInstance) equityChartInstance.resize();
});
