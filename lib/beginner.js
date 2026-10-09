// 新手模式：輸入資金與風險承受度，自動篩選候選股並計算買幾股
import { roundTick } from './indicators.js';
import { getCandles, getUniverse, getNews, mapLimit } from './data.js';
import { snapshot } from './analysis.js';
import { scoreHeadline } from './news.js';
import { aiAnalyze } from './ai.js';

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(2));

// 風險承受度：每筆最多虧總資金的幾 %、單一股票最多佔幾 %
const PROFILES = {
  保守: { riskPct: 0.5, maxPos: 0.2, desc: '單筆最多虧總資金 0.5%，一檔最多佔 20%' },
  穩健: { riskPct: 1, maxPos: 0.25, desc: '單筆最多虧總資金 1%，一檔最多佔 25%' },
  積極: { riskPct: 2, maxPos: 0.3, desc: '單筆最多虧總資金 2%，一檔最多佔 30%' },
};

const ETFS = [
  ['0050', '追蹤台灣市值最大的 50 家公司，最像「買下整個台股」，新手首選'],
  ['006208', '同樣追蹤台灣 50，管理費較低，適合長期持有'],
  ['0056', '高股息 ETF，重視配息，股價波動通常較小'],
  ['00878', '高股息且篩選永續（ESG）企業，每季配息'],
  ['00919', '高股息 ETF，每季配息'],
];

function yearStats(bars) {
  const sub = bars.slice(-250);
  let peak = 0, mdd = 0;
  for (const b of sub) { peak = Math.max(peak, b.c); mdd = Math.max(mdd, 1 - b.c / peak); }
  const rets = sub.slice(1).map((b, k) => Math.log(b.c / sub[k].c));
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length);
  return { ret: r2((sub[sub.length - 1].c / sub[0].c - 1) * 100), mdd: r2(mdd * 100), vol: r2(sd * Math.sqrt(250) * 100) };
}

async function marketTemperature() {
  const [{ bars }, vixC] = await Promise.all([getCandles('^TWII', '2y', '1d'), getCandles('^VIX', '1mo', '1d').catch(() => null)]);
  const s = snapshot(bars);
  const i = s.indicators;
  const vix = vixC?.bars.at(-1)?.c ?? null;
  const aboveMa60 = s.close > i.ma60;
  let level = 'range';
  if (s.score >= 4 && aboveMa60) level = 'bull';
  else if (s.score <= -2 || (!aboveMa60 && i.ma20 < i.ma60)) level = 'bear';
  if (level === 'bull' && vix > 30) level = 'range';
  const info = {
    bull: { label: '偏多', factor: 1, text: '大盤走勢偏多，可以分批、小量布局。' },
    range: { label: '盤整', factor: 0.5, text: '大盤方向不明，建議只動用一半的風險額度，慢慢來、不要急。' },
    bear: { label: '偏弱', factor: 0, text: '大盤走勢偏弱。新手最安全的做法是先空手觀望，下方名單僅供觀察，暫時不建議買進。' },
  }[level];
  return {
    level, ...info, index: s.close, change: s.change, score: s.score, vix: r2(vix), date: s.date,
    facts: [
      `加權指數 ${s.close.toLocaleString()}，${aboveMa60 ? '站上' : '低於'}季線（${i.ma60?.toLocaleString()}）`,
      `月線${i.ma20 > i.ma60 ? '高於' : '低於'}季線，趨勢${i.ma20 > i.ma60 ? '向上' : '向下'}`,
      vix != null ? `VIX 恐慌指數 ${r2(vix)}（${vix > 30 ? '市場很恐慌' : vix > 20 ? '略為緊張' : '市場平靜'}）` : null,
    ].filter(Boolean),
  };
}

async function newsCheck(name) {
  try {
    const news = await getNews(name, 15);
    const cutoff = Date.now() - 14 * 864e5;
    const recent = news.filter((n) => new Date(n.date).getTime() >= cutoff);
    const scored = recent.map((n) => ({ ...n, s: scoreHeadline(n.title).s }));
    const neg = scored.filter((n) => n.s < 0);
    return { count: recent.length, negative: neg.length, worst: neg[0]?.title ?? null, bad: neg.length >= 3 && neg.length > scored.filter((n) => n.s > 0).length };
  } catch { return { count: 0, negative: 0, worst: null, bad: false, unknown: true }; }
}

function size(capital, riskPct, maxPos, factor, entry, stop, target) {
  const riskAmt = (capital * riskPct / 100) * factor;
  let shares = Math.floor(riskAmt / (entry - stop));
  shares = Math.min(shares, Math.floor((capital * maxPos) / entry));
  return finish(shares, entry, stop, target);
}
function finish(shares, entry, stop, target) {
  shares = Math.max(0, shares);
  return { shares, lots: Math.floor(shares / 1000), oddShares: shares % 1000, cost: Math.round(shares * entry), maxLoss: Math.round(shares * (entry - stop)), maxGain: Math.round(shares * (target - entry)) };
}

export async function beginnerReport({ capital = 100000, profile = '穩健' } = {}, { withAI = true } = {}) {
  capital = Math.max(10000, Number(capital) || 100000);
  const prof = PROFILES[profile] || PROFILES['穩健'];
  const market = await marketTemperature();
  const u = await getUniverse();

  // 候選池：股本前 60 大的上市普通股（流動性高、較不易被操縱）
  const pool = [...u.values()].filter((s) => s.market === 'TW' && /^\d{4}$/.test(s.code) && s.industry !== 'ETF' && s.capital).sort((a, b) => b.capital - a.capital).slice(0, 60);
  const scanned = await mapLimit(pool, 6, async (s) => {
    const { bars } = await getCandles(`${s.code}.TW`, '2y', '1d');
    if (bars.length < 130) return null;
    const snap = snapshot(bars);
    const ind = snap.indicators, p = snap.close;
    const atrPct = (ind.atr / p) * 100;
    const sup = snap.supports[0]?.price;
    const stop = roundTick(Math.min(p - 1.5 * ind.atr, sup ? sup - 0.3 * ind.atr : Infinity));
    const stopPct = ((p - stop) / p) * 100;
    const target = roundTick(p + 2 * (p - stop));
    const trendOk = p > ind.ma60 && ind.ma20 > ind.ma60;
    const checks = [
      { ok: trendOk, label: '長期走勢向上', plain: `股價 ${p} 在季線 ${ind.ma60} 之上，且月線高於季線` },
      { ok: snap.score >= 3, label: '技術面偏多', plain: `技術指標綜合評分 ${snap.score} 分（3 分以上算偏多）` },
      { ok: ind.rsi > 40 && ind.rsi < 70, label: '沒有過熱', plain: `RSI ${ind.rsi}（70 以上代表短線漲太多、容易回檔）` },
      { ok: s.pe > 0 && s.pe < 35, label: '價格不貴', plain: s.pe > 0 ? `本益比 ${s.pe} 倍（35 倍以上偏貴）` : '沒有本益比資料（可能近期虧損）' },
      { ok: atrPct < 4.5, label: '波動不會太劇烈', plain: `平均每天波動約 ${r2(atrPct)}%` },
    ];
    const hard = trendOk && ind.rsi < 78 && atrPct < 5 && stopPct <= 8 && snap.score >= 2;
    if (!hard) return null;
    const rank = snap.score + checks.filter((c) => c.ok).length * 0.8 + (s.yield > 3 ? 0.5 : 0) - atrPct * 0.3;
    const nearRes = snap.resistances[0]?.price;
    return {
      code: s.code, name: s.name, industry: s.industry, price: p, change: snap.change, entry: p, stop, target, stopPct: r2(stopPct), targetPct: r2(((target - p) / p) * 100),
      rr: r2((target - p) / (p - stop)), pe: s.pe, yield: s.yield, pb: s.pb, atrPct: r2(atrPct), score: snap.score, rsi: ind.rsi, checks,
      resistanceNote: nearRes && nearRes < target ? `上方 ${nearRes} 附近有歷史壓力，漲到那裡可以先賣一半` : null,
      stats: yearStats(bars), rank,
      why: snap.factors.filter((f) => f.score > 0).slice(0, 3).map((f) => f.text),
    };
  });
  const candidates = scanned.filter((x) => x && !x.error).sort((a, b) => b.rank - a.rank);

  // 前 8 名查新聞，排除近期負面消息偏多者
  const top = candidates.slice(0, 8);
  await mapLimit(top, 4, async (c) => { c.news = await newsCheck(c.name); });
  const excluded = top.filter((c) => c.news?.bad);
  const picks = top.filter((c) => !c.news?.bad).slice(0, 3);

  picks.forEach((c) => Object.assign(c, size(capital, prof.riskPct, prof.maxPos, market.factor, c.entry, c.stop, c.target)));
  // 總投入不超過資金 80%，保留現金
  const total = picks.reduce((s, c) => s + c.cost, 0);
  if (total > capital * 0.8) {
    const k = (capital * 0.8) / total;
    picks.forEach((c) => Object.assign(c, finish(Math.floor(c.shares * k), c.entry, c.stop, c.target)));
  }
  picks.forEach((c) => {
    c.watchOnly = market.factor === 0;
    c.affordable = c.shares > 0;
    c.reasons = [`長期走勢向上：${c.checks[0].plain}`, ...c.why.slice(0, 2), c.pe > 0 ? `本益比 ${c.pe} 倍${c.yield ? `、殖利率 ${c.yield}%` : ''}` : null].filter(Boolean);
    delete c.why; delete c.rank;
  });

  // ETF 區
  const etfs = (await mapLimit(ETFS, 5, async ([code, note]) => {
    const { bars } = await getCandles(`${code}.TW`, '2y', '1d');
    const s = snapshot(bars), i = s.indicators, st = yearStats(bars);
    const trend = s.close > i.ma60 && i.ma20 > i.ma60 ? '向上' : s.close < i.ma60 && i.ma20 < i.ma60 ? '向下' : '盤整';
    return { code, name: u.get(code)?.name || code, note, price: s.close, trend, ret1y: st.ret, mdd1y: st.mdd, oneLot: Math.round(s.close * 1000), affordable: s.close <= capital * 0.5 };
  })).filter((x) => x && !x.error);

  const result = {
    asOf: new Date().toISOString(), capital, profile, riskPct: prof.riskPct, maxPos: prof.maxPos, profileDesc: prof.desc, market,
    scannedCount: pool.length, qualified: candidates.length, excluded: excluded.map((c) => ({ code: c.code, name: c.name, reason: `近 14 天負面新聞偏多：${c.news.worst}` })),
    picks, etfs,
    totals: { cost: picks.reduce((s, c) => s + c.cost, 0), maxLoss: picks.reduce((s, c) => s + c.maxLoss, 0) },
  };
  if (withAI) {
    result.ai = await aiAnalyze(`使用者是股票新手，資金 ${capital.toLocaleString()} 元、風險屬性「${profile}」。以下是系統篩選出的大盤狀況、候選股與 ETF。請用淺顯白話的繁體中文（避免專業術語，必要時舉生活化比喻）：1) 解釋大盤現在適不適合進場 2) 逐檔說明為什麼入選、買進後要注意什麼、什麼情況要停損 3) 給出新手最容易犯的 3 個錯誤提醒。`, { ...result, picks: result.picks.map(({ checks, ...rest }) => rest) });
  }
  return result;
}
