// 模組 5：投資組合風險管理
import { resolveSymbol, getCandles, getUniverse, mapLimit } from './data.js';
import { aiAnalyze } from './ai.js';

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(2));
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(3));

const PROFILES = {
  保守: { targetVol: 10, maxName: 15, maxSector: 30, maxLoss20: 10 },
  穩健: { targetVol: 16, maxName: 25, maxSector: 40, maxLoss20: 16 },
  積極: { targetVol: 24, maxName: 35, maxSector: 60, maxLoss20: 25 },
};

// 解析 "2330 40%, 2317 20, 0050 40" 等格式
export function parseHoldings(text) {
  const out = [];
  for (const part of String(text).split(/[\n,，;；]+/)) {
    const m = part.trim().match(/^(\S+?)\s*[:：\s]\s*([\d.]+)\s*%?$/);
    if (m) out.push({ input: m[1], weight: parseFloat(m[2]) });
  }
  if (!out.length) throw new Error('格式錯誤，請輸入如：2330 40%, 2317 20%, 0050 40%');
  const sum = out.reduce((s, h) => s + h.weight, 0);
  return out.map((h) => ({ ...h, weight: h.weight / sum }));
}

function logRets(bars) { const m = new Map(); for (let i = 1; i < bars.length; i++) m.set(bars[i].date, Math.log(bars[i].c / bars[i - 1].c)); return m; }

export async function portfolioReport(text, { profile = '穩健', value = 1_000_000, withAI = true } = {}) {
  const hold = parseHoldings(text);
  const prof = PROFILES[profile] || PROFILES['穩健'];
  const u = await getUniverse().catch(() => new Map());
  const assets = await mapLimit(hold, 6, async (h) => {
    const info = await resolveSymbol(h.input);
    const { bars } = await getCandles(info.symbol, '2y', '1d');
    const meta = u.get(info.code) || {};
    const isETF = /^00/.test(info.code);
    return { ...h, symbol: info.symbol, code: info.code, name: info.name || meta.name, industry: isETF ? 'ETF' : meta.industry || '其他', pe: meta.pe, yield: meta.yield, bars, rets: logRets(bars) };
  });
  const bad = assets.filter((a) => a.error);
  if (bad.length) throw new Error(`無法取得：${hold.filter((_, k) => assets[k].error).map((h) => h.input).join('、')}`);
  const { bars: idxBars } = await getCandles('^TWII', '2y', '1d');
  const idxRets = logRets(idxBars);

  // 對齊共同交易日（近 1 年）
  const dates = [...idxRets.keys()].filter((d) => assets.every((a) => a.rets.has(d))).slice(-250);
  const R = assets.map((a) => dates.map((d) => a.rets.get(d)));
  const M = dates.map((d) => idxRets.get(d));
  const n = assets.length, T = dates.length;
  if (T < 60) throw new Error('共同交易日不足 60 天');
  const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
  const cov = (x, y) => { const mx = mean(x), my = mean(y); let s = 0; for (let t = 0; t < x.length; t++) s += (x[t] - mx) * (y[t] - my); return s / (x.length - 1); };
  const C = R.map((x) => R.map((y) => cov(x, y)));
  const vol = C.map((row, k) => Math.sqrt(row[k] * 250));
  const corr = C.map((row, i) => row.map((c, j) => c / Math.sqrt(C[i][i] * C[j][j])));
  const varM = cov(M, M);
  const beta = R.map((x) => cov(x, M) / varM);
  const w = assets.map((a) => a.weight);
  const portVar = w.reduce((s, wi, i) => s + w.reduce((t, wj, j) => t + wi * wj * C[i][j], 0), 0);
  const portVol = Math.sqrt(portVar * 250);
  const mrc = w.map((wi, i) => (wi * w.reduce((t, wj, j) => t + wj * C[i][j], 0)) / portVar); // 風險貢獻比例
  const portBeta = w.reduce((s, wi, i) => s + wi * beta[i], 0);
  const portRets = dates.map((_, t) => w.reduce((s, wi, i) => s + wi * R[i][t], 0));
  const sorted = [...portRets].sort((a, b) => a - b);
  const var95 = -sorted[Math.floor(T * 0.05)];
  let eq = 1, peak = 1, mdd = 0; for (const r of portRets) { eq *= Math.exp(r); peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak); }
  const hhi = w.reduce((s, x) => s + x * x, 0);
  const avgCorr = n > 1 ? corr.flatMap((row, i) => row.filter((_, j) => j > i)).reduce((a, b) => a + b, 0) / (n * (n - 1) / 2) : 1;
  const diversification = w.reduce((s, wi, i) => s + wi * vol[i], 0) / portVol;

  // 產業曝險
  const sectors = {};
  assets.forEach((a) => (sectors[a.industry] = (sectors[a.industry] || 0) + a.weight));

  // 弱點與過度曝險
  const issues = [];
  assets.forEach((a, i) => { if (a.weight * 100 > prof.maxName) issues.push({ level: 'high', text: `${a.name}（${a.code}）佔 ${r2(a.weight * 100)}%，超過${profile}型單一持股上限 ${prof.maxName}%` }); });
  Object.entries(sectors).forEach(([s, x]) => { if (x * 100 > prof.maxSector && s !== 'ETF') issues.push({ level: 'high', text: `產業「${s}」曝險 ${r2(x * 100)}%，超過上限 ${prof.maxSector}%` }); });
  assets.forEach((a, i) => { if (mrc[i] - a.weight > 0.1) issues.push({ level: 'mid', text: `${a.name} 權重 ${r2(a.weight * 100)}% 但貢獻 ${r2(mrc[i] * 100)}% 的組合風險（高波動 ${r2(vol[i] * 100)}%）` }); });
  if (portVol * 100 > prof.targetVol * 1.15) issues.push({ level: 'high', text: `組合年化波動 ${r2(portVol * 100)}% 高於${profile}型目標 ${prof.targetVol}%` });
  if (portBeta > 1.2) issues.push({ level: 'mid', text: `組合 Beta ${r2(portBeta)}，大盤下跌時跌幅將放大` });
  const hidden = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const c = corr[i][j];
    if (c > 0.6) hidden.push({ a: assets[i].name, b: assets[j].name, corr: r2(c), sameSector: assets[i].industry === assets[j].industry, text: assets[i].industry === assets[j].industry ? '同產業高度連動' : '不同產業卻高度連動（隱藏相關性，可能同屬 AI/電子供應鏈或同受外資資金驅動）' });
  }
  hidden.sort((a, b) => b.corr - a.corr);
  if (avgCorr > 0.5) issues.push({ level: 'mid', text: `持股平均相關係數 ${r2(avgCorr)}，分散效果有限（分散比 ${r2(diversification)}）` });

  // 平衡方案：風險平價（反波動）→ 套用單一上限與目標波動 → 不足部分放現金/債券 ETF
  let inv = vol.map((v) => 1 / v); const s = inv.reduce((a, b) => a + b, 0); inv = inv.map((x) => x / s);
  let blend = w.map((wi, i) => 0.5 * wi + 0.5 * inv[i]);
  for (let k = 0; k < 10; k++) { // 迭代套用上限
    const cap = prof.maxName / 100; let excess = 0, free = 0;
    blend = blend.map((x) => { if (x > cap) { excess += x - cap; return cap; } return x; });
    blend.forEach((x) => { if (x < cap) free += x; });
    if (excess < 1e-6) break;
    blend = blend.map((x) => (x < cap ? x + excess * (x / free) : x));
  }
  const blendVar = blend.reduce((s2, wi, i) => s2 + blend.reduce((t, wj, j) => t + wi * wj * C[i][j], 0), 0);
  const blendVol = Math.sqrt(blendVar * 250);
  const equityShare = Math.min(1, prof.targetVol / 100 / blendVol);
  const proposal = assets.map((a, i) => ({ code: a.code, name: a.name, current: r2(a.weight * 100), proposed: r2(blend[i] * equityShare * 100), change: r2((blend[i] * equityShare - a.weight) * 100) }));
  if (equityShare < 0.999) proposal.push({ code: '現金/00679B', name: '現金或美債 ETF', current: 0, proposed: r2((1 - equityShare) * 100), change: r2((1 - equityShare) * 100) });
  const newBeta = blend.reduce((s2, wi, i) => s2 + wi * beta[i], 0) * equityShare;

  // 大盤下跌 20% 情境與避險
  const idxLevel = idxBars[idxBars.length - 1].c;
  const expLoss = portBeta * 0.2;
  // 歷史壓力：取過去 2 年大盤最差 20 日區間，組合對應報酬
  let worst = { idx: 0, port: 0, from: null, to: null };
  for (let t = 20; t < T; t++) {
    const ir = M.slice(t - 20, t).reduce((a, b) => a + b, 0), pr = portRets.slice(t - 20, t).reduce((a, b) => a + b, 0);
    if (ir < worst.idx) worst = { idx: ir, port: pr, from: dates[t - 20], to: dates[t - 1] };
  }
  const hedgeNotional = value * portBeta;
  const txContracts = hedgeNotional / (idxLevel * 200), mtxContracts = hedgeNotional / (idxLevel * 50);
  const hedge = {
    indexLevel: r2(idxLevel), portfolioValue: value, portBeta: r2(portBeta),
    scenario: { marketDrop: -20, expectedLossPct: r2(-expLoss * 100), expectedLoss: Math.round(-expLoss * value), withinTolerance: expLoss * 100 <= prof.maxLoss20 },
    historicalStress: { from: worst.from, to: worst.to, indexPct: r2((Math.exp(worst.idx) - 1) * 100), portfolioPct: r2((Math.exp(worst.port) - 1) * 100) },
    options: [
      { name: '放空小型台指期（MTX，每點 50 元）', detail: `完全避險需約 ${r2(mtxContracts)} 口（β 調整後名目 ${Math.round(hedgeNotional).toLocaleString()} 元）。建議先避險 50%：${Math.max(1, Math.round(mtxContracts / 2))} 口。注意保證金與每月結算轉倉。`, cost: '低（僅轉倉價差與保證金機會成本），但上漲時損失上檔' },
      { name: '放空台指期（TX，每點 200 元）', detail: `完全避險約 ${r2(txContracts)} 口；部位小於 1 口時建議改用小台或微台。`, cost: '低，口數顆粒度較粗' },
      { name: '買進台指選擇權賣權（TXO Put）', detail: `買進價外 5–8%（約 ${Math.round(idxLevel * 0.93 / 100) * 100}–${Math.round(idxLevel * 0.95 / 100) * 100} 點）近月或次月 Put，名目約 ${Math.round(hedgeNotional).toLocaleString()} 元（每點 50 元）。`, cost: '需支付權利金（年化約組合 2–5%），但保留上漲空間，適合保險型避險' },
      { name: '配置反向 ETF（00632R 元大台灣50反1）', detail: `配置約 ${Math.round(hedgeNotional * 0.3).toLocaleString()} 元（避險 30% Beta 曝險）。`, cost: '無保證金需求，但每日重設有長期耗損，不宜長抱' },
      { name: '降低高 Beta 部位 + 提高現金', detail: `採用上方平衡方案後 Beta 由 ${r2(portBeta)} 降至 ${r2(newBeta)}，大盤跌 20% 時預估損失降至 ${r2(newBeta * 20)}%。`, cost: '最簡單、無衍生性商品風險' },
    ],
    triggers: ['大盤跌破季線（MA60）且季線下彎：啟動 50% 避險', '大盤跌破半年線或 VIX > 30：避險提高至 80–100%', '大盤重新站上月線且外資連 3 日買超：逐步解除避險'],
  };

  const result = {
    profile, profileLimits: prof, value,
    holdings: assets.map((a, i) => ({ code: a.code, name: a.name, industry: a.industry, weight: r2(a.weight * 100), vol: r2(vol[i] * 100), beta: r2(beta[i]), riskContribution: r2(mrc[i] * 100), pe: a.pe, yield: a.yield })),
    stats: { portVol: r2(portVol * 100), portBeta: r2(portBeta), var95: r2(var95 * 100), var95Amount: Math.round(var95 * value), maxDrawdown1y: r2(mdd * 100), hhi: r3(hhi), effectiveN: r2(1 / hhi), avgCorr: r2(avgCorr), diversification: r2(diversification), days: T },
    sectors: Object.entries(sectors).map(([k, v]) => ({ sector: k, weight: r2(v * 100) })).sort((a, b) => b.weight - a.weight),
    correlation: { labels: assets.map((a) => a.name), matrix: corr.map((r) => r.map(r2)) },
    issues, hidden, proposal, proposalStats: { vol: r2(blendVol * equityShare * 100), beta: r2(newBeta) }, hedge,
  };
  if (withAI) {
    result.ai = await aiAnalyze(`請分析這個台股投資組合（風險屬性：${profile}）：1) 弱點與過度曝險 2) 隱藏相關性（例如同屬 AI 供應鏈、同受外資或匯率影響）3) 符合風險承受度的平衡方案（可評論系統提出的權重）4) 大盤下跌 20% 的避險策略與執行時點。`, result);
  }
  return result;
}
