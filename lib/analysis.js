// 模組 2：自動化技術分析（日線 + 週線）
import { computeAll, levels, trendlines, divergence, roundTick } from './indicators.js';
import { resolveSymbol, getCandles, getUniverse } from './data.js';
import { aiAnalyze } from './ai.js';

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(2));
const pct = (a, b) => ((a / b - 1) * 100);

// 單一週期快照：回傳指標值、評分與每一個評分理由
export function snapshot(bars, label = '日線') {
  const ind = computeAll(bars);
  const i = bars.length - 1;
  const b = bars[i], p = b.c;
  const v = (arr) => arr[i];
  const prev = (arr, k = 1) => arr[i - k];
  const factors = [];
  const add = (cat, score, text) => factors.push({ cat, score, text });

  // --- 趨勢 ---
  const ma5 = v(ind.ma5), ma20 = v(ind.ma20), ma60 = v(ind.ma60), ma120 = v(ind.ma120), ma240 = v(ind.ma240);
  if (ma5 && ma20 && ma60) {
    if (ma5 > ma20 && ma20 > ma60) add('趨勢', 2, `均線多頭排列（MA5 ${r2(ma5)} > MA20 ${r2(ma20)} > MA60 ${r2(ma60)}）`);
    else if (ma5 < ma20 && ma20 < ma60) add('趨勢', -2, `均線空頭排列（MA5 ${r2(ma5)} < MA20 ${r2(ma20)} < MA60 ${r2(ma60)}）`);
    else add('趨勢', 0, '均線糾結，趨勢不明確');
  }
  if (ma20) add('趨勢', p > ma20 ? 1 : -1, `收盤 ${r2(p)} ${p > ma20 ? '站上' : '跌破'} 月線 MA20（${r2(ma20)}）`);
  if (ma20 && prev(ind.ma20, 5)) add('趨勢', ma20 > prev(ind.ma20, 5) ? 1 : -1, `月線斜率${ma20 > prev(ind.ma20, 5) ? '向上' : '向下'}`);
  if (ma240) add('趨勢', p > ma240 ? 1 : -1, `股價${p > ma240 ? '位於' : '低於'}年線 MA240（${r2(ma240)}），長線${p > ma240 ? '偏多' : '偏空'}`);
  else if (ma120) add('趨勢', p > ma120 ? 1 : -1, `股價${p > ma120 ? '位於' : '低於'}半年線 MA120（${r2(ma120)}）`);
  const adxV = v(ind.adx);
  if (adxV != null) add('趨勢', 0, `ADX ${r2(adxV)}：${adxV > 25 ? '趨勢明確，適合順勢操作' : adxV < 20 ? '盤整格局，適合區間操作' : '趨勢醞釀中'}`);

  // --- 動能 ---
  const R = v(ind.rsi);
  if (R != null) {
    if (R > 80) add('動能', -1, `RSI ${r2(R)} 嚴重超買，追高風險高`);
    else if (R > 55) add('動能', 1, `RSI ${r2(R)} 位於多方區`);
    else if (R < 20) add('動能', 1, `RSI ${r2(R)} 嚴重超賣，留意反彈`);
    else if (R < 45) add('動能', -1, `RSI ${r2(R)} 位於空方區`);
    else add('動能', 0, `RSI ${r2(R)} 中性`);
  }
  const dif = v(ind.macd.dif), sig = v(ind.macd.signal), h = v(ind.macd.hist), hp = prev(ind.macd.hist);
  if (dif != null && sig != null) {
    if (h > 0 && hp <= 0) add('動能', 2, 'MACD 黃金交叉（DIF 上穿訊號線）');
    else if (h < 0 && hp >= 0) add('動能', -2, 'MACD 死亡交叉（DIF 下穿訊號線）');
    else add('動能', h > 0 ? 1 : -1, `MACD 柱狀體${h > 0 ? '為正' : '為負'}且${Math.abs(h) > Math.abs(hp) ? '擴大' : '收斂'}（DIF ${r2(dif)}）`);
  }
  const K = v(ind.kd.k), D = v(ind.kd.d), Kp = prev(ind.kd.k), Dp = prev(ind.kd.d);
  if (K != null) {
    if (K > D && Kp <= Dp) add('動能', K < 30 ? 2 : 1, `KD 黃金交叉（K ${r2(K)} / D ${r2(D)}）${K < 30 ? '，低檔交叉訊號較強' : ''}`);
    else if (K < D && Kp >= Dp) add('動能', K > 70 ? -2 : -1, `KD 死亡交叉（K ${r2(K)} / D ${r2(D)}）${K > 70 ? '，高檔交叉訊號較強' : ''}`);
    else if (K > 80) add('動能', 0, `KD 高檔鈍化（K ${r2(K)}），強勢但留意反轉`);
    else if (K < 20) add('動能', 0, `KD 低檔鈍化（K ${r2(K)}），弱勢但留意反彈`);
  }
  const dv = divergence(bars, ind.rsi, i);
  if (dv === 'bull') add('動能', 2, 'RSI 多頭背離：價格創低但 RSI 墊高');
  if (dv === 'bear') add('動能', -2, 'RSI 空頭背離：價格創高但 RSI 走低');

  // --- 量能 ---
  const vm = v(ind.volMa20);
  if (vm) {
    const ratio = b.v / vm, up = b.c >= bars[i - 1].c;
    if (ratio > 1.5) add('量能', up ? 1 : -1, `成交量為 20 日均量 ${r2(ratio)} 倍，${up ? '價漲量增' : '價跌量增（賣壓）'}`);
    else if (ratio < 0.6) add('量能', 0, `量縮至均量 ${r2(ratio)} 倍，觀望氣氛濃`);
  }

  // --- 布林通道 ---
  const bu = v(ind.bb.up), bd = v(ind.bb.dn), bm = v(ind.bb.mid);
  if (bu) {
    const width = (bu - bd) / bm;
    if (p > bu) add('波動', 0, `突破布林上軌（${r2(bu)}），強勢但短線乖離大`);
    else if (p < bd) add('波動', 0, `跌破布林下軌（${r2(bd)}），弱勢但短線乖離大`);
    if (width < 0.08) add('波動', 0, `布林帶寬僅 ${r2(width * 100)}%，波動壓縮，留意方向性突破`);
  }

  const score = factors.reduce((s, f) => s + f.score, 0);
  const lv = levels(bars);
  const supports = lv.filter((x) => x.type === 'support' && x.price < p).sort((a, b) => b.price - a.price).slice(0, 3);
  const resistances = lv.filter((x) => x.type === 'resistance' && x.price > p).sort((a, b) => a.price - b.price).slice(0, 3);
  const maLevels = [['MA20', ma20], ['MA60', ma60], ['MA120', ma120], ['MA240', ma240]].filter(([, x]) => x).map(([n, x]) => ({ name: n, price: r2(x), position: x < p ? '支撐' : '壓力' }));

  return {
    label, date: b.date, close: r2(p), change: r2(pct(p, bars[i - 1].c)),
    indicators: { ma5: r2(ma5), ma20: r2(ma20), ma60: r2(ma60), ma120: r2(ma120), ma240: r2(ma240), rsi: r2(R), k: r2(K), d: r2(D), dif: r2(dif), macdSignal: r2(sig), macdHist: r2(h), adx: r2(adxV), atr: r2(v(ind.atr)), bbUp: r2(bu), bbDn: r2(bd), volRatio: vm ? r2(b.v / vm) : null },
    factors, score, supports, resistances, maLevels, trendlines: trendlines(bars), divergence: dv, _ind: ind,
  };
}

function verdict(score) {
  if (score >= 6) return { signal: '買進', tone: 'buy' };
  if (score >= 2) return { signal: '持有 / 偏多', tone: 'hold-bull' };
  if (score > -2) return { signal: '持有 / 觀望', tone: 'hold' };
  if (score > -6) return { signal: '減碼 / 偏空', tone: 'hold-bear' };
  return { signal: '賣出', tone: 'sell' };
}

export async function technicalReport(input, { withAI = true } = {}) {
  const info = await resolveSymbol(input);
  const [daily, weekly] = await Promise.all([getCandles(info.symbol, '2y', '1d'), getCandles(info.symbol, '10y', '1wk')]);
  if (daily.bars.length < 60) throw new Error('歷史資料不足 60 日，無法分析');
  const d = snapshot(daily.bars, '日線');
  const w = snapshot(weekly.bars, '週線');
  // 週線權重較高：決定大方向；日線決定進出時點
  const total = d.score + w.score * 1.5;
  const v = verdict(total);
  const atrV = d.indicators.atr, p = d.close;
  const sup = d.supports[0]?.price ?? roundTick(p - 2 * atrV);
  const res = d.resistances[0]?.price ?? roundTick(p + 3 * atrV);
  const stop = roundTick(Math.min(sup - 0.5 * atrV, p - 1.5 * atrV));
  const target = roundTick(Math.max(res, p + 2 * (p - stop)));

  const steps = [
    { step: 1, title: '確認大方向（週線）', detail: `週線評分 ${w.score}。${w.factors.filter((f) => f.cat === '趨勢').map((f) => f.text).join('；')}` },
    { step: 2, title: '確認日線趨勢', detail: `日線評分 ${d.score}。${d.factors.filter((f) => f.cat === '趨勢').map((f) => f.text).join('；')}` },
    { step: 3, title: '檢查動能指標', detail: d.factors.filter((f) => f.cat === '動能').map((f) => f.text).join('；') || '無明顯動能訊號' },
    { step: 4, title: '量能與波動', detail: d.factors.filter((f) => f.cat === '量能' || f.cat === '波動').map((f) => f.text).join('；') || '量能正常' },
    { step: 5, title: '關鍵價位', detail: `最近支撐 ${d.supports.map((s) => s.price).join(' / ') || '無'}；最近壓力 ${d.resistances.map((s) => s.price).join(' / ') || '無（創高區）'}` },
    { step: 6, title: `綜合訊號：${v.signal}`, detail: `加權總分 ${r2(total)}（日線 ${d.score} + 週線 ${w.score}×1.5）。` + (
      v.tone === 'buy' ? `可於 ${roundTick(Math.max(sup, p - 0.5 * atrV))}–${p} 分批進場，停損 ${stop}，目標 ${target}。`
      : v.tone === 'sell' ? `持股可逢反彈至 ${res} 附近減碼，跌破 ${sup} 應停損出場。`
      : v.tone === 'hold-bull' ? `持股續抱，以 ${stop} 為移動停損；空手者等拉回 ${sup} 附近不破再進場。`
      : v.tone === 'hold-bear' ? `持股逢高減碼，跌破 ${sup} 出場；空手者觀望。`
      : `區間 ${sup}–${res} 操作，突破壓力或跌破支撐再表態。`) },
  ];

  const u = await getUniverse().catch(() => new Map());
  const fund = u.get(info.code) || {};
  const strip = (s) => { const { _ind, ...rest } = s; return rest; };
  const chart = daily.bars.slice(-250).map((b, k) => {
    const idx = daily.bars.length - 250 + k;
    return { ...b, ma20: d._ind.ma20[idx], ma60: d._ind.ma60[idx], ma120: d._ind.ma120[idx] };
  });
  const result = {
    info: { symbol: info.symbol, code: info.code, name: info.name || daily.meta.name, industry: fund.industry, pe: fund.pe, pb: fund.pb, yield: fund.yield },
    daily: strip(d), weekly: strip(w), total: r2(total), ...v, plan: { entry: p, stop, target, support: sup, resistance: res, rr: r2((target - p) / (p - stop)) }, steps, chart,
  };
  if (withAI) {
    result.ai = await aiAnalyze('請根據以下日線與週線技術資料，撰寫一份逐步的技術分析報告：1) 趨勢結構 2) 支撐壓力與趨勢線 3) 均線與動能 4) 明確的買進/持有/賣出訊號與理由 5) 進場、停損、目標與失效條件。', { info: result.info, daily: result.daily, weekly: result.weekly, plan: result.plan, ruleSignal: v.signal });
  }
  return result;
}
