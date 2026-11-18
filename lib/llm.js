// DeepSeek (OpenAI-compatible) client. Key is read from .env only.
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const f = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

async function chat(messages, { json = false, temperature = 0.2, maxTokens = 1200 } = {}) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY 未配置');
  const body = { model: MODEL, messages, temperature, max_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const t0 = Date.now();
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      });
      if (!r.ok) throw new Error(`DeepSeek HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d = await r.json();
      const content = d.choices[0].message.content;
      const ms = Date.now() - t0;
      if (!json) return { content, ms, usage: d.usage };
      try {
        return { data: JSON.parse(content), ms, usage: d.usage };
      } catch (e) {
        const m = content.match(/\{[\s\S]*\}/);
        if (m) return { data: JSON.parse(m[0]), ms, usage: d.usage };
        throw e;
      }
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

module.exports = { chat, MODEL };
