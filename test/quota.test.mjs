import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const rateLimit = { limit: 6, remaining: 0, reset: 1791678095, window: 'weekly' };
const error = { code: 'RATE_LIMITED', message: 'Weekly usage limit reached', rateLimit: { ...rateLimit, private: 'omit' } };
const routes = [
  ['/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }],
  ['/v1/messages', { model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }],
  ['/v1/responses', { model: 'm', input: 'hi' }],
];

test('HTTP quota errors preserve allowlisted metadata across all protocols, including stream requests', async () => {
  const s = await setup({ status: 429, errorBody: JSON.stringify({ success: false, error }) });
  try {
    for (const [path, body] of routes) for (const stream of [false, true]) {
      const res = await s.proxy.post(path, { ...body, stream }, AUTH);
      assert.equal(res.status, 429);
      const parsed = await res.json();
      assert.equal(parsed.error.code, error.code);
      assert.deepEqual(parsed.error.rateLimit, rateLimit);
      if (path !== '/v1/messages') assert.equal(res.headers.get('retry-after'), '30');
    }
  } finally { await s.close(); }
});

test('quota metadata survives NDJSON error events in streaming and non-streaming responses', async () => {
  const s = await setup({ ndjson: [JSON.stringify({ type: 'error', error: { ...error, statusCode: 429 } })] });
  try {
    for (const [path, body] of routes) for (const stream of [false, true]) {
      const res = await s.proxy.post(path, { ...body, stream }, AUTH);
      const text = await res.text();
      const parsed = res.headers.get('content-type').startsWith('application/json')
        ? JSON.parse(text) : text.split('\n').filter(line => line.startsWith('data: '))
          .map(line => JSON.parse(line.slice(6))).find(row => row.error?.rateLimit || row.response?.error?.rateLimit);
      assert.ok(parsed, path + ' stream=' + stream + ' missing quota metadata');
      const result = parsed.error || parsed.response.error;
      assert.equal(result.code, error.code);
      assert.deepEqual(result.rateLimit, rateLimit);
    }
  } finally { await s.close(); }
});

test('malformed quota metadata is omitted; ordinary 429 response and retry hint remain unchanged', async () => {
  const s = await setup({ status: 429, errorBody: JSON.stringify({ error: { ...error, rateLimit: { ...rateLimit, reset: '1791678095' } } }) });
  try {
    const res = await s.proxy.post(routes[0][0], routes[0][1], AUTH);
    const parsed = await res.json();
    assert.equal(res.status, 429);
    assert.equal(parsed.retry_after, 30);
    assert.equal(parsed.error.code, error.code);
    assert.equal(parsed.error.rateLimit, undefined);
  } finally { await s.close(); }
});
