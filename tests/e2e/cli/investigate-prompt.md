# E2E matrix failure investigation

You are investigating failures from a self-hosted E2E matrix run of this
repository (a code-review product). The run's evidence is in `evidence/`:

- `evidence/*/result.json` — per-cell scenario results. Failed rows carry
  `errorMessage`/`errorStack`; setup skips carry `evidence.skipReason`.
- `evidence/*/notify.json` — per-cell verdict, `advisoryFailures` (with
  priority), `gatingFailures`.
- `evidence/droplet-logs-<provider>.txt` — application logs captured from
  the ephemeral VM that ran that cell (API, worker, web containers).

The full monorepo is checked out at the repository root: the E2E harness
lives in `tests/e2e/` (scenarios in `tests/e2e/scenarios/`, helpers in
`tests/e2e/lib/`), the product API/backend in `libs/` and `apps/`.

## Task

For EACH advisory or gating failure in the evidence (ignore plain
not-applicable skips):

1. Follow the error: find the failing request/assertion in the scenario
   code under `tests/e2e/scenarios/`, then look for the corresponding
   moment in the droplet logs (stack traces, HTTP status lines, error
   logs around the scenario's time window).
2. Locate the responsible code path in the product (`libs/`, `apps/`)
   when the failure points at one.
3. Decide the classification with evidence:
   - `product` — the application misbehaved (cite file:line of the
     suspect code path),
   - `test-side` — harness/fixture/test-env defect (cite the scenario or
     fixture gap),
   - `infra` — external service/quota/network (cite the error that
     proves it).
4. Propose the most plausible fix or next diagnostic step.

Known context: quota errors from `aiplatform.googleapis.com` are a known
external Vertex quota issue — classify as `infra`, do not re-investigate
deeply.

## Output contract (write BOTH files at the repository root)

`investigation.md` — a human report: one `##` section per failure with
classification, confidence, the evidence trail you followed (quote the
decisive log lines), and the proposed fix. Lead with a 2-3 line overview.

`investigation.json` — machine-readable, exactly this shape:

```json
[
  {
    "signature": "<scenario-id>:<short-stable-slug-of-error-kind>",
    "title": "<one-line issue title>",
    "scenario": "<scenario id>",
    "cell": "<provider> × <license>",
    "classification": "product | test-side | infra",
    "confidence": "high | medium | low",
    "root_cause": "<2-4 sentences>",
    "suggested_fix": "<1-3 sentences>"
  }
]
```

The `signature` must be STABLE across runs for the same underlying
failure (same scenario + same error kind ⇒ same signature; never include
timestamps, run ids, or org ids in it).

Rules: read-only investigation — do not modify any file except the two
outputs. If the evidence is insufficient to decide, say so and mark
confidence `low` with the missing piece named. Do not invent log lines.
