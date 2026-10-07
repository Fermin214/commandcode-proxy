# Self-hosted account router

The router is a fork-owned deployment layer. `proxy.mjs` follows MAXeaglet
upstream with one error-metadata extension: validated `error.rateLimit`
(`limit`, `remaining`, `reset` in Unix seconds, `window`) is retained across
Chat Completions, Responses and Anthropic JSON/SSE errors. Unrelated provider
fields are omitted. Existing status mapping and retry hints remain unchanged;
the proxy itself does not manage account availability.

## One request, one account

The primary account rotates in Beijing time: account 0 at 00:00-07:59,
account 1 at 08:00-15:59, and account 2 at 16:00-23:59.
Every incoming request is forwarded once to the account chosen before sending.
HTTP 429/5xx, connection errors and timeouts never replay that request on another
account. This matters because the inner proxy also uses 429 for idle timeouts
and zero-output results; a status alone cannot establish safe regeneration.

An HTTP 401/403 from the selected internal proxy places that account in a
five-minute, in-memory cooldown. Only later incoming requests may choose another
account. Authentication cooldowns remain in memory. When all accounts are
cooling down, the router answers 503 without contacting any proxy. Expiration
allows the ordinary time-slot selection again; restarting clears cooldowns.
The router's own client-auth rejection does not cool an upstream account.

## Quota exhaustion

A structured error with code `RATE_LIMITED` or `USAGE_EXCEEDED`, a `weekly`
or `monthly` window, positive limit, zero remaining, and a valid future reset
temporarily removes that account from selection. The original request is still
returned unchanged and is never replayed. Only later incoming requests select
another account. Plain 429s, hourly limits, idle timeouts, zero output, missing
metadata and expired/invalid reset timestamps do not trigger quota cooldown.
JSON error bodies and bounded SSE error frames are observed without buffering
or delaying the response sent to the client.

Quota cooldowns are saved in the ignored `quota-state/accounts.json` directory
mount, separate from authentication cooldowns and call history. They survive
router/container restarts and expire when the provider's reset time arrives.
Saved rows are bound to a SHA-256 digest of the account key, so replacing a key
does not inherit the previous account's cooldown. Credentials and model text
are never saved. A malformed state file stops startup rather than silently
forgetting exhausted accounts; inspect/repair the state file before restarting.
The directory mount permits atomic file replacement (unlike a single-file
bind mount). State-write failures are logged; a failed manual-clear write
returns 503 rather than reporting success.

Two operations use the existing router bearer authentication:

- `GET /admin/accounts`: account labels, availability, quota/reset information
  and authentication-cooldown expiry; no keys or key digests.
- `DELETE /admin/accounts/<index>/quota-cooldown`: clear a saved quota cooldown
  after an upgrade or other confirmed early quota restoration. This does not
  generate a model request or clear the authentication cooldown.

Quota events and affected request history include only the quota fields and
account label. All-account unavailability still returns 503 without contacting
a proxy. Already in-flight requests can finish after a cooldown is discovered.
Until reset, backup accounts take more traffic and may exhaust their quotas too.

This guarantees one **router-to-proxy** request per incoming request. The
unmodified upstream `proxy.mjs` still has its own bounded same-account
connection retry behavior. The router does not claim to eliminate those retries
or to know whether an interrupted CommandCode generation was billed.

## Cancellation and correlation

Client disconnect destroys the current router-to-proxy request and records
`client_disconnected`, `upstream_aborted` and the final attempt. Closing that
connection allows the inner proxy's existing downstream-close handling to act.

The router preserves an incoming `x-request-id` (up to 200 characters), or
generates a UUID. It forwards and returns this ID. For non-streaming
`/v1/chat/completions`, a bounded copy of an uncompressed JSON response is used
to record the original `chatcmpl-*` ID together with:

```text
router_request_id / request_id
response_id
index / label / proxy / port
status / duration_ms / error
```

The body is piped unchanged, rather than rewritten or buffered before delivery.
Responses larger than 2 MiB, compressed responses, invalid JSON and streaming
responses still pass through; their `response_id` is left null. Model text and
credentials are not stored in history.

Existing last-call files, per-account daily statistics, daily history rotation
and 90-day retention remain. Historical retry totals are retained; this router
does not increment them. A disconnected or incomplete attempt is not counted as
a successful request.

## Compatibility boundary

Upstream `buildCcRequest()` currently drops OpenAI `response_format`, model
`thinking` and `enable_thinking` fields. The router does not invent CommandCode
equivalents or convert non-JSON model content into HTTP errors. Consumers should
declare their model presets accordingly. `reasoning_effort` is forwarded by the
inner proxy, but low reasoning is not a claim that thinking is disabled.

## Configuration and checks

Existing Compose account labels, keys and state mounts are used unchanged.
Optional router settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ROUTER_UPSTREAM_TIMEOUT_MS` | `125000` | Internal connection idle timeout; never authorizes replay |
| `ROUTER_ACCOUNT_COOLDOWN_MS` | `300000` | Authentication-error cooldown for later requests |
| `ROUTER_BRIDGE_HOST` | `172.23.0.1` | Additional local listener; loopback in isolated tests |
| `ROUTER_QUOTA_STATE_FILE` | `/data/quota-state/accounts.json` | Persistent quota state; Compose mounts the containing directory |

For an existing production installation, create `quota-state/` before applying
the updated Compose file. Rebuild the proxy image and recreate all three proxies
plus the router, retaining the key, label, history and statistics files. Replace
temporary fixed-account routing with the normal slots only after the known
exhausted account is present in quota state. Rollback can restore the preceding
image, router and Compose file; retain quota state for a subsequent rollout.

Run `node --test test/router.test.mjs` using only local mock servers and fake
keys. To run the unchanged upstream test suite in a fresh fork checkout, first
copy `config.example.json` to the ignored `config.json`, then run
`node --test test/*.test.mjs`.

Changing an isolated checkout does not deploy it. Apply the reviewed patch to
the deployment checkout and restart the router only in a separately authorized
release.
