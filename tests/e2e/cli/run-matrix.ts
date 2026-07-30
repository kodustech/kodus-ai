#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { allScenarios, resolveScenarios } from "../scenarios/index.js";
import { runMatrix } from "../lib/runner.js";
import { summarize, writeAll } from "../lib/evidence.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../lib/log.js";
import type { MatrixCell, ScenarioResult, Target } from "../lib/types.js";

const log = logger("cli:matrix");

interface MatrixFile {
    id: string;
    description?: string;
    scenarios: string[];
    cells: MatrixCell[];
}

function parseArgs(): {
    matrixPath: string;
    targetFilter?: Target;
    dryRun: boolean;
    skipMissingTokens: boolean;
} {
    const args = process.argv.slice(2);
    const positional: string[] = [];
    const flags: Record<string, string | boolean> = {};
    // Flags that take no value — treat them as booleans even if a positional
    // follows. Without this list the naive lookahead consumes the matrix path
    // as the value of `--skip-missing-tokens`.
    const booleanFlags = new Set(["dry-run", "skip-missing-tokens"]);
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = args[i + 1];
            if (!booleanFlags.has(key) && next && !next.startsWith("--")) {
                flags[key] = next;
                i++;
            } else {
                flags[key] = true;
            }
        } else {
            positional.push(a);
        }
    }
    const matrixPath = (flags.matrix as string) ?? positional[0];
    if (!matrixPath) {
        console.error(
            "usage: run-matrix <matrix.yml> [--target cloud|self-hosted] [--dry-run] [--skip-missing-tokens]",
        );
        process.exit(2);
    }
    return {
        matrixPath: resolve(matrixPath),
        targetFilter: flags.target as Target | undefined,
        dryRun: Boolean(flags["dry-run"]),
        skipMissingTokens: Boolean(flags["skip-missing-tokens"]),
    };
}

// Env vars each provider needs to function. Used by --skip-missing-tokens to
// filter cells locally before any provisioning happens. Keep in sync with
// `requireEnv` calls in tests/e2e/providers/*.ts.
const PROVIDER_REQUIRED_ENV: Record<string, string[]> = {
    github: ["GH_TEST_TOKEN", "GH_TEST_REPO"],
    // GitHub App variant: shares GH_TEST_TOKEN with `github` (used for
    // PR open / comment posting / webhook listing — those code paths
    // still run as a user, not as the App). The App-specific bits are
    // GH_APP_TEST_REPO (where the App is installed, scope-limited) and
    // GH_APP_INSTALLATION_ID (the numeric id captured after install).
    "github-app": [
        "GH_TEST_TOKEN",
        "GH_APP_TEST_REPO",
        "GH_APP_INSTALLATION_ID",
    ],
    gitlab: ["GL_TEST_TOKEN", "GL_TEST_REPO"],
    bitbucket: ["BB_TEST_USER", "BB_TEST_APP_PASSWORD", "BB_TEST_REPO"],
    "azure-devops": [
        "AZ_TEST_TOKEN",
        "AZ_TEST_ORG",
        "AZ_TEST_PROJECT",
        "AZ_TEST_REPO",
    ],
};

function missingEnvFor(provider: string): string[] {
    const required = PROVIDER_REQUIRED_ENV[provider] ?? [];
    return required.filter((v) => !process.env[v]);
}

// Some scenarios need extra inputs beyond the provider token — e.g. a license
// JWT on disk. With `--skip-missing-tokens`, we drop the scenario from the run
// instead of letting it fail at runtime. The check runs once per scenario id
// (not per cell), so the message surfaces before we provision anything.
//
// Keep in sync with the file/env reads inside each scenario's run() body.
interface ScenarioRequirement {
    files?: string[]; // absolute paths; presence required
    envOrFiles?: Array<{ env: string; defaultFile: string }>; // satisfied if either present
    env?: string[]; // env vars whose non-empty presence is required
}

function resolveHome(p: string): string {
    return p.startsWith("~/")
        ? `${process.env.HOME ?? ""}${p.slice(1)}`
        : p;
}

const SCENARIO_REQUIRED: Record<string, ScenarioRequirement> = {
    "per-seat-license-toggle": {
        envOrFiles: [
            {
                env: "SH_LICENSE_KEY_PATH",
                defaultFile: "~/.kodus-dev/license-seats1.jwt",
            },
        ],
    },
    // Mints a throwaway repo per run, which needs org Administration on
    // kodus-e2e (create + delete). The regular fine-grained GH_TEST_TOKEN
    // lacks that by design, so without the admin token the scenario would
    // 403 at repo creation — skip it instead. In CI the token is the QA
    // environment secret GH_REPO_ADMIN_TOKEN; set it locally to opt in.
    "trial-managed-review": {
        env: ["GH_REPO_ADMIN_TOKEN"],
    },
};

function missingScenarioRequirements(scenarioId: string): string[] {
    const req = SCENARIO_REQUIRED[scenarioId];
    if (!req) return [];
    const missing: string[] = [];
    for (const f of req.files ?? []) {
        if (!existsSync(resolveHome(f))) missing.push(`file:${f}`);
    }
    for (const { env, defaultFile } of req.envOrFiles ?? []) {
        const envVal = process.env[env];
        const path = envVal ? resolveHome(envVal) : resolveHome(defaultFile);
        if (!existsSync(path)) {
            missing.push(`${env} (or file ${defaultFile})`);
        }
    }
    for (const env of req.env ?? []) {
        if (!process.env[env]) missing.push(`env:${env}`);
    }
    return missing;
}

async function main() {
    const { matrixPath, targetFilter, dryRun, skipMissingTokens } = parseArgs();
    const raw = readFileSync(matrixPath, "utf8");
    const matrix = parseYaml(raw) as MatrixFile;

    let scenarios = resolveScenarios(matrix.scenarios);
    let cells = targetFilter
        ? matrix.cells.filter((c) => c.target === targetFilter)
        : matrix.cells;

    let preSkipped: Array<{ cell: MatrixCell; missing: string[] }> = [];
    let scenarioSkipped: Array<{ scenarioId: string; missing: string[] }> = [];
    if (skipMissingTokens) {
        const kept: MatrixCell[] = [];
        for (const cell of cells) {
            const missing = missingEnvFor(cell.provider);
            if (missing.length > 0) {
                preSkipped.push({ cell, missing });
            } else {
                kept.push(cell);
            }
        }
        if (preSkipped.length > 0) {
            log.info(
                `Skipping ${preSkipped.length} cells (missing provider tokens — won't fail the run):`,
            );
            for (const { cell, missing } of preSkipped) {
                log.info(
                    `  - ${cell.provider} × ${cell.target} × ${cell.license} (need: ${missing.join(", ")})`,
                );
            }
        }
        const keptScenarios = scenarios.filter((s) => {
            const missing = missingScenarioRequirements(s.id);
            if (missing.length > 0) {
                scenarioSkipped.push({ scenarioId: s.id, missing });
                return false;
            }
            return true;
        });
        if (scenarioSkipped.length > 0) {
            log.info(
                `Skipping ${scenarioSkipped.length} scenario(s) (missing scenario-specific inputs):`,
            );
            for (const { scenarioId, missing } of scenarioSkipped) {
                log.info(`  - ${scenarioId} (need: ${missing.join(", ")})`);
            }
        }
        scenarios = keptScenarios;
        cells = kept;
        if (cells.length === 0) {
            log.err(
                "All cells were skipped due to missing provider tokens. Set at least one provider's env vars and re-run.",
            );
            process.exit(2);
        }
    }

    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
    log.info(`Matrix ${matrix.id} (${cells.length} cells × ${scenarios.length} scenarios) runId=${runId}`);

    const allResults: ScenarioResult[] = [];
    const startedAt = new Date().toISOString();
    const targetsToRun: Target[] = targetFilter
        ? [targetFilter]
        : Array.from(new Set(cells.map((c) => c.target))) as Target[];

    // Split the run into independently-schedulable units, then run them
    // all in parallel.
    //
    //   cloud           → ONE unit (all cloud cells share qa.web.kodus.io
    //                      and the seeded cloud tenants; serial within).
    //   self-hosted      → ONE unit PER PROVIDER, each pinned to its own
    //                      droplet via SELFHOSTED_*_<PROVIDER> (set by
    //                      --auto-provision-per-provider). Isolating per
    //                      provider makes cross-provider license-state
    //                      pollution impossible and cuts wall-time (4
    //                      providers no longer queue behind one droplet).
    //
    // Cells WITHIN a unit stay serial on purpose: they share one droplet
    // (or the cloud control plane) and license-state ordering matters
    // (e.g. per-seat teardown affects the next cell). Concurrency is
    // bounded to one in-flight review per unit, so the peak LLM load is
    // the number of units, not the number of cells.
    interface RunUnit {
        target: Target;
        label: string;
        cells: MatrixCell[];
    }
    const runUnits: RunUnit[] = [];
    for (const target of targetsToRun) {
        const targetCells = cells.filter((c) => c.target === target);
        if (!targetCells.length) continue;
        if (target === "self-hosted") {
            const providers = Array.from(
                new Set(targetCells.map((c) => c.provider)),
            );
            for (const provider of providers) {
                runUnits.push({
                    target,
                    label: `${target}/${provider}`,
                    cells: targetCells.filter((c) => c.provider === provider),
                });
            }
        } else {
            runUnits.push({ target, label: target, cells: targetCells });
        }
    }

    const targetOutcomes = await Promise.allSettled(
        runUnits.map(async (unit) => {
            log.info(
                `--- [${unit.label}] running ${unit.cells.length} cell(s) in parallel with ${runUnits.length - 1} other unit(s)`,
            );
            const outcome = await runMatrix({
                artifactRoot: `${process.cwd()}/evidence`,
                runId,
                target: unit.target,
                cells: unit.cells,
                scenarios,
                dryRun,
            });
            return { label: unit.label, results: outcome.results };
        }),
    );
    let targetCrashed = false;
    for (const settled of targetOutcomes) {
        if (settled.status === "fulfilled") {
            allResults.push(...settled.value.results);
        } else {
            // A whole target crashing (e.g. provisioning failed before
            // any cell could run) is rare — every cell's own
            // assertion failures are caught inside runMatrix and end
            // up in `results`. If this fires we surface it on stderr
            // and continue tallying whatever the other target
            // produced. Crucially we also flag the crash so the
            // process exits non-zero even when `summary.failed` is 0
            // (which is what happens when provisioning blows up
            // before a single cell got to record a failure). Without
            // this flag a release gate could silently turn green on
            // a run where one whole target never executed.
            targetCrashed = true;
            log.err(
                `--- target run rejected: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`,
            );
        }
    }
    const finishedAt = new Date().toISOString();
    const bundle = { runId, startedAt, finishedAt, results: allResults };

    const artifactDir = `${process.cwd()}/evidence/${runId}`;
    writeAll(artifactDir, bundle);

    const summary = summarize(bundle);
    const preSkippedNote =
        preSkipped.length > 0
            ? ` — ${preSkipped.length} cells SKIPPED upfront (missing tokens)`
            : "";
    log.info(
        `Result: ${summary.passed}/${summary.total} passed (failed=${summary.failed}, skipped=${summary.skipped}, blocked=${summary.blocked})${preSkippedNote}`,
    );
    log.info(`Evidence: ${artifactDir}`);

    // ---- Tiered gating ---------------------------------------------------
    // Only P0 scenarios FAIL the run. P1/P2 failures (and quarantined
    // cells) are ADVISORY: the run stays green and they're reported as
    // warnings — in the log here and in the Discord summary built from
    // notify.json. This is what makes the matrix's red trustworthy: red
    // means a release gate broke, not that a P1 demo endpoint hiccuped.
    const failedResults = allResults.filter((r) => r.status === "failed");
    const gating = failedResults.filter(
        (r) => priorityOf(r.scenarioId) === "P0" && !isQuarantined(r),
    );
    const gatingSet = new Set(gating);
    const advisory = failedResults.filter((r) => !gatingSet.has(r));

    for (const r of advisory) {
        const why = isQuarantined(r)
            ? "quarantined"
            : `priority ${priorityOf(r.scenarioId)}`;
        log.info(
            `ADVISORY (non-gating, ${why}): ${describeCell(r)} — ${firstLine(r.errorMessage)}`,
        );
    }

    // Machine-readable digest for the CI notify step (Discord message with
    // real numbers instead of a binary "failed"). Lives NEXT TO result.json;
    // the workflow reads evidence/<latest>/notify.json.
    // Only cells that PASSED on their second attempt — i.e. genuine flakes
    // the retry absorbed. A cell that failed twice shows up in gating/
    // advisory instead.
    const retried = allResults.filter(
        (r) =>
            r.status === "passed" &&
            (r.evidence as Record<string, unknown>)?.retriedAfter,
    );
    const notify = {
        runId,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        skipped: summary.skipped,
        blocked: summary.blocked,
        preSkippedCells: preSkipped.length,
        targetCrashed,
        gatingFailures: gating.map((r) => ({
            cell: describeCell(r),
            error: firstLine(r.errorMessage),
        })),
        advisoryFailures: advisory.map((r) => ({
            cell: describeCell(r),
            priority: priorityOf(r.scenarioId),
            quarantined: isQuarantined(r),
            error: firstLine(r.errorMessage),
        })),
        retriedCells: retried.map((r) => describeCell(r)),
    };
    writeFileSync(
        join(artifactDir, "notify.json"),
        JSON.stringify(notify, null, 2),
    );

    if (gating.length > 0 || summary.blocked > 0 || targetCrashed) {
        process.exit(1);
    }
    if (advisory.length > 0) {
        log.info(
            `Run is GREEN with ${advisory.length} advisory (non-gating) failure(s) — see notify.json / Discord summary.`,
        );
    }
}

// Cells under investigation: they still RUN and REPORT (advisory) but never
// gate the release. Format: "scenario-id" (all cells) or
// "scenario-id×provider×license" (one cell). Keep entries SHORT-LIVED —
// every entry must have an open issue; quarantine is a parking lot, not a
// graveyard.
const QUARANTINED: string[] = [];

function isQuarantined(r: ScenarioResult): boolean {
    return (
        QUARANTINED.includes(r.scenarioId) ||
        QUARANTINED.includes(
            `${r.scenarioId}×${r.cell.provider}×${r.cell.license}`,
        )
    );
}

// Priority lookup from the scenario registry. Unknown id → P0
// (conservative: an unregistered scenario should gate, not slip through).
function priorityOf(scenarioId: string): string {
    return allScenarios[scenarioId]?.priority ?? "P0";
}

function describeCell(r: ScenarioResult): string {
    return `${r.scenarioId} × ${r.cell.target} × ${r.cell.provider} × ${r.cell.license}`;
}

function firstLine(message?: string): string {
    return (message ?? "").split("\n")[0].slice(0, 300);
}

main().catch((err) => {
    log.err((err as Error).stack ?? String(err));
    process.exit(1);
});
