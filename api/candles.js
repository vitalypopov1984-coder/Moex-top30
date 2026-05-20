/**
 * Vercel Serverless Function: /api/candles?ticker=SBER&interval=24&from=2025-01-01&till=2026-05-19
 *
 * Возвращает свечи OHLCV напрямую с MOEX ISS. Заменяет TradingView embed,
 * потому что бесплатный TV-widget плохо работает с российскими тикерами.
 *
 * Параметры:
 *   ticker   — биржевой код (обязательный)
 *   interval — 1, 10, 60, 24, 7, 31 (минуты для intraday, 24=день, 7=неделя, 31=месяц)
 *   from     — дата начала в ISO (default: 1 год назад)
 *   till     — дата конца в ISO   (default: сегодня)
 *
 * Документация: https://iss.moex.com/iss/reference/132
 */

function table(block) {
  if (!block || !block.columns || !block.data) return [];
  const cols = block.columns;
  return block.data.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "moex-top30-vercel/1.0", "Accept": "application/json" },
  });
  if (!r.ok) throw new Error(`MOEX HTTP ${r.status}`);
  return r.json();
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  const q = req.query || {};
  const ticker = String(q.ticker || "").toUpperCase().trim().replace(/[^A-Z0-9]/g, "");
  if (!ticker || ticker.length > 12) {
    res.status(400).json({ error: "bad_ticker" });
    return;
  }
  const interval = String(q.interval || "24");           // дневной по умолчанию
  if (!["1", "10", "60", "24", "7", "31"].includes(interval)) {
    res.status(400).json({ error: "bad_interval", allowed: ["1","10","60","24","7","31"] });
    return;
  }
  const today = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  const from = String(q.from || isoDate(oneYearAgo));
  const till = String(q.till || isoDate(today));

  try {
    let all = [];
    let start = 0;
    let safetyCounter = 0;
    while (true) {
      if (safetyCounter++ > 50) break;   // защита от бесконечного цикла
      const url = `https://iss.moex.com/iss/engines/stock/markets/shares/securities/${ticker}/candles.json`
                + `?iss.meta=off&interval=${interval}&from=${from}&till=${till}&start=${start}`;
      const data = await fetchJson(url);
      const rows = table(data.candles);
      if (!rows.length) break;
      all.push(...rows);

      // ISS pagination — берём cursor
      const cur = table({ columns: data["candles.cursor"]?.columns, data: data["candles.cursor"]?.data })[0];
      if (!cur) break;
      const next = cur.INDEX + cur.PAGESIZE;
      if (next >= cur.TOTAL) break;
      start = next;
    }

    if (all.length === 0) {
      res.status(404).json({ ticker, error: "no_candles" });
      return;
    }

    const candles = all
      .map(r => ({
        t: r.begin,       // дата/время начала свечи (строка ISO)
        o: +r.open,
        h: +r.high,
        l: +r.low,
        c: +r.close,
        v: +(r.volume || 0),
      }))
      .filter(c => Number.isFinite(c.o) && Number.isFinite(c.c));

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({
      ticker,
      interval,
      from, till,
      source: "MOEX ISS",
      as_of: new Date().toISOString(),
      count: candles.length,
      candles,
    });
  } catch (e) {
    res.status(502).json({ ticker, error: "moex_fetch_failed", message: String(e?.message || e) });
  }
}
