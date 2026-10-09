// 模組 4：策略回測分析
import { computeAll, divergence, sma } from './indicators.js';
import { resolveSymbol, getCandles } from './data.js';
import { aiAnalyze } from './ai.js';

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(2));

export const STRATEGIES = {
  ma_cross: {
    name: '均線交叉', params: { fast: 5, slow: 20 },
    desc: (p) => `MA${p.fast} 上穿 MA${p.slow} 買進，下穿賣出`,
    prep: (bars, p) => { const c = bars.map((b) => b.c); return { f: sma(c, p.fast), s: sma(c, p.slow) }; },
    entry: (x, i) => x.f[i] > x.s[i] && x.f[i - 1] <= x.s[i - 1],
    exit: (x, i) => x.f[i] < x.s[i] && x.f[i - 1] >= x.s[i - 1],
    grid: [{ fast: 5, slow: 20 }, { fast: 10, slow: 30 }, { fast: 20, slow: 60 }, { fast: 5, slow: 60 }, { fast: 10, slow: 60 }],
  },
  rsi_reversal: {
    name: 'RSI 超買超賣', params: { lo: 30, hi: 70 },
    desc: (p) => `RSI 由下往上穿越 ${p.lo} 買進，突破 ${p.hi} 賣出`,
    prep: () => ({}),
    entry: (x, i, p) => x.rsi[i] > p.lo && x.rsi[i - 1] <= p.lo,
    exit: (x, i, p) => x.rsi[i] >= p.hi,
    grid: [{ lo: 25, hi: 65 }, { lo: 30, hi: 70 }, { lo: 35, hi: 65 }, { lo: 30, hi: 60 }, { lo: 20, hi: 70 }],
  },
  rsi_divergence: {
    name: 'RSI 背離', params: { exitRsi: 70 },
    desc: (p) => `出現 RSI 多頭背離買進；RSI > ${p.exitRsi} 或空頭背離賣出`,
    prep: () => ({}),
    entry: (x, i, p, bars) => divergence(bars, x.rsi, i) === 'bull',
    exit: (x, i, p, bars) => x.rsi[i] > p.exitRsi || divergence(bars, x.rsi, i) === 'bear',
    grid: [{ exitRsi: 60 }, { exitRsi: 65 }, { exitRsi: 70 }, { exitRsi: 75 }],
  },
  macd_cross: {
    name: 'MACD 交叉', params: {},
    desc: () => 'DIF 上穿訊號線買進，下穿賣出',
    prep: () => ({}),
    entry: (x, i) => x.macd.hist[i] > 0 && x.macd.hist[i - 1] <= 0,
    exit: (x, i) => x.macd.hist[i] < 0 && x.macd.hist[i - 1] >= 0,
    grid: [{}],
  },
  kd_cross: {
    name: 'KD 交叉', params: { lo: 30, hi: 70 },
    desc: (p) => `K 值 < ${p.lo} 黃金交叉買進；K 值 > ${p.hi} 死亡交叉賣出`,
    prep: () => ({}),
    entry: (x, i, p) => x.kd.k[i] > x.kd.d[i] && x.kd.k[i - 1] <= x.kd.d[i - 1] && x.kd.k[i] < p.lo,
    exit: (x, i, p) => x.kd.k[i] < x.kd.d[i] && x.kd.k[i - 1] >= x.kd.d[i - 1] && x.kd.k[i] > p.hi,
    grid: [{ lo: 20, hi: 80 }, { lo: 30, hi: 70 }, { lo: 40, hi: 60 }],
  },
  bb_reversion: {
    name: '布林通道均值回歸', params: {},
    desc: () => '收盤跌破下軌後重新站回買進，觸及中軌/上軌賣出',
    prep: () => ({}),
    entry: (x, i, p, bars) => bars[i - 1].c < x.bb.dn[i - 1] && bars[i].c > x.bb.dn[i],
    exit: (x, i, p, bars) => bars[i].c >= x.bb.up[i],
    grid: [{}],
  },
  donchian: {
    name: '通道突破（海龜）', params: { n: 20, m: 10 },
    desc: (p) => `突破 ${p.n} 日高點買進，跌破 ${p.m} 日低點賣出`,
    prep: (bars, p) => {
      const hh = bars.map((_, i) => (i < p.n ? null : Math.max(...bars.slice(i - p.n, i).map((b) => b.h))));
      const ll = bars.map((_, i) => (i < p.m ? null : Math.min(...bars.slice(i - p.m, i).map((b) => b.l))));
      return { hh, ll };
    },
    entry: (x, i, p, bars) => x.hh[i] && bars[i].c > x.hh[i],
    exit: (x, i, p, bars) => x.ll[i] && bars[i].c < x.ll[i],
    grid: [{ n: 20, m: 10 }, { n: 55, m: 20 }, { n: 10, m: 5 }, { n: 40, m: 15 }],
  },
};

// 台股交易成本：手續費 0.1425%（可設折扣）、證交稅 0.3%（ETF 0.1%）
function costs(isETF, discount = 0.6) { return { buy: 0.001425 * discount, sell: 0.001425 * discount + (isETF ? 0.001 : 0.003) }; }

export function runBacktest(bars, ind, startIdx, stratKey, params, opts = {}) {
  const st = STRATEGIES[stratKey];
  const p = { ...st.params, ...params };
  const x = { ...ind, ...st.prep(bars, p) };
  const fee = costs(opts.isETF, opts.feeDiscount ?? 0.6);
  const trades = [];
  let pos = null, cash = 1, equity = [];
  let peak = 1, mdd = 0;
  const begin = Math.max(startIdx, 2);
  for (let i = begin; i < bars.length; i++) {
    const b = bars[i];
    // 先處理前一日產生的訊號，於今日開盤執行
    if (pos && pos.pendingExit) {
      const px = b.o; cash = pos.units * px * (1 - fee.sell);
      trades.push({ ...pos.rec, exitDate: b.date, exitPrice: r2(px), reason: pos.pendingExit, ret: r2((px * (1 - fee.sell) / (pos.entry * (1 + fee.buy)) - 1) * 100), days: i - pos.i });
      pos = null;
    } else if (!pos && x._pendingEntry) {
      const px = b.o; pos = { entry: px, units: (cash * (1 - fee.buy)) / px, i, high: px, rec: { entryDate: b.date, entryPrice: r2(px) } };
      cash = 0; x._pendingEntry = false;
    }
    // 盤中停損/停利/移動停損（以當日高低價判斷）
    if (pos) {
      pos.high = Math.max(pos.high, b.h);
      const stops = [];
      if (opts.stopLoss) stops.push({ px: pos.entry * (1 - opts.stopLoss / 100), why: `停損 ${opts.stopLoss}%` });
      if (opts.atrTrail && ind.atr[i - 1]) stops.push({ px: pos.high - opts.atrTrail * ind.atr[i - 1], why: `ATR×${opts.atrTrail} 移動停損` });
      const hitStop = stops.filter((s) => b.l <= s.px).sort((a, c) => c.px - a.px)[0];
      if (hitStop) {
        const px = Math.min(b.o, hitStop.px); cash = pos.units * px * (1 - fee.sell);
        trades.push({ ...pos.rec, exitDate: b.date, exitPrice: r2(px), reason: hitStop.why, ret: r2((px * (1 - fee.sell) / (pos.entry * (1 + fee.buy)) - 1) * 100), days: i - pos.i });
        pos = null;
      } else if (opts.takeProfit && b.h >= pos.entry * (1 + opts.takeProfit / 100)) {
        const px = Math.max(b.o, pos.entry * (1 + opts.takeProfit / 100)); cash = pos.units * px * (1 - fee.sell);
        trades.push({ ...pos.rec, exitDate: b.date, exitPrice: r2(px), reason: `停利 ${opts.takeProfit}%`, ret: r2((px * (1 - fee.sell) / (pos.entry * (1 + fee.buy)) - 1) * 100), days: i - pos.i });
        pos = null;
      }
    }
    // 收盤產生訊號
    const ok = (v) => v != null && Number.isFinite(v);
    try {
      if (pos && !pos.pendingExit && st.exit(x, i, p, bars)) pos.pendingExit = '策略出場訊號';
      else if (!pos && st.entry(x, i, p, bars)) {
        let pass = true;
        if (opts.trendFilter && !(ok(ind.ma60[i]) && b.c > ind.ma60[i] && ind.ma60[i] > ind.ma60[i - 5])) pass = false;
        if (opts.volFilter && !(ok(ind.volMa20[i]) && b.v > ind.volMa20[i])) pass = false;
        if (opts.adxFilter && !(ok(ind.adx[i]) && ind.adx[i] > 20)) pass = false;
        if (pass) x._pendingEntry = true;
      }
    } catch { /* 指標暖機期 */ }
    const eq = pos ? pos.units * b.c : cash;
    equity.push({ date: b.date, eq });
    peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak);
  }
  if (pos) {
    const b = bars[bars.length - 1];
    trades.push({ ...pos.rec, exitDate: b.date, exitPrice: r2(b.c), reason: '回測結束仍持有', ret: r2((b.c * (1 - fee.sell) / (pos.entry * (1 + fee.buy)) - 1) * 100), days: bars.length - 1 - pos.i, open: true });
  }
  return { metrics: metrics(trades, equity, bars, begin, mdd), trades, equity };
}

function metrics(trades, equity, bars, begin, mdd) {
  const wins = trades.filter((t) => t.ret > 0), losses = trades.filter((t) => t.ret <= 0);
  const gp = wins.reduce((s, t) => s + t.ret, 0), gl = -losses.reduce((s, t) => s + t.ret, 0);
  const final = equity.length ? equity[equity.length - 1].eq : 1;
  const years = equity.length / 250;
  const dr = equity.map((e, k) => (k ? e.eq / equity[k - 1].eq - 1 : 0)).slice(1);
  const mean = dr.reduce((a, b) => a + b, 0) / (dr.length || 1);
  const sd = Math.sqrt(dr.reduce((a, b) => a + (b - mean) ** 2, 0) / (dr.length || 1));
  let streak = 0, maxStreak = 0;
  for (const t of trades) { if (t.ret <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0; }
  const bh = bars[bars.length - 1].c / bars[begin].c - 1;
  let bhPeak = 0, bhMdd = 0; for (let i = begin; i < bars.length; i++) { bhPeak = Math.max(bhPeak, bars[i].c); bhMdd = Math.max(bhMdd, 1 - bars[i].c / bhPeak); }
  const inMkt = trades.reduce((s, t) => s + t.days, 0);
  return {
    trades: trades.length, winRate: trades.length ? r2((wins.length / trades.length) * 100) : 0,
    profitFactor: gl > 0 ? r2(gp / gl) : wins.length ? 99 : 0,
    avgWin: wins.length ? r2(gp / wins.length) : 0, avgLoss: losses.length ? r2(-gl / losses.length) : 0,
    payoff: losses.length && wins.length ? r2((gp / wins.length) / (gl / losses.length)) : null,
    totalReturn: r2((final - 1) * 100), cagr: years > 0 ? r2((final ** (1 / years) - 1) * 100) : null,
    maxDrawdown: r2(mdd * 100), sharpe: sd ? r2((mean / sd) * Math.sqrt(250)) : null,
    buyHold: r2(bh * 100), buyHoldMdd: r2(bhMdd * 100), exposure: r2((inMkt / Math.max(1, equity.length)) * 100),
    avgDays: trades.length ? r2(inMkt / trades.length) : 0, maxConsecLoss: maxStreak,
    expectancy: trades.length ? r2(trades.reduce((s, t) => s + t.ret, 0) / trades.length) : 0,
  };
}


export async function backtestReport(input, stratKey, years = 5, params = {}, opts = {}, { withAI = true } = {}) {
  if (!STRATEGIES[stratKey]) throw new Error('未知的策略');
  const info = await resolveSymbol(input);
  const y = Number(years) || 5;
  const { bars } = await getCandles(info.symbol, `${y + 1}y`, '1d');
  const startTs = Date.now() - y * 365.25 * 864e5;
  let startIdx = bars.findIndex((b) => b.t >= startTs);
  if (startIdx < 0) throw new Error('資料不足');
  startIdx = Math.max(startIdx, 60);
  const ind = computeAll(bars);
  const isETF = /^00/.test(info.code);
  const base = runBacktest(bars, ind, startIdx, stratKey, params, { ...opts, isETF });
  const st = STRATEGIES[stratKey];
  const p = { ...st.params, ...params };

  // 改進方向：自動測試各種濾網與參數
  const score = (m) => (m.trades < 3 ? -99 : (m.profitFactor > 5 ? 5 : m.profitFactor) * 2 + (m.cagr ?? 0) / 10 - m.maxDrawdown / 15);
  const variants = [
    { label: '加入趨勢濾網（收盤 > 上升中的 MA60 才進場）', opts: { trendFilter: true } },
    { label: '加入量能濾網（成交量 > 20 日均量）', opts: { volFilter: true } },
    { label: '加入 ADX > 20 濾網（避開盤整）', opts: { adxFilter: true } },
    { label: '加入固定停損 8%', opts: { stopLoss: 8 } },
    { label: '加入 ATR×3 移動停損', opts: { atrTrail: 3 } },
    { label: '加入停利 15%', opts: { takeProfit: 15 } },
    { label: '趨勢濾網 + ATR×3 移動停損', opts: { trendFilter: true, atrTrail: 3 } },
    ...st.grid.filter((g) => JSON.stringify({ ...st.params, ...g }) !== JSON.stringify(p)).map((g) => ({ label: `參數改為 ${st.desc({ ...st.params, ...g })}`, params: g })),
  ].map((v) => {
    const r = runBacktest(bars, ind, startIdx, stratKey, { ...params, ...(v.params || {}) }, { ...opts, ...(v.opts || {}), isETF });
    return { label: v.label, metrics: r.metrics, delta: r2(score(r.metrics) - score(base.metrics)) };
  }).sort((a, b) => b.delta - a.delta);

  // 樣本內/外檢驗：前 70% 與後 30%
  const split = startIdx + Math.floor((bars.length - startIdx) * 0.7);
  const isRes = runBacktest(bars.slice(0, split), ind, startIdx, stratKey, params, { ...opts, isETF }).metrics;
  const oosRes = runBacktest(bars, ind, split, stratKey, params, { ...opts, isETF }).metrics;

  const m = base.metrics;
  const insights = [];
  if (m.trades < 10) insights.push(`交易次數僅 ${m.trades} 筆，統計顯著性不足，結論需保守看待。`);
  if (m.winRate < 40 && m.payoff > 2) insights.push('勝率低但賺賠比高，屬趨勢型策略：重點在於嚴守停損並讓獲利奔跑。');
  if (m.winRate > 60 && m.payoff < 1) insights.push('勝率高但賺賠比低於 1，屬均值回歸型：單筆大虧可能吞噬多筆小賺，必須加上停損。');
  if (m.maxDrawdown > m.buyHoldMdd) insights.push(`策略最大回撤（${m.maxDrawdown}%）大於買進持有（${m.buyHoldMdd}%），風險控制未發揮效果。`);
  if (m.totalReturn < m.buyHold) insights.push(`策略報酬（${m.totalReturn}%）低於買進持有（${m.buyHold}%），在多頭標的上進出過於頻繁會錯失趨勢。`);
  if (m.maxConsecLoss >= 5) insights.push(`最大連續虧損 ${m.maxConsecLoss} 次，需預留心理與資金承受度，建議單筆風險 ≤ 1%。`);
  if (oosRes.trades >= 3 && isRes.profitFactor > 1.3 && oosRes.profitFactor < 1) insights.push('樣本外獲利因子跌破 1，可能過度擬合或市場結構已改變。');
  const better = variants.filter((v) => v.delta > 0.5).slice(0, 3);
  if (better.length) insights.push(`最有效的改進：${better.map((v) => v.label).join('、')}。`);

  const result = {
    info: { symbol: info.symbol, name: info.name, code: info.code }, strategy: { key: stratKey, name: st.name, desc: st.desc(p), params: p },
    period: { from: bars[startIdx].date, to: bars[bars.length - 1].date, years: y }, options: opts,
    metrics: m, trades: base.trades, equity: base.equity.filter((_, k, a) => k % Math.ceil(a.length / 400) === 0 || k === a.length - 1),
    benchmark: bars.slice(startIdx).filter((_, k, a) => k % Math.ceil(a.length / 400) === 0 || k === a.length - 1).map((b) => ({ date: b.date, eq: b.c / bars[startIdx].c })),
    variants, walkForward: { inSample: isRes, outOfSample: oosRes, splitDate: bars[split]?.date }, insights,
    assumptions: `訊號於收盤產生、次日開盤成交；手續費 0.1425%×${opts.feeDiscount ?? 0.6} 折、證交稅 ${isETF ? '0.1%' : '0.3%'}；全額進出、不計滑價與除權息調整。`,
  };
  if (withAI) {
    result.ai = await aiAnalyze('請解讀以下策略回測結果：勝率、獲利因子、最大回撤、與買進持有比較、樣本內外穩定度；並根據各改進變體的結果，提出 3–5 個可提高策略優勢的具體改進方向（含參數建議與過度擬合風險）。', { ...result, equity: undefined, benchmark: undefined, trades: result.trades.slice(-30) });
  }
  return result;
}
