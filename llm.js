// One function for every provider: OpenAI-compatible, Anthropic, Gemini.
async function chat(bot, apiKey, system, messages, max = 1024) {
  let url, headers = { 'Content-Type': 'application/json' }, body, pick;
  if (bot.provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01';
    body = { model: bot.model, max_tokens: max, temperature: 0.2, system, messages };
    pick = j => j.content.map(b => b.text || '').join('');
  } else if (bot.provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(bot.model)}:generateContent`;
    headers['x-goog-api-key'] = apiKey;
    body = {
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { temperature: 0.2, maxOutputTokens: max },
      contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
    };
    pick = j => j.candidates[0].content.parts.map(p => p.text || '').join('');
  } else {
    url = bot.base_url.replace(/\/$/, '') + '/chat/completions';
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    body = { model: bot.model, temperature: 0.2, max_tokens: max, messages: [{ role: 'system', content: system }, ...messages] };
    pick = j => j.choices[0].message.content;
  }
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${bot.provider} ${r.status}: ${JSON.stringify(j.error || j).slice(0, 300)}`);
  return pick(j);
}
module.exports = { chat };
