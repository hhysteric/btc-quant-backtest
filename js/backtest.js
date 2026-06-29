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
  return { results, best: results[0] };
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
      stats: opt.best.stats,
      kind: "timing",
    });
  }

  // 对比策略
  const weekly = backtestDCA(candles, closes, cfg.dcaAmount, "week");
  out.strategies.push({ name: "周定投", key: "weekly", equity: weekly.equity, trades: weekly.trades, stats: weekly.stats, kind: "dca" });

  const monthly = backtestDCA(candles, closes, cfg.dcaAmount, "month");
  out.strategies.push({ name: "月定投", key: "monthly", equity: monthly.equity, trades: monthly.trades, stats: monthly.stats, kind: "dca" });

  const ahrArr = computeAhr999(candles, closes);
  const ahr = backtestAhr999(candles, closes, cfg.dcaAmount, cfg.ahrThreshold, ahrArr);
  out.strategies.push({ name: `ahr999 定投（<${cfg.ahrThreshold}）`, key: "ahr999", equity: ahr.equity, trades: ahr.trades, stats: ahr.stats, kind: "dca" });

  const bh = backtestBuyHold(candles, closes, cfg.initialCash);
  out.strategies.push({ name: "买入持有（基准）", key: "buyhold", equity: bh.equity, trades: bh.trades, stats: bh.stats, kind: "timing" });

  out.ahr999 = ahrArr;
  return out;
}
