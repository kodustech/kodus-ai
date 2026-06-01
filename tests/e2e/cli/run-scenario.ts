#!/usr/bin/env -S node --experimental-strip-types
import { resolveScenarios } from "../scenarios/index.js";
import { runMatrix } from "../lib/runner.js";
import { writeAll } from "../lib/evidence.js";
import { logger } from "../lib/log.js";
import type {
    LicenseMode,
    MatrixCell,
    ProviderName,
    Target,
} from "../lib/types.js";

const log = logger("cli:scenario");

function parseArgs(): {
    scenarioId: string;
    target: Target;
    provider: ProviderName;
    license: LicenseMode;
    failFast: boolean;
} {
    const args = process.argv.slice(2);
    const positional: string[] = [];
    const flags: Record<string, string | boolean> = {};
    // Flags listed here never consume the next positional as their value
    // — they're pure boolean toggles. Without this, `run-scenario
    // --fail-fast my-id` swallows `my-id` as the value of fail-fast and
    // leaves scenarioId undefined.
    const booleanFlags = new Set(["fail-fast"]);
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
    const scenarioId = (flags.scenario as string) ?? positional[0];
    const target = (flags.target as Target) ?? "self-hosted";
    const provider = (flags.provider as ProviderName) ?? "github";
    const license = (flags.license as LicenseMode) ?? "license-paid";
    if (!scenarioId) {
        console.error(
            "usage: run-scenario --scenario <id> --target <cloud|self-hosted> --provider <name> --license <mode>",
        );
        process.exit(2);
    }
    return {
        scenarioId,
        target,
        provider,
        license,
        failFast: Boolean(flags["fail-fast"]),
    };
}

async function main() {
    const { scenarioId, target, provider, license, failFast } = parseArgs();
    const scenarios = resolveScenarios([scenarioId]);
    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
    const cell: MatrixCell = { target, provider, license };

    log.info(
        `Running ${scenarioId} on ${target} × ${provider} × ${license} (runId=${runId})`,
    );

    const outcome = await runMatrix({
        artifactRoot: `${process.cwd()}/evidence`,
        runId,
        target,
        cells: [cell],
        scenarios,
        failFast,
    });

    const artifactDir = `${process.cwd()}/evidence/${runId}`;
    writeAll(artifactDir, {
        runId,
        startedAt: outcome.startedAt,
        finishedAt: outcome.finishedAt,
        results: outcome.results,
    });

    const result = outcome.results[0];
    log.info(`Evidence written to ${artifactDir}`);

    if (!result || result.status !== "passed") {
        const status = result?.status ?? "no-result";
        log.err(`Scenario did not pass: status=${status}`);
        process.exit(1);
    }
    log.ok(`Scenario passed in ${(result.durationMs / 1000).toFixed(1)}s`);
}

main().catch((err) => {
    log.err((err as Error).stack ?? String(err));
    process.exit(1);
});
