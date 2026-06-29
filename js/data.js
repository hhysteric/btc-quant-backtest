// 数据获取：Binance API 分页拉取 + Excel/CSV 解析。
// 统一输出：[{ time: ms, date: 'YYYY-MM-DD', open, high, low, close }]，按时间升序。

// 主站在部分地区/网络不可达，data-api.binance.vision 为官方公开数据镜像，接口格式一致。
const BINANCE_HOSTS = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
  "https://api1.binance.com",
];

function toDateStr(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 带超时的 fetch。
async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 依次尝试各 Binance 主机，返回首个成功响应的 rows；记录可用主机供后续分页复用。
let _workingHost = null;
async function fetchKlinePage(path) {
  const hosts = _workingHost ? [_workingHost, ...BINANCE_HOSTS.filter((h) => h !== _workingHost)] : BINANCE_HOSTS;
  let lastErr = null;
  for (const host of hosts) {
    try {
      const resp = await fetchWithTimeout(host + path, 12000);
      if (!resp.ok) {
        lastErr = new Error(`${host} 返回 ${resp.status}`);
        continue;
      }
      _workingHost = host;
      return await resp.json();
    } catch (e) {
      lastErr = new Error(`${host} 连接失败`);
    }
  }
  throw new Error(
    `所有 Binance 数据源都无法访问（${lastErr ? lastErr.message : "未知"}）。` +
    `可能是网络限制，请改用本地 Excel/CSV 上传。`
  );
}

// 从 Binance 拉取 K 线，自动分页（单次上限 1000 条）。
async function fetchBinanceKlines(symbol, interval, startMs, endMs) {
  const candles = [];
  let cursor = startMs;
  const LIMIT = 1000;

  while (cursor < endMs) {
    const path = `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=${LIMIT}`;
    const rows = await fetchKlinePage(path);
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const r of rows) {
      // r = [openTime, open, high, low, close, volume, closeTime, ...]
      const t = r[0];
      candles.push({
        time: t,
        date: toDateStr(t),
        open: parseFloat(r[1]),
        high: parseFloat(r[2]),
        low: parseFloat(r[3]),
        close: parseFloat(r[4]),
      });
    }

    const lastOpen = rows[rows.length - 1][0];
    if (rows.length < LIMIT) break;
    cursor = lastOpen + 1; // 下一页从最后一根之后开始
  }

  return candles;
}

// 中英文表头映射。
const HEADER_MAP = {
  date: "date", time: "date", 日期: "date", 时间: "date",
  open: "open", 开盘: "open", 开盘价: "open",
  high: "high", 最高: "high", 最高价: "high",
  low: "low", 最低: "low", 最低价: "low",
  close: "close", 收盘: "close", 收盘价: "close", price: "close", 价格: "close",
};

function normalizeHeader(h) {
  const key = String(h).trim().toLowerCase();
  return HEADER_MAP[key] || HEADER_MAP[String(h).trim()] || null;
}

function parseDateCell(v) {
  if (v == null || v === "") return null;
  // Excel 序列号日期
  if (typeof v === "number") {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    return ms;
  }
  const t = Date.parse(String(v).replace(/\//g, "-"));
  return isNaN(t) ? null : t;
}

// 解析上传的 Excel/CSV 文件。
function parseFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
        if (rows.length < 2) throw new Error("文件内容不足");

        const headers = rows[0].map(normalizeHeader);
        const idx = {};
        headers.forEach((h, i) => { if (h) idx[h] = i; });
        if (idx.date == null || idx.close == null) {
          throw new Error("未识别到 date 与 close 列，请检查表头");
        }

        const candles = [];
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row || row.length === 0) continue;
          const t = parseDateCell(row[idx.date]);
          const close = parseFloat(row[idx.close]);
          if (t == null || isNaN(close)) continue;
          candles.push({
            time: t,
            date: toDateStr(t),
            open: idx.open != null ? parseFloat(row[idx.open]) || close : close,
            high: idx.high != null ? parseFloat(row[idx.high]) || close : close,
            low: idx.low != null ? parseFloat(row[idx.low]) || close : close,
            close,
          });
        }
        candles.sort((a, b) => a.time - b.time);
        if (candles.length === 0) throw new Error("未解析到有效行情数据");
        resolve(candles);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsArrayBuffer(file);
  });
}
