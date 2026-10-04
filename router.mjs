import http from 'node:http';
import crypto from 'node:crypto';
const { randomUUID } = crypto;
import fs from 'node:fs';

const keys = fs.readFileSync(process.env.ROUTER_KEYS_FILE || '/data/user-keys.txt', 'utf8')
  .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
if (keys.length < 3) throw new Error('router requires at least 3 upstream keys');
const accountLabels = (() => {
  const file = process.env.ROUTER_LABELS_FILE || '/data/account-labels.json';
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Map(rows.filter(row => Number.isInteger(row.index)).map(row => [row.index, row]));
  } catch (error) {
    log('warn', { event: 'account_labels_unavailable', error: error.message });
    return new Map();
  }
})();
const accountStateFile = process.env.ROUTER_STATE_FILE || '/data/account-last-call.json';
const accountHistoryFile = process.env.ROUTER_HISTORY_FILE || '/data/account-history/account-history.jsonl';
const accountHistoryDir = process.env.ROUTER_HISTORY_DIR || '/data/account-history';
const accountHistoryRetentionDays = Number(process.env.ROUTER_HISTORY_RETENTION_DAYS || 90);
let historyDay = new Date().toISOString().slice(0, 10);
const accountStatsFile = process.env.ROUTER_STATS_FILE || '/data/account-stats.json';
let accountLastCall = {};
try { accountLastCall = JSON.parse(fs.readFileSync(accountStateFile, 'utf8')) || {}; } catch {}
let accountStats = {};
try { accountStats = JSON.parse(fs.readFileSync(accountStatsFile, 'utf8')) || {}; } catch {}
function accountMeta(index) {
  return accountLabels.get(index) || { index, label: `账号-${index + 1}`, proxy: `proxy-${String.fromCharCode(97 + index)}`, port: ports[index] };
}
function pruneAccountHistory(today) {
  const days = Number.isFinite(accountHistoryRetentionDays) && accountHistoryRetentionDays > 0 ? accountHistoryRetentionDays : 90;
  const cutoff = Date.parse(`${today}T00:00:00.000Z`) - days * 86400000;
  try {
    for (const name of fs.readdirSync(accountHistoryDir)) {
      const match = /^account-history-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (match && Date.parse(`${match[1]}T00:00:00.000Z`) < cutoff) fs.unlinkSync(`${accountHistoryDir}/${name}`);
    }
  } catch (error) { log('warn', { event: 'account_history_prune_failed', error: error.message }); }
}
function rotateAccountHistory(today) {
  if (today === historyDay) return;
  try {
    if (fs.existsSync(accountHistoryFile) && fs.statSync(accountHistoryFile).size > 0) {
      fs.renameSync(accountHistoryFile, `${accountHistoryDir}/account-history-${historyDay}.jsonl`);
    }
    fs.writeFileSync(accountHistoryFile, '');
    historyDay = today;
    pruneAccountHistory(today);
  } catch (error) { log('warn', { event: 'account_history_rotate_failed', error: error.message }); }
}
pruneAccountHistory(historyDay);

function recordAccountCall(index, fields) {
  const account = accountMeta(index);
  const key = String(index);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const event = { index, label: account.label, proxy: account.proxy, port: account.port, ...fields };
  accountLastCall[key] = event;
  const stats = accountStats[key] || { index, label: account.label, proxy: account.proxy, port: account.port, days: {} };
  stats.index = index; stats.label = account.label; stats.proxy = account.proxy; stats.port = account.port;
  const dayStats = stats.days[day] || { attempts: 0, success: 0, retries: 0, timeouts: 0, http_errors: 0, last_started_at: null, last_finished_at: null };
  dayStats.attempts += 1;
  if (fields.retry) dayStats.retries += 1;
  if (fields.status !== null && fields.status >= 200 && fields.status < 300 && !fields.error) dayStats.success += 1;
  if (fields.error && /timeout/i.test(fields.error)) dayStats.timeouts += 1;
  if (fields.status !== null && fields.status >= 400) dayStats.http_errors += 1;
  dayStats.last_started_at = fields.started_at; dayStats.last_finished_at = fields.finished_at;
  stats.days[day] = dayStats; accountStats[key] = stats;
  try {
    rotateAccountHistory(day);
    fs.appendFileSync(accountHistoryFile, JSON.stringify(event) + '\n');
    fs.writeFileSync(accountStateFile, JSON.stringify(accountLastCall, null, 2) + '\n');
    fs.writeFileSync(accountStatsFile, JSON.stringify(accountStats, null, 2) + '\n');
  } catch (error) { log('warn', { event: 'account_state_write_failed', error: error.message }); }
}
const clientKey = process.env.ROUTER_CLIENT_KEY || fs.readFileSync(process.env.ROUTER_CLIENT_KEY_FILE || '/data/router-client-key', 'utf8').trim();
if (!clientKey) throw new Error('router client key is required');
const ports = (process.env.ROUTER_PORTS || '3051,3052,3053').split(',').map(Number);
const accountCount = Math.min(keys.length, ports.length);
const listenPort = Number(process.env.PORT || 3060);
const bridgeHost = process.env.ROUTER_BRIDGE_HOST || '172.23.0.1';
const upstreamTimeoutMs = Number.parseInt(process.env.ROUTER_UPSTREAM_TIMEOUT_MS || '', 10) > 0
  ? Number.parseInt(process.env.ROUTER_UPSTREAM_TIMEOUT_MS, 10) : 125000;
const accountCooldownMs = Number.parseInt(process.env.ROUTER_ACCOUNT_COOLDOWN_MS || '', 10) > 0
  ? Number.parseInt(process.env.ROUTER_ACCOUNT_COOLDOWN_MS, 10) : 5 * 60 * 1000;
const hosts = ports.map(port => `http://127.0.0.1:${port}`);
const accountCooldownUntil = new Map();
function slot(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false }).format(now)) % 24;
  return Math.floor(h / 8) % accountCount;
}
function log(event, fields = {}) { console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields })); }
function authorized(req) {
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${clientKey}`;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 32 * 1024 * 1024) { reject(Object.assign(new Error('request too large'), { statusCode: 413 })); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function requestIdFrom(req) {
  const value = req.headers['x-request-id'];
  return typeof value === 'string' && value.trim() && value.length <= 200 ? value.trim() : randomUUID();
}
function selectAccount(primary) {
  const now = Date.now();
  for (let offset = 0; offset < accountCount; offset++) {
    const index = (primary + offset) % accountCount;
    if ((accountCooldownUntil.get(index) || 0) <= now) return index;
  }
  return null;
}
function markAccountUnavailable(index, status, requestId) {
  if (status !== 401 && status !== 403) return;
  const until = Date.now() + accountCooldownMs;
  accountCooldownUntil.set(index, until);
  log('warn', { event: 'account_cooldown', request_id: requestId, account: accountMeta(index).label, proxy: accountMeta(index).proxy, status, cooldown_ms: accountCooldownMs });
}
function responseIdFrom(body) {
  if (!body || body.length > 2 * 1024 * 1024) return null;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return typeof parsed?.id === 'string' && parsed.id.startsWith('chatcmpl-') && parsed.id.length <= 200 ? parsed.id : null;
  } catch { return null; }
}
function sendRouterError(res, result) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const status = result.status || 502;
  const headers = { 'content-type': 'application/json' };
  if (status >= 500) headers['retry-after'] = '10';
  res.writeHead(status, headers);
  res.end(JSON.stringify({ error: { type: 'upstream_error', message: result.error || 'upstream request failed' } }));
}
function forward(req, res, index, body, requestId, state, nonStream) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      state.upstream = null;
      resolve(result);
    };
    const target = new URL(req.url, hosts[index % hosts.length]);
    const headers = { ...req.headers, host: `127.0.0.1:${ports[index % ports.length]}`, authorization: `Bearer ${keys[index % keys.length]}` };
    delete headers['x-api-key'];
    headers['x-request-id'] = requestId;
    if (body) {
      delete headers['transfer-encoding'];
      headers['content-length'] = String(body.length);
    }
    const upstream = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers }, upstreamRes => {
      if (state.clientDisconnected || res.destroyed) {
        upstreamRes.destroy();
        return finish({ clientDisconnected: true, error: 'client disconnected' });
      }
      const status = upstreamRes.statusCode || 502;
      markAccountUnavailable(index, status, requestId);
      // Observe a bounded copy for correlation; the response itself remains a byte-for-byte pipe.
      let chunks = nonStream && /^application\/json\b/i.test(upstreamRes.headers['content-type'] || '')
        && (!upstreamRes.headers['content-encoding'] || upstreamRes.headers['content-encoding'] === 'identity') ? [] : null;
      let capturedBytes = 0;
      upstreamRes.on('data', chunk => {
        if (!chunks) return;
        capturedBytes += chunk.length;
        if (capturedBytes > 2 * 1024 * 1024) { chunks = null; return; }
        chunks.push(chunk);
      });
      upstreamRes.on('end', () => finish({
        status,
        responseId: chunks ? responseIdFrom(Buffer.concat(chunks)) : null,
      }));
      upstreamRes.on('error', error => finish({ status, error: error.message }));
      res.writeHead(status, { ...upstreamRes.headers, 'x-request-id': requestId });
      upstreamRes.pipe(res);
    });
    state.upstream = upstream;
    upstream.setTimeout(upstreamTimeoutMs, () => {
      log('warn', { event: 'upstream_timeout', request_id: requestId, account: accountMeta(index).label, proxy: accountMeta(index).proxy, timeout_ms: upstreamTimeoutMs });
      upstream.destroy(new Error('upstream timeout'));
    });
    upstream.on('error', error => {
      if (state.clientDisconnected) return finish({ clientDisconnected: true, error: error.message });
      finish({ error: error.message });
    });
    if (body?.length) upstream.write(body);
    upstream.end();
  });
}
const server = http.createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200, {'content-type':'text/plain'}); res.end('OK'); return; }
  if (!authorized(req)) { res.writeHead(401, {'content-type':'application/json'}); res.end(JSON.stringify({error:{type:'auth_error',message:'invalid router key'}})); return; }
  const requestId = requestIdFrom(req);
  res.setHeader('x-request-id', requestId);
  const primary = slot();
  const index = selectAccount(primary);
  if (index === null) {
    log('warn', { event: 'all_accounts_cooling_down', request_id: requestId, scheduled: primary });
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'upstream_error', message: 'all accounts are cooling down' } }));
    return;
  }
  const state = { clientDisconnected: false, upstream: null };
  const onClientClose = () => {
    if (res.writableEnded || state.clientDisconnected) return;
    state.clientDisconnected = true;
    log('warn', { event: 'client_disconnected', request_id: requestId, account: accountMeta(index).label, proxy: accountMeta(index).proxy });
    if (state.upstream && !state.upstream.destroyed) {
      log('warn', { event: 'upstream_aborted', request_id: requestId, account: accountMeta(index).label, proxy: accountMeta(index).proxy });
      state.upstream.destroy(new Error('client disconnected'));
    }
  };
  res.once('close', onClientClose);
  req.once('aborted', onClientClose);
  let body;
  try { body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req); }
  catch (e) {
    res.off('close', onClientClose);
    req.off('aborted', onClientClose);
    if (!res.destroyed) {
      res.writeHead(e.statusCode || 400, {'content-type':'application/json'});
      res.end(JSON.stringify({error:{type:'invalid_request_error',message:e.message}}));
    }
    return;
  }
  if (state.clientDisconnected || res.destroyed) return;
  let requestMeta = {};
  try {
    const parsed = JSON.parse(body?.toString('utf8') || '{}');
    requestMeta = { model: typeof parsed.model === 'string' ? parsed.model : null, stream: parsed.stream === true };
  } catch {}
  log('request', { request_id: requestId, method: req.method, path: req.url, scheduled: primary, scheduled_account: accountMeta(primary).label, actual: index, account: accountMeta(index).label, ...requestMeta });
  const startedAt = new Date();
  const startedMs = Date.now();
  const last = await forward(req, res, index, body, requestId, state, new URL(req.url, 'http://localhost').pathname === '/v1/chat/completions' && requestMeta.stream === false);
  if (last.error && !state.clientDisconnected) sendRouterError(res, last);
  res.off('close', onClientClose);
  req.off('aborted', onClientClose);
  const finishedAt = new Date();
  const fields = { request_id: requestId, router_request_id: requestId, started_at: startedAt.toISOString(), finished_at: finishedAt.toISOString(), duration_ms: Date.now() - startedMs, status: last.status ?? null, retry: false, error: state.clientDisconnected ? 'client disconnected' : last.error || null, response_id: last.responseId || null, model: requestMeta.model, stream: requestMeta.stream, method: req.method, path: req.url };
  log('attempt', { scheduled: primary, scheduled_account: accountMeta(primary).label, actual: index, account: accountMeta(index).label, proxy: accountMeta(index).proxy, ...fields });
  recordAccountCall(index, fields);
});
server.listen(listenPort, '127.0.0.1', () => log('started', { port: listenPort, accounts: accountCount, upstream_timeout_ms: upstreamTimeoutMs, cross_account_retry: 'disabled' }));
for (const signal of ['SIGTERM', 'SIGINT']) signal && process.on(signal, () => server.close(() => process.exit(0)));

const bridgeServer = http.createServer(server.listeners('request')[0]);
bridgeServer.listen(listenPort, bridgeHost);
process.on('SIGTERM', () => bridgeServer.close());
process.on('SIGINT', () => bridgeServer.close());
