import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

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
    };
    await writeFile(files.keys, 'key-a\nkey-b\nkey-c\n');
    await writeFile(files.labels, JSON.stringify([0, 1, 2].map(index => ({ index, label: `account-${index}`, proxy: `proxy-${index}`, port: mocks[index].port }))));
    await writeFile(files.state, '{}\n');
    await writeFile(files.stats, JSON.stringify(options.stats || {}));
    await writeFile(files.history, '');
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
        ROUTER_BRIDGE_HOST: '127.0.0.2', ROUTER_UPSTREAM_TIMEOUT_MS: String(options.timeoutMs ?? 1000),
        ROUTER_ACCOUNT_COOLDOWN_MS: '60000' },
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
