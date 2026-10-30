import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioResult } from "./types.js";

export interface EvidenceBundle {
    runId: string;
    startedAt: string;
    finishedAt: string;
    results: ScenarioResult[];
}

export interface RunSummary {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    blocked: number;
    // ---- breakdown of `skipped` (see SkipKind) ----------------------------
    /** appliesTo excluded the cell. Expected; the matrix is sparse by design. */
    notApplicable: number;
    /** A required secret/fixture was missing. A coverage gap, not a pass. */
    setupSkipped: number;
    /** Quota / target down. We did NOT verify this cell. */
    infraSkipped: number;
    // ---- the numbers a human actually needs -------------------------------
    /** total minus the not-applicable cells: what this run was supposed to check. */
    applicable: number;
    /** passed + failed: what it actually checked. */
    executed: number;
    /** Passed only on the retry. Counted separately — see ScenarioResult.flaky. */
    passedOnRetry: number;
}

export function summarize(bundle: EvidenceBundle): RunSummary {
    const s: RunSummary = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        blocked: 0,
        notApplicable: 0,
        setupSkipped: 0,
        infraSkipped: 0,
        applicable: 0,
        executed: 0,
        passedOnRetry: 0,
    };
    for (const r of bundle.results) {
        s.total++;
        s[r.status]++;
        if (r.status === "skipped") {
            // Results written before skipKind existed (old artifacts read by
            // `e2e:report`) have no kind. Treat them as not-applicable: that
            // was the dominant case, and guessing `infra` would retroactively
            // paint historical runs inconclusive.
            if (r.skipKind === "infra") s.infraSkipped++;
            else if (r.skipKind === "setup") s.setupSkipped++;
            else s.notApplicable++;
        }
        if (r.flaky) s.passedOnRetry++;
    }
    s.applicable = s.total - s.notApplicable;
    s.executed = s.passed + s.failed;
    return s;
}

export function writeJson(dir: string, bundle: EvidenceBundle): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "result.json"),
        JSON.stringify(bundle, null, 2),
    );
}

export function writeMarkdown(dir: string, bundle: EvidenceBundle): void {
    mkdirSync(dir, { recursive: true });
    const s = summarize(bundle);
    const lines: string[] = [];
    lines.push(`# E2E run \`${bundle.runId}\``);
    lines.push("");
    lines.push(`- Started:  ${bundle.startedAt}`);
    lines.push(`- Finished: ${bundle.finishedAt}`);
    lines.push("");
    // The headline is deliberately "passed / EXECUTED", not "passed / total".
    // Against total it reads as catastrophic on a sparse matrix (23/84) and
    // hides the only number that matters: how much of what we meant to check
    // actually ran.
    lines.push(
        `## Summary: ${s.passed}/${s.executed} passed — executed ${s.executed}/${s.applicable} applicable (${s.total} cells total)`,
    );
    lines.push("");
    lines.push(
        `- Not verified: **${s.infraSkipped} infra** (quota / target down), ${s.setupSkipped} setup (missing secret)`,
    );
    lines.push(
        `- Failed: ${s.failed} · Blocked: ${s.blocked} · Passed only on retry: **${s.passedOnRetry}**`,
    );
    lines.push(`- Not applicable (appliesTo): ${s.notApplicable}`);
    lines.push("");
    lines.push(
        `| Scenario | Target | Provider | License | Status | Why | Duration |`,
    );
    lines.push(`|---|---|---|---|---|---|---|`);
    for (const r of bundle.results) {
        const emoji =
            r.status === "passed"
                ? r.flaky
                    ? "⚠️"
                    : "✅"
                : r.status === "failed"
                  ? "❌"
                  : r.status === "skipped"
                    ? r.skipKind === "infra"
                        ? "🚧"
                        : "⊘"
                    : "⏸";
        const label =
            r.status === "passed" && r.flaky ? "passed (on retry)" : r.status;
        const why =
            r.status === "skipped"
                ? `${r.skipKind ?? "not-applicable"}${r.evidence?.skipReason ? `: ${String(r.evidence.skipReason).slice(0, 80)}` : ""}`
                : "";
        lines.push(
            `| ${r.scenarioId} | ${r.cell.target} | ${r.cell.provider} | ${r.cell.license} | ${emoji} ${label} | ${why} | ${(r.durationMs / 1000).toFixed(1)}s |`,
        );
    }
    lines.push("");
    const failures = bundle.results.filter((r) => r.status === "failed");
    if (failures.length) {
        lines.push("## Failures");
        lines.push("");
        for (const f of failures) {
            lines.push(
                `### ${f.scenarioId} × ${f.cell.target} × ${f.cell.provider} × ${f.cell.license}`,
            );
            lines.push("");
            lines.push(`**Error**: ${f.errorMessage ?? "(no message)"}`);
            lines.push("");
            if (f.errorStack) {
                lines.push("```");
                lines.push(f.errorStack.slice(0, 2000));
                lines.push("```");
                lines.push("");
            }
            if (f.evidence && Object.keys(f.evidence).length) {
                lines.push("**Evidence**:");
                lines.push("```json");
                lines.push(JSON.stringify(f.evidence, null, 2));
                lines.push("```");
                lines.push("");
            }
        }
    }
    writeFileSync(join(dir, "summary.md"), lines.join("\n"));
}

export function writeAll(dir: string, bundle: EvidenceBundle): void {
    writeJson(dir, bundle);
    writeMarkdown(dir, bundle);
}
