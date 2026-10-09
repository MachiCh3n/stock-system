// Claude AI 解讀（選用）：設定 ANTHROPIC_API_KEY 後啟用，否則回傳 null 由規則引擎輸出
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
let client = null;

export function aiEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const SYSTEM = `你是一位資深台股交易研究員，熟悉台灣證券市場制度（漲跌幅 10%、升降單位、T+2 交割、三大法人、融資融券、台指期）。
你會收到系統已計算好的量化資料（價格、技術指標、基本面、新聞、回測或交易紀錄）。
規則：
- 只根據提供的資料推論，數字以資料為準，不要捏造未提供的財報數字或新聞。
- 使用繁體中文，條理清楚，以 Markdown 輸出（標題、條列、表格）。
- 明確區分「事實（資料）」與「推論（判斷）」，並指出主要風險與失效條件。
- 這是研究輔助工具，不是投資建議；最後一行加上簡短風險提示。`;

export async function aiAnalyze(task, payload, { effort = 'medium' } = {}) {
  if (!aiEnabled()) return null;
  try {
    const stream = getClient().beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort },
      system: SYSTEM,
      messages: [{ role: 'user', content: `${task}\n\n<data>\n${JSON.stringify(payload)}\n</data>` }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') return { error: 'AI 拒絕回應此請求', text: null };
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return { text, model: msg.model };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { error: 'Claude API 金鑰無效', text: null };
    if (e instanceof Anthropic.RateLimitError) return { error: 'Claude API 速率限制，請稍後再試', text: null };
    if (e instanceof Anthropic.APIError) return { error: `Claude API 錯誤 ${e.status}: ${e.message}`, text: null };
    return { error: `AI 呼叫失敗：${e.message}`, text: null };
  }
}
