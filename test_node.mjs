// 本地 Node 验证：加载策略模块（浏览器全局风格），用样例数据跑回测，核对数值合理性。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => fs.readFileSync(path.join(__dirname, "js", f), "utf8");

// 在一个共享作用域里 eval 各模块（仅取纯计算函数，不含 DOM 的 data.js 的解析部分用不到）
const code = [
  load("indicators.js"),
  load("strategies.js"),
  load("backtest.js"),
].join("\n");

const sandbox = {};
const fn = new Function(
  "module",
  code +
    "\nObject.assign(module, { sma, ema, computeAhr999, backtestDCA, backtestAhr999, backtestBuyHold, runBacktest });"
);
fn(sandbox);
const { runBacktest, computeAhr999 } = sandbox;

// 解析样例 CSV
const csv = fs.readFileSync(path.join(__dirname, "sample_data.csv"), "utf8").trim().split("\n");
const header = csv[0].split(",");
const candles = csv.slice(1).map((line) => {
  const c = line.split(",");
  const o = Object.fromEntries(header.map((h, i) => [h, c[i]]));
  const t = Date.parse(o.date);
  return {
    time: t,
    date: o.date,
    open: +o.open, high: +o.high, low: +o.low, close: +o.close,
  };
});

console.log(`样例数据：${candles.length} 根月线 ${candles[0].date} ~ ${candles.at(-1).date}`);

const cfg = {
  initialCash: 10000,
  dcaAmount: 100,
  maType: "both",
  maMode: "single",
  periodMin: 2,
  periodMax: 8,
  periodStep: 1,
  ahrThreshold: 1.2,
};

const result = runBacktest(candles, cfg);

console.log("\n=== 策略收益对比 ===");
for (const s of result.strategies) {
  const st = s.stats;
  console.log(
    `${s.name.padEnd(22)} 最终=$${Math.round(st.finalEquity).toString().padStart(8)} ` +
    `收益=${(st.totalReturn * 100).toFixed(1).padStart(7)}% ` +
    `回撤=${(st.maxDrawdown * 100).toFixed(1).padStart(5)}% ` +
    `买入=${st.buyCount}` +
    (st.invested != null ? ` 投入=$${Math.round(st.invested)}` : "")
  );
}

console.log("\n=== ahr999 指数（最近 5 期）===");
const ahr = computeAhr999(candles, candles.map((c) => c.close));
candles.slice(-5).forEach((c, i) => {
  const idx = candles.length - 5 + i;
  console.log(`${c.date}  price=$${c.close}  ahr999=${ahr[idx].toFixed(3)}`);
});

console.log("\n=== MA Top 3 ===");
result.rankings.ma.slice(0, 3).forEach((r, i) =>
  console.log(`${i + 1}. ${r.label}  最终=$${Math.round(r.stats.finalEquity)}  收益=${(r.stats.totalReturn * 100).toFixed(1)}%`)
);

// 基本健全性断言
const bh = result.strategies.find((s) => s.key === "buyhold");
if (bh.stats.finalEquity <= 0) throw new Error("买入持有资产异常");
if (!isFinite(ahr.at(-1)) || ahr.at(-1) <= 0) throw new Error("ahr999 数值异常");
// 成交明细断言
console.log("\n=== 成交明细检查 ===");
for (const s of result.strategies) {
  const trades = s.trades || [];
  if (trades.length === 0) throw new Error(`${s.name} 无成交记录`);
  // 金额 ≈ 价格 × 数量
  for (const t of trades) {
    const expect = t.price * t.qty;
    if (Math.abs(expect - t.amount) > Math.max(1e-6, expect * 1e-9))
      throw new Error(`${s.name} 金额与价格×数量不符：${t.date}`);
    if (!["buy", "sell"].includes(t.side)) throw new Error(`${s.name} 非法方向 ${t.side}`);
  }
  // 买入笔数应与 stats.buyCount 一致
  const buys = trades.filter((t) => t.side === "buy").length;
  if (buys !== s.stats.buyCount)
    throw new Error(`${s.name} 买入笔数(${buys}) != buyCount(${s.stats.buyCount})`);
  const sells = trades.filter((t) => t.side === "sell").length;
  console.log(`${s.name.padEnd(22)} 买入 ${buys} 笔，卖出 ${sells} 笔`);
}

// ahr999 策略的成交应带 ahr 字段
const ahrStrat = result.strategies.find((s) => s.key === "ahr999");
if (ahrStrat.trades.some((t) => t.ahr == null))
  throw new Error("ahr999 成交缺少 ahr 字段");
console.log("ahr999 首笔成交：", JSON.stringify({
  date: ahrStrat.trades[0].date, price: ahrStrat.trades[0].price,
  ahr: +ahrStrat.trades[0].ahr.toFixed(3), weight: +ahrStrat.trades[0].weight.toFixed(2),
}));

console.log("\n✓ 健全性检查通过");
