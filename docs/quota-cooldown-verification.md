# Quota cooldown verification

Date: 2026-10-07 (Asia/Hong_Kong).

The production QQ main account returned a structured 429 with
`error.code=RATE_LIMITED`, `rateLimit.window=weekly`, `remaining=0` and a Unix
reset timestamp. The former proxy discarded that object while the router
cooled only 401/403 authentication failures. Its temporary fixed-slot patch
avoided the exhausted account but required manual restoration.

The fork preserves the four validated quota fields across Chat Completions,
Responses and Anthropic JSON/SSE error paths. The router observes them, saves
weekly/monthly exhaustion until the supplied reset, skips unavailable accounts
for subsequent requests and allows authenticated inspection/manual clearing.
Existing status/retry hints, request cancellation and the no-cross-account-replay
contract are retained. No GameRadar worker, receipt or database changes.

Verification uses existing local HTTP mock processes plus targeted cases for
the persistence/recovery boundary that a production success probe cannot cover:

- Three protocols, streaming/non-streaming and HTTP/NDJSON quota errors.
- Real proxy-to-router rejection, unchanged response, one upstream generation,
  next-request account selection and correlated quota history.
- Bounded SSE observation with a split frame delimiter.
- Ambiguous/invalid/expired/hourly limits do not disable an account.
- New-process restoration, expiry, authenticated manual clear and key replacement.
- All accounts exhausted: 503 without contacting any proxy.

Windows Node 24: `node --test --test-concurrency=1 test/*.test.mjs` passed 63/63.
The initial parallel full run had one Windows loopback `ECONNRESET`; the serial
run passed. Sandbox file-renaming restrictions also affected existing history
rotation and new quota persistence; verification ran with ordinary user access
without changing filesystem permissions. No tests access paid services.

Production deployment and live probes are recorded after release; local passing
tests alone do not establish that the running server has this version.
