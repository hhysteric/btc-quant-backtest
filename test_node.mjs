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
    "\nObject.assign(module, { sma, ema, computeAhr999, backtestDCA, backtestAhr999, backtestBuyHold, runBacktest, analyzeParam, analyzeCross, runCrossBacktest });"
);
fn(sandbox);
const { runBacktest, computeAhr999, analyzeParam, analyzeCross, runCrossBacktest } = sandbox;

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

// 定投策略累计投入序列检查
console.log("\n=== 定投累计投入序列检查 ===");
for (const s of result.strategies.filter((x) => x.kind === "dca")) {
  const inv = s.investedSeries;
  if (!Array.isArray(inv) || inv.length !== candles.length)
    throw new Error(`${s.name} investedSeries 长度异常`);
  // 单调不减
  for (let i = 1; i < inv.length; i++)
    if (inv[i] < inv[i - 1]) throw new Error(`${s.name} 累计投入出现下降`);
  // 末值应等于 stats.invested
  if (Math.abs(inv[inv.length - 1] - s.stats.invested) > 1e-6)
    throw new Error(`${s.name} 末期投入(${inv.at(-1)}) != stats.invested(${s.stats.invested})`);
  console.log(`${s.name.padEnd(22)} 末期累计投入=$${Math.round(inv.at(-1))}  末期市值=$${Math.round(s.equity.at(-1))}`);
}

// 最优 MA/EMA 应携带均线序列供明细图绘制
console.log("\n=== 均线序列检查 ===");
for (const s of result.strategies.filter((x) => x.key.startsWith("best_"))) {
  if (!Array.isArray(s.maLines) || s.maLines.length === 0)
    throw new Error(`${s.name} 缺少 maLines`);
  for (const line of s.maLines) {
    if (!Array.isArray(line.data) || line.data.length !== candles.length)
      throw new Error(`${s.name} 均线 ${line.name} 长度异常`);
  }
  console.log(`${s.name.padEnd(22)} 均线: ${s.maLines.map((l) => l.name).join(", ")}`);
}

// Rolling 4Y 结构检查（样例仅约 2 年，应整列为 null / 数据不足）
console.log("\n=== Rolling 4Y 结构检查 ===");
const rolling = result.rolling;
if (!rolling || !Array.isArray(rolling.dates) || rolling.dates.length !== candles.length)
  throw new Error("rolling.dates 长度异常");
if (rolling.windowYears !== 4) throw new Error("rolling.windowYears 应为 4");
for (const t of ["ma", "ema"]) {
  const r = rolling[t];
  if (!r) continue;
  if (r.returns.length !== candles.length) throw new Error(`rolling.${t}.returns 长度异常`);
  if (r.periods.length !== candles.length) throw new Error(`rolling.${t}.periods 长度异常`);
  if (r.labels.length !== candles.length) throw new Error(`rolling.${t}.labels 长度异常`);
}
const sampleNonNull = (rolling.ma?.returns || []).filter((v) => v != null).length;
console.log(`样例（约 2 年）MA 非空点数=${sampleNonNull}（预期 0，数据不足 4 年）`);

// 用合成 5 年日线序列验证「数据充足」时 Rolling 能产出非空收益率
console.log("\n=== Rolling 4Y 合成数据验证 ===");
const synthN = 365 * 5;
const synthStart = Date.UTC(2019, 0, 1);
const synth = [];
let px = 5000;
for (let i = 0; i < synthN; i++) {
  // 带噪声的上行趋势，确保择时有进出
  px *= 1 + 0.0008 + 0.05 * Math.sin(i / 23) * Math.cos(i / 57) * 0.4;
  const t = synthStart + i * 86400000;
  const d = new Date(t).toISOString().slice(0, 10);
  synth.push({ time: t, date: d, open: px * 0.99, high: px * 1.02, low: px * 0.98, close: px });
}
const synthRes = runBacktest(synth, { ...cfg, periodMin: 10, periodMax: 60, periodStep: 10 });
const sr = synthRes.rolling.ma;
const nonNull = sr.returns.filter((v) => v != null).length;
if (nonNull === 0) throw new Error("合成 5 年数据 Rolling 仍全空，窗口逻辑有误");
// 非空点应出现在序列后段（前 4 年窗口不足）
const firstNonNull = sr.returns.findIndex((v) => v != null);
if (firstNonNull < synthN * 0.7)
  throw new Error(`Rolling 非空起点过早(${firstNonNull})，4 年窗口未生效`);
// 末点应带 label 与 period
if (sr.labels.at(-1) == null || sr.periods.at(-1) == null)
  throw new Error("Rolling 末点缺少 label/period");
console.log(`合成数据 ${synthN} 根，MA 非空点数=${nonNull}，首个非空 idx=${firstNonNull}`);
console.log(`末点最优：周期=${sr.periods.at(-1)}  参数=${sr.labels.at(-1)}  收益率=${(sr.returns.at(-1) * 100).toFixed(1)}%`);
if (sr.single !== true) throw new Error("单均线模式 rolling.single 应为 true");
if (sr.shortPeriods.at(-1) != null) throw new Error("单均线模式不应有 shortPeriods 值");

// 双均线模式：应填 shortPeriods/longPeriods，periods 留空
console.log("\n=== Rolling 4Y 双均线模式验证 ===");
const synthRes2 = runBacktest(synth, { ...cfg, maMode: "double", periodMin: 10, periodMax: 60, periodStep: 10 });
const sr2 = synthRes2.rolling.ma;
if (sr2.single !== false) throw new Error("双均线模式 rolling.single 应为 false");
if (sr2.shortPeriods.at(-1) == null || sr2.longPeriods.at(-1) == null)
  throw new Error("双均线模式末点缺少 short/long 周期");
if (sr2.shortPeriods.at(-1) >= sr2.longPeriods.at(-1))
  throw new Error("短周期应小于长周期");
if (sr2.periods.at(-1) != null) throw new Error("双均线模式 periods 应留空");
console.log(`双均线末点：短=${sr2.shortPeriods.at(-1)} 长=${sr2.longPeriods.at(-1)} 参数=${sr2.labels.at(-1)}`);

// 手续费检查：开启费率后，各策略最终资产应不高于无费情形（多数应更低）。
console.log("\n=== 手续费效果检查 ===");
const feeRes = runBacktest(candles, { ...cfg, feeRate: 0.001 });
const byKey = (res, k) => res.strategies.find((s) => s.key === k);
for (const key of ["buyhold", "weekly", "monthly", "ahr999"]) {
  const noFee = byKey(result, key).stats.finalEquity;
  const withFee = byKey(feeRes, key).stats.finalEquity;
  if (withFee > noFee + 1e-6)
    throw new Error(`${key} 收费后资产(${withFee}) 反而高于无费(${noFee})`);
  console.log(`${key.padEnd(10)} 无费=$${Math.round(noFee)}  收费(0.1%)=$${Math.round(withFee)}`);
}
// 择时类有进出的策略，收费应严格降低买入持有最终资产
const bhNoFee = byKey(result, "buyhold").stats.finalEquity;
const bhFee = byKey(feeRes, "buyhold").stats.finalEquity;
if (!(bhFee < bhNoFee)) throw new Error("买入持有收费后应略低于无费");
// trade.amount 仍是成交毛额（价格×数量在 buyhold 首笔成立）
const bhTrade = byKey(feeRes, "buyhold").trades[0];
if (Math.abs(bhTrade.amount - cfg.initialCash) > 1e-6)
  throw new Error("buyhold 成交额应等于初始资金（毛额）");
// 收费后实际买到的币量应少于无费
const coinNoFee = byKey(result, "buyhold").trades[0].qty;
const coinFee = bhTrade.qty;
if (!(coinFee < coinNoFee)) throw new Error("收费后买入币量应更少");
console.log(`买入持有：无费买入 ${coinNoFee.toFixed(6)} BTC，收费买入 ${coinFee.toFixed(6)} BTC`);

// 自定义参数回合分析检查
console.log("\n=== 回合分析（单均线 MA3）===");
const ana = analyzeParam(candles, { maType: "ma", maMode: "single", singlePeriod: 3, initialCash: 10000, feeRate: 0 });
if (!Array.isArray(ana.rounds)) throw new Error("analyzeParam 未返回 rounds");
if (ana.rounds.length === 0) throw new Error("MA3 单均线应产生至少一个回合");
// 逐回合校验：账户口径收益率 = exitEquity/entryEquity − 1
for (const r of ana.rounds) {
  const expect = r.entryEquity > 0 ? r.exitEquity / r.entryEquity - 1 : 0;
  if (Math.abs(expect - r.ret) > 1e-9) throw new Error(`回合收益率口径不符：${r.entryDate}`);
  if (!isFinite(r.ret) || !isFinite(r.priceChange)) throw new Error("回合收益出现非有限值");
  if (r.holdDays < 0) throw new Error("持有天数为负");
}
// 已平仓回合数应等于卖出笔数；持仓中回合 ≤ 1
const sellCount = ana.trades.filter((t) => t.side === "sell").length;
const closedRounds = ana.rounds.filter((r) => !r.open).length;
const openRounds = ana.rounds.filter((r) => r.open).length;
if (closedRounds !== sellCount) throw new Error(`已平仓回合(${closedRounds}) != 卖出笔数(${sellCount})`);
if (openRounds > 1) throw new Error(`持仓中回合应 ≤ 1，实际 ${openRounds}`);
if (ana.summary.winRate < 0 || ana.summary.winRate > 1) throw new Error("winRate 越界");
console.log(`MA3：回合数=${ana.summary.roundCount}（持仓中 ${openRounds}） 胜率=${(ana.summary.winRate * 100).toFixed(1)}% 平均回合=${(ana.summary.avgRoundReturn * 100).toFixed(1)}% 总回报=${(ana.summary.totalReturn * 100).toFixed(1)}%`);

// 趋势效率 ER 检查：序列与 candles 等长；非空值落在 [0,1]；summary.er 为末值。
console.log("\n=== 趋势效率 ER 检查 ===");
if (!Array.isArray(ana.erSeries) || ana.erSeries.length !== candles.length)
  throw new Error("erSeries 长度应与 candles 等长");
let erNonNull = 0, erLastSeen = null;
for (const v of ana.erSeries) {
  if (v == null) continue;
  if (!isFinite(v) || v < 0 || v > 1) throw new Error(`ER 越界或非有限：${v}`);
  erNonNull++; erLastSeen = v;
}
if (erNonNull === 0) throw new Error("ER 序列全空");
if (ana.summary.er == null || Math.abs(ana.summary.er - erLastSeen) > 1e-12)
  throw new Error("summary.er 应等于 erSeries 末个非空值");
if (ana.summary.erPeriod !== 3) throw new Error("单均线 MA3 的 erPeriod 应为 3");
// 极端：纯单调上行序列 ER 应接近 1；纯锯齿来回 ER 应接近 0
const upOnly = Array.from({ length: 20 }, (_, i) => 100 + i);
const er1 = analyzeParam(upOnly.map((c, i) => ({ time: i * 86400000, date: "2020-01-01", open: c, high: c, low: c, close: c })),
  { maType: "ma", maMode: "single", singlePeriod: 5, initialCash: 10000, feeRate: 0 });
if (er1.summary.er < 0.99) throw new Error(`单调上行 ER 应≈1，实际 ${er1.summary.er}`);
console.log(`MA3 ER 非空点=${erNonNull}  末值 ER=${ana.summary.er.toFixed(3)}（窗口 ${ana.summary.erPeriod}）  单调序列 ER=${er1.summary.er.toFixed(3)}`);

// 未来 100 天均线延伸检查：futureDates 长 100；每条 maLine 带等长 future；价格恒定时
// 均线应朝最后收盘价单调收敛（差值绝对值不增）。
console.log("\n=== 未来均线延伸检查（价格恒定）===");
if (ana.futureDays !== 100) throw new Error("futureDays 应为 100");
if (!Array.isArray(ana.futureDates) || ana.futureDates.length !== 100)
  throw new Error("futureDates 长度应为 100");
const lastClose = candles.at(-1).close;
for (const line of ana.maLines) {
  if (!Array.isArray(line.future) || line.future.length !== 100)
    throw new Error(`${line.name} future 长度应为 100`);
  // 末点应非常接近最后收盘价（横盘足够久后均线趋于现价）
  const tail = line.future.at(-1);
  if (!isFinite(tail)) throw new Error(`${line.name} future 末点非有限`);
  // 向现价收敛：与现价距离应单调不增
  let prevDist = Infinity;
  for (const v of line.future) {
    const dist = Math.abs(v - lastClose);
    if (dist > prevDist + 1e-6) throw new Error(`${line.name} 延伸未向现价收敛`);
    prevDist = dist;
  }
}
console.log(`MA3 延伸：现价=$${lastClose}  延伸末点=$${ana.maLines[0].future.at(-1).toFixed(2)}（应≈现价）`);

// 双均线模式
console.log("\n=== 回合分析（双均线 MA2/5）===");
const ana2 = analyzeParam(candles, { maType: "ma", maMode: "double", shortPeriod: 2, longPeriod: 5, initialCash: 10000, feeRate: 0 });
if (ana2.rounds.length === 0) throw new Error("双均线 MA2/5 应产生回合");
if (ana2.maLines.length !== 2) throw new Error("双均线应返回两条均线");
for (const r of ana2.rounds) {
  const expect = r.entryEquity > 0 ? r.exitEquity / r.entryEquity - 1 : 0;
  if (Math.abs(expect - r.ret) > 1e-9) throw new Error("双均线回合收益率口径不符");
}
console.log(`MA2/5：回合数=${ana2.summary.roundCount} 胜率=${(ana2.summary.winRate * 100).toFixed(1)}%`);

// 手续费应降低同参数下的最终资产
const anaFee = analyzeParam(candles, { maType: "ma", maMode: "single", singlePeriod: 3, initialCash: 10000, feeRate: 0.001 });
if (anaFee.summary.finalEquity > ana.summary.finalEquity + 1e-6)
  throw new Error("收费后回合分析最终资产反而更高");
console.log(`MA3 手续费效果：无费=$${Math.round(ana.summary.finalEquity)}  收费(0.1%)=$${Math.round(anaFee.summary.finalEquity)}`);

// MA/EMA 交叉回合分析检查
console.log("\n=== 交叉回合分析（MA2 × EMA5）===");
const cross = analyzeCross(candles, { fastType: "ma", fastPeriod: 2, slowType: "ema", slowPeriod: 5, initialCash: 10000, feeRate: 0 });
if (!Array.isArray(cross.rounds)) throw new Error("analyzeCross 未返回 rounds");
if (cross.rounds.length === 0) throw new Error("MA2×EMA5 应产生至少一个回合");
for (const r of cross.rounds) {
  const expect = r.entryEquity > 0 ? r.exitEquity / r.entryEquity - 1 : 0;
  if (Math.abs(expect - r.ret) > 1e-9) throw new Error(`交叉回合收益率口径不符：${r.entryDate}`);
  if (!isFinite(r.ret) || !isFinite(r.priceChange)) throw new Error("交叉回合收益出现非有限值");
  if (r.holdDays < 0) throw new Error("交叉回合持有天数为负");
}
const xSell = cross.trades.filter((t) => t.side === "sell").length;
const xClosed = cross.rounds.filter((r) => !r.open).length;
const xOpen = cross.rounds.filter((r) => r.open).length;
if (xClosed !== xSell) throw new Error(`交叉已平仓回合(${xClosed}) != 卖出笔数(${xSell})`);
if (xOpen > 1) throw new Error(`交叉持仓中回合应 ≤ 1，实际 ${xOpen}`);
if (cross.summary.winRate < 0 || cross.summary.winRate > 1) throw new Error("交叉 winRate 越界");
// 两条均线，一 MA 一 EMA
if (cross.maLines.length !== 2) throw new Error("交叉应返回两条均线");
const names = cross.maLines.map((l) => l.name);
if (!names.some((n) => n.startsWith("MA")) || !names.some((n) => n.startsWith("EMA")))
  throw new Error(`交叉两条均线应分别含 MA 与 EMA，实际 ${names.join(", ")}`);
if (cross.summary.label !== "MA2 × EMA5") throw new Error(`交叉 label 应为 "MA2 × EMA5"，实际 "${cross.summary.label}"`);
// ER 序列与 candles 等长、非空值∈[0,1]
if (!Array.isArray(cross.erSeries) || cross.erSeries.length !== candles.length)
  throw new Error("交叉 erSeries 长度应与 candles 等长");
let xErNonNull = 0;
for (const v of cross.erSeries) {
  if (v == null) continue;
  if (!isFinite(v) || v < 0 || v > 1) throw new Error(`交叉 ER 越界或非有限：${v}`);
  xErNonNull++;
}
if (xErNonNull === 0) throw new Error("交叉 ER 序列全空");
if (cross.summary.erPeriod !== 5) throw new Error("MA2×EMA5 的 erPeriod 应为 max(2,5)=5");
console.log(`MA2×EMA5：回合数=${cross.summary.roundCount}（持仓中 ${xOpen}） 胜率=${(cross.summary.winRate * 100).toFixed(1)}% 均线=${names.join(", ")} ER非空=${xErNonNull}`);

// 反向（EMA20 × MA60 方向可调）与手续费效果
const crossFee = analyzeCross(candles, { fastType: "ma", fastPeriod: 2, slowType: "ema", slowPeriod: 5, initialCash: 10000, feeRate: 0.001 });
if (crossFee.summary.finalEquity > cross.summary.finalEquity + 1e-6)
  throw new Error("交叉收费后最终资产反而更高");
console.log(`MA2×EMA5 手续费效果：无费=$${Math.round(cross.summary.finalEquity)}  收费(0.1%)=$${Math.round(crossFee.summary.finalEquity)}`);

// MA/EMA 交叉策略寻优检查
console.log("\n=== 交叉策略寻优（四组合）===");
const oCfg = { initialCash: 10000, fastMin: 2, fastMax: 4, fastStep: 1, slowMin: 5, slowMax: 8, slowStep: 1, feeRate: 0 };
const oRes = await runCrossBacktest(candles, oCfg);
// rankings 四个组合都在，且各自非空、降序
const comboKeys = ["maxma", "maxema", "emaxma", "emaxema"];
for (const k of comboKeys) {
  const rows = oRes.rankings[k];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`组合 ${k} 排行为空`);
  for (let i = 1; i < rows.length; i++)
    if (rows[i].stats.finalEquity > rows[i - 1].stats.finalEquity + 1e-6)
      throw new Error(`组合 ${k} 未按最终资产降序`);
  // 每条 fast<slow
  for (const r of rows)
    if (!(r.params.fast < r.params.slow)) throw new Error(`组合 ${k} 出现 fast>=slow：${r.label}`);
}
// strategies 含 best_cross 与 buyhold，equity 长度对齐
const bestCross = oRes.strategies.find((s) => s.key === "best_cross");
const oBh = oRes.strategies.find((s) => s.key === "buyhold");
if (!bestCross || !oBh) throw new Error("交叉寻优缺少 best_cross 或 buyhold");
if (bestCross.equity.length !== candles.length || oBh.equity.length !== candles.length)
  throw new Error("交叉寻优 equity 长度异常");
if (!Array.isArray(bestCross.maLines) || bestCross.maLines.length !== 2)
  throw new Error("best_cross 应有两条均线");
// 全局最优 finalEquity 应 ≥ 各组合 Top1 中的最小值（即确实取到全局最大）
const topPerCombo = comboKeys.map((k) => oRes.rankings[k][0].stats.finalEquity);
const globalBestEq = bestCross.stats.finalEquity;
if (globalBestEq < Math.max(...topPerCombo) - 1e-6)
  throw new Error("best_cross 未取到四组合中的全局最优");
console.log(`四组合 Top1 最终资产：${comboKeys.map((k, i) => `${k}=$${Math.round(topPerCombo[i])}`).join("  ")}`);
console.log(`全局最优：${bestCross.name}  最终=$${Math.round(globalBestEq)}  均线=${bestCross.maLines.map((l) => l.name).join(", ")}`);

// 手续费应降低全局最优最终资产
const oResFee = await runCrossBacktest(candles, { ...oCfg, feeRate: 0.001 });
const bestCrossFee = oResFee.strategies.find((s) => s.key === "best_cross");
if (bestCrossFee.stats.finalEquity > globalBestEq + 1e-6)
  throw new Error("交叉寻优收费后最终资产反而更高");
console.log(`交叉手续费效果：无费=$${Math.round(globalBestEq)}  收费(0.1%)=$${Math.round(bestCrossFee.stats.finalEquity)}`);

// rolling 结构：样例约 2 年应全 null
if (!oRes.rolling || oRes.rolling.dates.length !== candles.length) throw new Error("交叉 rolling.dates 长度异常");
if (oRes.rolling.windowYears !== 4) throw new Error("交叉 rolling.windowYears 应为 4");
const oRollKey = oRes.bestCombo.fastType; // rolling 用快线类型作 key
const oRollSeries = oRes.rolling[oRollKey];
if (!oRollSeries) throw new Error("交叉 rolling 缺少最优组合序列");
const oSampleNonNull = oRollSeries.returns.filter((v) => v != null).length;
if (oSampleNonNull !== 0) throw new Error(`样例约 2 年交叉 rolling 应全空，实际 ${oSampleNonNull}`);

// 合成 5 年日线：rolling 应产出非空，且 short<long、首个非空落后段
console.log("\n=== 交叉策略 Rolling 4Y 合成数据验证 ===");
const oSynthRes = await runCrossBacktest(synth, { initialCash: 10000, fastMin: 10, fastMax: 30, fastStep: 10, slowMin: 40, slowMax: 60, slowStep: 10, feeRate: 0 });
const oSynthRoll = oSynthRes.rolling[oSynthRes.bestCombo.fastType];
const oNonNull = oSynthRoll.returns.filter((v) => v != null).length;
if (oNonNull === 0) throw new Error("合成 5 年交叉 rolling 仍全空");
const oFirstNonNull = oSynthRoll.returns.findIndex((v) => v != null);
if (oFirstNonNull < synthN * 0.7) throw new Error(`交叉 rolling 非空起点过早(${oFirstNonNull})`);
if (oSynthRoll.shortPeriods.at(-1) == null || oSynthRoll.longPeriods.at(-1) == null)
  throw new Error("交叉 rolling 末点缺少 short/long");
if (oSynthRoll.shortPeriods.at(-1) >= oSynthRoll.longPeriods.at(-1))
  throw new Error("交叉 rolling 短周期应小于长周期");
if (oSynthRoll.single !== false) throw new Error("交叉 rolling.single 应为 false");
console.log(`合成数据交叉 rolling：非空=${oNonNull}  首个非空 idx=${oFirstNonNull}  末点=${oSynthRoll.labels.at(-1)}  最优组合=${oSynthRes.bestCombo.fastType}×${oSynthRes.bestCombo.slowType}`);

console.log("\n✓ 健全性检查通过");
