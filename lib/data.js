// 資料層：Yahoo Finance 價格、TWSE/TPEx 開放資料、Google 新聞 RSS
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' };
const cache = new Map();

async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

async function getJSON(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

async function getText(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}

// ---------- 產業別代碼 ----------
export const INDUSTRY = {
  '01': '水泥工業', '02': '食品工業', '03': '塑膠工業', '04': '紡織纖維', '05': '電機機械',
  '06': '電器電纜', '08': '玻璃陶瓷', '09': '造紙工業', '10': '鋼鐵工業', '11': '橡膠工業',
  '12': '汽車工業', '14': '建材營造', '15': '航運業', '16': '觀光餐旅', '17': '金融保險',
  '18': '貿易百貨', '19': '綜合', '20': '其他', '21': '化學工業', '22': '生技醫療',
  '23': '油電燃氣', '24': '半導體業', '25': '電腦及週邊設備業', '26': '光電業',
  '27': '通信網路業', '28': '電子零組件業', '29': '電子通路業', '30': '資訊服務業',
  '31': '其他電子業', '32': '文化創意業', '33': '農業科技業', '35': '綠能環保',
  '36': '數位雲端', '37': '運動休閒', '38': '居家生活', '91': '存託憑證',
};

// 常用指數 / 海外代號別名
const ALIAS = {
  '加權指數': '^TWII', '大盤': '^TWII', 'TAIEX': '^TWII', 'TWII': '^TWII', '台股': '^TWII',
  '櫃買指數': '^TWOII', '櫃買': '^TWOII', 'OTC': '^TWOII',
  '費半': '^SOX', 'SOX': '^SOX', '那斯達克': '^IXIC', 'NASDAQ': '^IXIC', '道瓊': '^DJI',
  'S&P500': '^GSPC', '標普': '^GSPC', 'VIX': '^VIX', '台積電ADR': 'TSM',
};

// ---------- 上市櫃公司清單（含本益比、殖利率、淨值比、產業） ----------
export async function getUniverse() {
  return cached('universe', 6 * 3600e3, async () => {
    const [twVal, twInfo, otcVal, otcInfo, twDay, otcDay] = await Promise.all([
      getJSON('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL').catch(() => []),
      getJSON('https://openapi.twse.com.tw/v1/opendata/t187ap03_L').catch(() => []),
      getJSON('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis').catch(() => []),
      getJSON('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O').catch(() => []),
      getJSON('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL').catch(() => []),
      getJSON('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes').catch(() => []),
    ]);
    const map = new Map();
    const num = (x) => { const n = parseFloat(String(x ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
    for (const r of twVal) map.set(r.Code, { code: r.Code, name: r.Name, market: 'TW', pe: num(r.PEratio), yield: num(r.DividendYield), pb: num(r.PBratio) });
    for (const r of twInfo) {
      const c = r['公司代號']; const o = map.get(c) || { code: c, name: r['公司簡稱'], market: 'TW' };
      o.industry = INDUSTRY[r['產業別']] || r['產業別']; o.capital = num(r['實收資本額']); o.fullName = r['公司名稱'];
      map.set(c, o);
    }
    for (const r of otcVal) map.set(r.SecuritiesCompanyCode, { code: r.SecuritiesCompanyCode, name: r.CompanyName, market: 'TWO', pe: num(r.PriceEarningRatio), yield: num(r.YieldRatio), pb: num(r.PriceBookRatio) });
    for (const r of otcInfo) {
      const c = r.SecuritiesCompanyCode || r['公司代號']; if (!c) continue;
      const o = map.get(c) || { code: c, name: r.CompanyAbbreviation || r['公司簡稱'], market: 'TWO' };
      const ind = r.SecuritiesIndustryCode || r['產業別'];
      o.industry = INDUSTRY[ind] || ind || o.industry; o.capital = num(r['Paidin.Capital.NTDollars'] ?? r['實收資本額']) ?? o.capital;
      map.set(c, o);
    }
    // 補上 ETF 等不在基本資料內的證券名稱
    for (const r of twDay) if (!map.has(r.Code)) map.set(r.Code, { code: r.Code, name: r.Name, market: 'TW', industry: /^00/.test(r.Code) ? 'ETF' : undefined });
    for (const r of otcDay) if (!map.has(r.SecuritiesCompanyCode)) map.set(r.SecuritiesCompanyCode, { code: r.SecuritiesCompanyCode, name: r.CompanyName, market: 'TWO', industry: /^00/.test(r.SecuritiesCompanyCode) ? 'ETF' : undefined });
    return map;
  });
}

export async function listIndustries() {
  const u = await getUniverse();
  const count = {};
  for (const s of u.values()) if (s.industry) count[s.industry] = (count[s.industry] || 0) + 1;
  return Object.entries(count).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
}

// 依產業取出股本最大的前 N 檔
export async function stocksInIndustry(industry, limit = 25) {
  const u = await getUniverse();
  return [...u.values()]
    .filter((s) => s.industry && s.industry.includes(industry))
    .sort((a, b) => (b.capital || 0) - (a.capital || 0))
    .slice(0, limit);
}

// ---------- 代號解析：2330 / 台積電 / 加權指數 / ^SOX ----------
export async function resolveSymbol(input) {
  const q = String(input || '').trim();
  if (!q) throw new Error('請輸入股票代號或名稱');
  if (ALIAS[q] || ALIAS[q.toUpperCase()]) {
    const sym = ALIAS[q] || ALIAS[q.toUpperCase()];
    return { symbol: sym, code: sym, name: q, market: 'INDEX' };
  }
  if (/^\^|\.TWO?$|^[A-Z]{1,5}$/.test(q.toUpperCase()) && !/^\d/.test(q)) {
    return { symbol: q.toUpperCase(), code: q.toUpperCase(), name: q.toUpperCase(), market: 'OTHER' };
  }
  const u = await getUniverse();
  let info = u.get(q.replace(/\.TWO?$/i, ''));
  if (!info) info = [...u.values()].find((s) => s.name === q) || [...u.values()].find((s) => s.name?.includes(q) || s.fullName?.includes(q));
  if (info) return { symbol: `${info.code}.${info.market === 'TWO' ? 'TWO' : 'TW'}`, ...info };
  // 不在清單（例如 ETF）：直接嘗試 .TW 再 .TWO
  if (/^\d{4,6}[A-Z]?$/i.test(q)) {
    for (const suf of ['TW', 'TWO']) {
      try { const c = await getCandles(`${q}.${suf}`, '1mo', '1d'); if (c.bars.length) return { symbol: `${q}.${suf}`, code: q, name: c.meta.name || q, market: suf }; } catch {}
    }
  }
  throw new Error(`找不到「${q}」，請輸入台股代號（如 2330）、名稱或指數（加權指數）`);
}

// ---------- K 線 ----------
export async function getCandles(symbol, range = '2y', interval = '1d') {
  return cached(`c:${symbol}:${range}:${interval}`, 10 * 60e3, async () => {
    // Yahoo 的 range=max 或超過 10y 會自動降為月資料，改以起訖時間戳指定
    const m = /^(d+)y$/.exec(range);
    const yrs = range === 'max' ? 30 : m ? Number(m[1]) : 0;
    const span = yrs && interval === '1d' ? `period1=${Math.floor(Date.now() / 1000 - yrs * 365.25 * 86400)}&period2=${Math.floor(Date.now() / 1000)}` : `range=${range}`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${span}&interval=${interval}&includeAdjustedClose=true`;
    const j = await getJSON(url);
    const res = j?.chart?.result?.[0];
    if (!res) throw new Error(`無法取得 ${symbol} 價格資料`);
    const q = res.indicators.quote[0];
    const bars = [];
    (res.timestamp || []).forEach((t, i) => {
      if (q.close[i] == null || q.open[i] == null) return;
      bars.push({ t: t * 1000, date: new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 10), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
    });
    return { bars, meta: { name: res.meta.shortName || res.meta.longName, price: res.meta.regularMarketPrice, prevClose: res.meta.chartPreviousClose, currency: res.meta.currency } };
  });
}

// ---------- 新聞（Google News RSS，個人研究用途） ----------
export async function getNews(query, max = 20) {
  return cached(`n:${query}`, 20 * 60e3, async () => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:30d')}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    const xml = await getText(url);
    const items = [];
    const decode = (s) => s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const b = m[1];
      const pick = (tag) => decode((b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '');
      const title = pick('title');
      const source = pick('source');
      items.push({ title: source && title.endsWith(` - ${source}`) ? title.slice(0, -source.length - 3) : title, link: pick('link'), date: new Date(pick('pubDate')).toISOString(), source });
    }
    items.sort((a, b) => b.date.localeCompare(a.date));
    return items.slice(0, max);
  });
}

// 有限併發
export async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) { const k = i++; try { out[k] = await fn(arr[k], k); } catch (e) { out[k] = { error: e.message }; } }
  }));
  return out;
}
