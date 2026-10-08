import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setup } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AUTH = { Authorization: 'Bearer client-test' };

async function listen(server, host = '127.0.0.1') {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  return server.address().port;
}
async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await Promise.race([new Promise(resolve => server.close(resolve)), sleep(1000)]);
}
async function startMock(handler) {
  const state = { calls: 0, headers: [], closed: 0 };
  const server = http.createServer((req, res) => {
    state.calls++;
    state.headers.push(req.headers);
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    res.on('close', () => { if (!res.writableEnded) state.closed++; });
    req.on('end', async () => {
      const result = await handler({ req, res, state, body: Buffer.concat(chunks) });
      if (result?.handled) return;
      if (result?.hang) {
        res.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
        if (result.prefix) res.write(result.prefix);
        res.flushHeaders();
        return;
      }
      const body = Buffer.from(result?.body ?? JSON.stringify({ error: { message: 'mock' } }));
      res.writeHead(result?.status ?? 200, { 'content-type': 'application/json', 'content-length': String(body.length) });
      res.end(body);
    });
  });
  const port = await listen(server);
  return { port, state, server };
}
async function startRouter(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-router-test-'));
  const mocks = [];
  try {
    for (let i = 0; i < 3; i++) mocks.push(await startMock(options.handlers?.[i] ?? (() => ({ status: 200, body: JSON.stringify({ id: 'chatcmpl-default', choices: [] }) }))));
    const historyDir = join(dir, 'history');
    await mkdir(historyDir);
    const files = {
      keys: join(dir, 'keys'), labels: join(dir, 'labels.json'), state: join(dir, 'last.json'),
      stats: join(dir, 'stats.json'), history: join(historyDir, 'history.jsonl'),
      quota: join(dir, 'quota-state', 'accounts.json'),
    };
    await writeFile(files.keys, 'key-a\nkey-b\nkey-c\n');
    await writeFile(files.labels, JSON.stringify([0, 1, 2].map(index => ({ index, label: `account-${index}`, proxy: `proxy-${index}`, port: mocks[index].port }))));
    await writeFile(files.state, '{}\n');
    await writeFile(files.stats, JSON.stringify(options.stats || {}));
    await writeFile(files.history, '');
    if (options.quota) {
      await mkdir(join(dir, 'quota-state'));
      await writeFile(files.quota, JSON.stringify(options.quota));
    }
    await writeFile(join(dir, 'client-key'), 'client-test\n');
    // A process-local test clock exercises the real slot/retention code without runtime test switches.
    const clock = join(dir, 'clock');
    const clockLoader = join(dir, 'clock.cjs');
    await writeFile(clock, String(Date.parse('2026-10-04T12:00:00+08:00')));
    await writeFile(clockLoader, `
      const fs = require('node:fs');
      const RealDate = Date;
      const now = () => Number(fs.readFileSync(${JSON.stringify(clock)}, 'utf8'));
      global.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [now()])); }
        static now() { return now(); }
      };
    `);
    const oldArchive = join(historyDir, 'account-history-2020-01-01.jsonl');
    const recentArchive = join(historyDir, 'account-history-2026-10-03.jsonl');
    await writeFile(oldArchive, 'old\n'); await writeFile(recentArchive, 'recent\n');
    const routerPort = await new Promise((resolve, reject) => {
      const probe = http.createServer();
      probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
    });
    const child = spawn(process.execPath, ['--require', clockLoader, join(ROOT, 'router.mjs')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(routerPort), ROUTER_PORTS: mocks.map(m => m.port).join(','), ROUTER_KEYS_FILE: files.keys,
        ROUTER_CLIENT_KEY_FILE: join(dir, 'client-key'), ROUTER_LABELS_FILE: files.labels, ROUTER_STATE_FILE: files.state,
        ROUTER_STATS_FILE: files.stats, ROUTER_HISTORY_FILE: files.history, ROUTER_HISTORY_DIR: historyDir,
        ROUTER_QUOTA_STATE_FILE: files.quota,
        ROUTER_BRIDGE_HOST: '127.0.0.2', ROUTER_UPSTREAM_TIMEOUT_MS: String(options.timeoutMs ?? 1000),
        ROUTER_ACCOUNT_COOLDOWN_MS: '60000', ROUTER_PRIMARY_ACCOUNT: options.primary === undefined ? '' : String(options.primary) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs = [];
    child.stdout.on('data', d => logs.push(d.toString())); child.stderr.on('data', d => logs.push(d.toString()));
    const base = `http://127.0.0.1:${routerPort}`;
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw new Error(`router exited: ${logs.join('')}`);
      try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
      await sleep(25);
      if (i === 59) throw new Error(`router did not start: ${logs.join('')}`);
    }
    return { base, child, mocks, files, historyDir, clock, logs: () => logs.join(''), async close() {
      if (child.exitCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        const guard = setTimeout(() => child.kill('SIGKILL'), 1500);
        try { await exited; } finally { clearTimeout(guard); }
      }
      await Promise.all(mocks.map(m => closeServer(m.server))); await rm(dir, { recursive: true, force: true });
    }};
  } catch (error) {
    await Promise.all(mocks.map(m => closeServer(m.server)));
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
async function post(router, body, headers = {}) {
  return fetch(`${router.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH, ...headers }, body: JSON.stringify(body) });
}
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false };
test('fixed primary survives time-slot changes and backup quota reset', async () => {
  const reset = Date.parse('2026-10-05T00:00:00+08:00');
  const router = await startRouter({ primary: 0, quota: { '1': {
    code: 'RATE_LIMITED', rateLimit: { window: 'weekly', limit: 5, remaining: 0, reset: reset / 1000 },
    until: reset, key_id: createHash('sha256').update('key-b').digest('hex'),
  } } });
  try {
    for (const now of ['2026-10-04T01:00:00+08:00', '2026-10-04T20:00:00+08:00', '2026-10-05T12:00:00+08:00']) {
      await writeFile(router.clock, String(Date.parse(now)));
      assert.equal((await post(router, CHAT)).status, 200);
    }
    const info = await (await fetch(router.base + '/admin/accounts', { headers: AUTH })).json();
    assert.deepEqual(info.routing, { mode: 'fixed-primary', primary: 0 });
    assert.equal(info.accounts[1].available, true);
    assert.deepEqual(router.mocks.map(m => m.state.calls), [3, 0, 0]);
  } finally { await router.close(); }
});
test('fixed primary uses a backup only on a later request after unavailability', async () => {
  const router = await startRouter({ primary: 0, handlers: [() => ({ status: 401 })] });
  try {
    assert.equal((await post(router, CHAT)).status, 401);
    assert.deepEqual(router.mocks.map(m => m.state.calls), [1, 0, 0]);
    assert.equal((await post(router, CHAT)).status, 200);
    assert.deepEqual(router.mocks.map(m => m.state.calls), [1, 1, 0]);
  } finally { await router.close(); }
});
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await sleep(20); }
  assert.fail('condition did not become true');
}
async function records(router) {
  return (await readFile(router.files.history, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('one request is never replayed to another account after 429', async () => {
  const router = await startRouter({ handlers: [0, 1, 2].map(() => () => ({ status: 429, body: JSON.stringify({ error: { message: 'rate limited' } }) })) });
  try {
    const response = await post(router, CHAT);
    assert.equal(response.status, 429);
    assert.equal(router.mocks.reduce((n, m) => n + m.state.calls, 0), 1);
  } finally { await router.close(); }
});

test('502 is returned without cross-account replay', async () => {
  const router = await startRouter({ handlers: [0, 1, 2].map(() => () => ({ status: 502, body: JSON.stringify({ error: { message: 'bad gateway' } }) })) });
  try {
    const response = await post(router, CHAT);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: { message: 'bad gateway' } });
    assert.equal(router.mocks.reduce((n, m) => n + m.state.calls, 0), 1);
  } finally { await router.close(); }
});

test('timeout is returned without cross-account replay', async () => {
  const router = await startRouter({ timeoutMs: 200, handlers: [1, 2, 3].map(() => () => ({ hang: true, prefix: '{"partial":' })) });
  try {
    const response = await post(router, CHAT);
    assert.equal(response.status, 200);
    await assert.rejects(response.text());
    await waitFor(() => router.logs().includes('upstream_timeout'));
    assert.equal(router.mocks.reduce((n, m) => n + m.state.calls, 0), 1);
  } finally { await router.close(); }
});

test('timeout before proxy headers is an error without cross-account replay', async () => {
  const router = await startRouter({ timeoutMs: 80, handlers: [1, 2, 3].map(() => ({ req, res }) => {
    // Hold before response headers, rather than simulating an accepted HTTP response.
    return new Promise(() => {});
  }) });
  try {
    const response = await post(router, CHAT);
    assert.equal(response.status, 502);
    assert.equal(router.mocks.reduce((n, m) => n + m.state.calls, 0), 1);
    assert.match(router.logs(), /upstream_timeout/);
  } finally { await router.close(); }
});

test('incoming request ID is forwarded and non-stream response ID is recorded', async () => {
  const router = await startRouter({ handlers: [0, 1, 2].map(() => ({ req, res }) => ({ status: 200, body: JSON.stringify({ id: 'chatcmpl-preserved', choices: [] }) })) });
  try {
    const requestId = 'gameradar-test-request-id';
    const response = await post(router, CHAT, { 'x-request-id': requestId });
    assert.equal(await response.text(), JSON.stringify({ id: 'chatcmpl-preserved', choices: [] }));
    assert.equal(response.headers.get('x-request-id'), requestId);
    const used = router.mocks.find(m => m.state.calls);
    assert.equal(used.state.headers[0]['x-request-id'], requestId);
    await waitFor(async () => (await records(router)).length === 1);
    const [history] = await records(router);
    assert.equal(history.router_request_id, requestId);
    assert.equal(history.request_id, requestId);
    assert.equal(history.response_id, 'chatcmpl-preserved');
    assert.equal(history.retry, false);
    assert.equal(history.label, 'account-1');
    assert.equal(history.proxy, 'proxy-1');
    const stats = JSON.parse(await readFile(router.files.stats, 'utf8'));
    const statsRow = Object.values(stats).find(row => row.days);
    assert.equal(statsRow.days[Object.keys(statsRow.days)[0]].attempts, 1);
  } finally { await router.close(); }
});

test('client disconnect aborts the current upstream and does not start another account', async () => {
  const router = await startRouter({ timeoutMs: 5000, handlers: [1, 2, 3].map(() => () => ({ hang: true })) });
  try {
    const request = http.request(`${router.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH } });
    request.on('error', () => {});
    request.end(JSON.stringify(CHAT));
    await waitFor(() => router.mocks.some(m => m.state.calls));
    request.destroy();
    await waitFor(() => router.mocks.some(m => m.state.closed));
    assert.equal(router.mocks.reduce((n, m) => n + m.state.calls, 0), 1);
    assert.match(router.logs(), /client_disconnected/);
    assert.match(router.logs(), /upstream_aborted/);
    await waitFor(async () => (await records(router)).length === 1);
    assert.equal((await records(router))[0].error, 'client disconnected');
  } finally { await router.close(); }
});

test('connection error never replays the current request or cools another account', async () => {
  const router = await startRouter({ handlers: [0, 1, 2].map(() => ({ req }) => {
    req.socket.destroy();
    return { handled: true };
  }) });
  try {
    const response = await post(router, CHAT);
    assert.equal(response.status, 502);
    await response.text();
    assert.equal(router.mocks.reduce((n, m) => n + m.state.calls, 0), 1);
    assert.doesNotMatch(router.logs(), /account_cooldown/);
  } finally { await router.close(); }
});

test('429 including idle timeout and zero-output does not mark the account unavailable', async () => {
  for (const message of ['Response timeout', 'Empty response from upstream (zero output tokens)']) {
    const router = await startRouter({ handlers: [0, 1, 2].map(() => () => ({
      status: 429, body: JSON.stringify({ error: { type: 'rate_limit_error', message } }),
    })) });
    try {
      for (let i = 0; i < 2; i++) await (await post(router, CHAT)).text();
      assert.deepEqual(router.mocks.map(m => m.state.calls), [0, 2, 0]);
      assert.doesNotMatch(router.logs(), /account_cooldown/);
    } finally { await router.close(); }
  }
});

test('eight-hour slots, history retention/rotation and saved statistics remain intact', async () => {
  const router = await startRouter();
  try {
    const times = ['2026-10-04T00:00:00+08:00', '2026-10-04T07:59:59+08:00',
      '2026-10-04T08:00:00+08:00', '2026-10-04T15:59:59+08:00',
      '2026-10-04T16:00:00+08:00', '2026-10-05T00:00:00+08:00'];
    let completed = 0;
    for (const time of times) {
      await writeFile(router.clock, String(Date.parse(time)));
      await (await post(router, CHAT)).text();
      completed++;
      await waitFor(async () => {
        try {
          const stats = JSON.parse(await readFile(router.files.stats, 'utf8'));
          return Object.values(stats).flatMap(row => Object.values(row.days)).reduce((n, day) => n + day.attempts, 0) === completed;
        } catch { return false; }
      });
    }
    await waitFor(() => router.logs().split('"event":"attempt"').length === 7);
    assert.deepEqual(router.mocks.map(m => m.state.calls), [3, 2, 1]);
    const files = await readdir(router.historyDir);
    assert.ok(!files.includes('account-history-2020-01-01.jsonl'));
    assert.ok(files.includes('account-history-2026-10-03.jsonl'));
    const archived = (await readFile(join(router.historyDir, 'account-history-2026-10-03.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(archived.length, 2);
    assert.ok(archived.every(row => row.index === 0));
    const state = JSON.parse(await readFile(router.files.state, 'utf8'));
    assert.equal(state['0'].label, 'account-0');
    assert.equal(state['2'].proxy, 'proxy-2');
    const stats = JSON.parse(await readFile(router.files.stats, 'utf8'));
    assert.equal(Object.values(stats).flatMap(s => Object.values(s.days)).reduce((n, s) => n + s.attempts, 0), 6);
    assert.equal(Object.values(stats).flatMap(s => Object.values(s.days)).reduce((n, s) => n + s.retries, 0), 0);
  } finally { await router.close(); }
});

test('loading existing statistics retains historical retry/error totals', async () => {
  const router = await startRouter({ stats: {
    '1': { index: 1, label: 'account-1', proxy: 'proxy-1', days: {
      '2026-10-04': { attempts: 9, success: 7, retries: 2, timeouts: 1, http_errors: 1 },
    } },
  } });
  try {
    await (await post(router, CHAT)).text();
    await waitFor(async () => {
      try {
        return JSON.parse(await readFile(router.files.stats, 'utf8'))['1'].days['2026-10-04'].attempts === 10;
      } catch { return false; }
    });
    const day = JSON.parse(await readFile(router.files.stats, 'utf8'))['1'].days['2026-10-04'];
    assert.equal(day.attempts, 10);
    assert.equal(day.success, 8);
    assert.equal(day.retries, 2);
    assert.equal(day.timeouts, 1);
    assert.equal(day.http_errors, 1);
  } finally { await router.close(); }
});

test('oversized or invalid JSON still passes unchanged when correlation cannot be extracted', async () => {
  for (const body of ['invalid JSON', JSON.stringify({ id: 'chatcmpl-big', padding: 'x'.repeat(2 * 1024 * 1024) })]) {
    const router = await startRouter({ handlers: [0, 1, 2].map(() => () => ({ body })) });
    try {
      assert.equal(await (await post(router, CHAT)).text(), body);
      await waitFor(async () => (await records(router)).length === 1);
      assert.equal((await records(router))[0].response_id, null);
    } finally { await router.close(); }
  }
});

test('all cooling accounts reject a new request without touching a proxy; expiration restores the slot', async () => {
  const router = await startRouter({ handlers: [0, 1, 2].map(() => () => ({ status: 401, body: '{}' })) });
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal((await post(router, CHAT)).status, 401);
      await waitFor(() => (router.logs().match(/"event":"account_cooldown"/g) || []).length === i + 1);
    }
    assert.equal((await post(router, CHAT)).status, 503);
    assert.deepEqual(router.mocks.map(m => m.state.calls), [1, 1, 1]);
    await writeFile(router.clock, String(Date.parse('2026-10-04T12:02:00+08:00')));
    assert.equal((await post(router, CHAT)).status, 401);
    assert.deepEqual(router.mocks.map(m => m.state.calls), [1, 2, 1]);
  } finally { await router.close(); }
});

test('streaming response remains transparent and its client disconnect closes the proxy connection', async () => {
  const router = await startRouter({ timeoutMs: 5000, handlers: [0, 1, 2].map(() => ({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"id":"chatcmpl-stream","choices":[]}\n\n');
    return { handled: true };
  }) });
  try {
    const controller = new AbortController();
    const response = await fetch(`${router.base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ ...CHAT, stream: true }), signal: controller.signal,
    });
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"id":"chatcmpl-stream","choices":[]}\n\n');
    controller.abort();
    await reader.cancel().catch(() => {});
    await waitFor(() => router.mocks.some(m => m.state.closed));
    assert.equal(router.mocks.reduce((n, m) => n + m.state.calls, 0), 1);
  } finally { await router.close(); }
});

test('an account rejected on one request is cooled down for the next new request', async () => {
  let rejected = false;
  const router = await startRouter({ handlers: [0, 1, 2].map((index) => ({ state }) => {
    if (!rejected && state.calls === 1) { rejected = true; return { status: 401, body: JSON.stringify({ error: { message: 'bad account' } }) }; }
    return { status: 200, body: JSON.stringify({ id: `chatcmpl-${index}`, choices: [] }) };
  }) });
  try {
    assert.equal((await post(router, CHAT)).status, 401);
    assert.equal((await post(router, CHAT)).status, 200);
    assert.equal(router.mocks.filter(m => m.state.calls).length, 2);
    assert.match(router.logs(), /account_cooldown/);
  } finally { await router.close(); }
});

const quotaReset = Date.parse('2026-10-04T12:01:00+08:00') / 1000;
const quotaError = { code: 'RATE_LIMITED', message: 'Weekly usage limit reached',
  rateLimit: { limit: 6, remaining: 0, reset: quotaReset, window: 'weekly' } };

test('real proxy quota rejection is not replayed; only the next request changes account', async () => {
  const proxy = await setup({ status: 429, errorBody: JSON.stringify({ error: quotaError }) });
  const router = await startRouter({ handlers: [undefined, async ({ body }) => {
    const response = await proxy.proxy.post('/v1/chat/completions', JSON.parse(body), { Authorization: 'Bearer user_test' });
    return { status: response.status, body: await response.text() };
  }] });
  try {
    const first = await post(router, { ...CHAT, stream: true });
    assert.equal(first.status, 429);
    assert.deepEqual((await first.json()).error.rateLimit, quotaError.rateLimit);
    await waitFor(() => router.logs().includes('quota_cooldown'));
    assert.deepEqual(router.mocks.map(m => m.state.calls), [0, 1, 0]);
    assert.equal(proxy.mock.generateCount(), 1);
    assert.equal((await post(router, CHAT)).status, 200);
    assert.deepEqual(router.mocks.map(m => m.state.calls), [0, 1, 1]);
    const saved = JSON.parse(await readFile(router.files.quota, 'utf8'));
    assert.equal(saved['1'].until, quotaReset * 1000);
    assert.equal(saved['1'].key_id, createHash('sha256').update('key-b').digest('hex'));
    const accounts = await (await fetch(router.base + '/admin/accounts', { headers: AUTH })).json();
    assert.equal(accounts.accounts[1].available, false);
    assert.equal(accounts.accounts[1].quota.rateLimit.window, 'weekly');
    assert.ok(!JSON.stringify(accounts).includes('key_id'));
    await waitFor(async () => (await records(router)).length === 2);
    assert.deepEqual((await records(router))[0].quota.rateLimit, quotaError.rateLimit);
  } finally { await router.close(); await proxy.close(); }
});

test('SSE quota error in HTTP 200 marks future requests without changing streamed bytes', async () => {
  const bytes = 'event: response.failed\r\ndata: ' + JSON.stringify({ response: { error: quotaError } }) + '\r\n\r\n';
  const router = await startRouter({ handlers: [undefined, ({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Split the frame delimiter across chunks to exercise the incremental observer.
    res.write(bytes.slice(0, -2)); setTimeout(() => res.end(bytes.slice(-2)), 20);
    return { handled: true };
  }] });
  try {
    const response = await post(router, { ...CHAT, stream: true });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), bytes);
    await waitFor(() => router.logs().includes('quota_cooldown'));
    assert.equal((await post(router, CHAT)).status, 200);
    assert.deepEqual(router.mocks.map(m => m.state.calls), [0, 1, 1]);
  } finally { await router.close(); }
});

test('ambiguous, temporary and invalid 429 quota signals do not disable accounts', async () => {
  const errors = [
    { ...quotaError, rateLimit: undefined },
    { ...quotaError, code: 'UNKNOWN' },
    { ...quotaError, rateLimit: { ...quotaError.rateLimit, window: 'hourly' } },
    { ...quotaError, rateLimit: { ...quotaError.rateLimit, remaining: 1 } },
    { ...quotaError, rateLimit: { ...quotaError.rateLimit, reset: 1 } },
    { ...quotaError, rateLimit: { ...quotaError.rateLimit, reset: String(quotaReset) } },
  ];
  let next = 0;
  const router = await startRouter({ handlers: [undefined, () => ({ status: 429, body: JSON.stringify({ error: errors[next++] }) })] });
  try {
    for (const error of errors) assert.equal((await post(router, CHAT)).status, 429);
    assert.deepEqual(router.mocks.map(m => m.state.calls), [0, errors.length, 0]);
    assert.doesNotMatch(router.logs(), /quota_cooldown/);
  } finally { await router.close(); }
});

test('saved quota survives a new process, expires automatically, and can be cleared with authentication', async () => {
  let saved;
  const first = await startRouter({ handlers: [undefined, () => ({ status: 429, body: JSON.stringify({ error: quotaError }) })] });
  try {
    await (await post(first, CHAT)).text();
    await waitFor(() => first.logs().includes('quota_cooldown'));
    saved = JSON.parse(await readFile(first.files.quota, 'utf8'));
  } finally { await first.close(); }
  const restored = await startRouter({ quota: saved });
  try {
    assert.equal((await post(restored, CHAT)).status, 200);
    assert.deepEqual(restored.mocks.map(m => m.state.calls), [0, 0, 1]);
    assert.equal((await fetch(restored.base + '/admin/accounts')).status, 401);
    assert.equal((await fetch(restored.base + '/admin/accounts/1/quota-cooldown', { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(restored.base + '/admin/accounts/1/quota-cooldown', { method: 'DELETE', headers: AUTH })).status, 204);
    assert.equal((await post(restored, CHAT)).status, 200);
    assert.deepEqual(restored.mocks.map(m => m.state.calls), [0, 1, 1]);
    assert.deepEqual(JSON.parse(await readFile(restored.files.quota, 'utf8')), {});
  } finally { await restored.close(); }
  const expired = await startRouter({ quota: saved });
  try {
    await writeFile(expired.clock, String(quotaReset * 1000));
    assert.equal((await post(expired, CHAT)).status, 200);
    assert.deepEqual(expired.mocks.map(m => m.state.calls), [0, 1, 0]);
    assert.deepEqual(JSON.parse(await readFile(expired.files.quota, 'utf8')), {});
  } finally { await expired.close(); }
  const replacedKey = await startRouter({ quota: { '1': { ...saved['1'], key_id: 'different-key' } } });
  try {
    assert.equal((await post(replacedKey, CHAT)).status, 200);
    assert.deepEqual(replacedKey.mocks.map(m => m.state.calls), [0, 1, 0]);
  } finally { await replacedKey.close(); }
});

test('all quota-exhausted accounts reject new requests without calling a proxy', async () => {
  const router = await startRouter({ handlers: [0, 1, 2].map(() => () => ({ status: 429, body: JSON.stringify({ error: quotaError }) })) });
  try {
    for (let i = 0; i < 3; i++) {
      await (await post(router, CHAT)).text();
      await waitFor(() => (router.logs().match(/"event":"quota_cooldown"/g) || []).length === i + 1);
    }
    assert.equal((await post(router, CHAT)).status, 503);
    assert.deepEqual(router.mocks.map(m => m.state.calls), [1, 1, 1]);
  } finally { await router.close(); }
});

async function usageReport(router, query = '') {
  const response = await fetch(router.base + '/admin/usage' + query, { headers: AUTH });
  assert.equal(response.status, 200);
  return response.json();
}

test('JSON usage is grouped by account, requested model and Beijing date without changing the response', async () => {
  const body = JSON.stringify({ id: 'chatcmpl-tokens', model: 'upstream-alias', choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } });
  const router = await startRouter({ handlers: [0, 1, 2].map(() => () => ({ body })) });
  try {
    await writeFile(router.clock, String(Date.parse('2026-10-04T00:01:00+08:00')));
    assert.equal(await (await post(router, { ...CHAT, model: 'Qwen/test' })).text(), body);
    await waitFor(async () => (await records(router)).length === 1);
    const report = await usageReport(router, '?from=2026-10-04&account=0&model=Qwen%2Ftest');
    assert.equal(report.timezone, 'Asia/Shanghai');
    assert.equal(report.source, 'proxy_response_usage');
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].label, 'account-0');
    assert.equal(report.rows[0].day, '2026-10-04');
    assert.equal(report.rows[0].model, 'Qwen/test');
    assert.equal(report.totals.calls, 1);
    assert.equal(report.totals.usage_reported, 1);
    assert.deepEqual(report.totals.tokens, { input_tokens: 100, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: null, total_tokens: 120 });
    assert.equal((await records(router))[0].usage_status, 'reported');
    assert.equal((await records(router))[0].usage.input_tokens, 100);
    const empty = await usageReport(router, '?account=1');
    assert.equal(empty.rows.length, 0);
    assert.equal(empty.totals.tokens.input_tokens, null);
  } finally { await router.close(); }
});

test('three streaming protocols count cumulative final usage once and preserve all bytes', async () => {
  const frames = [
    ['/v1/chat/completions', [
      { choices: [], usage: { prompt_tokens: 80, completion_tokens: 4 } },
      { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } },
      '[DONE]',
    ]],
    ['/v1/messages', [
      { type: 'message_start', message: { usage: { input_tokens: 70, output_tokens: 0, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 } } },
      { type: 'message_delta', usage: { output_tokens: 10 } },
      { type: 'message_delta', usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ]],
    ['/v1/responses', [
      { type: 'response.created', response: { usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 5 } } } },
    ]],
  ];
  for (const [path, values] of frames) {
    const bytes = values.map(value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\r\n\r\n').join('');
    const router = await startRouter({ handlers: [0, 1, 2].map(() => ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(bytes.slice(0, 27)); res.end(bytes.slice(27)); return { handled: true };
    }) });
    try {
      const response = await fetch(router.base + path, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ ...CHAT, stream: true }) });
      assert.equal(await response.text(), bytes);
      await waitFor(async () => (await records(router)).length === 1);
      const report = await usageReport(router);
      assert.equal(report.totals.calls, 1);
      assert.equal(report.totals.usage_reported, 1);
      assert.equal(report.totals.tokens.input_tokens, path === '/v1/messages' ? 105 : 100);
      assert.equal(report.totals.tokens.output_tokens, 20);
      assert.equal(report.totals.tokens.cache_read_tokens, 30);
      assert.equal(router.mocks.reduce((n, m) => n + m.state.calls, 0), 1);
    } finally { await router.close(); }
  }
});

test('missing usage and semantic/unfinished SSE errors are unknown or partial, never full zero usage', async () => {
  const cases = [
    { contentType: 'application/json', body: '{"choices":[]}', state: 'unknown', success: 1 },
    { contentType: 'text/event-stream', body: 'data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n', state: 'partial', success: 0 },
    { contentType: 'text/event-stream', body: 'data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: {"error":{"message":"upstream failed"}}\n\ndata: [DONE]\n\n', state: 'partial', success: 0 },
    { contentType: 'application/json', body: '{"usage":{"prompt_tokens":-1,"completion_tokens":"2"}}', state: 'unknown', success: 1 },
  ];
  for (const item of cases) {
    const router = await startRouter({ handlers: [0, 1, 2].map(() => ({ res }) => {
      res.writeHead(200, { 'content-type': item.contentType }); res.end(item.body); return { handled: true };
    }) });
    try {
      assert.equal(await (await post(router, { ...CHAT, stream: item.contentType === 'text/event-stream' })).text(), item.body);
      await waitFor(async () => (await records(router)).length === 1);
      const report = await usageReport(router);
      assert.equal(report.totals['usage_' + item.state], 1);
      assert.equal(report.totals.success, item.success);
      assert.equal(report.totals.tokens.input_tokens, null);
      if (item.state === 'partial') assert.equal(report.totals.partial_tokens.input_tokens, 10);
    } finally { await router.close(); }
  }
});

test('client disconnect keeps observed partial tokens without cross-account replay', async () => {
  const router = await startRouter({ timeoutMs: 5000, handlers: [0, 1, 2].map(() => ({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"usage":{"prompt_tokens":100,"completion_tokens":3}}\n\n');
    return { handled: true };
  }) });
  try {
    const controller = new AbortController();
    const response = await fetch(router.base + '/v1/chat/completions', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ ...CHAT, stream: true }), signal: controller.signal });
    await response.body.getReader().read(); controller.abort();
    await waitFor(async () => (await records(router)).length === 1);
    const report = await usageReport(router);
    assert.equal(report.totals.usage_partial, 1);
    assert.equal(report.totals.partial_tokens.input_tokens, 100);
    assert.equal(report.totals.tokens.input_tokens, null);
    assert.equal(report.totals.failed, 1);
    assert.equal(router.mocks.reduce((n, m) => n + m.state.calls, 0), 1);
  } finally { await router.close(); }
});

test('usage query is authenticated, validates filters, survives a new process and retains historical statistics', async () => {
  let stats;
  const first = await startRouter({ stats: { '1': { index: 1, days: { '2026-10-03': { attempts: 50, success: 40, retries: 2 } } } },
    handlers: [0, 1, 2].map(() => () => ({ body: JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 20 } }) })) });
  try {
    await (await post(first, { ...CHAT, model: '__proto__' })).text();
    await waitFor(async () => (await records(first)).length === 1);
    stats = JSON.parse(await readFile(first.files.stats, 'utf8'));
    assert.equal(stats['1'].days['2026-10-03'].attempts, 50);
  } finally { await first.close(); }
  const restored = await startRouter({ stats });
  try {
    assert.equal((await fetch(restored.base + '/admin/usage')).status, 401);
    for (const query of ['?from=2026-02-30', '?from=2026-10-04&to=2026-10-03', '?from=2026-01-01&to=2026-12-31', '?account=3'])
      assert.equal((await fetch(restored.base + '/admin/usage' + query, { headers: AUTH })).status, 400);
    const report = await usageReport(restored, '?model=__proto__');
    assert.equal(report.totals.calls, 1);
    assert.equal(report.totals.tokens.input_tokens, 100);
    assert.ok(report.tracking_started_at[1].started_at);
    await (await fetch(restored.base + '/v1/models', { headers: AUTH })).text();
    assert.equal((await usageReport(restored)).totals.calls, 1);
    assert.equal(restored.mocks.reduce((n, m) => n + m.state.calls, 0), 1);
  } finally { await restored.close(); }
});

test('real core proxy responses produce equivalent total input usage across three protocols', async () => {
  const upstreamUsage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, inputTokenDetails: { cacheWriteTokens: 5 } };
  const proxy = await setup({ ndjson: [
    JSON.stringify({ type: 'text-delta', text: 'hello' }),
    JSON.stringify({ type: 'finish-step', finishReason: 'stop', usage: upstreamUsage }),
    JSON.stringify({ type: 'finish', finishReason: 'stop', totalUsage: upstreamUsage }),
  ] });
  const router = await startRouter({ handlers: [0, 1, 2].map(() => async ({ req, res, body }) => {
    const response = await proxy.proxy.post(req.url, JSON.parse(body), { Authorization: 'Bearer user_test' });
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') });
    res.end(await response.text());
    return { handled: true };
  }) });
  try {
    const requests = [
      ['/v1/chat/completions', CHAT],
      ['/v1/messages', { model: 'm', max_tokens: 30, messages: CHAT.messages }],
      ['/v1/responses', { model: 'm', input: 'hi' }],
    ];
    let completed = 0;
    for (const [path, body] of requests) for (const stream of [false, true]) {
      const response = await fetch(router.base + path, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, stream }) });
      assert.equal(response.status, 200);
      await response.text();
      completed++;
      await waitFor(async () => (await records(router)).length === completed);
      const last = (await records(router)).at(-1);
      assert.equal(last.usage_status, 'reported', path + ' stream=' + stream);
      assert.equal(last.usage.input_tokens, 100);
      assert.equal(last.usage.output_tokens, 20);
    }
    const report = await usageReport(router);
    assert.equal(report.totals.calls, 6);
    assert.equal(report.totals.tokens.input_tokens, 600);
    assert.equal(report.totals.tokens.output_tokens, 120);
    assert.equal(report.totals.tokens.cache_read_tokens, 180);
    assert.equal(report.totals.tokens.cache_write_tokens, 20);
    assert.equal(report.totals.token_reports.cache_write_tokens, 4);
    assert.equal(proxy.mock.generateCount(), 6);
  } finally { await router.close(); await proxy.close(); }
});
