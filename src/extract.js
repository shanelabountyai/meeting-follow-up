'use strict';
// The model step (PRD §1 step 4, §3): request building for the Anthropic Messages API with a forced tool whose
// input_schema is the extraction contract, and parsing of the response. Tests never call a model: they feed
// recorded responses from fixtures/recorded/.

const TOOL_NAME = 'record_meeting';

// Keep the transcript inside its tags even if it contains the closing tag text.
const fence = (s) => String(s).replace(/<\/?\s*(transcript|chunk_results)\b[^>]*>/gi, (m) => m.replace('<', '‹'));

function toolSpec(schema) {
  const { $schema, $id, title, ...input } = schema; // eslint-disable-line no-unused-vars
  return { name: TOOL_NAME, description: 'Record the structured follow-up for one meeting.', input_schema: input };
}

function buildRequest({ text, part, parts, cfg, system, schema }) {
  const attrs = parts > 1 ? ` part="${part}" of="${parts}"` : '';
  return {
    model: cfg.model,
    max_tokens: cfg.maxOutputTokens,
    temperature: 0,
    system,
    tools: [toolSpec(schema)],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content: `<transcript${attrs}>\n${fence(text)}\n</transcript>` }],
  };
}

function buildReduceRequest({ chunkResults, cfg, system, schema }) {
  return {
    model: cfg.model,
    max_tokens: cfg.maxOutputTokens,
    temperature: 0,
    system,
    tools: [toolSpec(schema)],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content: `<chunk_results>\n${fence(JSON.stringify(chunkResults, null, 2))}\n</chunk_results>` }],
  };
}

const usageOf = (api) => ({ input_tokens: Number(api?.usage?.input_tokens) || 0, output_tokens: Number(api?.usage?.output_tokens) || 0 });

// → { ok, value, raw, usage, reason }. `raw` is what goes into the .review.json sidecar on failure.
function parseResponse(api) {
  const usage = usageOf(api);
  if (!api || typeof api !== 'object') return { ok: false, value: null, raw: String(api), usage, reason: 'no response' };
  if (api.type === 'error' || api.error) return { ok: false, value: null, raw: JSON.stringify(api).slice(0, 4000), usage, reason: 'api error' };
  const blocks = Array.isArray(api.content) ? api.content : [];
  const tool = blocks.find((b) => b && b.type === 'tool_use' && b.name === TOOL_NAME);
  const raw = tool ? JSON.stringify(tool.input) : blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  if (api.stop_reason === 'max_tokens') return { ok: false, value: null, raw, usage, reason: 'output truncated (max_tokens)' };
  if (tool) return { ok: true, value: tool.input, raw, usage, reason: '' };
  try {
    const t = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return { ok: true, value: JSON.parse(t), raw, usage, reason: '' };
  } catch {
    return { ok: false, value: null, raw, usage, reason: 'not valid JSON' };
  }
}

const addUsage = (a, b) => ({ input_tokens: (a?.input_tokens || 0) + (b?.input_tokens || 0), output_tokens: (a?.output_tokens || 0) + (b?.output_tokens || 0) });

module.exports = { TOOL_NAME, buildRequest, buildReduceRequest, parseResponse, addUsage, toolSpec, fence };
