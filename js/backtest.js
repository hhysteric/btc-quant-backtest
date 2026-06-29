// 回测编排：遍历 MA/EMA 参数寻优，并运行各对比策略。

function periodRange(min, max, step) {
  const arr = [];
  for (let p = min; p <= max; p += step) arr.push(p);
  return arr;
}

// 对单一均线类型（'ma' 或 'ema'）做参数寻优。
// mode: 'single' | 'double'。返回 { results:[...], best }。
function optimizeMa(candles, closes, type, mode, cfg) {
  const maFn = type === "ema" ? ema : sma;
  const periods = periodRange(cfg.periodMin, cfg.periodMax, cfg.periodStep);
  const cache = {};
  const getMa = (p) => (cache[p] || (cache[p] = maFn(closes, p)));

  const results = [];

  if (mode === "single") {
    for (const p of periods) {
      const sig = singleMaSignals(closes, getMa(p));
      const { equity, trades, stats } = backtestTiming(candles, closes, cfg.initialCash, sig);
      results.push({ label: `${type.toUpperCase()}${p}`, params: { p }, equity, trades, stats });
    }
  } else {
    for (let i = 0; i < periods.length; i++) {
      for (let j = i + 1; j < periods.length; j++) {
        const short = periods[i], long = periods[j];
        const sig = doubleMaSignals(getMa(short), getMa(long));
        const { equity, trades, stats } = backtestTiming(candles, closes, cfg.initialCash, sig);
        results.push({
          label: `${type.toUpperCase()}${short}/${long}`,
          params: { short, long },
          equity,
          trades,
          stats,
        });
      }
    }
  }

  results.sort((a, b) => b.stats.finalEquity - a.stats.finalEquity);

  // 仅为最优结果附上其所用均线序列（供明细图绘制），避免为所有结果存数组。
  const best = results[0];
  if (best) {
    if (mode === "single") {
      best.maLines = [{ name: best.label, data: getMa(best.params.p) }];
    } else {
      best.maLines = [
        { name: `${type.toUpperCase()}${best.params.short}`, data: getMa(best.params.short) },
        { name: `${type.toUpperCase()}${best.params.long}`, data: getMa(best.params.long) },
      ];
    }
  }
  return { results, best };
}

// Rolling 4Y：对每根 K 线回看 4 年窗口，在周期范围内逐根寻优，
// 记录该窗口内「最优策略能达到的收益率」及对应周期。
// 返回 { dates, windowYears, ma:{ returns, periods, labels }, ema:{...} }。
const ROLLING_WINDOW_YEARS = 4;

function rollingBestForType(candles, closes, type, cfg) {
  const n = candles.length;
  const maFn = type === "ema" ? ema : sma;
  const periods = periodRange(cfg.periodMin, cfg.periodMax, cfg.periodStep);
  // 预计算各周期均线 + 信号（满窗一次性算好，窗口内直接切片复用）
  const single = cfg.maMode === "single";
  const maArrs = {};
  for (const p of periods) maArrs[p] = maFn(closes, p);

  const winMs = ROLLING_WINDOW_YEARS * 365 * DAY_MS;
  const returns = new Array(n).fill(null);
  // 单均线：bestPeriods 存单值；双均线：shortPeriods/longPeriods 存短长两值。
  const bestPeriods = new Array(n).fill(null);
  const shortPeriods = new Array(n).fill(null);
  const longPeriods = new Array(n).fill(null);
  const labels = new Array(n).fill(null);

  let lo = 0;
  for (let i = 0; i < n; i++) {
    // 推进窗口左端，使 [lo, i] 覆盖约 4 年
    while (candles[i].time - candles[lo].time > winMs) lo++;
    // 窗口太短（不足 4 年）则跳过
    if (candles[i].time - candles[lo].time < winMs * 0.95) continue;

    let bestRet = -Infinity, bestLabel = null, bestP = null, bestShort = null, bestLong = null;
    if (single) {
      for (const p of periods) {
        const r = windowTimingReturn(closes, maArrs[p], lo, i);
        if (r != null && r > bestRet) { bestRet = r; bestP = p; bestLabel = `${type.toUpperCase()}${p}`; }
      }
    } else {
      for (let a = 0; a < periods.length; a++) {
        for (let b = a + 1; b < periods.length; b++) {
          const r = windowTimingReturnDouble(closes, maArrs[periods[a]], maArrs[periods[b]], lo, i);
          if (r != null && r > bestRet) {
            bestRet = r; bestShort = periods[a]; bestLong = periods[b];
            bestLabel = `${type.toUpperCase()}${periods[a]}/${periods[b]}`;
          }
        }
      }
    }
    if (bestRet > -Infinity) {
      returns[i] = bestRet;
      bestPeriods[i] = bestP;
      shortPeriods[i] = bestShort;
      longPeriods[i] = bestLong;
      labels[i] = bestLabel;
    }
  }
  return { single, returns, periods: bestPeriods, shortPeriods, longPeriods, labels };
}

// 在 [lo, hi] 窗口内、用单均线信号跑一次满仓择时，返回总收益率。
// 起始资金任意（用 1），收益率与资金无关。
function windowTimingReturn(closes, maArr, lo, hi) {
  let cash = 1, coin = 0;
  for (let i = lo; i <= hi; i++) {
    const m = maArr[i];
    if (m == null) continue;
    const price = closes[i];
    if (price > m && cash > 0) { coin = cash / price; cash = 0; }
    else if (price < m && coin > 0) { cash = coin * price; coin = 0; }
  }
  const end = cash + coin * closes[hi];
  return end - 1; // 起始 1 → 收益率
}

function windowTimingReturnDouble(closes, shortArr, longArr, lo, hi) {
  let cash = 1, coin = 0;
  for (let i = lo; i <= hi; i++) {
    const s = shortArr[i], l = longArr[i];
    if (s == null || l == null) continue;
    const price = closes[i];
    if (s > l && cash > 0) { coin = cash / price; cash = 0; }
    else if (s < l && coin > 0) { cash = coin * price; coin = 0; }
  }
  const end = cash + coin * closes[hi];
  return end - 1;
}

function rollingBest4Y(candles, closes, cfg) {
  const types = cfg.maType === "both" ? ["ma", "ema"] : [cfg.maType];
  const out = { dates: candles.map((c) => c.date), windowYears: ROLLING_WINDOW_YEARS };
  for (const t of types) out[t] = rollingBestForType(candles, closes, t, cfg);
  return out;
}

// 运行整套回测。返回所有结果供 UI 渲染。
function runBacktest(candles, cfg) {
  const closes = candles.map((c) => c.close);
  const out = { candles, strategies: [], rankings: {}, best: {} };

  // MA / EMA 寻优
  const types = cfg.maType === "both" ? ["ma", "ema"] : [cfg.maType];
  for (const t of types) {
    const opt = optimizeMa(candles, closes, t, cfg.maMode, cfg);
    out.rankings[t] = opt.results;
    out.best[t] = opt.best;
    out.strategies.push({
      name: `最优 ${t.toUpperCase()}（${opt.best.label}）`,
      key: `best_${t}`,
      equity: opt.best.equity,
      trades: opt.best.trades,
      maLines: opt.best.maLines,
      stats: opt.best.stats,
      kind: "timing",
    });
  }

  // 对比策略
  const weekly = backtestDCA(candles, closes, cfg.dcaAmount, "week");
  out.strategies.push({ name: "周定投", key: "weekly", equity: weekly.equity, investedSeries: weekly.investedSeries, trades: weekly.trades, stats: weekly.stats, kind: "dca" });

  const monthly = backtestDCA(candles, closes, cfg.dcaAmount, "month");
  out.strategies.push({ name: "月定投", key: "monthly", equity: monthly.equity, investedSeries: monthly.investedSeries, trades: monthly.trades, stats: monthly.stats, kind: "dca" });

  const ahrArr = computeAhr999(candles, closes);
  const ahr = backtestAhr999(candles, closes, cfg.dcaAmount, cfg.ahrThreshold, ahrArr);
  out.strategies.push({ name: `ahr999 定投（<${cfg.ahrThreshold}）`, key: "ahr999", equity: ahr.equity, investedSeries: ahr.investedSeries, trades: ahr.trades, stats: ahr.stats, kind: "dca" });

  const bh = backtestBuyHold(candles, closes, cfg.initialCash);
  out.strategies.push({ name: "买入持有（基准）", key: "buyhold", equity: bh.equity, trades: bh.trades, stats: bh.stats, kind: "timing" });

  out.ahr999 = ahrArr;
  out.rolling = rollingBest4Y(candles, closes, cfg);
  return out;
}
