# Full-stack functional validation — 2026-11-16/17

**Overall: not passed. Automatic resolution after a real fix remains unvalidated.**
The prior [quality calibration](../2026-11-16-review/README.md) remains failed or
unmeasured. This run changes no labels, thresholds or confirmation judgments.

The final backend was built with Nest webpack and normal API/worker entrypoints,
with fresh migrations/seeds, an isolated PostgreSQL/Mongo database and RabbitMQ
vhost. Tests used real REST, NextAuth, outbox/inbox, the dedicated worker,
GitHub private clones, persisted BYOK configuration, Fireworks and E2B. No engine,
queue or persistence gateway was substituted. Application source is pinned in
[public-final.json](public-final.json); the only subsequent application change
fixes the duplicated `@` in CODEOWNERS display, verified in Chromium.

| Scenario | Result | Evidence |
| --- | --- | --- |
| Browser login, validation, scan start | Pass | [UI start](ui-start.json) |
| Finding appears without reloading | Pass | [Live observation](ui-finding-live.json) |
| Details, ownership, prompt, actual clipboard, history | Pass | [UI result](ui-finding.json), [screenshot](ui-finding-details.png) |
| Actual isolated reproduction of known command injection | Pass | [Original finding/test/output](initial-findings.json) |
| Stable identity on unchanged commit | Pass | [Lifecycle](lifecycle.json), [database/queue records](pipeline-final.json) |
| One-token cap: zero model requests, no resolution | Pass | [Final records](pipeline-final.json) |
| Tenant fences, repository-scoped start, simultaneous-start rejection | Pass | [RBAC](rbac.json), [HTTP checks](lifecycle.json) |
| Alpha and self-hosted API gates; hidden alpha UI | Pass | [Gates](gates.json), [screenshot](ui-alpha-closed.png) |
| Seven CLI list/filter/prompt/isolation cases | Pass | [CLI](cli.json) |
| Two actual duplicate RabbitMQ deliveries | Pass | [Replay](replay.json): same inbox, issue/miss counter and spend |
| Complete coverage of vulnerable/unchanged repository | Fail | Both retained one incomplete resource-exhaustion area |
| Two complete scans after fixing the vulnerable code | Unvalidated | [Completion attempts](completion.json), [provider error](provider-failure.json) |

The first scan created one reproducible issue for $0.148912968. The unchanged
scan created zero, kept the same issue open and resolved zero for $0.081047364.
Both scans had partial coverage; neither is a full clean-scan proof.

The [fixed fixture](fixture.json) ran for 17m52s and failed with incomplete
misconfiguration/resource-exhaustion lenses. The 15-minute observer timeout and
the eventual failure are both retained. The model reported findings on that
fixed version; their presence must not be rewritten as a clean result. An
Anthropic attempt then failed with `AUTH_INVALID` using the VM's available key,
with no recorded successful model requests. Its original BYOK configuration was
restored. **No complete clean pair ran, and automatic resolution was not proven.**

[Actual retry warnings](retry-events.json) show the bounded native retry executing;
an unsuccessful second attempt stayed incomplete. Model metering totals
**$0.508101324**, below $4; this is model usage, not an infrastructure invoice.
No model scan remained running at final export.

[Backend CI](https://github.com/kodustech/kodus-ai/actions/runs/43981146199)
passed on application commit `6f2e8d605`: 1,391 suites, 20,215 tests and eight
snapshots; 61 tests skipped. Wiring, types/DI, permissions, environment, feature
gate and preview checks passed. The new automatic Kody check was skipped;
earlier review responses do not constitute human approval.

Scope: one Node.js fixture, GitHub PAT and desktop Chromium. This does not prove
every provider/language/integration or the complete PR-webhook review matrix.
The gated Next.js page rendered a 404 state with HTTP 200 because it streamed;
its navigation and scan controls were absent. Unrelated VM failures (MCP 502,
webhook callback 422, enum fallback and empty graph) are listed in
[the summary](public-final.json). Fixture source, original findings and final
database/queue records are retained so test cleanup does not erase the evidence.

[Cleanup](cleanup.json) removed eight test containers, three cache volumes,
the isolated databases/vhost, CLI dependencies and temporary credential files;
the eight pre-existing containers stayed running. GitHub refused fixture
deletion with HTTP 403, so these four private test repositories remain:
`kodustech/scan-e2e-1794869683954-{vulnerable,scope}` and
`malinosqui/scan-e2e-1794869683954-{vulnerable,scope}`.
