# Account/model usage verification

Date: 2026-10-07 (Asia/Hong_Kong).
Baseline: `5f529906f5b173783f21d3280f8b2070ac8cdfe1`.

The change observes response usage only in the fork-owned router. `proxy.mjs`
is unchanged. Per-request usage is persisted beside existing history and the
account/model/Beijing-day aggregates use the existing statistics file. The
authenticated usage query does not contact a provider. Missing and partial usage
are separate from full reports; unknown fields are null, not fabricated zeros.

Targeted checks cover the boundaries not reliably exercised by a live happy-path
request: three protocols and JSON/SSE, cache accounting, cumulative-event dedup,
client disconnect/semantic failure/truncation, new-process restoration, UTC versus
Beijing date, query validation/authentication and safe model-name dictionary keys.
The real core-proxy-to-router mock chain reports equivalent total input for all
three protocols, generates exactly six requested responses and preserves normal
forwarding. Existing quota/cancellation/no-replay tests remain enabled.

Full Windows/Linux results and production query evidence are retained in the
ignored release log after verification. Production usage starts with deployment;
the existing historical records do not contain recoverable token values.
