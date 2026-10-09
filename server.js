import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listIndustries, getUniverse } from './lib/data.js';
import { aiEnabled } from './lib/ai.js';
import { generateIdeas } from './lib/ideas.js';
import { technicalReport } from './lib/analysis.js';
import { newsStrategy } from './lib/news.js';
import { backtestReport, STRATEGIES } from './lib/backtest.js';
import { portfolioReport } from './lib/portfolio.js';
import { journalReport } from './lib/journal.js';
import { dailyPlan } from './lib/plan.js';
import { beginnerReport } from './lib/beginner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
// 允許以 file:// 開啟的頁面呼叫本機 API
app.use('/api', (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(here, 'public')));

const handle = (fn) => async (req, res) => {
  const t0 = Date.now();
  try {
    const data = await fn(req.body || {}, req);
    res.json({ ok: true, ms: Date.now() - t0, data });
  } catch (e) {
    console.error(`[${req.path}]`, e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
};
const ai = (b) => b.ai !== false && aiEnabled();

app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/api/meta', async (_req, res) => {
  res.json({
    ai: aiEnabled(),
    industries: await listIndustries().catch(() => []),
    strategies: Object.entries(STRATEGIES).map(([key, s]) => ({ key, name: s.name, params: s.params, desc: s.desc(s.params) })),
  });
});
app.post('/api/beginner', handle((b) => beginnerReport({ capital: Number(b.capital) || 100000, profile: b.profile }, { withAI: ai(b) })));
app.post('/api/ideas', handle((b) => generateIdeas(b.target, { withAI: ai(b) })));
app.post('/api/technical', handle((b) => technicalReport(b.symbol, { withAI: ai(b) })));
app.post('/api/news', handle((b) => newsStrategy(b.query, { withAI: ai(b), capital: Number(b.capital) || 1_000_000 })));
app.post('/api/backtest', handle((b) => backtestReport(b.symbol, b.strategy, Number(b.years) || 5, b.params || {}, b.options || {}, { withAI: ai(b) })));
app.post('/api/portfolio', handle((b) => portfolioReport(b.holdings, { profile: b.profile, value: Number(b.value) || 1_000_000, withAI: ai(b) })));
app.post('/api/journal', handle((b) => journalReport(b.journal, { withAI: ai(b) })));
app.post('/api/plan', handle((b) => dailyPlan(b.asset, { capital: Number(b.capital) || 1_000_000, riskPct: Number(b.riskPct) || 1, withAI: ai(b) })));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`台股交易研究系統：http://localhost:${PORT}`);
  console.log(aiEnabled() ? 'Claude AI 解讀：已啟用' : 'Claude AI 解讀：未啟用（設定 ANTHROPIC_API_KEY 後重啟即可啟用）');
  // 啟動時預先載入上市櫃清單，避免第一位訪客等待
  getUniverse().then((u) => console.log(`已載入 ${u.size} 檔證券資料`)).catch((e) => console.error('預載證券清單失敗：', e.message));
});
