// 模組 1：交易點子生成器
import { computeAll, roundTick } from './indicators.js';
import { resolveSymbol, getCandles, getUniverse, stocksInIndustry, mapLimit } from './data.js';
import { snapshot } from './analysis.js';
import { aiAnalyze } from './ai.js';

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(2));

// 各型態：偵測條件 + 停損/目標的 ATR 倍數
const SETUPS = [
  {
    id: 'pullback', name: '多頭趨勢回檔月線', side: 'long', stopAtr: 1.5, tgtAtr: 3,
    test: (b, x, i) => x.ma20[i] && x.ma60[i] && x.ma20[i] > x.ma60[i] && x.ma20[i] > x.ma20[i - 5] && x.ma60[i] > x.ma60[i - 10]
      && b[i].c >= x.ma20[i] * 0.99 && b[i].c <= x.ma20[i] * 1.03 && x.rsi[i] > 40 && x.rsi[i] < 60,
    why: '中期均線向上，股價回測月線不破，屬於順勢低風險買點',
  },
  {
    id: 'breakout', name: '帶量突破 20 日高點', side: 'long', stopAtr: 1.5, tgtAtr: 3.5,
    test: (b, x, i) => { if (i < 21) return false; let hh = 0; for (let j = i - 20; j < i; j++) hh = Math.max(hh, b[j].h); return b[i].c > hh && x.volMa20[i] && b[i].v > 1.5 * x.volMa20[i] && x.ma20[i] > x.ma60[i]; },
    why: '收盤突破近 20 日高點且成交量放大 1.5 倍以上，代表買盤積極、突破有效性較高',
  },
  {
    id: 'oversold', name: '長多格局超賣反彈', side: 'long', stopAtr: 1.5, tgtAtr: 2.5,
    test: (b, x, i) => (x.ma240[i] ? b[i].c > x.ma240[i] : x.ma120[i] && b[i].c > x.ma120[i]) && x.rsi[i - 1] < 35 && x.kd.k[i] > x.kd.d[i] && x.kd.k[i - 1] <= x.kd.d[i - 1] && x.kd.k[i] < 35,
    why: '長期趨勢仍在年線之上，短線超賣後 KD 低檔黃金交叉，均值回歸機率高',
  },
  {
    id: 'squeeze', name: '布林壓縮向上突破', side: 'long', stopAtr: 1.5, tgtAtr: 3,
    test: (b, x, i) => { if (!x.bb.up[i] || !x.bb.up[i - 1]) return false; let minW = Infinity; for (let j = i - 20; j < i; j++) if (x.bb.up[j]) minW = Math.min(minW, (x.bb.up[j] - x.bb.dn[j]) / x.bb.mid[j]); return minW < 0.1 && b[i].c > x.bb.up[i] && b[i - 1].c <= x.bb.up[i - 1]; },
    why: '波動度長時間壓縮後向上突破布林上軌，常見行情發動點',
  },
  {
    id: 'macdTurn', name: '零軸上 MACD 再度金叉', side: 'long', stopAtr: 1.5, tgtAtr: 3,
    test: (b, x, i) => x.macd.dif[i] > 0 && x.macd.hist[i] > 0 && x.macd.hist[i - 1] <= 0 && x.ma20[i] > x.ma60[i],
    why: 'MACD 在零軸之上回檔後再度黃金交叉，屬於多頭中繼的二次上攻訊號',
  },
  {
    id: 'breakdown', name: '空頭跌破月線（放空/避開）', side: 'short', stopAtr: 1.5, tgtAtr: 3,
    test: (b, x, i) => x.ma20[i] < x.ma60[i] && x.ma60[i] < x.ma60[i - 10] && b[i].c < x.ma20[i] && b[i - 1].c >= x.ma20[i - 1] && x.rsi[i] < 50,
    why: '均線空頭排列，反彈至月線後再度跌破，賣壓延續（融券或持股者減碼參考）',
  },
];

// 用該股自身過去資料回測此型態：勝率、平均報酬
function historicalEdge(bars, ind, setup, holdMax = 20) {
  let wins = 0, losses = 0, sumR = 0;
  for (let i = 60; i < bars.length - 1; i++) {
    if (!ind.atr[i] || !setup.test(bars, ind, i)) continue;
    const e = bars[i].c, a = ind.atr[i], dir = setup.side === 'long' ? 1 : -1;
    const stop = e - dir * setup.stopAtr * a, tgt = e + dir * setup.tgtAtr * a;
    let outcome = null;
    for (let j = i + 1; j < Math.min(bars.length, i + 1 + holdMax); j++) {
      const hitStop = dir === 1 ? bars[j].l <= stop : bars[j].h >= stop;
      const hitTgt = dir === 1 ? bars[j].h >= tgt : bars[j].l <= tgt;
      if (hitStop) { outcome = -1; break; } // 同日同時觸及時保守視為停損
      if (hitTgt) { outcome = setup.tgtAtr / setup.stopAtr; break; }
    }
    if (outcome == null) { const j = Math.min(bars.length - 1, i + holdMax); outcome = (dir * (bars[j].c - e)) / (setup.stopAtr * a); }
    outcome > 0 ? wins++ : losses++;
    sumR += outcome;
    i += 5; // 避免重疊訊號
  }
  const n = wins + losses;
  return { trades: n, winRate: n ? wins / n : null, expectancyR: n ? sumR / n : null };
}

async function resolveUniverse(target) {
  const t = String(target || '').trim();
  if (!t || ['加權指數', '大盤', '台股', 'TAIEX', '^TWII', '0050', '台灣50'].includes(t)) {
    const u = await getUniverse();
    return { label: '台股權值股（股本前 40 大上市公司）', list: [...u.values()].filter((s) => s.market === 'TW' && s.capital).sort((a, b) => b.capital - a.capital).slice(0, 40) };
  }
  if (t === '櫃買' || t === '櫃買指數') {
    const u = await getUniverse();
    return { label: '上櫃權值股（股本前 30 大）', list: [...u.values()].filter((s) => s.market === 'TWO' && s.capital).sort((a, b) => b.capital - a.capital).slice(0, 30) };
  }
  const ind = await stocksInIndustry(t.replace(/業$/, ''), 30);
  if (ind.length) return { label: `${t}（股本前 ${ind.length} 大）`, list: ind };
  const codes = t.split(/[,，\s]+/).filter(Boolean);
  const list = [];
  for (const c of codes) { try { list.push(await resolveSymbol(c)); } catch {} }
  if (!list.length) throw new Error(`無法辨識「${t}」：請輸入產業（如 半導體）、指數（加權指數）或股票代號清單（2330,2317）`);
  return { label: codes.join('、'), list };
}

export async function generateIdeas(target, { withAI = true, count = 5 } = {}) {
  const { label, list } = await resolveUniverse(target);
  const scanned = await mapLimit(list, 6, async (s) => {
    const sym = s.symbol || `${s.code}.${s.market === 'TWO' ? 'TWO' : 'TW'}`;
    const { bars } = await getCandles(sym, '2y', '1d');
    if (bars.length < 130) return null;
    const ind = computeAll(bars);
    const i = bars.length - 1;
    const snap = snapshot(bars);
    const out = [];
    for (const st of SETUPS) {
      // 今日或近 2 日觸發
      const trig = [i, i - 1].find((k) => st.test(bars, ind, k));
      if (trig == null) continue;
      const edge = historicalEdge(bars, ind, st);
      const p = bars[i].c, a = ind.atr[i], dir = st.side === 'long' ? 1 : -1;
      const stop = roundTick(p - dir * st.stopAtr * a);
      let target = roundTick(p + dir * st.tgtAtr * a);
      // 目標若超越最近壓力（多）或支撐（空），標示提醒
      const nearRes = snap.resistances[0]?.price, nearSup = snap.supports[0]?.price;
      const blocker = dir === 1 ? (nearRes && nearRes < target ? nearRes : null) : (nearSup && nearSup > target ? nearSup : null);
      const rr = Math.abs(target - p) / Math.abs(p - stop);
      // 基本面加分
      const fund = [];
      let fScore = 0;
      if (s.pe != null && s.pe > 0 && s.pe < 15) { fScore += 1; fund.push(`本益比 ${s.pe} 倍偏低`); }
      else if (s.pe != null && s.pe > 40) { fScore -= 1; fund.push(`本益比 ${s.pe} 倍偏高，評價風險`); }
      else if (s.pe) fund.push(`本益比 ${s.pe} 倍`);
      else if (s.pe === null && s.code && !/^\^/.test(s.code)) fund.push('近四季虧損或無本益比資料');
      if (s.yield > 4) { fScore += 1; fund.push(`殖利率 ${s.yield}% 具防禦性`); } else if (s.yield != null) fund.push(`殖利率 ${s.yield}%`);
      if (s.pb != null && s.pb < 1) { fScore += 0.5; fund.push(`股價淨值比 ${s.pb} 低於 1`); }
      const techScore = dir * snap.score;
      const wr = edge.winRate ?? 0.45;
      const rank = (edge.trades >= 3 ? wr * 10 + (edge.expectancyR ?? 0) * 3 : 4) + techScore * 0.5 + fScore + (trig === i ? 1 : 0);
      out.push({
        code: s.code, name: s.name, industry: s.industry, setup: st.name, side: st.side === 'long' ? '做多' : '做空/減碼',
        price: r2(p), entry: `${roundTick(p - dir * 0.3 * a)} – ${r2(p)}`, stop, target, rr: r2(rr), blocker,
        histWinRate: edge.winRate != null ? r2(edge.winRate * 100) : null, histTrades: edge.trades, histExpR: r2(edge.expectancyR),
        techScore: snap.score, triggeredOn: bars[trig].date,
        reasons: {
          technical: [st.why, ...snap.factors.filter((f) => Math.sign(f.score) === dir).slice(0, 4).map((f) => f.text)],
          fundamental: fund,
          risk: [blocker ? `上方最近${dir === 1 ? '壓力' : '支撐'} ${blocker} 可能先行阻擋，可考慮分批出場` : null, `ATR ${r2(a)}（日波動約 ${r2((a / p) * 100)}%）`, ...snap.factors.filter((f) => Math.sign(f.score) === -dir).slice(0, 2).map((f) => `反向訊號：${f.text}`)].filter(Boolean),
        },
        rank,
      });
    }
    return out;
  });
  const all = scanned.flat().filter((x) => x && !x.error);
  // 每檔只取最佳型態，再取前 N
  const best = new Map();
  for (const x of all) if (!best.has(x.code) || best.get(x.code).rank < x.rank) best.set(x.code, x);
  const ideas = [...best.values()].sort((a, b) => b.rank - a.rank).slice(0, count).map((x, k) => ({ ...x, no: k + 1, rank: r2(x.rank) }));
  const result = { universe: label, scanned: list.length, triggered: all.length, asOf: new Date().toISOString(), ideas };
  if (withAI && ideas.length) {
    result.ai = await aiAnalyze(`以下是系統今日掃描「${label}」後挑出的 ${ideas.length} 組交易機會（含進場、停損、目標、風險報酬比、歷史同型態勝率、技術與基本面因素）。請逐一評論每組機會成立的理由、需要確認的條件、可能失效的情境，並給出優先順序與整體市場注意事項。`, ideas);
  }
  return result;
}
