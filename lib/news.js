// 模組 3：新聞轉交易策略
import { resolveSymbol, getCandles, getNews, stocksInIndustry } from './data.js';
import { computeAll, roundTick } from './indicators.js';
import { aiAnalyze } from './ai.js';

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(2));

const BULL = ['創新高', '成長', '大增', '上修', '調升', '看好', '利多', '擴產', '接單', '訂單', '漲停', '買超', '加碼', '突破', '強勁', '優於預期', '樂觀', '轉盈', '獲利', '新高', '回升', '受惠', '爆發', '合作', '併購', '目標價上調', '升評', '需求暢旺', '供不應求', '漲價', '配息', '庫藏股'];
const BEAR = ['衰退', '下修', '調降', '看淡', '利空', '跌停', '賣超', '減碼', '虧損', '低於預期', '保守', '下滑', '砍單', '庫存', '降評', '目標價下調', '裁員', '罰', '訴訟', '關稅', '制裁', '禁令', '跌破', '重挫', '疲弱', '延後', '停工', '火災', '地震', '降價', '競爭加劇', '違約'];
const THEMES = [
  { name: '營收/財報', kw: ['營收', '財報', 'EPS', '毛利率', '獲利', '季報', '月報'], horizon: '短期', note: '財報與月營收通常在公布後 1–5 個交易日內反映，留意與市場預期的落差' },
  { name: '法說/展望', kw: ['法說', '展望', '指引', '財測', '資本支出', '股東會'], horizon: '短中期', note: '法說會展望會重設市場預期，影響可延續數週' },
  { name: '訂單/產能', kw: ['訂單', '接單', '擴產', '產能', '新廠', '量產', '出貨', '供應鏈'], horizon: '中長期', note: '產能與訂單影響未來 2–4 季營收，屬基本面趨勢因子' },
  { name: '法人/籌碼', kw: ['外資', '投信', '自營商', '買超', '賣超', '融資', '融券', '目標價', '評等'], horizon: '短期', note: '籌碼面消息多為短期資金流動，注意是否連續性' },
  { name: '產業/技術', kw: ['AI', '伺服器', '先進製程', '封裝', 'CoWoS', '2奈米', '3奈米', 'HBM', '電動車', '低軌衛星', '機器人', '矽光子'], horizon: '長期', note: '產業結構性題材決定評價區間，長線影響大於短線' },
  { name: '總經/政策', kw: ['關稅', '升息', '降息', '聯準會', 'Fed', '匯率', '台幣', '政策', '補助', '出口管制', '制裁', '選舉'], horizon: '中長期', note: '政策與總經變化影響整體評價與資金面，屬系統性風險' },
  { name: '公司治理/事件', kw: ['訴訟', '罰', '火災', '地震', '停工', '併購', '庫藏股', '增資', '減資', '董事'], horizon: '短期', note: '突發事件多造成短線跳空，需評估是否影響長期獲利能力' },
];

function scoreHeadline(t) {
  let s = 0; const hits = [];
  for (const k of BULL) if (t.includes(k)) { s += 1; hits.push(`+${k}`); }
  for (const k of BEAR) if (t.includes(k)) { s -= 1; hits.push(`-${k}`); }
  return { s, hits };
}

export async function newsStrategy(input, { withAI = true, capital = 1_000_000 } = {}) {
  const q = String(input || '').trim();
  if (!q) throw new Error('請輸入公司或產業');
  // 決定價格參考標的
  let ref = null, refLabel = q;
  try { ref = await resolveSymbol(q); } catch {
    const inds = await stocksInIndustry(q.replace(/業$/, ''), 1);
    if (inds[0]) { ref = { symbol: `${inds[0].code}.${inds[0].market === 'TWO' ? 'TWO' : 'TW'}`, ...inds[0] }; refLabel = `${q}（以龍頭 ${inds[0].name} 估算波動）`; }
    else { ref = await resolveSymbol('加權指數'); refLabel = `${q}（以加權指數估算波動）`; }
  }
  const searchTerm = ref?.name && ref.market !== 'INDEX' && ref.market !== 'OTHER' && ref.name !== q ? `${q} OR ${ref.name}` : q;
  const news = await getNews(searchTerm, 25);
  const scored = news.map((n) => {
    const { s, hits } = scoreHeadline(n.title);
    const themes = THEMES.filter((t) => t.kw.some((k) => n.title.includes(k))).map((t) => t.name);
    return { ...n, sentiment: s, hits, themes };
  });

  // 時間加權情緒（越新權重越高）
  const now = Date.now();
  let wSum = 0, sSum = 0;
  for (const n of scored) { const ageD = (now - new Date(n.date).getTime()) / 864e5; const w = Math.exp(-ageD / 7); wSum += w; sSum += w * Math.sign(n.sentiment); }
  const sentiment = wSum ? sSum / wSum : 0; // -1 ~ 1
  const themeCount = {};
  for (const n of scored) for (const t of n.themes) themeCount[t] = (themeCount[t] || 0) + 1;
  const themes = THEMES.filter((t) => themeCount[t.name]).map((t) => ({ ...t, count: themeCount[t.name], kw: undefined })).sort((a, b) => b.count - a.count);

  // 預期波動區間：以近 60 日報酬波動度估計 1σ 區間，並以情緒偏移中心
  const { bars } = await getCandles(ref.symbol, '1y', '1d');
  const ind = computeAll(bars);
  const i = bars.length - 1, p = bars[i].c;
  const rets = bars.slice(-61).map((b, k, a) => (k ? Math.log(b.c / a[k - 1].c) : null)).filter((x) => x != null);
  const sd = Math.sqrt(rets.reduce((s, x) => s + x * x, 0) / rets.length);
  const drift = sentiment * 0.25 * sd; // 每日偏移
  const band = (days) => ({ days, low: roundTick(p * Math.exp(drift * days - sd * Math.sqrt(days))), high: roundTick(p * Math.exp(drift * days + sd * Math.sqrt(days))), mid: roundTick(p * Math.exp(drift * days)) });

  const shortScore = scored.filter((n) => (now - new Date(n.date).getTime()) / 864e5 <= 7).reduce((s, n) => s + Math.sign(n.sentiment), 0);
  const longThemes = themes.filter((t) => t.horizon.includes('長'));
  const tone = sentiment > 0.25 ? '偏多' : sentiment < -0.25 ? '偏空' : '中性';
  // 部位配置：每筆風險 1% 資本；停損 = 2 ATR；情緒中性或與趨勢矛盾時減半
  const a = ind.atr[i];
  const trendUp = ind.ma20[i] > ind.ma60[i];
  const conflict = (sentiment > 0.25 && !trendUp) || (sentiment < -0.25 && trendUp);
  const riskPct = tone === '中性' || conflict ? 0.5 : 1;
  const stopDist = 2 * a;
  const shares = Math.floor((capital * riskPct / 100) / stopDist);
  const lots = Math.floor(shares / 1000);
  const position = {
    capital, riskPct, stopDistance: r2(stopDist), shares, lots, oddShares: shares % 1000,
    positionValue: Math.round(shares * p), positionPct: r2((shares * p / capital) * 100),
    action: tone === '偏多' ? (trendUp ? '順勢做多：消息面與技術面同向，可分 2–3 批建立部位' : '消息偏多但技術面尚未轉強：先建立 1/3 試單，站上月線再加碼')
      : tone === '偏空' ? (trendUp ? '消息偏空但趨勢仍多：持股設好移動停損，暫不追價' : '消息面與技術面同步偏空：減碼或避開，等待利空出盡訊號（爆量長下影線）')
      : '消息面中性：維持原部位，依技術面支撐壓力操作',
    note: conflict ? '消息與技術趨勢矛盾，風險預算減半' : '消息與技術趨勢一致或中性',
  };

  const result = {
    query: q, reference: refLabel, symbol: ref.symbol, price: r2(p), asOf: new Date().toISOString(),
    sentiment: r2(sentiment), tone, shortTermScore: shortScore, news: scored, themes,
    impact: {
      short: `近 7 日新聞情緒分數 ${shortScore >= 0 ? '+' : ''}${shortScore}（${scored.length} 則中正面 ${scored.filter((n) => n.sentiment > 0).length}、負面 ${scored.filter((n) => n.sentiment < 0).length}）。${themes.filter((t) => t.horizon.includes('短')).map((t) => `${t.name}：${t.note}`).join('；') || '短期無明顯催化事件'}`,
      long: longThemes.length ? longThemes.map((t) => `${t.name}（${t.count} 則）：${t.note}`).join('；') : '近期新聞以短期消息為主，未見明顯長期結構性題材',
    },
    ranges: [band(5), band(20), band(60)],
    volatility: { dailyPct: r2(sd * 100), annualPct: r2(sd * Math.sqrt(250) * 100), atr: r2(a) },
    position,
  };
  if (withAI) {
    result.ai = await aiAnalyze(`請整理「${q}」的最近新聞（標題、來源、日期如下），並轉化為交易影響：1) 重點新聞摘要與分類 2) 短期（1–4 週）影響 3) 長期（3–12 個月）影響 4) 預期價格波動區間（參考系統以波動度計算的區間並說明是否需調整）5) 建議部位配置與分批策略 6) 需要追蹤的後續事件。`, { ...result, news: scored.map(({ title, source, date }) => ({ title, source, date })) });
  }
  return result;
}
