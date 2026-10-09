// 模組 7：全自動每日交易計畫
import { resolveSymbol, getCandles, mapLimit } from './data.js';
import { snapshot } from './analysis.js';
import { roundTick } from './indicators.js';
import { aiAnalyze } from './ai.js';

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(2));

const GLOBAL = [
  { sym: '^SOX', name: '費城半導體' }, { sym: '^IXIC', name: '那斯達克' }, { sym: '^GSPC', name: 'S&P 500' },
  { sym: 'TSM', name: '台積電 ADR' }, { sym: '^VIX', name: 'VIX 恐慌指數' }, { sym: 'TWD=X', name: '美元/台幣' }, { sym: '^TNX', name: '美 10 年債殖利率' },
];

function floorPivots(b) {
  const P = (b.h + b.l + b.c) / 3;
  return { P: roundTick(P), R1: roundTick(2 * P - b.l), R2: roundTick(P + (b.h - b.l)), S1: roundTick(2 * P - b.h), S2: roundTick(P - (b.h - b.l)) };
}

export async function dailyPlan(input = '台股', { capital = 1_000_000, riskPct = 1, withAI = true } = {}) {
  const q = String(input || '台股').trim();
  const isFutures = /台指期|期貨|TX|小台/.test(q);
  const target = isFutures || /台股|大盤|加權/.test(q) ? await resolveSymbol('加權指數') : await resolveSymbol(q);
  const [{ bars }, globals] = await Promise.all([
    getCandles(target.symbol, '2y', '1d'),
    mapLimit(GLOBAL, 7, async (g) => { const { bars: gb } = await getCandles(g.sym, '1mo', '1d'); const a = gb[gb.length - 1], p = gb[gb.length - 2]; return { ...g, date: a.date, close: r2(a.c), change: r2((a.c / p.c - 1) * 100) }; }),
  ]);
  const snap = snapshot(bars);
  const last = bars[bars.length - 1];
  const pv = floorPivots(last);
  const atrV = snap.indicators.atr;
  const g = Object.fromEntries(globals.filter((x) => !x.error).map((x) => [x.sym, x]));
  const sox = g['^SOX']?.change ?? 0, adr = g['TSM']?.change ?? 0, vix = g['^VIX']?.close ?? 20, twd = g['TWD=X']?.change ?? 0;
  const bias = sox + adr * 0.5 > 1.5 ? '偏多' : sox + adr * 0.5 < -1.5 ? '偏空' : '中性';
  const gapTh = r2((atrV / last.c) * 100 * 0.5);
  const stopDist = 1.5 * atrV;
  const unit = isFutures ? '口（小台每點 50 元）' : '股';
  const size = isFutures ? Math.max(1, Math.floor((capital * riskPct / 100) / (stopDist * 50))) : Math.floor((capital * riskPct / 100) / stopDist);
  const name = isFutures ? '台指期（以加權指數計算價位）' : target.name;
  const open = isFutures ? '08:45' : '09:00';
  const close = isFutures ? '13:45' : '13:30';
  const trendTxt = snap.score >= 4 ? '多頭' : snap.score <= -4 ? '空頭' : '盤整';

  const sections = [
    { phase: '盤前掃描', items: [
      { time: '07:30', task: '檢查隔夜國際市場', detail: globals.filter((x) => !x.error).map((x) => `${x.name} ${x.close}（${x.change > 0 ? '+' : ''}${x.change}%）`).join('、'), flag: Math.abs(sox) > 2 ? `費半${sox > 0 ? '大漲' : '大跌'} ${sox}%，預期電子股${sox > 0 ? '開高' : '開低'}` : null },
      { time: '07:45', task: '評估今日市場偏向', detail: `國際偏向：${bias}；${name} 技術面：${trendTxt}（評分 ${snap.score}）。VIX ${vix}${vix > 25 ? '偏高，降低部位 50%' : '正常'}；台幣${twd > 0 ? '貶值，留意外資賣超' : '升值，有利外資回流'}。` },
      { time: '08:00', task: '確認重大事件與新聞', detail: '查看公開資訊觀測站重大訊息、經濟日曆（美國 CPI/非農/FOMC、台灣出口數據）、個股法說會與除權息日。' },
      { time: '08:15', task: '標記今日關鍵價位', detail: `昨收 ${r2(last.c)}；樞紐 P ${pv.P}｜壓力 R1 ${pv.R1} / R2 ${pv.R2}｜支撐 S1 ${pv.S1} / S2 ${pv.S2}；MA20 ${snap.indicators.ma20}、MA60 ${snap.indicators.ma60}；波段壓力 ${snap.resistances.map((x) => x.price).join('/') || '無'}、波段支撐 ${snap.supports.map((x) => x.price).join('/') || '無'}` },
      { time: '08:25', task: '設定部位與風險上限', detail: `資金 ${capital.toLocaleString()} 元、單筆風險 ${riskPct}%（${Math.round(capital * riskPct / 100).toLocaleString()} 元）；停損距離 1.5×ATR = ${r2(stopDist)} 點 → 建議 ${size.toLocaleString()} ${unit}。單日最大虧損 ${riskPct * 2}% 即停止交易。` },
      ...(isFutures ? [] : [{ time: '08:30', task: '觀察試撮（08:30–09:00）', detail: `試撮價高於昨收 ${gapTh}% 以上視為跳空開高、低於 −${gapTh}% 視為跳空開低（約 0.5 ATR）。注意大單掛撤造成的假象。` }]),
    ] },
    { phase: '開盤策略', items: [
      { time: open, task: '開盤情境判斷', detail: `跳空開高 > ${gapTh}%：不追價，等 15 分鐘高點突破再進場，停損設開盤區間低點。平盤開：觀察是否站穩樞紐 P ${pv.P}。跳空開低 < −${gapTh}%：若守住 S1 ${pv.S1} 且出現量縮止跌，可小量試單；跌破 S2 ${pv.S2} 不接刀。` },
      { time: isFutures ? '09:00' : '09:15', task: '確立開盤區間（ORB）', detail: '記錄前 15 分鐘高低點。突破高點且成交量 > 昨日同時段 → 順勢做多；跌破低點 → 多單減碼/空單進場。' },
      { time: isFutures ? '09:15' : '09:30', task: '確認量能與法人動向', detail: '比對累計成交量與昨日同時段；觀察權值股（台積電、鴻海、聯發科）是否同步；期現貨價差是否擴大。' },
    ] },
    { phase: '盤中調整', items: [
      { time: '10:00', task: '第一次部位檢查', detail: `已持有部位：價格 > 進場價 + 1R 時停損上移至成本。未進場：若價格位於 P ${pv.P} 之${snap.score >= 0 ? '上，等回測不破再進' : '下，觀望或順勢偏空'}。` },
      { time: '11:00', task: '盤中趨勢確認', detail: '價格是否維持在當日均價（VWAP）之上？跌破 VWAP 且無法收復 → 多單減碼。成交量萎縮 → 減少交易頻率。' },
      { time: '12:00', task: '午盤檢討', detail: '確認今日損益是否接近單日上限；檢查是否有違反規則的單（追價、未設停損）。午盤量縮時段避免新進場。' },
      { time: '12:30', task: '評估尾盤方向', detail: `觀察 R1 ${pv.R1} / S1 ${pv.S1} 是否被測試；外資期貨部位變化；若強勢股於高檔整理不破，尾盤可能再攻。` },
    ] },
    { phase: '收盤策略', items: [
      ...(isFutures ? [
        { time: '13:15', task: '決定是否留倉', detail: '日盤收盤前 30 分鐘：無明確趨勢則平倉；留倉需確認夜盤風險（美股數據公布）與保證金充足。' },
        { time: '13:45', task: '日盤收盤', detail: `收盤價與 MA20 ${snap.indicators.ma20} 比較，決定夜盤（15:00 起）策略。` },
      ] : [
        { time: '13:00', task: '尾盤佈局', detail: '強勢股收在當日高點附近且量增 → 可留倉；弱勢股收在低點 → 當日出清避免隔日跳空。' },
        { time: '13:25', task: '最後集合競價（13:25–13:30）', detail: '確認所有當沖部位已平倉；隔日沖/波段單確認停損單已設定。不在最後競價追價。' },
        { time: '13:30', task: '收盤', detail: `記錄收盤價 vs 關鍵價位（P ${pv.P}、MA20 ${snap.indicators.ma20}），判斷明日偏向。` },
        { time: '14:00', task: '盤後定價交易（14:00–14:30）', detail: '如需以收盤價調整部位可利用盤後定價；零股交易 13:40–14:30。' },
      ]),
      { time: '15:00', task: '查看三大法人買賣超與融資券', detail: '外資、投信連續買賣超方向；融資增減是否與股價背離（散戶追價訊號）。' },
      { time: '15:30', task: '撰寫交易日誌', detail: '記錄每筆交易：進出場理由、是否遵守計畫、情緒狀態（1–5 分）、可改進之處。更新本系統「交易日誌分析」。' },
      { time: '21:00', task: '預備明日', detail: '檢查美股開盤（21:30/22:30）與重要數據；更新明日觀察清單與關鍵價位。' },
    ] },
  ];
  let id = 0; sections.forEach((s) => s.items.forEach((it) => (it.id = `${new Date().toISOString().slice(0, 10)}-${++id}`)));
  const result = { asset: name, symbol: target.symbol, date: last.date, bias, trend: trendTxt, score: snap.score, pivots: pv, atr: atrV, globals, sections, rules: ['沒有計畫不交易', `單筆風險 ≤ ${riskPct}%，單日虧損 ≥ ${riskPct * 2}% 停止交易`, '進場同時設定停損，停損只能上移不能下移', '開盤 15 分鐘內不追價'] };
  if (withAI) result.ai = await aiAnalyze(`請根據以下資料，為「${name}」撰寫今日交易計畫重點：1) 盤前判斷（國際市場、偏向）2) 開盤三種情境的具體應對 3) 盤中調整要點 4) 收盤與留倉策略。保持精簡、可執行。`, { ...result, sections: undefined });
  return result;
}
