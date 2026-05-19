/**
 * Vercel Serverless Function: /api/fundamentals
 *
 * Объединяет:
 *   • Live цены с MOEX ISS (board TQBR)
 *   • Quarterly snapshot фундаменталки (встроен в этот файл — обновляется парсером
 *     e-disclosure раз в квартал и деплоится коммитом)
 *   • Ручные таргеты аналитиков (consensus)
 *
 * Считает на лету:
 *   • Fair value = blend(relative_valuation, consensus, dcf) — упрощённый
 *   • Upside %, status (undervalued / fair / overvalued)
 *   • P/E TTM (с живой ценой)
 *   • Composite score = 0.5×FA + 0.4×TA + 0.1×Sentiment, скорректированный на риск
 *   • FA score / TA score / Risk score (упрощённые, см. ниже)
 *
 * Возвращает уже отсортированный список (по composite ↓) — это и есть TOP-30
 * на живых данных.
 *
 * Edge cache 5 минут.
 */

// ── Static fundamentals snapshot (обновляется парсером e-disclosure раз в квартал) ──
// На production эти данные должны приходить из data/fundamentals.json. Пока встраиваем
// сюда — в serverless это работает без файловой системы.
const FUNDAMENTALS = {
  SBER:  { eps_ttm: 74.4,   roe: 0.24, net_debt_rub: -3.40e12, fcf_growth_5y: 0.07, wacc: 0.19, shares: 21.59e9, dy_pct: 11.8 },
  LKOH:  { eps_ttm: 1777.0, roe: 0.22, net_debt_rub: -0.95e12, fcf_growth_5y: 0.04, wacc: 0.17, shares: 0.692e9, dy_pct: 13.5 },
  PHOR:  { eps_ttm: 834.0,  roe: 0.35, net_debt_rub:  0.18e12, fcf_growth_5y: 0.05, wacc: 0.18, shares: 0.130e9, dy_pct: 9.1 },
  TATN:  { eps_ttm: 139.4,  roe: 0.19, net_debt_rub: -0.20e12, fcf_growth_5y: 0.04, wacc: 0.17, shares: 2.327e9, dy_pct: 12.4 },
  GMKN:  { eps_ttm: 22.4,   roe: 0.28, net_debt_rub:  0.60e12, fcf_growth_5y: 0.03, wacc: 0.18, shares: 152.86e9, dy_pct: 10.7 },
  YDEX:  { eps_ttm: 244.3,  roe: 0.21, net_debt_rub: -0.10e12, fcf_growth_5y: 0.18, wacc: 0.20, shares: 0.367e9, dy_pct: 0.0 },
  MGNT:  { eps_ttm: 572.0,  roe: 0.18, net_debt_rub:  0.18e12, fcf_growth_5y: 0.06, wacc: 0.18, shares: 0.102e9, dy_pct: 10.2 },
  NVTK:  { eps_ttm: 211.4,  roe: 0.23, net_debt_rub: -0.05e12, fcf_growth_5y: 0.04, wacc: 0.17, shares: 3.037e9, dy_pct: 9.4 },
  ROSN:  { eps_ttm: 121.2,  roe: 0.17, net_debt_rub:  3.50e12, fcf_growth_5y: 0.04, wacc: 0.18, shares: 10.598e9, dy_pct: 10.8 },
  MOEX:  { eps_ttm: 30.3,   roe: 0.25, net_debt_rub: -0.20e12, fcf_growth_5y: 0.10, wacc: 0.18, shares: 2.276e9, dy_pct: 8.9 },
  NLMK:  { eps_ttm: 28.7,   roe: 0.21, net_debt_rub:  0.05e12, fcf_growth_5y: 0.03, wacc: 0.18, shares: 5.993e9, dy_pct: 9.4 },
  CHMF:  { eps_ttm: 240.0,  roe: 0.24, net_debt_rub: -0.10e12, fcf_growth_5y: 0.03, wacc: 0.18, shares: 0.838e9, dy_pct: 10.1 },
  TRNFP: { eps_ttm: 328.9,  roe: 0.14, net_debt_rub: -0.50e12, fcf_growth_5y: 0.03, wacc: 0.17, shares: 0.007e9, dy_pct: 11.3 },
  PLZL:  { eps_ttm: 1897.0, roe: 0.31, net_debt_rub:  0.40e12, fcf_growth_5y: 0.06, wacc: 0.18, shares: 0.136e9, dy_pct: 6.4 },
  MTSS:  { eps_ttm: 38.4,   roe: 0.62, net_debt_rub:  0.45e12, fcf_growth_5y: 0.02, wacc: 0.17, shares: 1.999e9, dy_pct: 13.0 },
  IRAO:  { eps_ttm: 1.108,  roe: 0.13, net_debt_rub: -0.30e12, fcf_growth_5y: 0.02, wacc: 0.17, shares: 104.4e9, dy_pct: 7.8 },
  AFKS:  { eps_ttm: 1.6,    roe: 0.08, net_debt_rub:  0.80e12, fcf_growth_5y: 0.05, wacc: 0.21, shares: 9.65e9, dy_pct: 5.2 },
  TCSG:  { eps_ttm: 458.8,  roe: 0.32, net_debt_rub:  null,    fcf_growth_5y: 0.08, wacc: 0.20, shares: 0.199e9, dy_pct: 0.0 },
  PIKK:  { eps_ttm: 163.4,  roe: 0.22, net_debt_rub:  0.25e12, fcf_growth_5y: 0.05, wacc: 0.20, shares: 0.660e9, dy_pct: 0.0 },
  ALRS:  { eps_ttm: 8.15,   roe: 0.16, net_debt_rub:  0.10e12, fcf_growth_5y: 0.02, wacc: 0.18, shares: 7.365e9, dy_pct: 7.7 },
  OZON:  { eps_ttm: null,   roe: null, net_debt_rub:  null,    fcf_growth_5y: 0.30, wacc: 0.21, shares: 0.221e9, dy_pct: 0.0 },
  FIVE:  { eps_ttm: 356.3,  roe: 0.25, net_debt_rub:  0.18e12, fcf_growth_5y: 0.07, wacc: 0.18, shares: 0.272e9, dy_pct: 9.4 },
  GAZP:  { eps_ttm: 26.6,   roe: 0.07, net_debt_rub:  5.50e12, fcf_growth_5y: 0.02, wacc: 0.19, shares: 23.674e9, dy_pct: 7.5 },
  RUAL:  { eps_ttm: 4.52,   roe: 0.11, net_debt_rub:  0.50e12, fcf_growth_5y: 0.02, wacc: 0.19, shares: 15.193e9, dy_pct: 0.0 },
  AFLT:  { eps_ttm: 11.5,   roe: 0.18, net_debt_rub:  0.55e12, fcf_growth_5y: 0.04, wacc: 0.20, shares: 3.974e9, dy_pct: 5.1 },
  VTBR:  { eps_ttm: 0.0069, roe: 0.14, net_debt_rub:  null,    fcf_growth_5y: null, wacc: 0.19, shares: 5.368e12, dy_pct: 8.2 },
  HYDR:  { eps_ttm: 0.104,  roe: 0.10, net_debt_rub:  0.30e12, fcf_growth_5y: 0.03, wacc: 0.18, shares: 437.16e9, dy_pct: 7.0 },
  SMLT:  { eps_ttm: 352.0,  roe: 0.30, net_debt_rub:  0.18e12, fcf_growth_5y: 0.08, wacc: 0.21, shares: 0.062e9, dy_pct: 5.0 },
  BSPB:  { eps_ttm: 117.0,  roe: 0.21, net_debt_rub:  null,    fcf_growth_5y: null, wacc: 0.19, shares: 0.500e9, dy_pct: 11.4 },
  RTKM:  { eps_ttm: 12.1,   roe: 0.15, net_debt_rub:  0.50e12, fcf_growth_5y: 0.03, wacc: 0.17, shares: 3.495e9, dy_pct: 9.0 },
};

const CONSENSUS = {
  SBER: 380, LKOH: 8500, PHOR: 7900, TATN: 860, GMKN: 175, YDEX: 5600,
  MGNT: 6300, NVTK: 1380, ROSN: 710, MOEX: 250, NLMK: 198, CHMF: 1450,
  TRNFP: 1700, PLZL: 17900, MTSS: 320, IRAO: 4.95, AFKS: 19,
  TCSG: 3600, PIKK: 760, ALRS: 73, OZON: 4800, FIVE: 3300, GAZP: 158,
  RUAL: 50, AFLT: 75, VTBR: 0.0242, HYDR: 0.81, SMLT: 2080,
  BSPB: 480, RTKM: 98,
};

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

const UNIVERSE = Object.keys(FUNDAMENTALS);

function table(block) {
  if (!block || !block.columns || !block.data) return [];
  const cols = block.columns;
  return block.data.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

// ── Fair value ──────────────────────────────────────────────────────────────
function sectorMedians(stocks) {
  const bucket = {};
  for (const s of stocks) {
    if (!s.sector || s.pe_ttm == null || s.pe_ttm <= 0) continue;
    bucket[s.sector] = bucket[s.sector] || { pes: [], roes: [] };
    bucket[s.sector].pes.push(s.pe_ttm);
    if (s.roe != null) bucket[s.sector].roes.push(s.roe);
  }
  const med = arr => {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a,b) => a-b);
    const m = Math.floor(sorted.length/2);
    return sorted.length % 2 ? sorted[m] : (sorted[m-1] + sorted[m]) / 2;
  };
  const out = {};
  for (const [sec, b] of Object.entries(bucket)) out[sec] = { pe: med(b.pes), roe: med(b.roes) };
  return out;
}

function relativeValuation(eps, sectorPE, roe, sectorROE) {
  if (eps == null || sectorPE == null || eps <= 0) return null;
  let premium = 0;
  if (roe != null && sectorROE != null) {
    premium = 0.025 * ((roe - sectorROE) * 100);
    premium = Math.max(-0.6, Math.min(0.6, premium));
  }
  return +(sectorPE * (1 + premium) * eps).toFixed(4);
}

function dcfTwoStage({ eps, shares, fcf_growth, wacc, net_debt }) {
  if (eps == null || shares == null || fcf_growth == null) return null;
  if (wacc == null || wacc <= 0.03) return null;
  // Грубо: FCF_TTM ≈ NI_TTM = eps × shares (proxy)
  const fcf_ttm = eps * shares;
  let pv = 0, fcf = fcf_ttm;
  for (let i = 1; i <= 5; i++) {
    fcf = fcf * (1 + fcf_growth);
    pv += fcf / Math.pow(1 + wacc, i);
  }
  const terminal = fcf * (1 + 0.03) / (wacc - 0.03);
  pv += terminal / Math.pow(1 + wacc, 5);
  const equity = pv - (net_debt || 0);
  if (equity <= 0) return null;
  return +(equity / shares).toFixed(4);
}

function composeFair(rv, cs, dcf) {
  const W = { rv: 0.55, cs: 0.30, dcf: 0.15 };
  const present = [];
  if (rv  != null) present.push(['rv',  rv,  W.rv]);
  if (cs  != null) present.push(['cs',  cs,  W.cs]);
  if (dcf != null) present.push(['dcf', dcf, W.dcf]);
  if (!present.length) return { fair: null, weights: { rv:0, cs:0, dcf:0 } };
  const total = present.reduce((s, [,, w]) => s + w, 0);
  const weights = { rv:0, cs:0, dcf:0 };
  let fair = 0;
  for (const [k, v, w] of present) {
    const nw = w / total;
    weights[k] = +nw.toFixed(3);
    fair += nw * v;
  }
  return { fair: +fair.toFixed(4), weights };
}

function classifyStatus(price, fair) {
  if (fair == null || price <= 0) return null;
  const up = (fair - price) / price;
  if (up >= 0.15) return "undervalued";
  if (up >= 0.05) return "fair";
  return "overvalued";
}

// ── Composite score (упрощённый, на основе доступных данных) ────────────────
function pctRank(value, allValues) {
  if (value == null) return 50;
  const valid = allValues.filter(v => v != null);
  if (valid.length < 3) return 50;
  const below = valid.filter(v => v < value).length;
  return (below / valid.length) * 100;
}

function computeScores(stocks) {
  // Перцентили по universe
  const upsides = stocks.map(s => s.upside_pct);
  const roes    = stocks.map(s => s.roe);
  const dys     = stocks.map(s => s.dy_pct);
  const pes     = stocks.map(s => s.pe_ttm).filter(v => v != null && v > 0);
  const d1s     = stocks.map(s => s.change_1d_pct);

  for (const s of stocks) {
    // Fundamental score: ROE + DivYield + (низкий P/E)
    const roeScore  = pctRank(s.roe, roes);
    const dyScore   = pctRank(s.dy_pct, dys);
    const peScore   = (s.pe_ttm != null && s.pe_ttm > 0)
                        ? (100 - pctRank(s.pe_ttm, pes))
                        : 50;
    const upScore   = pctRank(s.upside_pct, upsides);
    const fa = +(0.30*roeScore + 0.25*peScore + 0.20*dyScore + 0.25*upScore).toFixed(1);

    // Technical score: 1d change + sentiment proxy (среднее изменение позитивных сигналов)
    // Без YTD-серий (которые грузятся lazy) делаем proxy: позиция change_1d_pct в universe
    const d1Score = pctRank(s.change_1d_pct, d1s);
    // Если изменение умеренно положительное (+0.5..+3%) — это хороший momentum,
    // экстремумы получают штраф
    let momentumBias = 50;
    if (s.change_1d_pct != null) {
      if      (s.change_1d_pct > 5)  momentumBias = 35;   // overheated
      else if (s.change_1d_pct > 0)  momentumBias = 65;
      else if (s.change_1d_pct < -5) momentumBias = 30;
      else if (s.change_1d_pct < 0)  momentumBias = 45;
    }
    const ta = +(0.6*d1Score + 0.4*momentumBias).toFixed(1);

    // Sentiment score — пока plug-value 50 (требует news/telegram pipeline)
    const sentiment = 50;

    // Risk multiplier (упрощённый)
    const liquidityPenalty = 0.2;   // statик пока
    const volPenalty = Math.min(Math.abs(s.change_1d_pct || 0) / 10, 1) * 0.2;
    const sectorRisk = (s.sector === "Banks" || s.sector === "Oil & Gas") ? 0.10 : 0.05;
    const riskPenalty = liquidityPenalty + volPenalty + sectorRisk;
    const riskMult = Math.max(0.5, 1 - 0.5 * riskPenalty);

    s.fa_score = fa;
    s.ta_score = ta;
    s.sentiment_score = sentiment;
    s.risk_multiplier = +riskMult.toFixed(3);
    s.composite_score = +((0.50*fa + 0.40*ta + 0.10*sentiment) * riskMult).toFixed(1);
    s.fa_composite = +((0.85*fa + 0.10*sentiment + 0.05*ta) * riskMult).toFixed(1);
    s.ta_composite = +((0.85*ta + 0.10*sentiment + 0.05*fa) * riskMult).toFixed(1);

    // Risk label
    if (riskPenalty < 0.30) s.risk_label = "Low";
    else if (riskPenalty < 0.50) s.risk_label = "Mid";
    else s.risk_label = "High";
  }
  return stocks;
}

// ── Main handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    // Получаем живые цены MOEX
    const priceUrl = "https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities.json"
                   + "?iss.meta=off"
                   + "&securities.columns=SECID,SHORTNAME,PREVPRICE,CURRENCYID"
                   + "&marketdata.columns=SECID,LAST,LCURRENTPRICE,LCLOSEPRICE,LASTCHANGEPRCNT";
    const r = await fetch(priceUrl, {
      headers: { "User-Agent": "moex-top30-vercel/1.0", "Accept": "application/json" },
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
      const s = sec[ticker], m = mkt[ticker] || {}, f = FUNDAMENTALS[ticker] || {};
      if (!s) { errors.push({ ticker, message: "not_in_moex" }); continue; }
      const price = m.LAST ?? m.LCURRENTPRICE ?? s.PREVPRICE;
      const prev  = s.PREVPRICE ?? m.LCLOSEPRICE;
      if (price == null) { errors.push({ ticker, message: "no_price" }); continue; }
      const change_1d_pct = (prev && prev > 0) ? +((price / prev - 1) * 100).toFixed(2) : null;
      const pe_ttm = (f.eps_ttm != null && f.eps_ttm > 0) ? +(price / f.eps_ttm).toFixed(2) : null;

      stocks.push({
        ticker,
        name:   NAME_MAP[ticker] || s.SHORTNAME || ticker,
        sector: SECTOR_MAP[ticker] || "Other",
        currency: s.CURRENCYID || "RUB",
        price: +price,
        price_prev_close: prev != null ? +prev : null,
        change_1d_pct,
        // Фундаментал (из quarterly snapshot)
        eps_ttm: f.eps_ttm,
        roe:     f.roe,
        dy_pct:  f.dy_pct,
        net_debt_rub: f.net_debt_rub,
        shares: f.shares,
        pe_ttm,
      });
    }

    // Sector medians для relative valuation
    const medians = sectorMedians(stocks);

    // Fair value + status + upside
    for (const s of stocks) {
      const m = medians[s.sector] || {};
      const f = FUNDAMENTALS[s.ticker] || {};
      const rv  = relativeValuation(s.eps_ttm, m.pe, s.roe, m.roe);
      const cs  = CONSENSUS[s.ticker] ?? null;
      const dcf = dcfTwoStage({
        eps: s.eps_ttm, shares: s.shares,
        fcf_growth: f.fcf_growth_5y, wacc: f.wacc, net_debt: s.net_debt_rub,
      });
      const composed = composeFair(rv, cs, dcf);
      s.fair_value = composed.fair;
      s.fair_value_components = { relative_valuation: rv, consensus: cs, dcf };
      s.fair_value_weights    = { relative_valuation: composed.weights.rv,
                                  consensus: composed.weights.cs,
                                  dcf: composed.weights.dcf };
      s.upside_pct = s.fair_value != null
        ? +(((s.fair_value - s.price) / s.price) * 100).toFixed(2)
        : null;
      s.status = classifyStatus(s.price, s.fair_value);
    }

    // Composite / FA / TA / Risk scores
    computeScores(stocks);

    // Сортированный список (по composite score ↓)
    const ranked = [...stocks].sort((a, b) => (b.composite_score ?? 0) - (a.composite_score ?? 0));
    ranked.forEach((s, i) => { s.rank_composite = i + 1; });

    const fa_ranked = [...stocks].sort((a, b) => (b.fa_composite ?? 0) - (a.fa_composite ?? 0));
    fa_ranked.forEach((s, i) => { s.rank_fa = i + 1; });

    const ta_ranked = [...stocks].sort((a, b) => (b.ta_composite ?? 0) - (a.ta_composite ?? 0));
    ta_ranked.forEach((s, i) => { s.rank_ta = i + 1; });

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({
      as_of: new Date().toISOString(),
      source: "MOEX ISS + e-disclosure (quarterly snapshot)",
      version: "2.0-live-with-fundamentals",
      universe_size: UNIVERSE.length,
      coverage: stocks.length,
      stocks: ranked,
      errors,
    });
  } catch (e) {
    res.status(500).json({ error: "internal", message: String(e?.message || e) });
  }
}
