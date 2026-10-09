// ---------- 共用工具 ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (x, d = 2) => (x == null || !Number.isFinite(+x) ? '—' : (+x).toLocaleString('zh-TW', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const pct = (x, d = 2) => (x == null ? '—' : `${x > 0 ? '+' : ''}${num(x, d)}%`);
const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : ''); // 台股慣例：紅漲綠跌
const md = (t) => DOMPurify.sanitize(marked.parse(t || ''));
const kpi = (l, v, s = '', c = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${c}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// 直接以檔案開啟 index.html 時，改連本機伺服器
const API_BASE = location.protocol === 'file:' ? 'http://localhost:3000' : '';
const OFFLINE_MSG = '無法連線到分析伺服器。請先在專案資料夾執行 npm start，並以瀏覽器開啟 http://localhost:3000（不要直接雙擊 index.html）。';

async function request(path, init) {
  let r;
  try { r = await fetch(`${API_BASE}/api/${path}`, init); } catch { throw new Error(OFFLINE_MSG); }
  let j;
  try { j = await r.json(); } catch { throw new Error(`伺服器回應格式錯誤（HTTP ${r.status}）`); }
  return j;
}

async function api(path, body) {
  const j = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ai: $('#aiToggle').checked }) });
  if (!j.ok) throw new Error(j.error);
  return j;
}

function aiBlock(ai) {
  if (!ai) return '';
  if (ai.error) return `<div class="card"><div class="muted small">AI 解讀未完成：${esc(ai.error)}</div></div>`;
  return `<div class="card ai"><h2>Claude AI 深度解讀</h2><div class="md">${md(ai.text)}</div></div>`;
}

// ---------- 導覽 ----------
$$('#menu a').forEach((a) => a.addEventListener('click', () => {
  $$('#menu a').forEach((x) => x.classList.toggle('active', x === a));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${a.dataset.tab}`));
  try { localStorage.setItem('tab', a.dataset.tab); } catch {}
  a.scrollIntoView({ block: 'nearest', inline: 'center' }); // 手機版：選中的模組捲到選單中間
}));
try { const t = localStorage.getItem('tab'); if (t) $(`#menu a[data-tab="${t}"]`)?.click(); } catch {}

// ---------- 啟動資料 ----------
let STRATS = [];
function loadMeta() { return request('meta').then((m) => {
  $('#aiStatus').innerHTML = m.ai ? '✓ 已連接 Claude API' : '未設定 ANTHROPIC_API_KEY，僅顯示量化分析';
  // 確認伺服器有 Claude 金鑰後才開放 AI 開關
  $('#aiToggle').disabled = !m.ai;
  $('#aiToggle').checked = m.ai;
  $('#industryList').innerHTML = m.industries.map((i) => `<option value="${esc(i.name)}">`).join('');
  $('#industryChips').innerHTML = ['加權指數', '櫃買', ...m.industries.slice(0, 14).map((i) => i.name)].map((n) => `<span class="chip">${esc(n)}</span>`).join('');
  $$('#industryChips .chip').forEach((c) => c.addEventListener('click', () => { $('#tab-ideas input[name=target]').value = c.textContent; $('#tab-ideas form').requestSubmit(); }));
  STRATS = m.strategies;
  $('#stratSelect').innerHTML = STRATS.map((s) => `<option value="${s.key}">${esc(s.name)}</option>`).join('');
  renderParams();
}).catch((e) => {
  $('#aiStatus').innerHTML = `<span class="up">${esc(e.message)}</span>`;
  setTimeout(loadMeta, 5000); // 伺服器啟動後自動重試
}); }
loadMeta();
function renderParams() {
  const s = STRATS.find((x) => x.key === $('#stratSelect').value);
  $('#paramBox').innerHTML = s ? Object.entries(s.params).map(([k, v]) => `<label>${k}<input class="xs" type="number" data-param="${k}" value="${v}"></label>`).join('') : '';
}
$('#stratSelect').addEventListener('change', renderParams);

// ---------- 表單送出 ----------
const RENDER = {};
$$('form[data-api]').forEach((f) => f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = f.dataset.api;
  const out = $('.out', f.closest('section'));
  const body = Object.fromEntries(new FormData(f));
  if (key === 'backtest') {
    body.params = Object.fromEntries($$('[data-param]', f).map((i) => [i.dataset.param, Number(i.value)]));
    body.options = { stopLoss: Number(body.stopLoss) || 0, takeProfit: Number(body.takeProfit) || 0, atrTrail: Number(body.atrTrail) || 0, trendFilter: !!body.trendFilter, volFilter: !!body.volFilter, adxFilter: !!body.adxFilter };
  }
  const btn = $('button:not([type=button])', f); btn.disabled = true;
  out.innerHTML = `<div class="loading"><div class="spinner"></div>${$('#aiToggle').checked ? '分析中（含 Claude AI 解讀，約需 30–90 秒）…' : '分析中…'}</div>`;
  try {
    const { data, ms } = await api(key, body);
    out.innerHTML = RENDER[key](data) + `<div class="muted small">完成時間 ${(ms / 1000).toFixed(1)} 秒・資料日期以各表為準</div>`;
    RENDER[key].after?.(data, out);
  } catch (err) {
    out.innerHTML = `<div class="err">${esc(err.message)}</div>`;
  } finally { btn.disabled = false; }
}));

// ---------- 圖表 ----------
function candleChart(el, bars, overlays = [], lines = []) {
  const chart = LightweightCharts.createChart(el, {
    autoSize: true, layout: { background: { color: 'transparent' }, textColor: css('--muted') },
    grid: { vertLines: { color: '#1b2336' }, horzLines: { color: '#1b2336' } }, rightPriceScale: { borderColor: '#243049' }, timeScale: { borderColor: '#243049' },
  });
  const cs = chart.addCandlestickSeries({ upColor: css('--up'), downColor: css('--down'), borderUpColor: css('--up'), borderDownColor: css('--down'), wickUpColor: css('--up'), wickDownColor: css('--down') });
  cs.setData(bars.map((b) => ({ time: b.date, open: b.o, high: b.h, low: b.l, close: b.c })));
  const colors = ['#f0b429', '#60a5fa', '#c084fc'];
  overlays.forEach((o, k) => {
    const s = chart.addLineSeries({ color: colors[k % 3], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: o.name });
    s.setData(bars.filter((b) => b[o.key] != null).map((b) => ({ time: b.date, value: b[o.key] })));
  });
  lines.forEach((l) => cs.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: l.title }));
  chart.timeScale().fitContent();
  return chart;
}
function lineChart(el, seriesList) {
  const chart = LightweightCharts.createChart(el, { autoSize: true, layout: { background: { color: 'transparent' }, textColor: css('--muted') }, grid: { vertLines: { color: '#1b2336' }, horzLines: { color: '#1b2336' } } });
  seriesList.forEach((s) => { const ls = chart.addLineSeries({ color: s.color, lineWidth: 2, title: s.name }); ls.setData(s.data); });
  chart.timeScale().fitContent();
}

// ---------- 1. 交易點子 ----------
RENDER.ideas = (d) => `
  <div class="kpis">${kpi('掃描範圍', esc(d.universe))}${kpi('掃描檔數', d.scanned)}${kpi('觸發型態數', d.triggered)}${kpi('入選機會', d.ideas.length)}</div>
  ${d.ideas.length ? '' : '<div class="card muted">今日掃描範圍內沒有符合條件的型態。可改選其他產業，或等待市場出現更明確的訊號（不交易也是一種部位）。</div>'}
  ${d.ideas.map((x) => `
    <div class="card idea ${x.side === '做多' ? '' : 'short'}">
      <div class="head"><div><span class="muted mono">#${x.no}</span> <b>${esc(x.name)} ${esc(x.code)}</b> <span class="muted">${esc(x.industry || '')}</span></div>
        <div><span class="badge ${x.side === '做多' ? 'b-buy' : 'b-sell'}">${x.side}</span> <span class="badge b-hold-bull">${esc(x.setup)}</span></div></div>
      <div class="levels">
        <div><div class="l">進場區間</div><div class="v">${x.entry}</div></div>
        <div><div class="l">出場目標</div><div class="v up">${num(x.target)}</div></div>
        <div><div class="l">停損點</div><div class="v down">${num(x.stop)}</div></div>
        <div><div class="l">風險報酬比</div><div class="v">1 : ${num(x.rr)}</div></div>
        <div><div class="l">歷史同型態勝率</div><div class="v">${x.histWinRate != null ? `${x.histWinRate}%` : '—'}</div><div class="l">${x.histTrades} 次・期望值 ${num(x.histExpR)}R</div></div>
      </div>
      <div class="grid g3">
        <div><h3>技術面</h3><ul class="reasons">${x.reasons.technical.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
        <div><h3>基本面</h3><ul class="reasons">${x.reasons.fundamental.map((t) => `<li>${esc(t)}</li>`).join('') || '<li class="muted">無資料</li>'}</ul></div>
        <div><h3>風險提示</h3><ul class="reasons">${x.reasons.risk.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
      </div>
      <div class="muted small">現價 ${num(x.price)}・訊號日 ${x.triggeredOn}・技術總分 ${x.techScore}</div>
    </div>`).join('')}
  ${aiBlock(d.ai)}
  <div class="card muted small">勝率為該股過去 2 年出現相同型態後，以相同停損/目標（ATR 倍數）在 20 個交易日內的結果統計，不代表未來績效。</div>`;

// ---------- 2. 技術分析 ----------
const factorList = (fs) => fs.map((f) => `<div class="factor"><span class="cat">${f.cat}</span><span class="sc ${cls(f.score)}">${f.score > 0 ? '+' : ''}${f.score}</span><span>${esc(f.text)}</span></div>`).join('');
const tlText = (t) => (t ? `${t.direction}趨勢線：${t.from.date} ${num(t.from.price)} → ${t.to.date} ${num(t.to.price)}，今日約 ${num(t.valueToday)}` : '資料不足');
RENDER.technical = (d) => `
  <div class="card"><div class="head" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px">
    <h2>${esc(d.info.name)} <span class="muted mono">${esc(d.info.symbol)}</span> <span class="badge b-${d.tone}">${d.signal}</span></h2>
    <div class="mono">收盤 <b class="${cls(d.daily.change)}">${num(d.daily.close)}</b> <span class="${cls(d.daily.change)}">${pct(d.daily.change)}</span> <span class="muted">${d.daily.date}</span></div></div>
    <div class="kpis">${kpi('綜合評分', num(d.total), '日線 + 週線×1.5', cls(d.total))}${kpi('建議進場', num(d.plan.entry))}${kpi('停損', num(d.plan.stop), '', 'down')}${kpi('目標', num(d.plan.target), '', 'up')}${kpi('風險報酬比', `1:${num(d.plan.rr)}`)}${kpi('本益比 / 殖利率', `${d.info.pe ?? '—'} / ${d.info.yield ?? '—'}%`, d.info.industry || '')}</div>
    <div class="chart" id="techChart"></div>
  </div>
  <div class="card"><h2>逐步交易訊號</h2><ol class="steps">${d.steps.map((s) => `<li><b>${esc(s.title)}</b><div class="muted">${esc(s.detail)}</div></li>`).join('')}</ol></div>
  <div class="grid g2">
    ${[d.daily, d.weekly].map((s) => `<div class="card"><h2>${s.label} <span class="badge ${s.score >= 0 ? 'b-buy' : 'b-sell'}">評分 ${s.score}</span></h2>
      ${factorList(s.factors)}
      <h3>支撐 / 壓力</h3>
      <table><tr><th>支撐</th><th class="n">價位</th><th class="n">觸及</th></tr>${s.supports.map((x) => `<tr><td>波段支撐</td><td class="n down">${num(x.price)}</td><td class="n">${x.touches}</td></tr>`).join('')}
      <tr><th>壓力</th><th></th><th></th></tr>${s.resistances.map((x) => `<tr><td>波段壓力</td><td class="n up">${num(x.price)}</td><td class="n">${x.touches}</td></tr>`).join('') || '<tr><td colspan=3 class="muted">上方無歷史壓力（創高區）</td></tr>'}</table>
      <h3>均線</h3><div class="small">${s.maLevels.map((m) => `${m.name} <span class="mono">${num(m.price)}</span>（${m.position}）`).join('・')}</div>
      <h3>趨勢線</h3><div class="small">${tlText(s.trendlines.support)}<br>${tlText(s.trendlines.resistance)}</div>
      <h3>動能</h3><div class="small mono">RSI ${num(s.indicators.rsi)}・K ${num(s.indicators.k)} D ${num(s.indicators.d)}・MACD柱 ${num(s.indicators.macdHist)}・ADX ${num(s.indicators.adx)}・ATR ${num(s.indicators.atr)}</div>
    </div>`).join('')}
  </div>
  ${aiBlock(d.ai)}`;
RENDER.technical.after = (d) => candleChart($('#techChart'), d.chart, [{ key: 'ma20', name: 'MA20' }, { key: 'ma60', name: 'MA60' }, { key: 'ma120', name: 'MA120' }], [
  ...d.daily.supports.slice(0, 2).map((s) => ({ price: s.price, color: css('--down'), title: '支撐' })),
  ...d.daily.resistances.slice(0, 2).map((s) => ({ price: s.price, color: css('--up'), title: '壓力' })),
  { price: d.plan.stop, color: '#8a96b0', title: '停損' },
]);

// ---------- 3. 新聞 ----------
RENDER.news = (d) => `
  <div class="kpis">${kpi('新聞情緒', d.tone, `加權分數 ${num(d.sentiment)}`, d.sentiment > 0.25 ? 'up' : d.sentiment < -0.25 ? 'down' : '')}${kpi('近 7 日淨分', d.shortTermScore, '', cls(d.shortTermScore))}${kpi('參考價', num(d.price), esc(d.reference))}${kpi('日波動', `${d.volatility.dailyPct}%`, `年化 ${d.volatility.annualPct}%`)}${kpi('新聞數', d.news.length, '近 30 天')}</div>
  <div class="grid g2">
    <div class="card"><h2>短期影響（1–4 週）</h2><p>${esc(d.impact.short)}</p><h2 style="margin-top:14px">長期影響（3–12 個月）</h2><p>${esc(d.impact.long)}</p>
      <h3>主題分布</h3><div class="chips">${d.themes.map((t) => `<span class="chip">${esc(t.name)}・${t.count}・${t.horizon}</span>`).join('') || '<span class="muted">無</span>'}</div></div>
    <div class="card"><h2>預期價格波動區間（1σ，約 68% 機率）</h2>
      <table><tr><th>期間</th><th class="n">下緣</th><th class="n">中心</th><th class="n">上緣</th></tr>${d.ranges.map((r) => `<tr><td>${r.days} 個交易日</td><td class="n down">${num(r.low)}</td><td class="n">${num(r.mid)}</td><td class="n up">${num(r.high)}</td></tr>`).join('')}</table>
      <h2 style="margin-top:14px">建議部位配置</h2>
      <p><b>${esc(d.position.action)}</b></p>
      <div class="small muted">資金 ${num(d.position.capital, 0)} 元・單筆風險 ${d.position.riskPct}%・停損距離 2×ATR = ${num(d.position.stopDistance)}<br>
      建議股數 <b class="mono">${num(d.position.shares, 0)}</b>（${d.position.lots} 張 + ${d.position.oddShares} 股零股），部位約 ${num(d.position.positionValue, 0)} 元（${d.position.positionPct}%）・${esc(d.position.note)}</div></div>
  </div>
  <div class="card"><h2>近期新聞</h2><div class="tbl-wrap"><table><tr><th>日期</th><th>標題</th><th>來源</th><th>主題</th><th class="n">情緒</th></tr>
    ${d.news.map((n) => `<tr><td class="mono small">${n.date.slice(0, 10)}</td><td><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a></td><td class="small muted">${esc(n.source)}</td><td class="small">${esc(n.themes.join('、'))}</td><td class="n ${cls(n.sentiment)}">${n.sentiment > 0 ? '+' : ''}${n.sentiment}</td></tr>`).join('')}</table></div></div>
  ${aiBlock(d.ai)}`;

// ---------- 4. 回測 ----------
const mRow = (label, m) => `<tr><td>${esc(label)}</td><td class="n">${m.trades}</td><td class="n">${num(m.winRate)}%</td><td class="n">${num(m.profitFactor)}</td><td class="n ${cls(m.totalReturn)}">${pct(m.totalReturn)}</td><td class="n down">${num(m.maxDrawdown)}%</td><td class="n">${num(m.sharpe)}</td></tr>`;
RENDER.backtest = (d) => {
  const m = d.metrics;
  return `
  <div class="card"><h2>${esc(d.info.name)} ・ ${esc(d.strategy.name)}</h2><div class="muted">${esc(d.strategy.desc)}・${d.period.from} ～ ${d.period.to}</div></div>
  <div class="kpis">${kpi('勝率', `${num(m.winRate)}%`, `${m.trades} 筆交易`)}${kpi('獲利因子', num(m.profitFactor), '毛利 ÷ 毛損', m.profitFactor >= 1.5 ? 'up' : m.profitFactor < 1 ? 'down' : '')}${kpi('最大回撤', `${num(m.maxDrawdown)}%`, `買進持有 ${num(m.buyHoldMdd)}%`, 'down')}${kpi('總報酬', pct(m.totalReturn), `買進持有 ${pct(m.buyHold)}`, cls(m.totalReturn))}${kpi('年化報酬', pct(m.cagr), '', cls(m.cagr))}${kpi('夏普值', num(m.sharpe))}${kpi('賺賠比', num(m.payoff), `均賺 ${num(m.avgWin)}% / 均賠 ${num(m.avgLoss)}%`)}${kpi('期望值', pct(m.expectancy), '每筆平均')}${kpi('曝險時間', `${num(m.exposure)}%`, `平均持有 ${num(m.avgDays, 0)} 天`)}${kpi('最大連虧', m.maxConsecLoss, '筆')}</div>
  <div class="card"><h2>權益曲線 <span class="small muted">金：策略／藍：買進持有</span></h2><div class="chart sm" id="eqChart"></div></div>
  <div class="grid g2">
    <div class="card"><h2>分析重點</h2><ul class="reasons">${d.insights.map((t) => `<li>${esc(t)}</li>`).join('') || '<li class="muted">無特別警示</li>'}</ul>
      <h3>樣本內外檢驗（切點 ${d.walkForward.splitDate}）</h3>
      <table><tr><th></th><th class="n">筆</th><th class="n">勝率</th><th class="n">PF</th><th class="n">報酬</th><th class="n">MDD</th><th class="n">夏普</th></tr>${mRow('樣本內 70%', d.walkForward.inSample)}${mRow('樣本外 30%', d.walkForward.outOfSample)}</table>
      <p class="small muted">${esc(d.assumptions)}</p></div>
    <div class="card"><h2>改進方向（自動測試）</h2><div class="tbl-wrap"><table><tr><th>變體</th><th class="n">筆</th><th class="n">勝率</th><th class="n">PF</th><th class="n">報酬</th><th class="n">MDD</th><th class="n">夏普</th></tr>
      ${mRow('▶ 原始策略', m)}${d.variants.map((v) => mRow(`${v.delta > 0 ? '▲' : '▽'} ${v.label}`, v.metrics)).join('')}</table></div></div>
  </div>
  <div class="card"><h2>交易明細（最近 30 筆）</h2><div class="tbl-wrap"><table><tr><th>進場日</th><th class="n">進場價</th><th>出場日</th><th class="n">出場價</th><th class="n">報酬</th><th class="n">天數</th><th>出場原因</th></tr>
    ${d.trades.slice(-30).reverse().map((t) => `<tr><td class="mono">${t.entryDate}</td><td class="n">${num(t.entryPrice)}</td><td class="mono">${t.exitDate}</td><td class="n">${num(t.exitPrice)}</td><td class="n ${cls(t.ret)}">${pct(t.ret)}</td><td class="n">${t.days}</td><td class="small">${esc(t.reason)}</td></tr>`).join('')}</table></div></div>
  ${aiBlock(d.ai)}`;
};
RENDER.backtest.after = (d) => lineChart($('#eqChart'), [
  { name: '策略', color: '#f0b429', data: d.equity.map((e) => ({ time: e.date, value: +(e.eq * 100).toFixed(2) })) },
  { name: '買進持有', color: '#60a5fa', data: d.benchmark.map((e) => ({ time: e.date, value: +(e.eq * 100).toFixed(2) })) },
]);

// ---------- 5. 投資組合 ----------
const heat = (v) => { const a = Math.min(1, Math.abs(v)); return v >= 0 ? `rgba(239,68,68,${a * 0.75})` : `rgba(34,197,94,${a * 0.75})`; };
RENDER.portfolio = (d) => {
  const s = d.stats, h = d.hedge;
  return `
  <div class="kpis">${kpi('年化波動', `${s.portVol}%`, `${d.profile}型目標 ${d.profileLimits.targetVol}%`, s.portVol > d.profileLimits.targetVol ? 'up' : '')}${kpi('組合 Beta', num(s.portBeta), '相對加權指數')}${kpi('單日 VaR 95%', `${s.var95}%`, `約 ${num(s.var95Amount, 0)} 元`)}${kpi('近一年最大回撤', `${s.maxDrawdown1y}%`, '', 'down')}${kpi('有效持股數', num(s.effectiveN), `HHI ${s.hhi}`)}${kpi('平均相關係數', num(s.avgCorr), `分散比 ${s.diversification}`)}</div>
  <div class="grid g2">
    <div class="card"><h2>弱點與過度曝險</h2>${d.issues.map((i) => `<div class="factor"><span class="badge b-${i.level}">${i.level === 'high' ? '高' : '中'}</span><span>${esc(i.text)}</span></div>`).join('') || '<div class="muted">未發現明顯弱點</div>'}
      <h3>隱藏相關性（相關係數 > 0.6）</h3>${d.hidden.map((x) => `<div class="factor"><span class="sc up">${x.corr}</span><span>${esc(x.a)} × ${esc(x.b)}：${esc(x.text)}</span></div>`).join('') || '<div class="muted small">無</div>'}
      <h3>產業曝險</h3>${d.sectors.map((x) => `<div class="small">${esc(x.sector)} <span class="mono">${x.weight}%</span><div class="progress"><div style="width:${x.weight}%"></div></div></div>`).join('')}</div>
    <div class="card"><h2>持股風險拆解</h2><div class="tbl-wrap"><table><tr><th>持股</th><th class="n">權重</th><th class="n">波動</th><th class="n">Beta</th><th class="n">風險貢獻</th></tr>
      ${d.holdings.map((x) => `<tr><td>${esc(x.name)} <span class="muted small">${esc(x.code)}</span></td><td class="n">${x.weight}%</td><td class="n">${x.vol}%</td><td class="n">${x.beta}</td><td class="n ${x.riskContribution - x.weight > 5 ? 'up' : ''}">${x.riskContribution}%</td></tr>`).join('')}</table></div>
      <h3>相關係數矩陣</h3><div class="tbl-wrap"><table class="heat"><tr><th></th>${d.correlation.labels.map((l) => `<th>${esc(l.slice(0, 4))}</th>`).join('')}</tr>
      ${d.correlation.matrix.map((r, i) => `<tr><th>${esc(d.correlation.labels[i].slice(0, 4))}</th>${r.map((v) => `<td style="background:${heat(v)}">${num(v)}</td>`).join('')}</tr>`).join('')}</table></div></div>
  </div>
  <div class="card"><h2>平衡方案（${d.profile}型）<span class="small muted">調整後波動 ${d.proposalStats.vol}%・Beta ${d.proposalStats.beta}</span></h2>
    <div class="tbl-wrap"><table><tr><th>標的</th><th class="n">目前</th><th class="n">建議</th><th class="n">調整</th></tr>${d.proposal.map((p) => `<tr><td>${esc(p.name)} <span class="muted small">${esc(p.code)}</span></td><td class="n">${p.current}%</td><td class="n">${p.proposed}%</td><td class="n ${cls(p.change)}">${pct(p.change)}</td></tr>`).join('')}</table></div>
    <p class="small muted">方法：目前權重與風險平價（反波動加權）各半混合，套用單一持股上限 ${d.profileLimits.maxName}%，再依目標波動 ${d.profileLimits.targetVol}% 決定股票／現金比例。</p></div>
  <div class="card"><h2>大盤下跌 20% 情境與避險策略</h2>
    <div class="kpis">${kpi('預估組合跌幅', `${h.scenario.expectedLossPct}%`, `約 ${num(h.scenario.expectedLoss, 0)} 元`, 'down')}${kpi('是否在承受範圍', h.scenario.withinTolerance ? '是' : '否', `上限 ${d.profileLimits.maxLoss20}%`, h.scenario.withinTolerance ? '' : 'up')}${kpi('歷史最差 20 日', `${h.historicalStress.portfolioPct}%`, `${h.historicalStress.from}～${h.historicalStress.to} 大盤 ${h.historicalStress.indexPct}%`)}${kpi('加權指數', num(h.indexLevel, 0))}</div>
    <table class="stack-sm"><tr><th>避險工具</th><th>執行方式</th><th>成本／取捨</th></tr>${h.options.map((o) => `<tr><td><b>${esc(o.name)}</b></td><td class="small">${esc(o.detail)}</td><td class="small muted">${esc(o.cost)}</td></tr>`).join('')}</table>
    <h3>避險啟動條件</h3><ul class="reasons">${h.triggers.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
  ${aiBlock(d.ai)}`;
};

// ---------- 6. 交易日誌 ----------
const SAMPLE = `2026-06-02,2330,多,2380,2026-06-09,2305,1000,2310,突破追價
2026-06-10,2317,多,263,2026-06-11,258.5,3000,254
2026-06-11,2317,多,258.5,2026-06-22,268.5,6000,,攤平
2026-06-23,2454,多,4535,2026-06-25,4310,200,4355
2026-07-01,3231,多,159.5,2026-07-02,158.5,4000,151.5
2026-07-03,2382,多,377,2026-07-21,324,3000,362,不想認賠
2026-07-08,2603,空,196,2026-07-13,195,2000,202
2026-07-22,2330,多,2400,2026-07-24,2350,1000,2330
2026-07-27,2330,多,2350,2026-08-12,2415,2000,2255,連勝加碼
2026-08-13,6669,多,2035,2026-08-14,2155,300,1975
2026-08-14,6669,多,2155,2026-08-17,2220,600
2026-08-20,2308,多,1745,2026-08-27,1770,1000,1675
2026-09-01,3017,多,3410,2026-09-03,3300,500,3275
2026-09-04,2881,多,150.5,2026-09-24,150,10000,146`;
$('#loadSample').addEventListener('click', () => { $('#journalBox').value = SAMPLE; });
RENDER.journal = (d) => {
  const s = d.stats;
  return `
  <div class="kpis">${kpi('交易筆數', s.n)}${kpi('勝率', `${s.winRate}%`)}${kpi('總損益', num(s.totalPnl, 0), '已扣手續費與證交稅', cls(s.totalPnl))}${kpi('賺賠比', num(s.payoff))}${kpi('獲利因子', num(s.profitFactor))}${kpi('期望值', pct(s.expectancyPct), '每筆平均', cls(s.expectancyPct))}${kpi('持有天數', `${s.holdWin} / ${s.holdLoss}`, '獲利單 / 虧損單')}</div>
  <div class="card"><h2>3 條個人化交易規則</h2>${d.rules.map((r, k) => `<div class="rule"><div class="num">${k + 1}</div><div><b>${esc(r.rule)}</b><div class="small muted">針對：${esc(r.from)}</div></div></div>`).join('')}</div>
  <div class="grid g3">
    <div class="card"><h2>反覆出現的錯誤</h2>${d.mistakes.map((m) => `<div class="factor"><span class="badge b-high">${m.severity}</span><span><b>${esc(m.name)}</b><br><span class="small muted">${esc(m.evidence)}</span></span></div>`).join('') || '<div class="muted">未偵測到</div>'}</div>
    <div class="card"><h2>行為偏誤</h2>${d.biases.map((m) => `<div class="factor"><span class="badge b-mid">${m.severity}</span><span><b>${esc(m.name)}</b><br><span class="small muted">${esc(m.evidence)}</span></span></div>`).join('') || '<div class="muted">未偵測到</div>'}</div>
    <div class="card"><h2>錯失的機會</h2>${d.missed.map((m) => `<div class="factor"><span><b>${esc(m.name)}</b><br><span class="small muted">${esc(m.evidence)}</span></span></div>`).join('') || '<div class="muted">未偵測到</div>'}</div>
  </div>
  <div class="card"><h2>交易明細</h2><div class="tbl-wrap"><table><tr><th>#</th><th>標的</th><th>方向</th><th>進場</th><th>出場</th><th class="n">報酬</th><th class="n">損益</th><th class="n">天數</th><th class="n">進場前5日漲幅</th><th class="n">出場後20日</th><th>備註</th></tr>
    ${d.trades.map((t) => `<tr><td class="mono">${t.no}</td><td>${esc(t.name || t.code)}</td><td>${t.side === 1 ? '多' : '空'}</td><td class="mono small">${t.entryDate}<br>${num(t.entry)}</td><td class="mono small">${t.exitDate}<br>${num(t.exit)}</td><td class="n ${cls(t.retPct)}">${pct(t.retPct)}</td><td class="n ${cls(t.pnl)}">${num(t.pnl, 0)}</td><td class="n">${t.hold}</td><td class="n">${pct(t.runUp5)}</td><td class="n">${pct(t.after20)}</td><td class="small muted">${esc(t.note)}</td></tr>`).join('')}</table></div></div>
  ${aiBlock(d.ai)}`;
};

// ---------- 7. 每日交易計畫 ----------
RENDER.plan = (d) => `
  <div class="kpis">${kpi('標的', esc(d.asset), d.date)}${kpi('國際偏向', d.bias, '', d.bias === '偏多' ? 'up' : d.bias === '偏空' ? 'down' : '')}${kpi('技術趨勢', d.trend, `評分 ${d.score}`)}${kpi('樞紐 P', num(d.pivots.P), `R1 ${num(d.pivots.R1)}／S1 ${num(d.pivots.S1)}`)}${kpi('ATR', num(d.atr))}</div>
  <div class="card"><h2>隔夜國際市場</h2><div class="kpis">${d.globals.filter((g) => !g.error).map((g) => kpi(esc(g.name), num(g.close), pct(g.change), cls(g.change))).join('')}</div></div>
  <div class="card checklist"><h2>今日交易檢查清單 <span class="small muted" id="planProg"></span></h2><div class="progress"><div id="planBar" style="width:0"></div></div>
    ${d.sections.map((s) => `<div class="phase"><h3>${esc(s.phase)}</h3>${s.items.map((it) => `<label class="item" data-id="${it.id}"><input type="checkbox"><span class="time">${it.time}</span><span><div class="task">${esc(it.task)}</div><div class="detail">${esc(it.detail)}</div>${it.flag ? `<div class="flag">⚠ ${esc(it.flag)}</div>` : ''}</span></label>`).join('')}</div>`).join('')}
  </div>
  <div class="card"><h2>鐵律</h2><ul class="reasons">${d.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>
  ${aiBlock(d.ai)}`;
RENDER.plan.after = (d, out) => {
  const key = `plan-${d.date}-${d.symbol}`;
  let state = {}; try { state = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
  const items = $$('.item', out);
  const update = () => { const n = items.filter((i) => i.classList.contains('done')).length; $('#planBar').style.width = `${(n / items.length) * 100}%`; $('#planProg').textContent = `${n} / ${items.length} 完成`; };
  items.forEach((it) => {
    const cb = $('input', it);
    cb.checked = !!state[it.dataset.id]; it.classList.toggle('done', cb.checked);
    cb.addEventListener('change', () => { state[it.dataset.id] = cb.checked; it.classList.toggle('done', cb.checked); try { localStorage.setItem(key, JSON.stringify(state)); } catch {} update(); });
  });
  update();
};
