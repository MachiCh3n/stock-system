// 技術指標（皆回傳與輸入等長的陣列，不足期數為 null）
export function sma(arr, n) {
  const out = new Array(arr.length).fill(null);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    s += arr[i];
    if (i >= n) s -= arr[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

export function ema(arr, n) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    if (prev == null) {
      if (i >= n - 1) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += arr[j]; prev = s / n; out[i] = prev; }
      continue;
    }
    prev = arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export function macd(closes, f = 12, s = 26, sig = 9) {
  const ef = ema(closes, f), es = ema(closes, s);
  const dif = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const firstIdx = dif.findIndex((x) => x != null);
  const sigArr = new Array(closes.length).fill(null);
  if (firstIdx >= 0) {
    const e = ema(dif.slice(firstIdx), sig);
    e.forEach((v, i) => (sigArr[firstIdx + i] = v));
  }
  const hist = dif.map((d, i) => (d != null && sigArr[i] != null ? d - sigArr[i] : null));
  return { dif, signal: sigArr, hist };
}

// 台灣常用 KD（9,3,3）
export function kd(bars, n = 9) {
  const K = new Array(bars.length).fill(null), D = new Array(bars.length).fill(null);
  let k = 50, d = 50;
  for (let i = 0; i < bars.length; i++) {
    if (i < n - 1) continue;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, bars[j].h); ll = Math.min(ll, bars[j].l); }
    const rsv = hh === ll ? 50 : ((bars[i].c - ll) / (hh - ll)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv; d = (2 / 3) * d + (1 / 3) * k;
    K[i] = k; D[i] = d;
  }
  return { k: K, d: D };
}

export function atr(bars, n = 14) {
  const tr = bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
  const out = new Array(bars.length).fill(null);
  let prev = null;
  for (let i = 0; i < tr.length; i++) {
    if (i < n - 1) continue;
    if (prev == null) { prev = tr.slice(0, n).reduce((a, b) => a + b, 0) / n; out[i] = prev; continue; }
    prev = (prev * (n - 1) + tr[i]) / n; out[i] = prev;
  }
  return out;
}

export function bollinger(closes, n = 20, k = 2) {
  const mid = sma(closes, n);
  const up = [], dn = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] == null) { up.push(null); dn.push(null); continue; }
    let v = 0; for (let j = i - n + 1; j <= i; j++) v += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / n); up.push(mid[i] + k * sd); dn.push(mid[i] - k * sd);
  }
  return { mid, up, dn };
}

// ADX（趨勢強度）
export function adx(bars, n = 14) {
  const len = bars.length, out = new Array(len).fill(null);
  if (len < n * 2 + 1) return out;
  let trS = 0, pS = 0, mS = 0, adxV = null; const dxs = [];
  for (let i = 1; i < len; i++) {
    const up = bars[i].h - bars[i - 1].h, dn = bars[i - 1].l - bars[i].l;
    const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    if (i <= n) { trS += tr; pS += pdm; mS += mdm; if (i < n) continue; }
    else { trS = trS - trS / n + tr; pS = pS - pS / n + pdm; mS = mS - mS / n + mdm; }
    const pdi = (100 * pS) / trS, mdi = (100 * mS) / trS;
    const dx = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
    dxs.push(dx);
    if (dxs.length === n) adxV = dxs.reduce((a, b) => a + b, 0) / n;
    else if (dxs.length > n) adxV = (adxV * (n - 1) + dx) / n;
    if (adxV != null) out[i] = adxV;
  }
  return out;
}

// 擺盪高低點（pivot）
export function pivots(bars, left = 5, right = 5) {
  const highs = [], lows = [];
  for (let i = left; i < bars.length - right; i++) {
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isH = false;
      if (bars[j].l <= bars[i].l) isL = false;
    }
    if (isH) highs.push({ i, price: bars[i].h, date: bars[i].date });
    if (isL) lows.push({ i, price: bars[i].l, date: bars[i].date });
  }
  return { highs, lows };
}

// 將相近價位聚類為支撐/壓力區
export function levels(bars, lookback = 250, tolPct = 0.02) {
  const sub = bars.slice(-lookback);
  const offset = bars.length - sub.length;
  const { highs, lows } = pivots(sub, 4, 4);
  const pts = [...highs, ...lows].map((p) => ({ ...p, i: p.i + offset }));
  pts.sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const p of pts) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(p.price - c.avg) / c.avg < tolPct) { c.pts.push(p); c.avg = c.pts.reduce((s, x) => s + x.price, 0) / c.pts.length; }
    else clusters.push({ avg: p.price, pts: [p] });
  }
  const last = bars[bars.length - 1].c;
  return clusters
    .map((c) => ({ price: +c.avg.toFixed(2), touches: c.pts.length, lastDate: c.pts.reduce((a, b) => (a.i > b.i ? a : b)).date, type: c.avg < last ? 'support' : 'resistance' }))
    .filter((c) => c.touches >= 1);
}

// 以最近擺盪點建立趨勢線
export function trendlines(bars) {
  const { highs, lows } = pivots(bars.slice(-180), 5, 5);
  const off = Math.max(0, bars.length - 180);
  const lastI = bars.length - 1;
  const mk = (pts, kind) => {
    if (pts.length < 2) return null;
    const [a, b] = pts.slice(-2).map((p) => ({ ...p, i: p.i + off }));
    const slope = (b.price - a.price) / (b.i - a.i);
    return { kind, from: { date: a.date, price: a.price }, to: { date: b.date, price: b.price }, slopePerDay: slope, valueToday: +(b.price + slope * (lastI - b.i)).toFixed(2), direction: slope > 0 ? '上升' : '下降' };
  };
  return { support: mk(lows, 'support'), resistance: mk(highs, 'resistance') };
}

// 背離偵測：價格創新低但 RSI 未創新低（多頭背離），反之空頭背離
export function divergence(bars, rsiArr, i, lookback = 40) {
  if (i < lookback) return null;
  const { lows, highs } = pivots(bars.slice(i - lookback, i + 1), 3, 2);
  const o = i - lookback;
  if (lows.length >= 2) {
    const [a, b] = lows.slice(-2);
    if (b.price < a.price && rsiArr[b.i + o] != null && rsiArr[a.i + o] != null && rsiArr[b.i + o] > rsiArr[a.i + o] && rsiArr[a.i + o] < 45 && i - (b.i + o) <= 5) return 'bull';
  }
  if (highs.length >= 2) {
    const [a, b] = highs.slice(-2);
    if (b.price > a.price && rsiArr[b.i + o] != null && rsiArr[a.i + o] != null && rsiArr[b.i + o] < rsiArr[a.i + o] && rsiArr[a.i + o] > 55 && i - (b.i + o) <= 5) return 'bear';
  }
  return null;
}

// 台股升降單位（tick）
export function tick(p) {
  if (p < 10) return 0.01; if (p < 50) return 0.05; if (p < 100) return 0.1;
  if (p < 500) return 0.5; if (p < 1000) return 1; return 5;
}
export function roundTick(p) { const t = tick(p); return +(Math.round(p / t) * t).toFixed(2); }

export function computeAll(bars) {
  const c = bars.map((b) => b.c);
  return {
    ma5: sma(c, 5), ma10: sma(c, 10), ma20: sma(c, 20), ma60: sma(c, 60), ma120: sma(c, 120), ma240: sma(c, 240),
    rsi: rsi(c, 14), macd: macd(c), kd: kd(bars), atr: atr(bars), bb: bollinger(c), adx: adx(bars), volMa20: sma(bars.map((b) => b.v), 20),
  };
}
