import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioResult } from "./types.js";

export interface EvidenceBundle {
    runId: string;
    startedAt: string;
    finishedAt: string;
    results: ScenarioResult[];
}

export function summarize(bundle: EvidenceBundle): {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    blocked: number;
} {
    const summary = { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 };
    for (const r of bundle.results) {
        summary.total++;
        summary[r.status]++;
    }
    return summary;
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
    lines.push(
        `## Summary: ${s.passed}/${s.total} passed (failed=${s.failed}, skipped=${s.skipped}, blocked=${s.blocked})`,
    );
    lines.push("");
    lines.push(`| Scenario | Target | Provider | License | Status | Duration |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const r of bundle.results) {
        const emoji =
            r.status === "passed"
                ? "✅"
                : r.status === "failed"
                  ? "❌"
                  : r.status === "skipped"
                    ? "⊘"
                    : "⏸";
        lines.push(
            `| ${r.scenarioId} | ${r.cell.target} | ${r.cell.provider} | ${r.cell.license} | ${emoji} ${r.status} | ${(r.durationMs / 1000).toFixed(1)}s |`,
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
