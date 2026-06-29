// 各策略回测。所有策略输入 candles，输出 { equity: [..每根总资产], stats }。
// equity 与 candles 等长，便于多曲线对齐绘制。

const BTC_GENESIS_MS = Date.UTC(2009, 0, 3); // 2009-01-03 创世
const DAY_MS = 86400 * 1000;

// 计算资金曲线的收益指标。
function computeStats(candles, equity, buyCount, intervalDays) {
  const start = equity[0];
  const end = equity[equity.length - 1];
  const totalReturn = start > 0 ? (end - start) / start : 0;

  const days = (candles[candles.length - 1].time - candles[0].time) / DAY_MS || 1;
  const years = days / 365;
  const annualized = start > 0 && years > 0
    ? Math.pow(end / start, 1 / years) - 1
    : 0;

  let peak = -Infinity, maxDD = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) maxDD = Math.max(maxDD, (peak - v) / peak);
  }

  return {
    finalEquity: end,
    totalReturn,
    annualized,
    maxDrawdown: maxDD,
    buyCount,
  };
}

// 全仓择时：信号为 true 持币，false 空仓。基于均线交叉。
// mode: 'single' 价格 vs 均线；'double' 短均线 vs 长均线。
function backtestTiming(candles, closes, initialCash, signals) {
  const equity = new Array(candles.length);
  const trades = [];
  let cash = initialCash;
  let coin = 0;
  let buyCount = 0;

  for (let i = 0; i < candles.length; i++) {
    const price = closes[i];
    const sig = signals[i];
    if (sig === true && cash > 0) {
      const qty = cash / price;
      const amount = cash;
      coin = qty;
      cash = 0;
      buyCount++;
      trades.push({
        date: candles[i].date, side: "buy", price, qty, amount,
        coinAfter: coin, cashAfter: cash, equityAfter: cash + coin * price,
      });
    } else if (sig === false && coin > 0) {
      const qty = coin;
      const amount = coin * price;
      cash = amount;
      coin = 0;
      trades.push({
        date: candles[i].date, side: "sell", price, qty, amount,
        coinAfter: coin, cashAfter: cash, equityAfter: cash + coin * price,
      });
    }
    equity[i] = cash + coin * price;
  }
  return { equity, trades, stats: computeStats(candles, equity, buyCount, 1) };
}

// 由均线数组生成持仓信号（单均线：收盘价在均线上方则持有）。
function singleMaSignals(closes, maArr) {
  return closes.map((c, i) => (maArr[i] == null ? null : c > maArr[i]));
}

// 双均线：短均线在长均线上方则持有。
function doubleMaSignals(shortArr, longArr) {
  return shortArr.map((s, i) =>
    s == null || longArr[i] == null ? null : s > longArr[i]
  );
}

// 周期性定投（不卖出）。periodType: 'week' | 'month'。
function backtestDCA(candles, closes, amount, periodType) {
  const equity = new Array(candles.length);
  const trades = [];
  let coin = 0;
  let spent = 0;
  let buys = 0;
  let lastKey = null;

  for (let i = 0; i < candles.length; i++) {
    const d = new Date(candles[i].time);
    let key;
    if (periodType === "week") {
      // ISO 周：用「距创世的周序号」做键
      key = Math.floor((candles[i].time - BTC_GENESIS_MS) / (7 * DAY_MS));
    } else {
      key = d.getUTCFullYear() * 12 + d.getUTCMonth();
    }
    if (key !== lastKey) {
      const price = closes[i];
      const qty = amount / price;
      coin += qty;
      spent += amount;
      buys++;
      lastKey = key;
      trades.push({
        date: candles[i].date, side: "buy", price, qty, amount,
        coinAfter: coin, cashAfter: null, equityAfter: coin * price,
      });
    }
    equity[i] = coin * closes[i];
  }
  // 定投起点资金为 0，用累计投入做收益基准
  const stats = computeStats(candles, equity, buys, 1);
  stats.invested = spent;
  stats.totalReturn = spent > 0 ? (equity[equity.length - 1] - spent) / spent : 0;
  return { equity, trades, stats };
}

// 指数增长估值（ahr999 的分母之一）。币龄自创世起算。
function expGrowthValuation(timeMs) {
  const ageDays = Math.max((timeMs - BTC_GENESIS_MS) / DAY_MS, 1);
  return Math.pow(10, 5.84 * Math.log10(ageDays) - 17.01);
}

// 计算每根 K 线的 ahr999 指数。
// ahr999 = (现价 / 200日定投成本均价) * (现价 / 指数增长估值)
function computeAhr999(candles, closes) {
  const out = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const price = closes[i];
    // 近 200 根的定投成本均价 = N / Σ(1/price)（等额定投的几何意义）
    const n = Math.min(200, i + 1);
    let invSum = 0;
    for (let j = i - n + 1; j <= i; j++) invSum += 1 / closes[j];
    const dcaCost = n / invSum;
    const valuation = expGrowthValuation(candles[i].time);
    out[i] = (price / dcaCost) * (price / valuation);
  }
  return out;
}

// ahr999 定投：每个定投周期到来时，若 ahr999 < 阈值则买入。
// 默认按「日」定投（与指数日频一致），阈值越低买得越多（线性加权）。
function backtestAhr999(candles, closes, baseAmount, threshold, ahrArr) {
  const equity = new Array(candles.length);
  const trades = [];
  let coin = 0;
  let spent = 0;
  let buys = 0;
  let lastKey = null;

  for (let i = 0; i < candles.length; i++) {
    // 周定投节奏，贴近常见用法
    const key = Math.floor((candles[i].time - BTC_GENESIS_MS) / (7 * DAY_MS));
    const ahr = ahrArr[i];
    if (key !== lastKey) {
      lastKey = key;
      if (ahr != null && ahr < threshold) {
        // 加权：ahr 越低越多，封顶 3 倍
        const weight = Math.min(3, Math.max(1, threshold / Math.max(ahr, 0.1)));
        const amt = baseAmount * weight;
        const price = closes[i];
        const qty = amt / price;
        coin += qty;
        spent += amt;
        buys++;
        trades.push({
          date: candles[i].date, side: "buy", price, qty, amount: amt,
          coinAfter: coin, cashAfter: null, equityAfter: coin * price,
          ahr, weight,
        });
      }
    }
    equity[i] = coin * closes[i];
  }
  const stats = computeStats(candles, equity, buys, 1);
  stats.invested = spent;
  stats.totalReturn = spent > 0 ? (equity[equity.length - 1] - spent) / spent : 0;
  return { equity, trades, stats };
}

// 买入持有基准：首根全仓买入。
function backtestBuyHold(candles, closes, initialCash) {
  const coin = initialCash / closes[0];
  const equity = closes.map((c) => coin * c);
  const trades = [{
    date: candles[0].date, side: "buy", price: closes[0], qty: coin, amount: initialCash,
    coinAfter: coin, cashAfter: 0, equityAfter: initialCash,
  }];
  return { equity, trades, stats: computeStats(candles, equity, 1, 1) };
}
