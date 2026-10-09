// 模組 6：交易日誌分析
import { resolveSymbol, getCandles, mapLimit } from './data.js';
import { computeAll } from './indicators.js';
import { aiAnalyze } from './ai.js';

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(2));

// 每行：進場日,代號,方向(多/空),進場價,出場日,出場價,股數[,停損價][,備註]
export function parseJournal(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^進場日|^#/.test(t)) continue;
    const f = t.split(/[,，\t]/).map((s) => s.trim());
    if (f.length < 7) throw new Error(`欄位不足：「${t}」`);
    const side = /空|short|S/i.test(f[2]) ? -1 : 1;
    const row = { entryDate: f[0].replace(/\//g, '-'), code: f[1], side, entry: +f[3], exitDate: f[4].replace(/\//g, '-'), exit: +f[5], qty: +f[6], stop: f[7] ? +f[7] : null, note: f[8] || '' };
    if (![row.entry, row.exit, row.qty].every(Number.isFinite)) throw new Error(`數字格式錯誤：「${t}」`);
    rows.push(row);
  }
  if (!rows.length) throw new Error('沒有可分析的交易');
  return rows.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
}

const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);

export async function journalReport(text, { withAI = true } = {}) {
  const trades = parseJournal(text).slice(-20);
  const fee = 0.001425 * 0.6;
  trades.forEach((t, k) => {
    t.no = k + 1;
    const gross = t.side * (t.exit - t.entry) * t.qty;
    t.pnl = Math.round(gross - (t.entry + t.exit) * t.qty * fee - t.exit * t.qty * (t.side === 1 ? 0.003 : 0) - t.entry * t.qty * (t.side === -1 ? 0.003 : 0));
    t.retPct = r2((t.side * (t.exit / t.entry - 1)) * 100);
    t.hold = days(t.entryDate, t.exitDate);
    t.size = t.entry * t.qty;
    if (t.stop) t.plannedRiskPct = r2(Math.abs(t.entry - t.stop) / t.entry * 100);
  });

  // 取得行情以判斷追高、過早出場、錯失機會
  const codes = [...new Set(trades.map((t) => t.code))];
  const priceMap = new Map();
  await mapLimit(codes, 5, async (c) => { const info = await resolveSymbol(c); const { bars } = await getCandles(info.symbol, '2y', '1d'); priceMap.set(c, { bars, ind: computeAll(bars), name: info.name }); });
  for (const t of trades) {
    const pd = priceMap.get(t.code); if (!pd) continue;
    t.name = pd.name;
    const { bars, ind } = pd;
    const ei = bars.findIndex((b) => b.date >= t.entryDate), xi = bars.findIndex((b) => b.date >= t.exitDate);
    if (ei > 5) {
      t.runUp5 = r2((bars[ei].c / bars[ei - 5].c - 1) * 100);
      t.distMa20 = ind.ma20[ei] ? r2((t.entry / ind.ma20[ei] - 1) * 100) : null;
      t.rsiAtEntry = r2(ind.rsi[ei]);
    }
    if (xi > 0 && xi < bars.length - 1) {
      const fwd = bars.slice(xi + 1, xi + 21);
      if (fwd.length) {
        const best = t.side === 1 ? Math.max(...fwd.map((b) => b.h)) : Math.min(...fwd.map((b) => b.l));
        t.after20 = r2((t.side * (best / bars[xi].c - 1)) * 100); // 出場後 20 日內最大順向幅度（以出場日實際收盤為基準）
      }
    }
  }

  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const avg = (a, f) => (a.length ? sum(a, f) / a.length : 0);
  const stats = {
    n: trades.length, winRate: r2((wins.length / trades.length) * 100), totalPnl: sum(trades, (t) => t.pnl),
    avgWinPct: r2(avg(wins, (t) => t.retPct)), avgLossPct: r2(avg(losses, (t) => t.retPct)),
    payoff: losses.length && wins.length ? r2(avg(wins, (t) => t.pnl) / Math.abs(avg(losses, (t) => t.pnl))) : null,
    profitFactor: losses.length ? r2(sum(wins, (t) => t.pnl) / Math.abs(sum(losses, (t) => t.pnl))) : null,
    holdWin: r2(avg(wins, (t) => t.hold)), holdLoss: r2(avg(losses, (t) => t.hold)),
    largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : 0, largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : 0,
  };
  stats.expectancyPct = r2((stats.winRate / 100) * stats.avgWinPct + (1 - stats.winRate / 100) * stats.avgLossPct);

  const mistakes = [], biases = [], missed = [];
  // 1. 處分效應：賠錢單抱得比賺錢單久
  if (losses.length >= 2 && wins.length >= 2 && stats.holdLoss > stats.holdWin * 1.3)
    biases.push({ name: '處分效應（賺小賠大）', evidence: `虧損單平均持有 ${stats.holdLoss} 天，獲利單僅 ${stats.holdWin} 天`, severity: 3 });
  if (stats.payoff != null && stats.payoff < 1 && stats.winRate > 45)
    mistakes.push({ name: '賺賠比失衡', evidence: `平均獲利 ${stats.avgWinPct}% vs 平均虧損 ${stats.avgLossPct}%，賺賠比 ${stats.payoff}`, severity: 3 });
  // 2. 停損紀律
  const brokeStop = trades.filter((t) => t.stop && t.side * (t.exit - t.stop) < -0.01 * t.stop);
  if (brokeStop.length) mistakes.push({ name: '未執行停損', evidence: `${brokeStop.length} 筆出場價明顯低於預設停損（#${brokeStop.map((t) => t.no).join('、#')}），額外損失 ${Math.round(sum(brokeStop, (t) => Math.abs(t.exit - t.stop) * t.qty)).toLocaleString()} 元`, severity: 3 });
  const noStop = trades.filter((t) => !t.stop);
  if (noStop.length > trades.length / 2) mistakes.push({ name: '進場前未設停損', evidence: `${noStop.length}/${trades.length} 筆交易沒有紀錄停損價`, severity: 2 });
  const bigLoss = losses.filter((t) => t.retPct < -8);
  if (bigLoss.length) mistakes.push({ name: '單筆虧損過大', evidence: `${bigLoss.length} 筆虧損超過 8%（#${bigLoss.map((t) => t.no).join('、#')}）`, severity: 3 });
  // 3. 追高
  const chase = trades.filter((t) => t.side === 1 && ((t.runUp5 ?? 0) > 8 || (t.distMa20 ?? 0) > 10 || (t.rsiAtEntry ?? 0) > 75));
  if (chase.length >= 2) {
    const cw = chase.filter((t) => t.pnl > 0).length;
    mistakes.push({ name: '追高進場', evidence: `${chase.length} 筆在短線大漲後買進（5 日漲幅>8%、乖離月線>10% 或 RSI>75），勝率 ${r2((cw / chase.length) * 100)}%`, severity: cw / chase.length < stats.winRate / 100 ? 3 : 1 });
  }
  // 4. 報復性交易：虧損後 2 日內再進場且部位放大
  const revenge = [];
  for (let k = 1; k < trades.length; k++) {
    const prev = trades.filter((p) => p.exitDate <= trades[k].entryDate && p.pnl < 0).pop();
    if (prev && days(prev.exitDate, trades[k].entryDate) <= 2 && trades[k].size > prev.size * 1.2) revenge.push(trades[k]);
  }
  if (revenge.length) biases.push({ name: '報復性交易', evidence: `${revenge.length} 筆在虧損後 2 天內放大部位再進場（#${revenge.map((t) => t.no).join('、#')}），結果 ${sum(revenge, (t) => t.pnl).toLocaleString()} 元`, severity: 3 });
  // 5. 過度自信：連勝後部位放大
  const over = [];
  for (let k = 2; k < trades.length; k++) if (trades[k - 1].pnl > 0 && trades[k - 2].pnl > 0 && trades[k].size > avg(trades, (t) => t.size) * 1.5) over.push(trades[k]);
  if (over.length) biases.push({ name: '過度自信', evidence: `連勝後部位放大至平均 1.5 倍以上：#${over.map((t) => t.no).join('、#')}，結果 ${sum(over, (t) => t.pnl).toLocaleString()} 元`, severity: 2 });
  // 6. 部位大小不一致
  const sizes = trades.map((t) => t.size), ms = avg(trades, (t) => t.size);
  const cv = Math.sqrt(avg(sizes, (s) => (s - ms) ** 2)) / ms;
  if (cv > 0.6) mistakes.push({ name: '部位大小不一致', evidence: `部位金額變異係數 ${r2(cv)}（最小 ${Math.round(Math.min(...sizes)).toLocaleString()}、最大 ${Math.round(Math.max(...sizes)).toLocaleString()} 元）`, severity: 2 });
  // 7. 重複在同一檔虧損
  const byCode = {};
  losses.forEach((t) => (byCode[t.code] = (byCode[t.code] || 0) + 1));
  Object.entries(byCode).filter(([, c]) => c >= 3).forEach(([c, k]) => biases.push({ name: '執著特定個股', evidence: `${c} 虧損 ${k} 次仍反覆進場`, severity: 2 }));
  // 錯失機會
  const early = wins.filter((t) => (t.after20 ?? 0) > Math.max(8, t.retPct));
  if (early.length) missed.push({ name: '獲利單過早出場', evidence: `${early.length} 筆出場後 20 日內再順向走 ${early.map((t) => `#${t.no} +${t.after20}%`).join('、')}`, value: early });
  const whipsaw = losses.filter((t) => (t.after20 ?? 0) > 10);
  if (whipsaw.length) missed.push({ name: '停損後行情反轉（停損太緊或進場點太差）', evidence: whipsaw.map((t) => `#${t.no} ${t.code} 出場後最高再走 +${t.after20}%`).join('、'), value: whipsaw });

  // 依嚴重度產生 3 條個人化規則
  const ruleBook = {
    '處分效應（賺小賠大）': `虧損單持有不得超過獲利單平均持有天數（${stats.holdWin || 5} 天）；觸及停損立即出場，不加碼攤平。`,
    '賺賠比失衡': '只做預期風險報酬比 ≥ 2:1 的交易；獲利達 1R 後將停損移至成本，剩餘部位以移動停損出場。',
    '未執行停損': '進場同時下好停損單（觸價單），盤中不得手動取消或下移停損。',
    '進場前未設停損': '下單前必須寫下：進場理由、停損價、目標價；沒有停損價的交易不准下單。',
    '單筆虧損過大': '單筆最大虧損 = 總資金 1%；股數 = (資金×1%) ÷ (進場價 − 停損價)。',
    '追高進場': `不買 5 日漲幅 > 8% 或乖離月線 > 10% 的股票；強勢股等回測 5 日線或月線再進場。`,
    '報復性交易': '單日虧損達資金 2% 或連續 2 筆停損，當天停止交易；隔天部位減半。',
    '過度自信': '部位大小只依公式計算，不因連勝放大；連勝 3 次後強制檢查是否違反任何規則。',
    '部位大小不一致': '固定風險部位法：每筆交易風險固定為資金 1%，不憑感覺決定張數。',
    '執著特定個股': '同一檔股票連續停損 2 次，冷卻 10 個交易日不得再交易。',
    '獲利單過早出場': '獲利單分兩批出場：一半在目標價，另一半以 10 日均線或 ATR×2 移動停損抱住趨勢。',
  };
  const ranked = [...mistakes, ...biases].sort((a, b) => b.severity - a.severity);
  if (missed.find((m) => m.name === '獲利單過早出場')) ranked.splice(1, 0, { name: '獲利單過早出場', severity: 2 });
  const rules = [];
  for (const r of ranked) if (ruleBook[r.name] && !rules.find((x) => x.from === r.name)) rules.push({ rule: ruleBook[r.name], from: r.name });
  const defaults = [
    { rule: '每筆交易風險固定為總資金 1%，並於進場時同步設定停損單。', from: '基本風控' },
    { rule: '只在符合書面進場條件（趨勢 + 訊號 + 風報比 ≥ 2）時下單，每週檢討交易日誌。', from: '交易一致性' },
    { rule: '每日交易前填寫計畫，盤中不臨時追單；收盤後記錄情緒與執行分數。', from: '紀律養成' },
  ];
  for (const d of defaults) if (rules.length < 3) rules.push(d);

  const result = { stats, trades, mistakes, biases, missed, rules: rules.slice(0, 3) };
  if (withAI) {
    result.ai = await aiAnalyze('請檢視以下最近交易紀錄與系統偵測結果，找出反覆出現的錯誤、錯失的機會與行為偏誤（處分效應、過度自信、報復性交易、確認偏誤等），並提供 3 條具體、可量化、可立即執行的個人化交易規則。', result);
  }
  return result;
}
