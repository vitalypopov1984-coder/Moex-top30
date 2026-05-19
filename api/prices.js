/**
 * Vercel Serverless Function: /api/prices
 * Возвращает текущие котировки 30 тикеров из MOEX ISS API.
 *
 * Один запрос к ISS отдаёт цены ВСЕХ инструментов борда TQBR — это эффективно.
 * Edge-кеш 5 минут (Cache-Control s-maxage=300).
 *
 * Источник: https://iss.moex.com/iss/reference/
 */

const UNIVERSE = [
  "SBER","LKOH","PHOR","TATN","GMKN","YDEX","MGNT","NVTK","ROSN","MOEX",
  "NLMK","CHMF","TRNFP","PLZL","MTSS","IRAO","AFKS","TCSG","PIKK","ALRS",
  "OZON","FIVE","GAZP","RUAL","AFLT","VTBR","HYDR","SMLT","BSPB","RTKM",
];

const NAME_MAP = {
  SBER:"Сбербанк", LKOH:"Лукойл", PHOR:"ФосАгро", TATN:"Татнефть",
  GMKN:"Норникель", YDEX:"Яндекс", MGNT:"Магнит", NVTK:"Новатэк",
  ROSN:"Роснефть", MOEX:"Мосбиржа", NLMK:"НЛМК", CHMF:"Северсталь",
  TRNFP:"Транснефть", PLZL:"Полюс", MTSS:"МТС", IRAO:"Интер РАО",
  AFKS:"АФК Система", TCSG:"ТКС Холдинг", PIKK:"ПИК", ALRS:"Алроса",
  OZON:"Озон", FIVE:"X5 Retail Group", GAZP:"Газпром", RUAL:"Русал",
  AFLT:"Аэрофлот", VTBR:"ВТБ", HYDR:"РусГидро", SMLT:"Самолёт",
  BSPB:"Банк Санкт-Петербург", RTKM:"Ростелеком",
};

const SECTOR_MAP = {
  SBER:"Banks", LKOH:"Oil & Gas", PHOR:"Chemicals", TATN:"Oil & Gas",
  GMKN:"Metals & Mining", YDEX:"IT", MGNT:"Retail", NVTK:"Oil & Gas",
  ROSN:"Oil & Gas", MOEX:"Other", NLMK:"Metals & Mining",
  CHMF:"Metals & Mining", TRNFP:"Oil & Gas", PLZL:"Metals & Mining",
  MTSS:"Telecom", IRAO:"Power", AFKS:"Other", TCSG:"Banks",
  PIKK:"Real Estate", ALRS:"Metals & Mining", OZON:"Retail",
  FIVE:"Retail", GAZP:"Oil & Gas", RUAL:"Metals & Mining",
  AFLT:"Transport", VTBR:"Banks", HYDR:"Power", SMLT:"Real Estate",
  BSPB:"Banks", RTKM:"Telecom",
};

// ISS отдаёт данные блоками { columns: [...], data: [[...]] } — превращаем в [{...}]
function table(block) {
  if (!block || !block.columns || !block.data) return [];
  const cols = block.columns;
  return block.data.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

export default async function handler(req, res) {
  try {
    const url = "https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities.json"
              + "?iss.meta=off"
              + "&securities.columns=SECID,SHORTNAME,PREVPRICE,LOTSIZE,CURRENCYID,LISTLEVEL"
              + "&marketdata.columns=SECID,LAST,LCURRENTPRICE,LCLOSEPRICE,LASTCHANGEPRCNT,VOLTODAY,VALTODAY";

    const r = await fetch(url, {
      headers: {
        "User-Agent": "moex-top30-vercel/1.0",
        "Accept": "application/json",
      },
    });

    if (!r.ok) {
      res.status(502).json({ error: "moex_iss_unreachable", status: r.status });
      return;
    }
    const data = await r.json();
    const sec = Object.fromEntries(table(data.securities).map(r => [r.SECID, r]));
    const mkt = Object.fromEntries(table(data.marketdata).map(r => [r.SECID, r]));

    const stocks = [];
    const errors = [];

    for (const ticker of UNIVERSE) {
      const s = sec[ticker], m = mkt[ticker] || {};
      if (!s) {
        errors.push({ ticker, stage: "snapshot", message: "not_found_in_moex" });
        continue;
      }
      const price = m.LAST ?? m.LCURRENTPRICE ?? s.PREVPRICE;
      const prev  = s.PREVPRICE ?? m.LCLOSEPRICE;
      if (price == null) {
        errors.push({ ticker, stage: "snapshot", message: "no_price" });
        continue;
      }
      const change_1d_pct = (prev && prev > 0) ? +((price / prev - 1) * 100).toFixed(2) : null;

      stocks.push({
        ticker,
        name: NAME_MAP[ticker] || s.SHORTNAME || ticker,
        sector: SECTOR_MAP[ticker] || "Other",
        currency: s.CURRENCYID || "RUB",
        price: +price,
        price_prev_close: prev != null ? +prev : null,
        change_1d_pct,
        // Поля, которые требуют отдельных источников (fundamentals.json):
        // оставляем null — фронт сможет их подгружать из data/fundamentals.json,
        // когда оно появится, но котировку отображает уже сейчас.
        fair_value: null,
        fair_value_components: { relative_valuation: null, consensus: null, dcf: null },
        fair_value_weights:    { relative_valuation: 0,    consensus: 0,    dcf: 0    },
        upside_pct: null,
        status: null,
        ytd_pct: null,
        ytd_high: null,
        ytd_low: null,
        ytd_series: null,  // YTD грузится lazy через /api/ytd?ticker=X
      });
    }

    // Edge-cache 5 минут, stale-while-revalidate ещё 60 секунд
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({
      as_of: new Date().toISOString(),
      source: "MOEX ISS",
      version: "1.0-live",
      universe_size: UNIVERSE.length,
      coverage: stocks.length,
      stocks,
      errors,
    });
  } catch (e) {
    res.status(500).json({ error: "internal", message: String(e?.message || e) });
  }
}
