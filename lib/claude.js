'use strict';
// The Anthropic Messages API with plain fetch (no SDK). The key comes from
// ANTHROPIC_API_KEY in .env and is never logged or shown.
const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5-5';

class ClaudeError extends Error {
  constructor(message, { status, code } = {}) { super(message); this.status = status; this.code = code; }
}

function createClaude({ apiKey, fetch = globalThis.fetch, timeoutMs = 60000 }) {
  async function message({ model, system, messages, tools, toolChoice, maxTokens = 4000 }) {
    if (!apiKey) throw new ClaudeError('The Anthropic key is not set. Ryan: add ANTHROPIC_API_KEY to this module\'s settings (.env on Windows, environment variables on Hostinger).', { code: 'config' });
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        redirect: 'error',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: model || DEFAULT_MODEL, max_tokens: maxTokens, system, messages, tools, tool_choice: toolChoice }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const why = e && e.name === 'TimeoutError' ? 'took too long' : 'could not be reached';
      throw new ClaudeError(`Claude ${why}. Try Draft again.`, { code: 'unreachable' });
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
      const kind = data?.error?.type || '';
      let msg = `Claude answered with an error (${res.status}${kind ? ` ${kind}` : ''}).`;
      if (res.status === 401) msg = 'The Anthropic key was refused. Ryan: check ANTHROPIC_API_KEY.';
      else if (res.status === 404 && /model/i.test(data?.error?.message || '')) msg = 'That Claude model name was not found. Check Settings → Claude model.';
      else if (res.status === 429 || res.status === 529) msg = 'Claude is busy right now. Wait a moment and tap Draft again.';
      throw new ClaudeError(msg, { status: res.status, code: kind || 'api' });
    }
    if (!data || !Array.isArray(data.content)) throw new ClaudeError('Claude sent an answer this page could not read.', { code: 'bad_answer' });
    return data;
  }
  return { message };
}

module.exports = { createClaude, ClaudeError, DEFAULT_MODEL, API_URL };
