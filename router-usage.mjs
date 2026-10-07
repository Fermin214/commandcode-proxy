// Router-owned response observation. No request/response rewriting or model text storage.
export const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const sum = values => values.every(value => value !== null) && Number.isSafeInteger(values.reduce((a, b) => a + b, 0))
  ? values.reduce((a, b) => a + b, 0) : null;

export function createUsageObserver(pathname) {
  const kind = pathname === '/v1/messages' ? 'anthropic' : pathname === '/v1/responses' ? 'responses' : 'chat';
  let reported = {};
  let terminal = false;
  let failed = false;
  function remember(usage) {
    if (usage && typeof usage === 'object') reported = { ...reported, ...usage };
  }
  function json(payload) {
    if (!payload || typeof payload !== 'object') return;
    failed ||= !!payload.error || payload.status === 'failed';
    remember(payload.usage);
  }
  function sse(payload) {
    if (payload === '[DONE]') { if (kind === 'chat') terminal = true; return; }
    if (!payload || typeof payload !== 'object') return;
    failed ||= !!payload.error || !!payload.response?.error || payload.type === 'error' || payload.type === 'response.failed';
    if (kind === 'anthropic') {
      if (payload.type === 'message_start') remember(payload.message?.usage);
      if (payload.type === 'message_delta') remember(payload.usage);
      if (payload.type === 'message_stop') terminal = true;
    } else if (kind === 'responses') {
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(payload.type)) {
        remember(payload.response?.usage);
        terminal = payload.type !== 'response.failed';
      }
    } else remember(payload.usage);
  }
  function result({ complete, streaming, status }) {
    let input, output, read, write;
    if (kind === 'anthropic') {
      read = count(reported.cache_read_input_tokens);
      write = count(reported.cache_creation_input_tokens);
      input = sum([count(reported.input_tokens), read, write]);
      output = count(reported.output_tokens);
    } else if (kind === 'responses') {
      input = count(reported.input_tokens); output = count(reported.output_tokens);
      read = count(reported.input_tokens_details?.cached_tokens);
      write = count(reported.input_tokens_details?.cache_write_tokens);
    } else {
      input = count(reported.prompt_tokens); output = count(reported.completion_tokens);
      read = count(reported.prompt_tokens_details?.cached_tokens);
      write = count(reported.prompt_tokens_details?.cache_write_tokens);
    }
    // A cache count is a subset of total input, never an additional OpenAI input count.
    if (input !== null && ((read !== null && read > input) || (write !== null && write > input)
        || (read !== null && write !== null && read + write > input))) {
      read = null; write = null;
    }
    const usage = { input_tokens: input, output_tokens: output, cache_read_tokens: read, cache_write_tokens: write };
    const success = complete && status >= 200 && status < 300 && !failed && (!streaming || terminal);
    const any = TOKEN_FIELDS.some(key => usage[key] !== null);
    return { usage_status: success && input !== null && output !== null ? 'reported' : any ? 'partial' : 'unknown',
      usage: any ? usage : null, semantic_error: failed, stream_incomplete: streaming && !terminal };
  }
  return { json, sse, result };
}

export function emptyUsageCounters() {
  return { calls: 0, success: 0, failed: 0, usage_reported: 0, usage_partial: 0, usage_unknown: 0,
    tokens: Object.fromEntries(TOKEN_FIELDS.map(key => [key, 0])),
    token_reports: Object.fromEntries(TOKEN_FIELDS.map(key => [key, 0])),
    partial_tokens: Object.fromEntries(TOKEN_FIELDS.map(key => [key, 0])),
    partial_token_reports: Object.fromEntries(TOKEN_FIELDS.map(key => [key, 0])) };
}
export function addUsage(counters, fields) {
  counters.calls++;
  if (fields.status >= 200 && fields.status < 300 && !fields.error && !fields.quota) counters.success++;
  else counters.failed++;
  const state = ['reported', 'partial'].includes(fields.usage_status) ? fields.usage_status : 'unknown';
  counters['usage_' + state]++;
  if (state === 'unknown') return;
  const prefix = state === 'partial' ? 'partial_' : '';
  for (const key of TOKEN_FIELDS) {
    const value = count(fields.usage?.[key]);
    if (value !== null) { counters[prefix + 'tokens'][key] += value; counters[prefix + 'token_reports'][key]++; }
  }
}
export function combineUsage(total, row) {
  for (const key of ['calls', 'success', 'failed', 'usage_reported', 'usage_partial', 'usage_unknown']) total[key] += row[key];
  for (const name of ['tokens', 'token_reports', 'partial_tokens', 'partial_token_reports'])
    for (const key of TOKEN_FIELDS) total[name][key] += row[name][key];
}
export function publicUsage(row) {
  const result = { ...row, tokens: { ...row.tokens }, partial_tokens: { ...row.partial_tokens } };
  for (const key of TOKEN_FIELDS) {
    if (!row.token_reports[key]) result.tokens[key] = null;
    if (!row.partial_token_reports[key]) result.partial_tokens[key] = null;
  }
  result.tokens.total_tokens = row.usage_reported ? row.tokens.input_tokens + row.tokens.output_tokens : null;
  return result;
}
export function usageDay(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
