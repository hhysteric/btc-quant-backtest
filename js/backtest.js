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

  const feeRate = cfg.feeRate || 0;
  if (mode === "single") {
    for (const p of periods) {
      const sig = singleMaSignals(closes, getMa(p));
      const { equity, trades, stats } = backtestTiming(candles, closes, cfg.initialCash, sig, feeRate);
      results.push({ label: `${type.toUpperCase()}${p}`, params: { p }, equity, trades, stats });
    }
  } else {
    for (let i = 0; i < periods.length; i++) {
      for (let j = i + 1; j < periods.length; j++) {
        const short = periods[i], long = periods[j];
        const sig = doubleMaSignals(getMa(short), getMa(long));
        const { equity, trades, stats } = backtestTiming(candles, closes, cfg.initialCash, sig, feeRate);
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

  const feeRate = cfg.feeRate || 0;
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
        const r = windowTimingReturn(closes, maArrs[p], lo, i, feeRate);
        if (r != null && r > bestRet) { bestRet = r; bestP = p; bestLabel = `${type.toUpperCase()}${p}`; }
      }
    } else {
      for (let a = 0; a < periods.length; a++) {
        for (let b = a + 1; b < periods.length; b++) {
          const r = windowTimingReturnDouble(closes, maArrs[periods[a]], maArrs[periods[b]], lo, i, feeRate);
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
function windowTimingReturn(closes, maArr, lo, hi, feeRate = 0) {
  let cash = 1, coin = 0;
  for (let i = lo; i <= hi; i++) {
    const m = maArr[i];
    if (m == null) continue;
    const price = closes[i];
    if (price > m && cash > 0) { coin = (cash * (1 - feeRate)) / price; cash = 0; }
    else if (price < m && coin > 0) { cash = coin * price * (1 - feeRate); coin = 0; }
  }
  const end = cash + coin * closes[hi];
  return end - 1; // 起始 1 → 收益率
}

function windowTimingReturnDouble(closes, shortArr, longArr, lo, hi, feeRate = 0) {
  let cash = 1, coin = 0;
  for (let i = lo; i <= hi; i++) {
    const s = shortArr[i], l = longArr[i];
    if (s == null || l == null) continue;
    const price = closes[i];
    if (s > l && cash > 0) { coin = (cash * (1 - feeRate)) / price; cash = 0; }
    else if (s < l && coin > 0) { cash = coin * price * (1 - feeRate); coin = 0; }
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

// 自定义单参数回合分析：用户指定一个 MA/EMA 周期（或双均线短/长），
// 跑一次择时回测，并把成交按「买入→卖出」配对成回合，逐回合算收益。
// 回合收益率按账户资产口径（含手续费）：卖出后总资产 / 买入前总资产 − 1。
// 考夫曼趋势效率 ER(n)：方向位移 / 路径总长度，落在 [0,1]。
// 接近 1 → 单边趋势明显（择时类策略友好）；接近 0 → 来回震荡（易被反复打脸）。
function efficiencyRatio(closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    const change = Math.abs(closes[i] - closes[i - period]);
    let volatility = 0;
    for (let j = i - period + 1; j <= i; j++) volatility += Math.abs(closes[j] - closes[j - 1]);
    out[i] = volatility > 0 ? change / volatility : 0;
  }
  return out;
}

// 未来 N 天均线延伸：假设价格恒定在最后收盘价不动，把收盘序列向后补 N 个相同值，
// 重算均线后取尾段。用于直观展示「若就地横盘，均线会怎样向现价收敛」。
function projectMaForward(closes, maFn, period, days) {
  const last = closes[closes.length - 1];
  const extended = closes.concat(new Array(days).fill(last));
  const full = maFn(extended, period);
  return full.slice(closes.length); // 长度 = days
}

const ANALYZE_FUTURE_DAYS = 100;

// 回合分析共用内核：给定持仓信号与两条/一条均线，跑择时回测、配对回合、算 ER 与未来延伸，
// 产出与 analyzeParam/analyzeCross 一致的结果结构。供「单参数回合分析」与「MA/EMA 交叉」共用。
function buildRoundsResult(candles, closes, signals, maLines, erPeriod, initialCash, feeRate, label) {
  const FUTURE_DAYS = ANALYZE_FUTURE_DAYS;

  // 趋势效率序列（窗口取观察周期），与 candles 等长；末值放入 summary。
  const erSeries = efficiencyRatio(closes, erPeriod);
  let erLast = null;
  for (let i = erSeries.length - 1; i >= 0; i--) {
    if (erSeries[i] != null) { erLast = erSeries[i]; break; }
  }

  // 未来日期序列（沿用最后一根的日历日步进，按自然日 +1 天）。
  const lastTime = candles[candles.length - 1].time;
  const futureDates = [];
  for (let d = 1; d <= FUTURE_DAYS; d++) {
    futureDates.push(new Date(lastTime + d * DAY_MS).toISOString().slice(0, 10));
  }

  const { equity, trades, stats } = backtestTiming(candles, closes, initialCash, signals, feeRate);

  // 配对成回合：trades 中 buy/sell 严格交替（全仓进出）。
  const dayMs = DAY_MS;
  const rounds = [];
  let entry = null;
  let prevEquity = initialCash; // 上一笔成交后的总资产，作为下一回合买入前资产
  for (const t of trades) {
    if (t.side === "buy") {
      entry = {
        entryDate: t.date, entryPrice: t.price,
        entryEquity: prevEquity, // 买入前总资产
      };
    } else if (t.side === "sell" && entry) {
      const exitEquity = t.equityAfter;
      const ret = entry.entryEquity > 0 ? exitEquity / entry.entryEquity - 1 : 0;
      const priceChange = entry.entryPrice > 0 ? t.price / entry.entryPrice - 1 : 0;
      const holdDays = Math.round((Date.parse(t.date) - Date.parse(entry.entryDate)) / dayMs);
      rounds.push({
        ...entry, exitDate: t.date, exitPrice: t.price, exitEquity,
        ret, priceChange, holdDays, open: false,
      });
      entry = null;
    }
    prevEquity = t.equityAfter;
  }
  // 末尾未平仓的买入：用最后一根资产估算浮动收益
  let holdingOpen = false;
  if (entry) {
    holdingOpen = true;
    const exitEquity = equity[equity.length - 1];
    const lastPrice = closes[closes.length - 1];
    const ret = entry.entryEquity > 0 ? exitEquity / entry.entryEquity - 1 : 0;
    const priceChange = entry.entryPrice > 0 ? lastPrice / entry.entryPrice - 1 : 0;
    const holdDays = Math.round((candles[candles.length - 1].time - Date.parse(entry.entryDate)) / dayMs);
    rounds.push({
      ...entry, exitDate: candles[candles.length - 1].date, exitPrice: lastPrice, exitEquity,
      ret, priceChange, holdDays, open: true,
    });
  }

  const closed = rounds.filter((r) => !r.open);
  const wins = closed.filter((r) => r.ret > 0).length;
  const rets = rounds.map((r) => r.ret);
  const summary = {
    totalReturn: stats.totalReturn,
    finalEquity: stats.finalEquity,
    maxDrawdown: stats.maxDrawdown,
    roundCount: rounds.length,
    closedCount: closed.length,
    winRate: closed.length > 0 ? wins / closed.length : 0,
    avgRoundReturn: rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0,
    maxRoundReturn: rets.length > 0 ? Math.max(...rets) : 0,
    minRoundReturn: rets.length > 0 ? Math.min(...rets) : 0,
    holdingOpen,
    label,
    er: erLast,
    erPeriod,
  };

  return { stats, trades, rounds, summary, maLines, equity, candles, erSeries, futureDates, futureDays: FUTURE_DAYS };
}

function analyzeParam(candles, cfg) {
  const closes = candles.map((c) => c.close);
  const maFn = cfg.maType === "ema" ? ema : sma;
  const TYPE = cfg.maType.toUpperCase();
  const feeRate = cfg.feeRate || 0;
  const initialCash = cfg.initialCash || 10000;
  const FUTURE_DAYS = ANALYZE_FUTURE_DAYS;

  let signals, maLines, erPeriod, label;
  if (cfg.maMode === "double") {
    const shortArr = maFn(closes, cfg.shortPeriod);
    const longArr = maFn(closes, cfg.longPeriod);
    signals = doubleMaSignals(shortArr, longArr);
    maLines = [
      { name: `${TYPE}${cfg.shortPeriod}`, data: shortArr, future: projectMaForward(closes, maFn, cfg.shortPeriod, FUTURE_DAYS) },
      { name: `${TYPE}${cfg.longPeriod}`, data: longArr, future: projectMaForward(closes, maFn, cfg.longPeriod, FUTURE_DAYS) },
    ];
    erPeriod = cfg.longPeriod; // 双均线用长周期作为趋势效率的观察窗口
    label = `${TYPE}${cfg.shortPeriod}/${cfg.longPeriod}`;
  } else {
    const arr = maFn(closes, cfg.singlePeriod);
    signals = singleMaSignals(closes, arr);
    maLines = [{ name: `${TYPE}${cfg.singlePeriod}`, data: arr, future: projectMaForward(closes, maFn, cfg.singlePeriod, FUTURE_DAYS) }];
    erPeriod = cfg.singlePeriod;
    label = `${TYPE}${cfg.singlePeriod}`;
  }

  return buildRoundsResult(candles, closes, signals, maLines, erPeriod, initialCash, feeRate, label);
}

// MA/EMA 交叉回合分析：快线与慢线各自可为 MA 或 EMA（如 MA20 × EMA60）。
// 快线上穿慢线（金叉）→ 持币买入；下穿（死叉）→ 空仓卖出。复用回合分析全套展示。
function analyzeCross(candles, cfg) {
  const closes = candles.map((c) => c.close);
  const fastFn = cfg.fastType === "ema" ? ema : sma;
  const slowFn = cfg.slowType === "ema" ? ema : sma;
  const FAST = cfg.fastType.toUpperCase();
  const SLOW = cfg.slowType.toUpperCase();
  const feeRate = cfg.feeRate || 0;
  const initialCash = cfg.initialCash || 10000;
  const FUTURE_DAYS = ANALYZE_FUTURE_DAYS;

  const fastArr = fastFn(closes, cfg.fastPeriod);
  const slowArr = slowFn(closes, cfg.slowPeriod);
  const signals = doubleMaSignals(fastArr, slowArr); // 快>慢则持有
  const maLines = [
    { name: `${FAST}${cfg.fastPeriod}`, data: fastArr, future: projectMaForward(closes, fastFn, cfg.fastPeriod, FUTURE_DAYS) },
    { name: `${SLOW}${cfg.slowPeriod}`, data: slowArr, future: projectMaForward(closes, slowFn, cfg.slowPeriod, FUTURE_DAYS) },
  ];
  const erPeriod = Math.max(cfg.fastPeriod, cfg.slowPeriod); // 趋势观察窗口取较长者
  const label = `${FAST}${cfg.fastPeriod} × ${SLOW}${cfg.slowPeriod}`;

  return buildRoundsResult(candles, closes, signals, maLines, erPeriod, initialCash, feeRate, label);
}

// 运行整套回测。返回所有结果供 UI 渲染。
function runBacktest(candles, cfg) {
  const closes = candles.map((c) => c.close);
  const feeRate = cfg.feeRate || 0;
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
  const weekly = backtestDCA(candles, closes, cfg.dcaAmount, "week", feeRate);
  out.strategies.push({ name: "周定投", key: "weekly", equity: weekly.equity, investedSeries: weekly.investedSeries, trades: weekly.trades, stats: weekly.stats, kind: "dca" });

  const monthly = backtestDCA(candles, closes, cfg.dcaAmount, "month", feeRate);
  out.strategies.push({ name: "月定投", key: "monthly", equity: monthly.equity, investedSeries: monthly.investedSeries, trades: monthly.trades, stats: monthly.stats, kind: "dca" });

  const ahrArr = computeAhr999(candles, closes);
  const ahr = backtestAhr999(candles, closes, cfg.dcaAmount, cfg.ahrThreshold, ahrArr, feeRate);
  out.strategies.push({ name: `ahr999 定投（<${cfg.ahrThreshold}）`, key: "ahr999", equity: ahr.equity, investedSeries: ahr.investedSeries, trades: ahr.trades, stats: ahr.stats, kind: "dca" });

  const bh = backtestBuyHold(candles, closes, cfg.initialCash, feeRate);
  out.strategies.push({ name: "买入持有（基准）", key: "buyhold", equity: bh.equity, trades: bh.trades, stats: bh.stats, kind: "timing" });

  out.ahr999 = ahrArr;
  out.rolling = rollingBest4Y(candles, closes, cfg);
  return out;
}
