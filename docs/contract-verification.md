# Contract repair verification

Date: 2026-10-04 (Asia/Hong_Kong).

## Source and delivery

- ccproxy fork baseline: `e54a68d6bd520bbbc98ae9d56de627fa7bceeb82`.
- MAXeaglet upstream snapshot checked: `ce5a217`.
- Working checkout: `C:\Projects\commandcode-proxy`; the implementation is maintained as a fork-owned change.
- The reviewed patch was applied to the clean local fork baseline.
- Changed files: `router.mjs`, `test/router.test.mjs`, `ROUTER.md`, and this verification record.
- `proxy.mjs` and the upstream tests/helpers were not changed.
- The production bind-mounted router file was restored to its baseline.
  The source had initially been edited there; further work was moved to an
  isolated checkout before any service restart. No production deployment ran.

GameRadar's preset file is `site/models.ts`, exported by `site/package.json`.
The existing official/ccproxy preset separation and `.env.example` changes
from the other task were preserved. Backend, receipts, migrations, timeouts and
business logic have no worktree changes.

## Router checks

The upstream suite has 41 existing tests; all passed. The 14 router tests cover:

- 429, 502, connection errors and both pre-header/post-output timeout paths
  without cross-account replay.
- Cancellation of the active internal connection, including streaming.
- Incoming request ID inheritance and the unchanged JSON response ID mapping.
- Exact response body preservation for valid, invalid and oversized responses.
- Authentication cooldown for later requests only; all-account cooldown and
  automatic expiration.
- Beijing eight-hour rotation, daily archive rotation and retention, historical
  statistics, account labels and error counters.

An initial aggregate run had one assertion reading persisted statistics before
the write completed. After synchronizing that test on the saved attempt count,
the final router run passed 14/14. The 41 unchanged upstream results were not
rerun unnecessarily. After moving to the real local fork checkout, a clock-fixture assertion needed the same persistence synchronization; the final Windows router run passed 14/14. One unchanged upstream Responses test had a loopback reset in the parallel Windows run and passed its isolated rerun. Linux tested on the server's Node runtime; Windows also
tested the router lifecycle suite on Node 24.

## GameRadar checks

- `npm run typecheck`: passed.
- `npm run build -w @aihot/web`: passed.
- `node --test apps/web/tests/*.test.ts`: 27/27 passed.
- Relevant existing backend tests: 40/40 passed across the ten selected files,
  using PostgreSQL 17 in an internal Docker network.
- Direct current-preset contract checks: the four verified ccproxy presets
  send no `response_format`, `thinking` or `enable_thinking`; send
  `reasoning_effort: low`; parse fenced JSON using the existing parser/schema;
  save the original `chatcmpl-*` ID; reuse saved receipts without a new call.
  Official DeepSeek, its think preset, and official MiMo retain their request behavior.

The existing analysis/grouping fixtures point their local stubs at official
preset variables. Their run used the corresponding official preset selections
through existing environment overrides, without editing the tests. The actual
ccproxy presets were checked separately against a local stub.

This is not a claim that the entire original CI suite passed. An initial native
Windows full run was stopped after routing mismatches and timeouts over an SSH
database tunnel; server-local, relevant tests replaced it. Administrator tests
were rerun with `NODE_ENV=test` after the production image's inherited setting
had returned 401. No production keys or model endpoints were used in these
checks, and all test database containers/networks were removed.

## Final preset declarations

| Preset | jsonMode | Extra |
| --- | --- | --- |
| glm-5.3-flash-ccproxy | false | reasoning_effort: low |
| deepseek-flash-ccproxy | false | reasoning_effort: low |
| qwen3.8-flash-ccproxy | false | reasoning_effort: low |
| mimo-v2.6-flash-ccproxy | false | reasoning_effort: low |

MiMo was subsequently verified at the user's request with two authorized
production-model protocol calls outside the GameRadar queue. The exact same
short JSON fixture succeeded in both:

| Input controls | HTTP | Reasoning characters | Output tokens | Duration |
| --- | --- | --- | --- | --- |
| thinking.type: disabled | 200 | 95 | 49 | 3602 ms |
| reasoning_effort: low | 200 | 105 | 51 | 7302 ms |

These samples confirm that the current proxy path does not disable MiMo
thinking, and accepts low effort; they do not demonstrate a reduction in
latency or reasoning consumption. A captured mock CommandCode request from the
unchanged proxy additionally confirmed `params.reasoning_effort: low` and the
absence of `thinking`, `enable_thinking`, and `response_format`. Official MiMo
keeps `thinking.type: disabled`; the ccproxy preset now declares low intensity.
No ccproxy think-specific preset was added; the existing official think preset
was retained.

## Remaining boundary

The router guarantees one internal proxy request, not one provider generation:
unmodified upstream `proxy.mjs` retains its own bounded same-account retries.
Its cancellation listener is currently registered after receiving a
CommandCode response. Closing the router connection triggers the existing
handler when active, but cannot guarantee pre-response cancellation inside that
unmodified handler. This limitation does not prevent the requested router
boundary from being implemented.

No missing requirement in this task forced a change to `proxy.mjs`. Native
JSON mode, native thinking-disable semantics, upstream-internal retry policy
and the early cancellation-listener limitation remain upstream capabilities.
