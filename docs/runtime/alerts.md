# Kody Runtime alerts and runbook

The alert rules are code: [runtime-alerts.rules.yml](../../apps/runtime/observability/prometheus/runtime-alerts.rules.yml),
with one promtool test per rule ([tests](../../apps/runtime/observability/prometheus/tests/runtime-alerts.test.yml),
`scripts/runtime/test-alert-rules.sh`). The prices and the daily cost threshold are recording rules of
[runtime-settings.rules.yml](../../apps/runtime/observability/prometheus/runtime-settings.rules.yml), the one file an
operator edits. Names follow the taxonomy ([observability.md](observability.md) part 2).

- **Severity.** `page` goes to the on-call at once; `warning` to the team channel. Route both through Alertmanager to
  BetterStack (its Alertmanager integration), the product's incident tool, so Runtime pages and product incidents land
  in one place.
- **Absent is not zero.** Runtime processes export only with `RUNTIME_METRICS_PORT`; the cell and the injector only with
  `-metrics-addr`. Watch `up` for each scrape target apart from these rules.
- **Safe triage only.** Use the authenticated datasource with the caller's authorized organization and Run scope. Never
  put credentials in command arguments, dump `.env` or container environments, print raw payloads, prompts or reasons,
  or inspect private proof manifests or TLS bundles. Database examples run only inside an approved read-only session.
  No step here starts work or changes resources.
- **The product's view.** Kody Runtime → Settings → Health shows an org owner the same stuck items, errors and cells
  from the database; this runbook is the operator's.

## Alerts

| Alert | Severity | Fires when |
| --- | --- | --- |
| [RuntimeItemStuck](#runtimeitemstuck) | warning | the hang detector sees a Run, setup, claim, sandbox, admission request or workflow past its bound for 5 m |
| [RuntimeHangDetectorNotRunning](#runtimehangdetectornotrunning) | warning | no maintenance pass ran for 10 m |
| [RuntimeClaimsPastHardExpiry](#runtimeclaimspasthardexpiry) | warning | more than 3 claims released past their hard expiry in 30 m |
| [RuntimeBlockerSignatureSpike](#runtimeblockersignaturespike) | warning | one blocker signature class 5 times in an hour |
| [RuntimeSetupSuccessRateLow](#runtimesetupsuccessratelow) | warning | under half of at least 4 setups in 6 h became active, for 15 m |
| [RuntimeBootP95Regression](#runtimebootp95regression) | warning | Run boot p95 over 1.5 times the same hour a day before and over 2 min, for 30 m |
| [RuntimeNoKodusCellConnected](#runtimenokoduscellconnected) | page | no Kodus cell connected for 5 m |
| [RuntimeCellSilent](#runtimecellsilent) | warning | a connected cell sends no frame for over 60 s, or the detector reports one, for 2 m |
| [RuntimeCellsFull](#runtimecellsfull) | warning | every connected cell of an owner full for 15 m |
| [RuntimeCellDeadman](#runtimecelldeadman) | page | a cell's dead-man reaches state 2 |
| [RuntimeAdmissionNotDraining](#runtimeadmissionnotdraining) | warning | the oldest admission request waits over 20 m, for 10 m |
| [RuntimeSecurityEvent](#runtimesecurityevent) | page | a canary or a credential crossed a boundary |
| [RuntimeCellExfiltrationAlert](#runtimecellexfiltrationalert) | page | a cell's injector or agent raised an exfiltration alert |
| [RuntimeOpenBaoDown](#runtimeopenbaodown) | page | OpenBao sealed or unreachable from an injector for 2 m |
| [RuntimeDailyCostHigh](#runtimedailycosthigh) | warning | machine time and LLM tokens of 24 h at the configured prices above the threshold, for 15 m |

### RuntimeItemStuck

`runtime_stuck_items{kodus_runtime_stuck_subject, kodus_runtime_stuck_state}`: what the hang detector saw past its bound
at its last pass ([observability.md part 4](observability.md#4-hang-detection), the bounds table). The worker logs one
`runtime.stuck` line per item the first time it crosses (`kodus.runtime.stuck.*`, the ids). The detector never acts.

1. Search the worker log for `"msg":"runtime.stuck"` with the subject and state: it names the Run, setup, claim or
   workflow.
2. A Run: open its Run page (the stuck notice says the age and the bound). The sweep should have ended it at 45 min
   (`sweep.finalize`, `stop.cleared`); if it did not, check `RuntimeHangDetectorNotRunning` and the stop workflow
   (`runtimeRunStop` in DBOS status).
3. A setup: Environment Health. `no_progress` means no step was saved for one boot's ceiling: check the setup's claim
   (`claim.ready_wait`, the cell's `claim.phase` lines) and `RuntimeCellSilent`.
4. A claim past its hard expiry: the reap releases it each pass (`runtime_claim_hard_expired_total`); a claim that stays
   means the release fails: look for the worker's `claim.release_failed` lines.
5. A workflow: DBOS public status for the workflow id. Do not cancel unknown workflows, edit DBOS tables or force-release
   permits.

### RuntimeHangDetectorNotRunning

No `runtime_maintenance_pass_total{outcome="ran"}` in 10 m: the sweep, the reap, the retention and the hang detector all
run in that pass, on the replica that holds the `runtime-worker/maintenance` lock. Check the runtime-worker is up and
`RUNTIME_SWEEPER` is not off, then `maintenance.failed` lines. `skipped` passes mean another replica holds the lock; if
every replica only skips, a holder is stuck inside the pass: the lock is a Postgres advisory lock on a dedicated connection and frees when that connection ends.

### RuntimeClaimsPastHardExpiry

The maintenance reap released more than 3 claims past `hard_expires_at` in 30 m: the worker's lease, the cell's lease and
the dead-man all failed to end them first. Look at the cells involved (`claim.reaped` and `deadman.*` cell lines) and the
hub's `claim.renew.failed`. A release is not proof the machines are gone: check the cell's `cell_claims_reaped_total` and
the independent reaper's `reaper.pass`.

### RuntimeBlockerSignatureSpike

One `kodus_runtime_blocker_signature` class 5 times in an hour, by consumer (setup, runtime). The class never carries the
repository text after it (`missing_env`, not the variable's name). Across orgs, a platform class (`cell_unavailable`,
`boot_timeout`, `image_load`, `builder_failed`) is usually ours: check the cells. A repository class
(`missing_env`, `toolchain:*`) on one org is that org's setup: the Health screen links its catalog card.

### RuntimeSetupSuccessRateLow

`runtime_setup_outcome_total` by `kodus_runtime_setup_outcome`: under half active over 6 h with at least 4 setups. Split by
`kodus_runtime_recipe_origin`: `authored` dropping points at Kody's recipe author, `committed` at the cells or the build
path. Then the top blocker classes (the spike alert's query without the threshold).

### RuntimeBootP95Regression

p95 of `runtime_claim_ready_wait{outcome="ready", consumer="runtime"}` over the last hour against the same hour a day
before. Find the phase that grew with `runtime_claim_boot_phase` and the export with `runtime_build_export_duration`;
`runtime_claim_start_total{kodus_runtime_claim_start="cold"}` rising means pool and bake hits fell. A deploy of the
builder image or the cell is the first suspect.

### RuntimeNoKodusCellConnected

No Kodus cell has a session on any hub replica. Runs on Kodus cloud wait for room, then end `cell_unavailable`. Check the
cells' `hub.connected` / `hub.disconnected` lines, their certificates (`cell_cert_seconds_left`), and the hub's
`tls.peer_refused` and `cell.hello` lines.

### RuntimeCellSilent

`runtime_cell_heartbeat_age` over 60 s on a replica, or the detector's `connected_silent` cell: a session says connected
while no frame came. The hub drops a cell silent for 45 s (`cell.silent`); one that stays connected means the drop did
not happen (`cell.silence_check_failed`) or the session row was not closed (`cell.disconnect_unrecorded`).

### RuntimeCellsFull

Every connected cell of an owner reported no free slot for 15 m: claims wait for room
(`runtime_claim_capacity_wait_total`), Runs queue (`runtime_run_queue_wait`). Add capacity, or check for claims that
should have ended (`RuntimeItemStuck` on claims).

### RuntimeCellDeadman

`cell_deadman_state` 2: the cell lost the hub for 15 m and destroyed every machine. Page, then check that the cleanup
succeeded (`deadman.abandoned`, `cell_claim_cleanup_errors_total`, the reaper's pass) before calling the machines gone.
State 1 (lost, no new work) for 5 m is the earlier sign; an absent scrape is not state 0.

### RuntimeAdmissionNotDraining

`runtime_admission_oldest_wait{kind}` over 20 m: a request ends at 30 m (`ADMISSION_WAIT_MS`). See
`runtime_admission_queue_depth` by state, then [Admission cleanup and resource loss](#admission-cleanup-and-resource-loss).

### RuntimeSecurityEvent

A Run was halted because a canary or a credential crossed a boundary. Page the authorized owner; keep the org, Run and
claim ids and the closed `kind`/`where`, never the canary value. The claim stays `compromised` with its machines as
evidence until it is released. See [Security, overload and browser refusal](#security-overload-and-browser-refusal).

### RuntimeCellExfiltrationAlert

`cell_exfiltration_alerts_total` (the agent acted on an alert) or `cell_injector_alerts_total` (the injector saw a
credential or a placeholder going to a host it was not for). The claim is compromised and runs nothing more; the hub
shows `claim.compromised`. Same handling as RuntimeSecurityEvent.

### RuntimeOpenBaoDown

`cell_openbao_up` 0: the injector's `sys/health` read answered sealed (503), uninitialized (501) or nothing. No secret
reaches a claim's hosts; requests that need one are refused (`injector.no_secret` with code `unavailable`). Unseal or
restore OpenBao through its own procedure; never copy unseal material into a ticket.

### RuntimeDailyCostHigh

`kodus_runtime:machine_usd:increase1d` (GB·min and vCPU·min of ended claims at the unit prices) plus
`kodus_runtime:llm_usd_estimate:increase1d` (the worker's gateway tokens at a blended price) over the threshold of
`runtime-settings.rules.yml`. Off while the threshold is 0. The LLM part is an estimate and misses the recipe author and
the test planner when they run in the product; the Usage screen has the exact figure per org. Find the org with
`topk(5, sum by (kodus_organization_id) (increase(runtime_machine_gb_minutes_total[1d])))`.

## Signal map

OTel names become Prometheus names by `@opentelemetry/exporter-prometheus`: dots become underscores, counters gain
`_total`, histograms `_bucket`/`_sum`/`_count`; no unit suffix. The full catalog is
[taxonomy.json](../../libs/runtime/telemetry/taxonomy.json) and [observability.md](observability.md) part 2.

| Signal | Producer | Use |
| --- | --- | --- |
| `runtime_run_state_total`, `runtime_run_verdict_total`, `runtime_run_duration`, `runtime_run_queue_wait` | runtime-worker | Runs by state, verdict and trigger; durations |
| `runtime_setup_outcome_total`, `runtime_blocker_total` | runtime-worker | setup outcomes by recipe origin; blockers by kind and signature class |
| `runtime_stuck_items`, `runtime_stuck_detected_total`, `runtime_claims_open`, `runtime_admission_queue_depth`, `runtime_admission_oldest_wait`, `runtime_maintenance_pass_total` | runtime-worker | the hang detector and the maintenance pass |
| `runtime_llm_tokens_total`, `runtime_llm_budget_used` | runtime-worker | gateway tokens by task; budget used per call |
| `runtime_claim_ready_wait`, `runtime_claim_boot_phase`, `runtime_build_export_duration`, `runtime_claim_start_total` | runtime-hub | boot, its phases, the export, pool and bake hits |
| `runtime_claim_transition_total`, `runtime_claim_renew_total`, `runtime_claim_capacity_wait_total`, `runtime_claim_reconciled_total` | runtime-hub | claim states and leases |
| `runtime_machine_gb_minutes_total`, `runtime_machine_vcpu_minutes_total` | runtime-hub | machine time of ended claims |
| `runtime_cell_connected`, `runtime_cell_sessions`, `runtime_cell_free_slots`, `runtime_cell_full`, `runtime_cell_heartbeat_age` | runtime-hub | cells per replica (sum the replicas) |
| `runtime_step_duration`, `runtime_egress_denied_total`, `runtime_hub_protocol_violation_total`, `runtime_hub_background_error_total`, `runtime_hub_connection_overload_total` | runtime-hub | steps (sandbox ops: `kind="sandbox.op"`), egress, the gateway |
| `runtime_security_event_total`, `runtime_evidence_write_failed_total`, `runtime_claim_hard_expired_total` | worker and hub | security, evidence, the reap |
| `cell_*` | cell, injector, reaper | per cell scrape target: claims, pool, memory, dead-man, egress, injector, OpenBao |
| `runtime_publish_*`, `runtime_pool_scheduler_tick_total` | product worker and API | not exported: the product processes register no meter provider |

## Structured diagnostics and trace privacy

The #2487 [Runtime logger](../../apps/runtime/src/shared/observability/logger.ts) keeps canonical timestamp/level/service/message/trace identity. Its [metadata pass](../../apps/runtime/src/shared/observability/diagnostic-fields.ts) bounds depth, field count and strings, omits sensitive-key fields/accessors/toJSON/cycles and caps the serialized line at 16 KiB. Arbitrary caller messages/context/IDs must still be static or validated; free-text DLP is outside this contract. Structured exception carriers retain only closed `kind` and optional allowlisted `code`, not copied exception message/stack/request. The carrier key remains caller-specific, such as `error` or `err`.

[Failure classification](../../libs/runtime/telemetry/failure.ts) uses `timeout`, `cancelled`, `network`, `permission_denied`, `invalid_input` or `unexpected`. Hub/worker span helpers record `error.type`, an optional `kodus.runtime.error.code`, a category-only exception event and ERROR status, then preserve the original thrown value for the caller. Investigate categories with authorized IDs; never ask an operator to add raw exceptions to logs to recover a missing detail.

Local tests establish diagnostic shaping and span API behavior. Deployment collector/exporter configuration, actual scrape names, alert routing and incident delivery still need operational validation. No collector trace or production log capture is implied by those tests.

### Injector credential forwarding (source candidate)

The injector logs fixed event/code pairs; these are logs, not new metric series:

| Event / code | Triage |
| --- | --- |
| `injector.upstream` / `upstream_unavailable` | Check approved host reachability/TLS and upstream HTTP validity through authorized health signals. Parser errors may contain credentials; never add raw `err` to logs. |
| `injector.response_refused` / `sensitive_header_name` | An upstream response field name matched a known credential form. The response was refused before forwarding. Inspect the approved integration's behavior without recording the field name or secret. |
| `injector.response_cut` / `response_incomplete` | Response exceeded the cap (256 MiB credentialed, `-max-inspected-response-gb` inspected) or streaming failed. The request is aborted; use bounded byte count and approved upstream health. Do not count this as a complete response. |
| Credential lookup / `expired`, `denied`, `not_configured`, `cancelled`, `timeout`, `unavailable` | Confirm reference scope, current signed authority, expiry and configured backend health. Never dump values, token-provider errors or backend bodies. |

A generic502 does not distinguish these causes for the workload. Correlate
validated claim/host IDs and fixed codes in the owner-authorized log datasource.
A scoped review recorded the tests and a KV-initialization race, later confirmed,
in disposable fixture setup. That fixture now waits on a bounded read-only mount
probe; production requests still refuse backend failures. No production alert
threshold or installed OpenBao integration was validated here.

### Browser completion and hub transport

The [cell completion path](../../apps/runtime-cell/internal/agent/steps.go) emits `cell_browser_explorations_total{outcome}` and a `step.result` log with closed `status`, `durationMs`, `cliCalls`, `actionsCompleted`, `candidateCount` and `truncated`. Local failures may add `runner_error`, `deadline_exceeded`, `job_refused` or `target_not_exposed` as `reason`. Page snapshots/selectors and raw runner exceptions do not enter this completion log. The local duration covers the cell's operation; `runnerDurationMs`, when present, is the runner's reported time. A completion count does not establish that the hub acknowledged delivery.

```promql
sum by (outcome) (increase(cell_browser_explorations_total[15m]))
```

This distribution is a diagnostic query, not a paging threshold or a quality/coverage score. Legacy `cell_steps_total{kind="browser.explore",outcome="ok"}` retains VM/transport semantics: blocked/unavailable exploration can increment it too. Use the dedicated outcome counter for browser completion status.

The [hub dispatcher](../../apps/runtime/src/hub/claims/step-dispatcher.ts) attaches `kodus.runtime.step.outcome`, optional closed `kodus.runtime.step.reason`, and `kodus.runtime.hub.duration_ms` to `runtime.hub.step`. Within that span, returned `EnvError` outcomes set ERROR via `inSpan.statusOf`; a received result envelope can remain transport-OK while its application measurement fails. A green span does not mean no regression. `kodus.runtime.cell.duration_ms` comes from reset duration or nested probe/exec duration when available; missing measurements are not zero, and reported clock scopes do not provide an exclusive control-plane CPU measurement.

Admission nacks expose an allowlisted code in `step.refused` logs and `step.finished` stream events; unknown codes become `unknown`. These span/stream fields are not new metric labels. The separate browser-policy refusal path still lacks a specific dashboard wire reason, as described below.

## Publication stalled or refused

The product sweeps every minute by default. A final publication is stale after 2m, and each redrive waits twice as long as the last (about an hour from the first failure to the fallback); five redrives are followed by a fallback when supported, then give-up. The comment fallback links to the Run; a completed-check fallback is failed, "Result not posted", so a required check blocks the merge until the result is posted or the Run is run again. This is recovery behavior, not a guarantee GitHub accepted it. See [redrive rules](../../libs/runtime-publish/domain/publication-redrive.ts).

```promql
max(runtime_publish_stuck) > 0
```

Proposed `for: 15m`. The gauge reflects a bounded sweep selection, not total backlog. For terminal failures:

```promql
sum by (kind) (increase(runtime_publish_redrive_total{outcome="gave_up"}[15m])) > 0
```

The paging refusal set matches `ALERT_REFUSALS` in [publish-runtime-request.use-case.ts](../../libs/runtime-publish/application/publish-runtime-request.use-case.ts#L97):

```promql
sum by (reason) (increase(runtime_publish_outcome_total{outcome="refused",reason=~"invalid_message|key_mismatch|unstructured_body|attempt_mismatch|incomplete_record|repository_not_in_org|repository_mismatch|platform_mismatch"}[10m])) > 0
```

`target_not_found`, `unexpected_event` and `no_integration` do not emit the paging marker. Missing integration can require operator action without being evidence of tampering. `metadata.alert="runtime_publish_refused"` identifies the same paging subset.

In an approved Mongo session, inspect identifiers/status, not stored requests or raw platform-error `reason`:

```js
const organizationId = 'AUTHORIZED_ORGANIZATION_ID';
const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
db.runtime_publications.find(
  { organizationId, status: { $in: ['failed', 'publishing'] }, updatedAt: { $gte: since } },
  { _id: 0, key: 1, runId: 1, kind: 1, status: 1, updatedAt: 1, leaseUntil: 1,
    'redrive.attempts': 1, 'redrive.gaveUpAt': 1, 'redrive.gaveUpReason': 1 }
).sort({ updatedAt: 1 }).limit(20).maxTimeMS(3000);
```

This is bounded triage, not proof older rows do not exist. Widen the authorized time window deliberately when needed. Check integration health through the product; after resolving access/platform failure, use authorized "Run again". Do not replay stored publication payloads manually.

## Worker planner and immutable bake recovery

This boundary is implemented behind `RUNTIME_PLANNER_HOST=worker`; deployment and a real configured-model Run remain separate acceptance steps. The host is part of the worker's DBOS application version (`RUNTIME_RELEASE_VERSION` plus `+planner-worker` on the worker host, `apps/runtime/README.md`), so a workflow never resumes on the other host. Before a host change, confirm no nonterminal workflow, queued request or active claim belongs to the previous host's version.

The product's `runtime.plan.model-turn` LLM spans carry `runId`, repository/team and PR identifiers. Correlate these with the Run's usage ledger and the worker's planning round; there is no new dedicated model-turn Prometheus counter to assume deployed. Never log the signed Bearer, `x-runtime-sealed-token`, prompts or continuation metadata to recover context. Structured/raw-header and installed Sentry header-redaction checks cover the new header.

| Response | Meaning and next check |
| --- | --- |
|401/403 | Run identity/context/authorization refused, or a canary boundary event. Inspect the closed code through the authorized Run path; do not replace credentials or relax scope checks. |
|409 `model_turn_duplicate` | A turn is pending/uncertain, or the same ID was used with another request. The receipt deliberately prevents another paid call; do not delete it or resend under a new ID. |
|429 `llm_budget_exceeded` | Per-raw-attempt reservation was refused. Inspect the scoped ledger, including retry/repair/fallback and unknown pending reservations. A reservation is not measured token use or a dollar charge. |
|502 `llm_unavailable` | Model/transport/closed-frame failure. Check bounded model spans and provider availability; do not expose raw exceptions in the Run or widen allowed frames as an operational workaround. |
|400/413/415 before authentication | Strict JSON/depth, byte limit, media type or compressed request refusal. The proxy must preserve the agreed bounded JSON contract. |

Receipts live in the product's `runtime_model_turn_receipts`, with a30-day expiry and Mongo TTL index. The key is SHA256 of `organizationId + NUL + runId + NUL + attempt + NUL + turnId`; these are authorized identifiers, not credentials. When diagnosing one known turn in an approved read-only Mongo session, query that exact key and project only `_id`, `expiresAt`, `response.scope` and `response.budget`. Never export `response.generation`. An existing pending receipt is not evidence the provider did no work. Mongo TTL deletion is asynchronous; reaching `expiresAt` does not prove removal.

A docker-gvisor bake now has an immutable generation ID and exact artifact membership. The cell stores a bounded catalog under `<state-dir>/bakes`, controller-only root0700/files0600 with an exclusive lock. A healthy cell process with an empty catalog does not prove an environment's image is ready. Legacy SHA-only images need normal setup; never manufacture a catalog/current pointer from the dashboard's previous Ready state. Recovering a catalog restores bake eligibility, not claims, leases, SSH keys, step execution or pool targets.

On startup refusal, inspect only bounded scope/count/code diagnostics. Surviving holders must be reconciled by the owned cleanup path before startup; do not remove the lock, chmod the catalog for a guest or adopt holders manually. Confirm that the independent reaper's most recent `reaper.pass` succeeded and separately check actual inventory. A local OrbStack LXC global drop-in can disable `NoNewPrivileges`/Protect settings on trusted controller services; local idle/mTLS proof does not validate production host hardening.

## Scheduler, broker and Run clocks

The pool cron runs every 5m by default (`RUNTIME_CRON_POOL_SCHEDULER` can override it). Its counter is recorded in the API, which registers no meter provider today: the query below has no series until the API exports metrics (observability.md, "Missing").

```promql
sum(increase(runtime_pool_scheduler_tick_total{outcome=~"failed|lock_failed"}[30m])) >= 3
```

`skipped` means another replica owns the lock. `sum(increase(...)) == 0` misses absent series. Monitor the expected scrape target with `up`, and separately use `absent_over_time(runtime_pool_scheduler_tick_total[30m])` with each expected deployment/target selector. Combine target availability and the configured cron interval; these are templates until the deployment's labels are known. Exporter downtime and a stopped cron are different incidents.

For delayed retries, use the already authenticated RabbitMQ management datasource/UI. Inspect only `workflow.exchange.delayed` publish-in/out counters for the authorized vhost and a bounded 75m window. Growing input with no output after the maximum rate-limit delay (60m in `rabbitmq-error.handler.ts`) warrants investigation. Historical #2083 records one failure, not today's guaranteed cause. Per-exchange metric names depend on installed plugin/scrape: confirm before installing a rule. Never put management credentials in `curl` arguments or print connection URIs.

Run clocks come from [run-engine.service.ts](../../apps/runtime/src/worker/dbos/run-engine.service.ts#L524) and [run-orchestrator.ts](../../apps/runtime/src/worker/run/run-orchestrator.ts#L48):

- Booting/testing: 45m from `max(bootingAt, capacityWait.at)` when that capacity-wait timestamp exists. Waiting for room changes the clock; `requestedAt +45m` gives false alarms.
- Queue budget: 30m. The "never started" check allows another 5m and checks workflow/admission existence. Row age alone does not authorize deleting it.
- `awaiting_approval` waits for the fork approval path; omit it from the ordinary age alarm.

Use the authorized Run view/stream first, then the Health screen's Stuck list. The projection is not authoritative workflow status. In an authenticated read-only Runtime Postgres session:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '3s';
SELECT run_id, repository_id, pr_number, state, requested_at, report->>'bootingAt' AS booting_at,
       report->'capacityWait'->>'at' AS capacity_wait_at, updated_at
FROM runtime.runtime_runs
WHERE organization_id = 'AUTHORIZED_ORGANIZATION_ID'
  AND state IN ('queued', 'booting', 'testing')
  AND updated_at >= now() - interval '24 hours'
ORDER BY updated_at ASC
LIMIT 50;
COMMIT;
```

Correlate with public DBOS status through approved operator tooling and the scoped admission row. The projection is not DBOS execution truth. Do not infer stuck Runs by subtracting unrelated transition counters, cancel unknown workflows, edit DBOS tables or force-release permits.

## Admission cleanup and resource loss

#2483 distinguishes [done, pending and failed](../../apps/runtime/src/shared/admission/admission-contract.ts). `member_cleanup_pending` means inventory has not confirmed member absence. Permit/ticket stays held; [normal reconciliation](../../apps/runtime/src/worker/dbos/run-engine.service.ts#L403) retries even after a pending finish checkpoint. Expected pending cleanup does **not** emit `admission.ticket_cleanup_failed`.

Actual failure logs use `cell_unavailable`, `hub_refused`, `unexpected` or `store_unavailable` as `reason` (`run-engine.service.ts:285,354`). These are `msg`/`reason` fields, not `metadata.alert`, and no cleanup counter is emitted. Repeated failures or terminal Runs retaining permits/tickets need inspection; transient pending alone is not a paging condition.

In an authenticated read-only Runtime Postgres session:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '3s';
SELECT kind, request_key, state, last_reason, permit_held,
       ticket IS NOT NULL AS has_ticket, updated_at, next_at
FROM runtime.runtime_admission_requests
WHERE org_id = 'AUTHORIZED_ORGANIZATION_ID'
  AND updated_at >= now() - interval '24 hours'
ORDER BY updated_at ASC
LIMIT 50;
COMMIT;
```

Columns follow `shared/runtime-schema.ts`. The query excludes payload, owner/lease tokens and ticket contents. `last_reason` is an admission category, not a remote exception. The window is deliberate, not total-absence proof. Verify cell connection and authoritative inventory through approved tooling, then let reconciliation finish. Never interpret timeout/expired lease alone as "resource absent".

For resends, a proposed warning is rate above 0.1/s for 15m on `cell_hub_delivery_retries_total`. For reaps, investigate more than three in 30m on `cell_claims_reaped_total`, scoped by reason/instance. The reap counter increments before teardown and does not confirm successful deletion.

Dead-man state1 follows 5m without hub contact or revocation; state2 follows 15m. States derive from time/contact, not teardown success ([deadman.go](../../apps/runtime-cell/internal/lease/deadman.go#L78)). `DestroyExpired`/`DestroyAll` can fail and retry while the gauge stays lost/abandoned. Page on state2, but check cleanup counts/failures and inventory before declaring machines gone. An absent scrape is not state0.

The control-plane `runtime_claim_hard_expired_total` counts hard-expired claim releases through the hub ([run-deps.factory.ts](../../apps/runtime/src/worker/dbos/run-deps.factory.ts#L221)). Independent machine-reaper logs/counters have another scope. Do not sum them or use claim release as proof of EC2 deletion.

## Security, overload and browser refusal

Page on a new `runtime_security_event_total` event ([RuntimeSecurityEvent](#runtimesecurityevent)); retain authorized org/Run/claim IDs and closed `kind`/`where`, never canary values. Investigate unexpected `runtime_hub_protocol_violation_total` and sustained `runtime_hub_background_error_total`; `op` identifies the background operation. Overload `reason` names an outgoing frame/buffer/request/step ceiling, not enterprise capacity. Reconnect/lost steps are consequences; do not silently resend steps to make the dashboard look successful.

GitHub authentication returns fixed 401/503 codes before acknowledgement/enqueue. There is no dedicated authentication metric here: use existing ingress/access-log datasource and fixed response codes, without body/signature/secret. Check only whether the owner provisioned matching secrets and preserved raw forwarding; follow [rollout instructions](../../apps/webhooks/README.md), never extract credentials or bypass signing.

Browser denials terminate the job. The current wire maps healthy observer refusal to missing probe / `transport_lost`, ultimately `inconclusive`; it must not become `behavior_change` or `pr_destabilizes_machine`. Correlate scoped step status with fixed runner refusal codes, not raw page/CLI output. A dashboard-specific policy reason is still unimplemented. Evidence persistence failure is signaled by `runtime_evidence_write_failed_total`; missing evidence does not prove a passing browser flow.

For resource triage use the [passive collectors](../../scripts/runtime-validation/resource-profile/README.md) on explicit targets, not whole environments/private artifact directories. Keep Run/claim mapping, gaps and lifetime-vs-window peak distinctions. Never sum parent/child cgroups or infer concurrency from idle samples. No diagnostic here enables features, rotates secrets, restarts services, deletes resources or executes customer code.

## Injector alert source continuity (#2488)

The local fix negotiates eventlog version 1, a producer epoch and atomic oldest/latest bounds. The initial handshake is nonblocking; subsequent polls validate contiguous sequence numbers, bounded JSON and the same epoch. A restart, retention gap or impossible cursor never silently resets to zero. Legacy producers without metadata cannot open admission in the updated cell. Upgrade the injector/producer before the cell.

`cell_alert_source_available` has a series only when an alert source is configured: zero until handshake or while unavailable, one after continuity is established. An absent series on a cell without an injector is not a failed feed. `cell_alert_source_failures_total{reason}` uses only `producer_restart`, `retention_gap`, `cursor_invalid`, `unsupported_feed`, `invalid_feed` or `source_unavailable`. Correlate `alerts.source_unavailable` (`alarm`, `reason`, `latched`) and `claim.alert_source_unavailable`; do not inspect headers, event bodies, credentials or token values.

On detected loss the cell closes admission/advertised slots, cancels and releases affected claims, and fences unsent/retried ready/result frames. The hub maps refusal to infrastructure unavailability; worker/gate fixtures keep it inconclusive instead of manufacturing a PR regression or security incident. Actual exfiltration alerts retain their security path.

A transient failure may reopen only after a valid poll proves continuity. Restart/gap/cursor-invalid latches the cell closed: drain/reconcile its claims and replace/restart the cell only after the producer is healthy and its log can establish the required history. If the producer already evicted history, restarting the cell alone cannot repair it. Keep claims closed and escalate through the normal incident procedure; do not delete history or reset the cursor to make the gauge green.

This fix cannot reconstruct alerts lost before producer restart, retract a result already sent before detection, or revoke an already published Run. Full vault/registry/incident integration and rollout acceptance remain open; local regression evidence is not a completed S-29/S-48 acceptance run.

## Owner-local secret management

The optional injector Unix management socket emits `vault.management.request` with closed `operation`, `code`, `status` and `duration_ms` fields. Startup/shutdown use `vault.management.started/stopped`. Values, bodies, raw transport errors, socket paths and arbitrary caller labels are excluded. This is local source instrumentation; no live owner vault or new metric/dashboard was deployed.

For `unsafe_socket`, check the canonical parent ownership/mode0700 and socket mode0600 under the intended injector UID. An existing/stale path refuses startup. Verify process ownership and lifetime before deciding what to remove; never replace an unknown or live socket, and never open a second process over the running vault's ciphertext.

For denied binding/lookup, compare metadata only: signed org/environment/claim, exact credential host, original hard expiry, secret-version expiry and revocation. Approved ordinary egress is insufficient. Legacy policies without signed environment and normal claims with no CredentialHosts deliberately refuse credentials. Upgrade proxy/resolver/injector readers before the new environment-aware cell writer.

A client `cancelled` result may represent caller cancellation, a transport/header timeout or a server408. Correlate its timestamp with the closed server operation/status/duration event before attributing a cause; the current client code alone does not isolate them. One test timeout under concurrent compiling remains recorded, with no proven resource cause and no increased deadline. Isolated/sequential checks passed. No PR capacity estimate follows.

The CLI bounds stdin plus request by30seconds and reads values only on stdin. A timed-out durable mutation may already have committed: inspect metadata, then retry only the identical immutable version/binding. Do not rotate to a different value under the same version or print raw requests to diagnose it. Run scopes, product RBAC/UI, private registries, rotation/backup and customer acceptance remain separate gates.

Signed injector policy removal with a configured vault now distinguishes memory
revocation from durable success:204 requires the stored claim revocation to
commit;503 means live policy was removed but durable completion is not promised.
A retry must target the same globally unique claim ID and still carry a valid
signed removal. Do not restore policy as a recovery workaround. The current
per-claim in-flight binding barriers prevent an already authorized Bind from
committing after removal, without stalling an unrelated claim. This is candidate
source behavior, not an active owner-vault deployment or normal autogrant.
