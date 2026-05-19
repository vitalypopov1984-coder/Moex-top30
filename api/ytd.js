/**
 * Vercel Serverless Function: /api/ytd?ticker=SBER
 * Возвращает реальную YTD-серию closing prices для одного тикера.
 *
 * Lazy-загрузка: вызывается только при открытии карточки эмитента,
 * а не на каждом загрузке страницы. Это сильно экономит trafic и invocations.
 *
 * Edge-cache 1 час — внутридневные изменения YTD-картинку почти не меняют.
 */

function table(block) {
  if (!block || !block.columns || !block.data) return [];
  const cols = block.columns;
  return block.data.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

function ytdStartDate() {
  // 1 января текущего года
  return `${new Date().getUTCFullYear()}-01-01`;
}

async function fetchAllHistory(ticker, fromDate) {
  // ISS пагинирует по 100 строк; пройдём все страницы
  let start = 0;
  const all = [];
  while (true) {
    const url = `https://iss.moex.com/iss/history/engines/stock/markets/shares/boards/TQBR/securities/${ticker}.json`
              + `?from=${fromDate}&start=${start}&iss.meta=off`
              + `&history.columns=TRADEDATE,CLOSE,LEGALCLOSEPRICE`;
    const r = await fetch(url, {
      headers: { "User-Agent": "moex-top30-vercel/1.0", "Accept": "application/json" },
    });
    if (!r.ok) throw new Error(`MOEX HTTP ${r.status}`);
    const data = await r.json();
    const rows = table(data.history);
    if (rows.length === 0) break;
    all.push(...rows);

    // history.cursor: { INDEX, TOTAL, PAGESIZE }
    const cur = table({ columns: data["history.cursor"]?.columns, data: data["history.cursor"]?.data })[0];
    if (!cur) break;
    const next = cur.INDEX + cur.PAGESIZE;
    if (next >= cur.TOTAL) break;
    start = next;
  }
  return all;
}

export default async function handler(req, res) {
  const ticker = (req.query?.ticker || "").toUpperCase().trim();
  if (!/^[A-Z0-9]{1,12}$/.test(ticker)) {
    res.status(400).json({ error: "bad_ticker" });
    return;
  }
  try {
    const rows = await fetchAllHistory(ticker, ytdStartDate());
    if (rows.length === 0) {
      res.status(404).json({ ticker, error: "no_history" });
      return;
    }

    const series = rows
      .map(r => ({ d: r.TRADEDATE, c: (r.CLOSE ?? r.LEGALCLOSEPRICE) }))
      .filter(p => p.c != null);

    const closes = series.map(p => +p.c);
    const high = Math.max(...closes);
    const low  = Math.min(...closes);
    const first = closes[0], last = closes[closes.length - 1];
    const ytd_pct = first > 0 ? +(((last / first) - 1) * 100).toFixed(2) : null;

    // Если в году > 120 точек — прорежим до 120 равномерно
    let downsampled = series;
    if (series.length > 120) {
      const step = series.length / 120;
      downsampled = [];
      for (let i = 0; i < 120; i++) {
        downsampled.push(series[Math.min(Math.floor(i * step), series.length - 1)]);
      }
      // Последняя точка — фактическая последняя
      downsampled[downsampled.length - 1] = series[series.length - 1];
    }

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({
      ticker,
      source: "MOEX ISS",
      as_of: new Date().toISOString(),
      ytd_pct,
      ytd_high: +high,
      ytd_low: +low,
      points: downsampled.length,
      ytd_series: downsampled,
    });
  } catch (e) {
    res.status(502).json({ ticker, error: "moex_fetch_failed", message: String(e?.message || e) });
  }
}
