# Kody Runtime control plane

`apps/runtime` holds two Nest apps that sit between the product and the cells (`apps/runtime-cell`, Go):

- **runtime-hub** (`src/hub/main.ts`): terminates the cells' mTLS WebSocket and drives claims and steps on them.
- **runtime-worker** (`src/worker/main.ts`): consumes the product's Runtime commands and runs each Run and environment setup as a DBOS workflow.

Domain code shared with the product (protocol, gate, run state, sealed secrets, telemetry) lives in `libs/runtime`. This app only wires it to Postgres, RabbitMQ, Mongo and the cells.

## A Run, end to end

```mermaid
sequenceDiagram
    participant P as Product (API + outbox)
    participant W as runtime-worker
    participant H as runtime-hub
    participant C as Cell
    P->>W: RuntimeRunRequested (tokens sealed) on workflow.jobs.runtime_run.queue (stop, revoke, approvals on workflow.jobs.runtime_control.queue)
    W->>W: RunRequestedHandler: PR lock, supersede, projection "queued"
    W->>W: DBOS runtimeRun workflow (fair queue, partition = org)
    par base and PR
        W->>H: POST /internal/cells/:cellId/acquire (repo token opened in this step)
        H->>C: claim.acquire
        C-->>H: ack, then claim.ready
        H-->>W: Claim (bound)
    end
    W->>W: agent plan (LLM gateway, Run token opened in the call)
    loop each probe round
        W->>H: POST /internal/claims/:id/reset and /probe (org + Run named)
        H->>C: machine.reset / probe.run
        C-->>H: step.result
        H-->>W: outcome (step events go to the Run stream)
    end
    W->>W: intent, verdict (decideRunVerdict), projection
    W->>P: RuntimePublishRequested (structured report), routing key workflow.jobs.created.RUNTIME_PUBLISH
    W->>H: POST /internal/claims/:id/release
    H->>C: claim.release
```

## runtime-hub

`src/hub/cell-hub.ts` is the entry point. It is a facade over four parts:

| Part | File | Does |
|---|---|---|
| `CellIdentityService` | `hub/enrollment/cell-identity.service.ts` | Enrollment with a single-use token and a CSR, 24 h renewals, and the per-replica pin and revocation cache checked at the TLS handshake. |
| `CellConnectionRegistry` | `hub/gateway/cell-connections.ts` | One live socket per cell; request/ack plumbing. A dropped connection resolves every wait on it as lost. |
| `ClaimService` | `hub/claims/claim.service.ts` | Acquire (rebind on retry, a duplicate joins the round in flight), claim outcomes, release, heartbeat reconciliation, security violations, egress policy, image bake, pool target. |
| `StepDispatcher` | `hub/claims/step-dispatcher.ts` | probe.run, exec and machine.reset on a bound claim, at most once per stepId. |

The CA is `hub/ca/x509.ts`. It signs cell certificates (OU=cell, CN=cellId) and verifies every certificate it issues against itself. The DER and CSR handling is hand-written and is not replaced by a library yet.

**Listeners** (`hub/hub-app.ts`):

- **Public**, `RUNTIME_HUB_PORT` (3410). Serves `/cells` (WebSocket, `hub/cell-gateway.service.ts`), `/cells/register`, `/cells/renew` and `/health` (`hub/http/public-cell.controller.ts`). `/health` lists no cells. The handshake asks for a client certificate but does not require one, because registration has none yet. A certificate that is presented must chain to the CA, must not be revoked, and must be the pinned serial.
- **Internal**, `RUNTIME_HUB_INTERNAL_PORT` (3411, private network only). Serves `/internal/*` (`hub/http/internal.controller.ts`). It requires a client certificate from the worker CA at the handshake. `WorkerAuthGuard` (`shared/internal-auth.guard.ts`) then checks OU=worker and, when `RUNTIME_WORKER_ALLOWED_CNS` is set, the CN.

Each listener answers 404 to the other's routes.

**Outgoing backpressure** (#2462). Each cell connection permits at most 4 MiB
of queued outgoing data, a frame of 1 MiB, 128 unanswered requests and 256
in-flight steps. The byte check includes the next frame. Crossing a ceiling
closes that connection and terminates its transport; pending requests reject,
steps become transport-lost, and readiness waits end disconnected. Frames are
never silently discarded or resent. `runtime.hub.connection_overload{reason}`
counts `buffer`, `frame`, `requests` or `steps`; `cell.overloaded` logs counts
and identifiers only. These are protective ceilings, not measured capacity.
They do not bound incoming message queues or total process connections.

**Security violations.** A cell reports one as an unsolicited `blocked` frame (`claimId`, no `re`, kind `security_violation`, the alert kind as signature). `ClaimService.onUnsolicitedBlocked` accepts it only for a live claim of that cell:

- The claim moves to `compromised`: it takes no step, and the heartbeat reconciliation never releases it, because its machines are the evidence.
- The blocker is recorded in `runtime_claim_blockers`, once per claim, kind and signature.
- A boot waiting on the claim ends blocked; a step in flight, and every later step, returns `security_violation`.
- A `security` event goes on the Run stream.
- Any other unsolicited kind is nacked `unsolicited_blocked`; a claim that is not live on that cell is nacked `unknown_claim`.

**Claim routes** take `organizationId`, plus `runId` for a Run's claim. The hub checks both against the claim row:

- A mismatch is `ClaimScopeError` → 404.
- A claim that is not bound, or is past its hard expiry, takes no step (`lease_expired`).

## runtime-worker

`src/worker/runtime-worker.module.ts` (`RuntimeWorkerModule.forConfig(config)`) wires everything from one validated `WorkerConfig`.

- **Consumer**: `RuntimeCommandConsumer` (`worker/consumer/run-request.consumer.ts`) only routes. Each event has its own handler:
  - `worker/commands/run-requested.handler.ts`: Run requested and cancelled. The start and supersede decision holds a per-PR Postgres advisory lock.
  - `worker/commands/command-handlers.ts`: fork approval, egress approval, stop, stop clear, environment setup, pool size, cell token, cell revoke. A pool size change goes to the cell of the environment's last setup (`HubPoolTargetSender`, through the replica that holds it); with no setup on record it waits for the next setup, which carries the size.
  - A message that does not parse is dead-lettered (`Nack(false)`). Stop, revocation, approvals and pool commands use `workflow.jobs.runtime_control.queue` and its own channel. Run cancellation stays ordered with Run requests on the Run queue.
- **Engine**: `RunEngineService` (`worker/dbos/run-engine.service.ts`) registers these workflows:
  - `runtimeRun` on the fair queue (`runtime-runs`, partition = org).
  - `runtimeForkGate`, off the queue. It waits for a fork approval, then enqueues `${runId}:run`.
  - `runtimeRunStop`.
  - `runtimeEnvironmentSetup` on `runtime-setups` (one per org at a time).
  - `stop()` cancels the Run and starts the stop workflow. It never waits for the Run to end.
- **Orchestrator**: `worker/run/run-orchestrator.ts`, phases in order:
  - **boot**: base and PR together; a lost cell gets one more try per side.
  - **plan**: the agent's probes (`worker/agent`).
  - **replay**: base twice and PR once per probe, plus the rounds the gate asks for (`worker/run/replay.ts`).
  - **intent**: findings only; it can only downgrade (`worker/intent`).
  - **verdict**: `decideRunVerdict`; a truncated diff is partly tested at best.
  - **publish**: always the structured report; the publisher refuses free text.
  - A fork PR boots only with `forkApproved`, which only the gate sets.
  - A `security_violation` on either side halts the Run as a failing check (`Security violation · …`), with `securityEvent` (kind `exfiltration`, side, signature) on the projection and `securityViolation` in the report. It comes from three places: a boot blocker, a step result (`SecurityViolationError`, `worker/run/security-violation.ts`), or a blocker the hub recorded between steps (read in the `egress` step).
- **Cell choice**: `shared/cell-directory.ts` reserves a slot on the best eligible cell (the org's own first, then the cells where the org holds fewer live claims, then the most free slots). A Run's acquire passes the cell of its environment's last setup as `prefer` (`poolCellOf`, only from a record of the same org): that cell holds the warm pool, so it goes first while it is eligible and has a slot. A failure finding it is no preference.
  - An org holds at most `RUNTIME_ORG_SHARED_CLAIM_CAP` live claims (pending, bound, held) on shared (kodus-owned) cells; its own cells are not capped. Past the cap, and with no free slot on any eligible cell, the acquire is blocked (kind `resources`, signature `org_capacity` or `no_capacity`) before anything is sent to a cell; both have a card in `libs/runtime/blockers/catalog.ts`. No connected cell at all is still `cell_unavailable`.
  - The cap counts the claim rows the hub wrote, so acquires of one org in flight together may pass it by their number (the DBOS org partition bounds them). A new round of a claim never counts against itself.
- **Setup**: `worker/setup/environment-setup.service.ts` boots the default-branch head with the recipe the product read, checks the app answers, and asks for an image bake. When the bake is accepted and the command carries `poolSize`, the `pool` step sends `pool.target` with `imageId: latest` to the cell that baked, before the release; the cell fills the pool from that bake once it is done (S-52). The record lives in `environment-setup.store.ts`.

**Restored claims** (#2464). A claim read from a checkpoint is an identity,
not evidence that its machines still exist. Existing new planner/replay/test
and setup health/bake callbacks renew it through the scoped hub client before
starting work. A renewal failure is recorded as closed data and interpreted
outside that callback: a Run becomes errored with Run again, or retains a
known security halt; setup blocks without paid recipe retries. A completed
checkpoint does not reissue its work. The production factory requires renewal;
only the explicit fake-driver path permits an adapter without it. This does
not cancel work already in flight or reacquire machines behind a recorded round.

**Transport and machine facts** (#2466). `cell_unavailable` and `transport_lost`
do not assert guest failure. Only explicit VM-health observations can support
`pr_destabilizes_machine`; repeated missing control links remain inconclusive.
- **Maintenance**: `RunEngineService.maintenanceTick` runs every 15 s. The replica that takes the maintenance advisory lock sweeps stuck Runs, reaps claims past their hard expiry through the hub, and, once an hour, applies 30-day retention (`applyRetention` in `shared/runtime-schema.ts`; the Run stream in batches of 5,000).
- **Evidence**: see [Evidence](#evidence).

## Stores and who writes them

The Runtime has its own Postgres database, migrated by `ensureRuntimeSchema` (`shared/runtime-schema.ts`). Migrations are versioned in `runtime.schema_migrations`. Each one runs once, under an advisory lock. Add a migration; never edit an applied one.

| Table | Written by |
|---|---|
| `runtime_claims` | Hub (`hub/hub-store.ts`), only through `transitionClaim` / `rebindClaim`. One exception: `revokeCell` (`shared/pg-command-store.ts`) terminates a revoked cell's claims in the revocation's transaction. Each row keeps why it is in its state (`reason`, a `ClaimReason`; `reason_detail`, the cell's own code) and since when (`state_changed_at`). |
| `runtime_cell_sessions` | Hub. Exception: the worker's `PgCellDirectory` (`shared/cell-directory.ts`) decrements `free_slots` when it reserves a cell; the next heartbeat overwrites it. |
| `runtime_cells` | Hub (sessions, registration, pins); worker on revocation. |
| `runtime_steps_index`, `runtime_egress_events`, `runtime_claim_blockers` | Hub. The worker reads blockers for its Run (`PgRunClaims.securityViolations`). |
| `runtime_cell_tokens` | Worker inserts (token issued); hub consumes on registration, in the same transaction as the cell row. |
| `runtime_fork_approvals`, `runtime_egress_approvals`, `runtime_stops`, `runtime_cell_revocations` | Worker (commands from the API, which never writes this database). |
| `runtime_run_events` | Hub (`libs/runtime/run/adapters/pg-run-stream.store.ts`), the Run stream (default store). Read by the API with the read-only role. |
| DBOS system tables | DBOS, inside the worker. |

Mongo (product cluster, `runtime_*` collections) holds the Run projection and the environment setup records. Both are written by the worker.

## Run stream

The hub writes the Run stream (ADR-047):

- Step events: from `StepDispatcher`.
- Run events: from the worker over `POST /internal/runs/:runId/events`, with an event key.

`HubRunEventSink` retries a hub outage, then drops the event and logs `stream.event_dropped`. The projection holds the truth; the stream is its view.

**Store**: the Runtime Postgres (`RUNTIME_STREAM_STORE=postgres`, the default for the hub and the API), so any hub replica appends and any API replica reads, with no shared volume.

- **Idempotent**: every event has a key, unique per Run (`runtime_run_events_key_idx`), so a retried append from any replica is a no-op. The worker's keys are `{attempt}:state:…`, `{attempt}:phase:…`; the hub's are `step:{stepId}:started|finished` (a stepId is sent at most once) and `security:{claimId}:{signature}`.
- **Bounded**: an event over 64 KiB is refused (`RunStreamEventTooLargeError`); a page reads at most 1,000 events on the `(org_id, run_id, seq)` index; rows go after 30 days, oldest seq first in batches, found by a BRIN index on `created_at` (migration 10).
- **API read**: `PgRuntimeRunStreamReader` (`libs/runtime/api/infrastructure`) with `RUNTIME_DATABASE_READ_URL`, inside `BEGIN READ ONLY`. The role is `kodus_runtime_reader` (`scripts/runtime/dev-runtime-users.sh`): `SELECT` on `runtime_run_events`, `runtime_cells`, `runtime_egress_*` and `runtime_claims` (the Run cost), nothing else. The long-poll reads every `RUNTIME_STREAM_POLL_INTERVAL_MS` (500 ms) per open request.
- **Cutover**: while the API still has `RUNTIME_STREAM_DIR`, a Run with no row in Postgres is read from its file stream, and a file offset keeps reading the file. Unset it once the Runs from before the switch no longer matter. A Run in flight during the switch shows only its file part.
- `RUNTIME_STREAM_STORE=file` keeps the shared volume (`RUNTIME_STREAM_DIR`) for both, single host only.

## Evidence

A Run's evidence (§8, `experiments/kody-runtime/EVIDENCE-CAPTURE-DESIGN.md`) lives at the key `{orgId}/{runId}/{side}/{stepId}/{type}`. The worker writes `output`; cells upload their artifacts (logs, db, cast, screenshots, video, trace, HAR) with grants the worker signs per step. Two stores, `RUNTIME_EVIDENCE_STORE` on the worker and the API:

| | `file` (default) | `s3` |
|---|---|---|
| Where | `RUNTIME_EVIDENCE_DIR` on the worker (`shared/file-evidence-store.ts`) | a bucket of any S3-compatible store (`shared/s3-evidence-store.ts`) |
| Cell upload | PUT to the worker's evidence server (`worker/evidence`, `RUNTIME_EVIDENCE_PORT`, `RUNTIME_EVIDENCE_UPLOAD_URL`), HMAC grant: exact key, type, byte ceiling, nonce (single use) | presigned PUT to the staging key `{prefix}.uploads/{key}`, `content-type` signed |
| Browser read | URL the API signs with `RUNTIME_EVIDENCE_SIGNING_SECRET`, served by the evidence server | presigned GET the API signs, with `response-content-type`, `response-content-disposition: attachment`, `response-cache-control: private, no-store` |
| Retention | hourly sweep, 30 days | the bucket's lifecycle rule (below) |
| Replicas | one worker (its disk) | any number |

Both answer for at most 5 minutes (reads) and 15 minutes (grants). The cell is the same for both: it PUTs `g.url` with `Content-Type` and `Content-Length`, follows no redirect and accepts 200, 201 or 204; S3 answers 200.

**SigV4** (`libs/runtime/contracts/sigv4.ts`): presigned URLs and the Authorization header, with node `crypto` and `fetch`, no SDK. `sigv4.spec.ts` checks it against the AWS examples (the S3 presigned GET, GET/PUT Object, GET lifecycle, List Objects, and the test suite's get-vanilla).

**Why a staging key** (the size bound): a presigned PUT signs headers, not a range, so it cannot say "at most N bytes" (signing `content-length` would fix the exact size, which the worker does not know when it signs). A presigned POST policy with `content-length-range` can, but needs a multipart POST, which would change the cell. So the cell's PUT lands on a key only the worker reads, and `checkUploadedRefs` takes each upload (`S3EvidenceStore.takeUpload`):

1. HEAD the staging object. Missing, another content type, or over the type's `maxBytes`: dropped; an oversized object is deleted unread.
2. A text artifact checked for canaries is read with `If-Match` on that ETag; a leak is stored redacted (marked `x-amz-meta-kody-redacted`, so a retried step still halts the Run).
3. Commit: server-side copy pinned to the same ETag (or a PUT of the checked text) into the evidence key, then delete the staging object.

A PUT after the take changes nothing the API can serve. What an abusive cell can do is store up to the S3 single-PUT limit in its own staging key for the grant's 15 minutes; the take deletes it, and the lifecycle rule does if no take runs.

**Config** (`loadS3EvidenceConfig`, `libs/runtime/contracts/evidence-s3.ts`): `RUNTIME_EVIDENCE_S3_BUCKET`, `_REGION` (us-east-1), `_ENDPOINT` (unset: AWS, virtual-hosted), `_PUBLIC_ENDPOINT` (the host cells and browsers reach; unset: the endpoint), `_FORCE_PATH_STYLE` (MinIO), `_PREFIX`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_SESSION_TOKEN`. Credentials are read once and are not enumerable on the config object, so it never logs or serializes them. The grant URL must pass the protocol's host rule: https to a DNS name, or http to `localhost` or a one-label name.

**Least privilege**: the worker's key needs `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `{bucket}/{prefix}*`; the API's needs only `s3:GetObject` on the same (`RUNTIME_EVIDENCE_S3_READ_*` in the dev compose). Cells get no key, only URLs.

**Lifecycle rule** (instead of a sweep), set once per bucket. `node -r ts-node/register/transpile-only -r tsconfig-paths/register apps/runtime/src/e2e/evidence-bucket.ts` creates the bucket and puts it with the worker's `RUNTIME_EVIDENCE_S3_*`; on AWS, the same as Terraform or `aws s3api put-bucket-lifecycle-configuration`:

```json
{ "Rules": [
  { "ID": "kody-runtime-evidence", "Filter": { "Prefix": "<prefix>" }, "Status": "Enabled", "Expiration": { "Days": 30 } },
  { "ID": "kody-runtime-evidence-uploads", "Filter": { "Prefix": "<prefix>.uploads/" }, "Status": "Enabled", "Expiration": { "Days": 1 } }
] }
```

Locally: `docker compose -f docker-compose.dev.yml --profile evidence-s3 up -d runtime-minio runtime-minio-init`, then `RUNTIME_EVIDENCE_STORE=s3` for runtime-worker and kodus-api.

## Sealed tokens

The product seals the repo token and the Run token with AES-256-GCM (`libs/runtime/run/sealed-secret.ts`):

- A Run's tokens are bound to its runId.
- A setup's repo token is bound to the setup command's `key`.

`RuntimeRunRequestedSchema` refuses a Run request with unsealed tokens. A setup token that arrives plain is sealed at ingress (`sealedForInput` in `worker/secrets/sealed-tokens.ts`). Either way, DBOS only ever stores sealed values.

Tokens are opened only in two places:

- The repo token: in `HubEnvironmentClient.acquire` (`worker/env/hub-environment-runtime.ts`), inside the acquire step.
- The Run token: in `HttpLlmGateway.complete` (`worker/agent/http-llm-gateway.ts`).

Neither call returns or logs the plain value. Canaries are an HMAC keyed from the seal key (`canaryKeyFrom`).

## Config

All config is read in one place, `shared/config.ts`:

- `loadRuntimeConfig` is the hub's loader; `loadWorkerConfig` adds the worker's settings.
- Both validate at boot. A bad number, bad JSON, or a missing seal key stops the process.
- Only the standard `OTEL_*` variables are read elsewhere, in `shared/otel.ts`.

| Variable | Default (dev) | Notes |
|---|---|---|
| `RUNTIME_DATABASE_URL` | `postgres://runtime:runtime@localhost:5442/kodus_runtime` | Runtime database and DBOS system database. |
| `RUNTIME_RABBITMQ_URL`, `RUNTIME_MONGO_URL`, `RUNTIME_MONGO_DB` | localhost | `workflow.exchange` is checked, never declared. |
| `RUNTIME_HUB_PORT` / `RUNTIME_HUB_INTERNAL_PORT` | 3410 / 3411 | Must differ. |
| `RUNTIME_REPLICA_URL`, `RUNTIME_HUB_URL` | internal listener | What the worker dials. |
| `RUNTIME_TLS_CA`, `_CA_KEY`, `_CERT`, `_KEY`, `RUNTIME_TLS_WORKER_CA`, `RUNTIME_WORKER_TLS_CERT`, `_KEY` | none | PEM file paths. The hub refuses to start without them, except in plaintext test mode. |
| `RUNTIME_WORKER_ALLOWED_CNS` | empty (any worker cert) | Comma list. |
| `RUNTIME_SECRET_SEAL_KEY` | none | Worker only; 32 bytes as hex or base64. |
| `RUNTIME_MANAGED_CELLS` | `{}` | cellId → certificate serial. |
| `RUNTIME_ORG_CONCURRENCY`, `RUNTIME_GLOBAL_CONCURRENCY` | 2, 20 | Fair-queue limits. |
| `RUNTIME_RELEASE_VERSION` | `development` outside production | Worker only. Required in production; immutable release identifier passed to DBOS `applicationVersion`. 1–128 letters, digits, dots, underscores or hyphens; starts with a letter or digit. |
| `RUNTIME_ORG_SHARED_CLAIM_CAP` | 8 | Hub and worker must agree. Live claims/ticket slots one org may hold on shared cells at once. |
| `RUNTIME_DURABLE_ADMISSION` | `0` | Opt-in on both hub and worker. Short durable attempts and shared Run/setup execution budget. Requires worker maintenance. |
| `RUNTIME_ADMISSION_GLOBAL_WAITING`, `_ORG_WAITING` | 1000 / 100 | Accepted waiting requests, including pending cleanup. |
| `RUNTIME_ADMISSION_MAX_PAYLOAD_BYTES`, `_GLOBAL_BACKLOG_BYTES`, `_ORG_BACKLOG_BYTES` | 20 / 256 / 64 MiB | Sealed input byte ceilings. |
| `RUNTIME_ADMISSION_ATTEMPT_CONCURRENCY`, `_ATTEMPT_ORG_CONCURRENCY` | 8 / 1 | Concurrent short attempts and bounded rejection finalizers. |
| `RUNTIME_ADMISSION_RETRY_MS`, `_LEASE_MS`, `_MAX_ATTEMPTS` | 5000 / 30000 / 360 | Original deadline never resets; lease range 30–120 seconds. |
| `RUNTIME_LLM_GATEWAY_URL` | unset → recorded turns | `RUNTIME_LLM_FIXTURE` picks the recording. |
| `RUNTIME_GIT_PROVIDER`, `RUNTIME_GIT_API_BASE` | github, api.github.com | Where the cell downloads tarballs. |
| `RUNTIME_STREAM_STORE` | `postgres` | `file` keeps the shared volume (`RUNTIME_STREAM_DIR`). Hub and API. |
| `RUNTIME_EVIDENCE_STORE` | `file` | `s3` needs `RUNTIME_EVIDENCE_S3_*` (see [Evidence](#evidence)). Worker and API. |
| `RUNTIME_EVIDENCE_DIR`, `_PORT`, `_SIGNING_SECRET` | unset | File store: evidence off without them. |

The production image (`docker/Dockerfile` target `runtime-control-plane`, `RUNTIME_PRODUCTION_IMAGE=1`, `NODE_ENV=production`) refuses three dev switches:

- `RUNTIME_TEST_ONLY_PLAINTEXT`: plain HTTP and shared tokens. It also needs an explicit `RUNTIME_INTERNAL_TOKEN` and `RUNTIME_CELL_TOKENS`; there are no default tokens.
- `RUNTIME_DEV_ALLOW_INSECURE_CELLS`: accepts cells with isolation none.
- `RUNTIME_ENV_DRIVER=fake`.

Production workers also require `RUNTIME_RELEASE_VERSION`, for example an immutable build or commit ID, set consistently on replicas of that release. Never use the shared `development` identity in production. The production Docker target supplies no fallback; startup fails with a named configuration error if it is absent or invalid. The two development Compose worker examples default to `development` only when the variable is absent; an explicit empty value is rejected.

Durable admission introduces new workflow branches and Runtime migrations. Keep it off on existing deployments until an isolated rollout uses a new release identity and both sides are configured consistently. Its strict shared-host Run reservation requires two cold boot budgets plus two slots; it does not make two 12 GiB builds fit a 16 GiB host. Details and evidence boundaries: [admission implementation](../../experiments/kody-runtime/ADMISSION-IMPLEMENTATION.md).

DBOS's inferred version hashes registered workflow wrapper source, SDK version and application name; it does not traverse imported Run/setup helpers. Explicit release identity selects the compatible stored workflow version, without changing queue names or migrating checkpoints. Keep compatible old workers available to finish old-version work. A new identifier does not prove old-journal replay compatibility, and old auto-hashed executions need an explicit recovery/deployment plan.

Setup capacity waits read the current DBOS cancellation signal inside their existing boot steps. Cancellation propagates unchanged, stops the progress watcher and prevents normal closing, lesson writing and further recipe attempts for the cancelled flow. It does not abort provisioning already sent to a hub or guarantee immediate claim release; existing leases and the reaper remain the safety net until a durable setup stop/finalizer is added.

## Observability

- **Logs**: one JSON line per event, from `RuntimeLogger` (`shared/logger.ts`). Each line carries `service`, `context`, `msg`, and the active `traceId`/`spanId`. Nest's loggers write through it. Hub lines carry `replicaId`, `cellId`, `claimId`, `runId` and `stepId`.
- **Spans**:
  - Worker: `runtime.run.requested`, `runtime.run`, `runtime.run.boot`, `.agent`, `.replay`, `.intent`.
  - Hub: `runtime.hub.claim.acquire` and `runtime.hub.step`. They join the worker's trace through the W3C `traceparent` the worker sends (`hub/http/trace-context.interceptor.ts`).
  - Traces go to OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Metrics**: Prometheus on `RUNTIME_METRICS_PORT`.
  - The §11 set comes from `libs/runtime/telemetry`.
  - The hub adds `runtime.claim.ready_wait{outcome,consumer}`, `runtime.step.duration{kind,outcome}`, `runtime.hub.background_error{op}`, `runtime.claim.reconciled` and `runtime.claim.transition{to,reason}` (`HubMetrics` in `hub/hub-types.ts`). Every transition is also a `claim.transition` log line with the claim's ids, the state reached, its reason and the cell's detail.

## Run it locally

1. Write the dev CA and certificates: `scripts/runtime/dev-ca.sh .runtime-certs cell-dev-1`. Optionally, create the least-privilege Postgres, Mongo and RabbitMQ users with `scripts/runtime/dev-runtime-users.sh`.
2. Start the services: `docker compose -f docker-compose.dev.yml up runtime-hub runtime-worker`. They create the `kodus_runtime` database on boot when it is missing (`ensureDatabase` in `src/shared/runtime-schema.ts`).
   - The worker's dev seal key equals the product's dev default in the same file.
   - The hub's public port is published on 127.0.0.1:3410. The internal port is not published.
3. Run one Run end to end with the Go cell on the host: `ENV_FILE=.env experiments/kody-runtime/sample-app/run-e2e.sh`. Its header lists the variables it takes.

For the isolated stack with the TS fake cell (`src/fake-cell`), use `docker-compose.runtime.yml` with `pnpm run runtime:up` and `pnpm run runtime:e2e`. There the worker reaches the hub's internal listener on `:3411` (`RUNTIME_HUB_URL`, `RUNTIME_REPLICA_URL`) and opens tokens with the dev key from `src/testing/dev-seal-key.ts`. Its container names match the dev stack's runtime services, so run one stack at a time.

## Test it

- **Unit and contract**: `API_NODE_ENV=test npx jest apps/runtime`. Types: `npx tsc --noEmit -p apps/runtime/tsconfig.json`. `src/fake-cell/hub-cell.contract.spec.ts` runs a whole Run through the hub and the fake cell on real protocol frames.
- **Postgres and DBOS integration** (opt-in, skipped without the variable):
  `RUNTIME_IT_DATABASE_URL=postgres://… API_NODE_ENV=test npx jest apps/runtime --runInBand`.
  - Covers the guarded claim transitions, replica-scoped disconnect, slot reservation, registration atomicity, revocation, the keyed run stream (and the API's read-only read of it, and its batched retention), the advisory locks, migrations, and the run and setup workflows.
  - Use `--runInBand`: two DBOS launches on a fresh database race.
- **S3 evidence** (opt-in): `RUNTIME_IT_S3_ENDPOINT=http://localhost:9000 API_NODE_ENV=test npx jest apps/runtime/src/shared/s3-evidence-store.integration.spec.ts` against the dev MinIO (keys `RUNTIME_IT_S3_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`). A cell's PUT with a grant, a refused content type, the take, an oversized upload, an expired grant, the presigned read.
- **Go cell ↔ hub over mTLS**: `src/hub/go-cell-hub.integration.spec.ts`.
  - Runs when `go`, `docker` and `openssl` are present.
  - Builds `apps/runtime-cell` and starts a throwaway Postgres.
  - Checks both listeners, revocation, and renewal across a hub restart.


## Local browser exploration

The planner can ask for `browser_explore` when UI files changed and the acquired base claim advertises `capabilities.browserExplore: v1`. It shares the existing two exploration rounds with shell commands. The worker gives each call a stable step ID; the hub validates org/Run/base scope, the negotiated current cell connection and an atomic fresh-step registration before sending `browser.explore`. A lost step is not resent.

The cell runs agent-browser against local Chromium. The result is bounded untrusted planner input, never a replay probe. The worker checks canaries across the request/result before retaining or redacting observations; only count/duration/status summaries remain in the final agent plan. Playwright replay and the gate keep deciding the result independently.

Upgrade the product API's optional planner request schema before enabling `-browser-explore` on cells. Without the distinct capability, the worker omits the new request fields for old API compatibility. No external browser provider exists in this path. See [the delivery and validation notes](../../experiments/kody-runtime/agent-browser/README.md).

## A2A executable finding tasks

The product exposes the A2A1.0 Agent Card and JSON-RPC finding transport. Set `RUNTIME_A2A_BASE_URL` on the API to its trusted public origin (HTTPS, or literal-loopback HTTP in development), apply the new product migration and grant the read-only Runtime role only `scope`, `organization_id` and `cleared_at` on `runtime.runtime_stops`. Keys need `findings:submit`, repository scope and `env:exec` for executable probes. Upgrade the worker before enabling the product transport. The worker uses closed external probes through existing replay/gate and emits no publication for these Runs. [Implemented lifecycle, budgets, tests and remaining Inc. A work](../../experiments/kody-runtime/a2a/README.md).


## Contract completion wave 3

[#2497–#2499 behavior and rollout](../../experiments/kody-runtime/contract-wave3/README.md) covers named recipe validation, recoverable Run delivery and product-owned external-task maintenance. Apply Runtime migrations 17/18 and the additive product lifecycle migration through the normal reviewed deployment path; they were not activated by the implementation tests.

`env_validate(sessionId, name)` resolves only checks pinned from a confirmed default-branch recipe. It shares exec scopes/quota/audit, returns a step ID and requires current isolated workload execution; it never supplies observer proof or boot readiness.

Run/setup/cancel admission retry uses the product-owned private delayed direct exchange `workflow.exchange.runtime_run_retry`. Runtime has publish-only access there. `RUNTIME_COMMAND_MAX_RETRIES` and `RUNTIME_COMMAND_RETRY_DELAY_MS` bound retries; a broker storage confirmation does not guarantee future delivery. Durable PR generation records reject stale known deliveries; drain old consumers before relying on that invariant. Control commands keep their existing NACK policy. Ordering records are retained until a safe replay/collection horizon exists.

`RUNTIME_EXTERNAL_MAINTENANCE_ENABLED` defaults off in the product worker. It requires Runtime enabled and the code-review role; it reconciles overdue tasks and retains terminal/rejected tasks for at least 30 days while protecting aliases/retry relatives. Closed outcome/count/duration telemetry separates failures from verified application findings. The API persists product-owned receipts/terminal task CAS; it never writes Runtime state. The product maintenance job only reads Runtime projections.
