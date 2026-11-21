# Runtime validation selection

`inventory.json` assigns exact reviewed test paths to layers. The runner never
passes a broad path pattern to Jest. A new test below an inventoried root fails
with `inventory_drift` until its layer is reviewed and added; the manifest's
`unlisted` field names every such path. The check needs no installed package and
runs first in the `offline` CI job, so a branch that adds a spec must list it in
the same change (re-run `--plan` after merging branches that each add specs). Missing files,
symlinks, duplicate ownership, unsafe paths and unknown arguments fail closed.

```sh
# No test execution or artifact creation; this is the default.
node scripts/runtime-validation/run.mjs --plan --layers=unit,browser

# Same exact selection used in Runtime CI. Needs installed workspace dependencies.
node scripts/runtime-validation/run.mjs --run --layers=unit,browser,planner-options,planner-host

# Only in an isolated test runner: these fixtures open local HTTP listeners.
node scripts/runtime-validation/run.mjs --run --layers=sdk --allow-fixture=sdk

# Native harness regression tests; no packages/services/browser needed.
node --test scripts/runtime-validation/run.test.mjs
```

| Layer             | Initial scope                                                                                     | Execution                            |
| ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `unit`            | Every TypeScript Runtime/domain/product/MCP/web spec below the roots that needs no service         | Jest, exact paths, 40 per process    |
| `browser`         | 9 browser-runner Node test files; does not open Chromium                                          | Native Node, one process per file    |
| `planner-options` | Planner runner option/floor/provenance regressions                                                | Native Node                          |
| `planner-host`    | Current worker planner/product-gateway scripted contract                                          | Jest; no model-quality claim         |
| `sdk`             | A2A transport plus A2A/MCP roundtrip fixtures                                                     | Jest; requires `--allow-fixture=sdk` |
| `postgres`        | Store/DBOS/reader specs gated on `RUNTIME_IT_DATABASE_URL`                                        | Catalogued; adapter unavailable      |
| `rabbitmq`        | Runtime retry fixture                                                                             | Catalogued; adapter unavailable      |
| `s3`              | Evidence store fixture                                                                            | Catalogued; adapter unavailable      |
| `go-cell`         | Specs gated on `RUNTIME_IT_GO_CELL` (Go↔hub real cell, preview edge tunnel)                        | Catalogued; adapter unavailable      |
| `boat-live`       | The boat host provider against the real API (`RUNTIME_BOAT_LIVE_TEST=1`)                          | Catalogued; adapter unavailable      |
| `browser-smoke`   | Docker browser-image context packaging fixture                                                    | Catalogued; adapter unavailable      |
| `cli`             | Runtime env/import Vitest tests                                                                   | Catalogued; adapter unavailable      |

Counts describe this inventory, not acceptance of the whole feature. The CLI leaf
paths are explicit: this is not an inventory of all CLI tests. The Go module's
race/security tests remain in `runtime-cell.yml` rather than being silently added
to the Node command. Model-backed eval runners are never run here.

Unavailable adapters refuse the **whole requested execution before starting any
layer**, even if the caller supplies an allow-fixture flag. They do not receive
inherited application database URLs or count as passing/skipped integration
coverage. Adding one requires a disposable owned fixture, explicit credentials
created for that fixture, preflight budgets, per-spec database/process isolation
where required, and teardown in success/failure/cancellation. PostgreSQL tests
must never target an application's database: some drop a literal `runtime` schema.

The runner creates a new private `kody-runtime-validation-*` directory below the
OS temporary directory. Its manifest contains selected/excluded files, inventory
hash, Node/platform/architecture, selected-test/runner SHA256, per-file
passed/failed/skipped counts, bounded command timing and outcome. These hashes
identify the selected test files and harness only; the production dependency
graph is explicitly `not_attested`. Capture the tested production source snapshot
and dirty working-tree state separately in integration/release evidence.
Selected files still `not_run` after failure remain visible. Exit codes are:

- `0`: complete selected execution passed (possibly with explicit skips), or plan succeeded.
- `1`: measured runner/test failure.
- `2`: invalid request, unavailable fixture/dependency, drift or incomplete/unreadable result.

A plan has `status: not_measured` and every selected file is `not_run`; it is never
a green test result. Empty/missing/unexpected result suites cannot pass validation.
Logs use mode0600; directories0700; each command has a3-minute timeout and16MiB log
ceiling. The timeout terminates only the command's own process group. Artifacts
are retained for diagnosis; remove only the exact directory returned in
`artifactRoot` when finished. CI uploads manifests only, not raw test output.

Children receive a small explicit environment: a private HOME/TMP, fixed test
mode, disabled integration/DBOS-cloud flags and bounded Node heap. Parent model,
Git, cloud, database, proxy, Docker and NODE_OPTIONS values are not forwarded.
The child sets `DOTENV_CONFIG_PATH` to the platform null device, preventing
transitive `dotenv/config` from reading a cwd `.env`. A regression uses only an
owned temporary synthetic `.env`; it skips the dependency-specific check if
dotenv is unavailable. Explicit application code that calls dotenv with its own
path is outside this guard. No user configuration or credential discovery occurs
in the runner.
This environment restriction is **not an OS network/filesystem sandbox**: use
isolated sources/dependencies and a network policy/container for stronger
containment. Reviewed tests can still create their synthetic local resources.
The CI job runs without repository secrets or persisted checkout credentials;
install uses the existing lockfile and package-manager version, with lifecycle
scripts disabled.

The new workflow must itself run before it is treated as installed CI acceptance.

The same workflow also runs the offline resource-profile Python contract tests
with `python3 -m unittest discover -s scripts/runtime-validation/resource-profile -p 'test_*.py'`; this does not capture live resources or establish capacity.
