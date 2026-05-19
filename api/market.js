/**
 * Vercel Serverless Function: /api/market
 * Возвращает общее состояние рынка для mood gauge и market map.
 *
 *  • IMOEX — текущее значение индекса и изменение за день
 *  • breadth — % акций TQBR с положительным изменением за день
 *  • top_gainers / top_losers — топ-20 рост / топ-20 падение за день (для market map)
 *  • mood_score — агрегатный показатель 0..100 (0 — медведь, 100 — бык)
 *
 * Edge cache: 5 минут.
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
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

export default async function handler(req, res) {
  try {
    // 1) Снапшот всех акций борда TQBR
    const allUrl = "https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities.json"
                 + "?iss.meta=off"
                 + "&securities.columns=SECID,SHORTNAME,PREVPRICE"
                 + "&marketdata.columns=SECID,LAST,LCURRENTPRICE,LCLOSEPRICE,LASTCHANGEPRCNT,VALTODAY";
    const allData = await fetchJson(allUrl);
    const sec = Object.fromEntries(table(allData.securities).map(r => [r.SECID, r]));
    const mkt = Object.fromEntries(table(allData.marketdata).map(r => [r.SECID, r]));

    const movers = [];
    let upCount = 0, downCount = 0, totalCount = 0;
    let sumChange = 0;

    for (const ticker of Object.keys(sec)) {
      const s = sec[ticker], m = mkt[ticker] || {};
      const price = m.LAST ?? m.LCURRENTPRICE ?? s.PREVPRICE;
      const prev  = s.PREVPRICE ?? m.LCLOSEPRICE;
      if (price == null || prev == null || prev <= 0) continue;
      const change_pct = +((price / prev - 1) * 100).toFixed(2);
      const value      = +(m.VALTODAY || 0);
      // Сильно неликвидные — отбрасываем (шум для market map)
      if (value < 1_000_000) continue;
      movers.push({
        ticker, name: s.SHORTNAME, price: +price, change_pct,
        value_rub: value,
      });
      totalCount++;
      if (change_pct > 0) upCount++;
      else if (change_pct < 0) downCount++;
      sumChange += change_pct;
    }

    movers.sort((a, b) => b.change_pct - a.change_pct);
    const top_gainers = movers.slice(0, 20);
    const top_losers  = movers.slice(-20).reverse();

    // 2) IMOEX — индекс
    let imoex = null;
    try {
      const imoexData = await fetchJson(
        "https://iss.moex.com/iss/engines/stock/markets/index/securities/IMOEX.json"
        + "?iss.meta=off&marketdata.columns=SECID,LAST,LASTCHANGEPRCNT,LCLOSEPRICE"
        + "&securities.columns=SECID,PREVPRICE"
      );
      const ims = table(imoexData.securities)[0] || {};
      const imm = table(imoexData.marketdata)[0] || {};
      const last = imm.LAST ?? imm.LCLOSEPRICE;
      const prev = ims.PREVPRICE ?? imm.LCLOSEPRICE;
      imoex = {
        value: last != null ? +last : null,
        prev_close: prev != null ? +prev : null,
        change_pct: imm.LASTCHANGEPRCNT != null
          ? +imm.LASTCHANGEPRCNT
          : (last && prev && prev > 0 ? +((last/prev - 1) * 100).toFixed(2) : null),
      };
    } catch (e) {
      imoex = { error: String(e.message) };
    }

    // 3) Mood score 0..100 — комбинация breadth, avg change и IMOEX
    const breadth_pct = totalCount > 0 ? (upCount / totalCount) * 100 : 50;
    const avg_change = totalCount > 0 ? sumChange / totalCount : 0;
    const imoex_change = (imoex && typeof imoex.change_pct === 'number') ? imoex.change_pct : 0;
    // Нормализация avg_change: -3% → 0, +3% → 100
    const change_norm = Math.max(0, Math.min(100, (avg_change + 3) / 6 * 100));
    const imoex_norm  = Math.max(0, Math.min(100, (imoex_change + 3) / 6 * 100));
    const mood_score = +(0.45 * breadth_pct + 0.35 * change_norm + 0.20 * imoex_norm).toFixed(1);

    let mood_label = "Нейтральный";
    if      (mood_score < 25) mood_label = "Сильный медвежий";
    else if (mood_score < 45) mood_label = "Медвежий";
    else if (mood_score < 55) mood_label = "Нейтральный";
    else if (mood_score < 75) mood_label = "Бычий";
    else                       mood_label = "Сильный бычий";

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({
      as_of: new Date().toISOString(),
      source: "MOEX ISS",
      imoex,
      breadth: {
        total: totalCount,
        up:    upCount,
        down:  downCount,
        flat:  totalCount - upCount - downCount,
        up_pct: +breadth_pct.toFixed(1),
        avg_change_pct: +avg_change.toFixed(2),
      },
      mood: { score: mood_score, label: mood_label },
      top_gainers,
      top_losers,
    });
  } catch (e) {
    res.status(500).json({ error: "internal", message: String(e?.message || e) });
  }
}
