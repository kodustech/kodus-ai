#!/usr/bin/env -S node --experimental-strip-types
/**
 * The matrix's missing dashboard.
 *
 * Answers the three questions that used to require grepping Actions logs by
 * hand — which is how a broken github cell stayed broken for six days:
 *
 *   1. When did each cell last actually pass?      (last-green)
 *   2. What is flaky, and how flaky?               (flake rate)
 *   3. How much of what we meant to check ran?     (executed coverage)
 *
 * usage: report [--history <file>] [--days 30] [--format text|md] [--target cloud|self-hosted]
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    cellHealth,
    daysSince,
    parseHistory,
    quarantineCandidates,
    runRollups,
    type CellHealth,
    type HistoryRow,
} from "../lib/history.js";

const DEFAULT_HISTORY = "history/e2e-history.jsonl";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function pct(n: number): string {
    return `${Math.round(n * 100)}%`;
}

function ago(iso: string | null, now: Date): string {
    if (!iso) return "NEVER";
    const d = daysSince(iso, now);
    if (d === null) return "NEVER";
    if (d === 0) return "today";
    return `${d}d ago`;
}

function main(): void {
    const now = new Date();
    const days = Number(arg("days") ?? 30);
    const format = arg("format") ?? "text";
    const targetFilter = arg("target");
    const historyFile = resolve(
        process.cwd(),
        arg("history") ?? process.env.E2E_HISTORY_FILE ?? DEFAULT_HISTORY,
    );

    if (!existsSync(historyFile)) {
        console.error(
            `No history at ${historyFile}.\n` +
                `The log starts empty and fills as runs complete (see cli/history-append.ts).\n` +
                `To seed it from the CI artifacts that still exist, run:\n` +
                `  tests/e2e/provisioning/history-backfill.sh`,
        );
        process.exit(2);
    }

    let rows: HistoryRow[] = parseHistory(readFileSync(historyFile, "utf8"));
    if (targetFilter) rows = rows.filter((r) => r.target === targetFilter);
    if (rows.length === 0) {
        console.error("History file has no usable rows yet.");
        process.exit(2);
    }

    const health = cellHealth(rows, { sinceDays: days, now });
    const runs = runRollups(rows).slice(0, 12);
    const candidates = quarantineCandidates(health);

    // Cells that exist in the log but have not passed inside the window.
    // `NEVER` here is the loudest signal in the report: a gate we believe we
    // have that has produced no green result at all.
    const stale = health
        .filter((h) => !h.lastGreen)
        .sort((a, b) => b.unverified + b.failed - (a.unverified + a.failed));
    const unverifiedHeavy = health
        .filter((h) => h.unverified > 0)
        .sort((a, b) => b.unverified - a.unverified);

    const md = format === "md";
    const out: string[] = [];
    const h1 = (s: string) => out.push(md ? `\n## ${s}` : `\n=== ${s} ===`);
    const line = (s = "") => out.push(s);

    line(
        md
            ? `# E2E matrix health — last ${days} days${targetFilter ? ` (${targetFilter})` : ""}`
            : `E2E matrix health — last ${days} days${targetFilter ? ` (${targetFilter})` : ""}`,
    );
    line(
        `${rows.length} rows · ${runs.length} run${runs.length === 1 ? "" : "s"} shown · source: ${historyFile}`,
    );

    h1("Recent runs");
    if (md) {
        line();
        line("| when | matrix | verdict | passed | verified | not verified | flaky |");
        line("|---|---|---|---|---|---|---|");
    }
    for (const r of runs) {
        const verified = `${r.executed}/${r.applicable}`;
        if (md) {
            line(
                `| ${r.ts.slice(0, 16).replace("T", " ")} | ${r.matrixId} | ${(r.verdict ?? "?").toUpperCase()} | ${r.passed}/${r.executed} | ${verified} | ${r.infraSkipped} | ${r.flaky} |`,
            );
        } else {
            line(
                `  ${r.ts.slice(0, 16).replace("T", " ")}  ${(r.verdict ?? "?").padEnd(12)} ${String(r.passed).padStart(3)}/${String(r.executed).padEnd(3)} passed  verified ${verified.padEnd(7)} unverified=${r.infraSkipped} flaky=${r.flaky}  [${r.matrixId}]`,
            );
        }
    }

    h1(`Cells with NO green in ${days}d (${stale.length})`);
    if (stale.length === 0) {
        line(md ? "\nNone — every cell passed at least once." : "  none");
    } else {
        if (md) {
            line();
            line("| cell | executed | failed | unverified |");
            line("|---|---|---|---|");
        }
        for (const h of stale.slice(0, 25)) {
            line(
                md
                    ? `| \`${h.cell}\` | ${h.executed} | ${h.failed} | ${h.unverified} |`
                    : `  ${h.cell}\n      executed=${h.executed} failed=${h.failed} unverified=${h.unverified}`,
            );
        }
    }

    h1(`Coverage lost to infra (${unverifiedHeavy.length} cells)`);
    if (unverifiedHeavy.length === 0) {
        line(md ? "\nNone — nothing was skipped for quota or an unreachable target." : "  none");
    } else {
        for (const h of unverifiedHeavy.slice(0, 15)) {
            line(
                md
                    ? `- \`${h.cell}\` — **${h.unverified}** run(s) not verified, last green ${ago(h.lastGreen, now)}`
                    : `  ${String(h.unverified).padStart(3)}× unverified  ${h.cell}  (last green ${ago(h.lastGreen, now)})`,
            );
        }
    }

    h1("Flakiest cells");
    const flaky = health
        .filter((h) => h.flaky > 0 || h.failRate > 0)
        .sort((a, b) => b.flakeRate + b.failRate - (a.flakeRate + a.failRate))
        .slice(0, 15);
    if (flaky.length === 0) {
        line(md ? "\nNone." : "  none");
    } else {
        if (md) {
            line();
            line("| cell | runs | flake | fail | last green |");
            line("|---|---|---|---|---|");
        }
        for (const h of flaky) {
            line(
                md
                    ? `| \`${h.cell}\` | ${h.executed} | ${pct(h.flakeRate)} | ${pct(h.failRate)} | ${ago(h.lastGreen, now)} |`
                    : `  flake=${pct(h.flakeRate).padStart(4)} fail=${pct(h.failRate).padStart(4)} n=${String(h.executed).padStart(3)}  ${h.cell}  (last green ${ago(h.lastGreen, now)})`,
            );
        }
    }

    h1("Quarantine candidates");
    line(
        md
            ? "\nCells with enough runs for the rate to mean something (≥5) and ≥30% flake+fail. Add to `QUARANTINED` in `lib/verdict.ts` **with an open issue**, or fix them."
            : "  (>=5 runs, >=30% flake+fail — add to QUARANTINED in lib/verdict.ts WITH an issue, or fix)",
    );
    if (candidates.length === 0) {
        line(md ? "\nNone." : "  none");
    } else {
        for (const h of candidates) {
            line(
                md
                    ? `- \`${h.scenario}×${h.provider}×${h.license}\` — ${pct(h.flakeRate)} flake / ${pct(h.failRate)} fail over ${h.executed} runs`
                    : `  ${h.scenario}×${h.provider}×${h.license}  ${pct(h.flakeRate)} flake / ${pct(h.failRate)} fail over ${h.executed} runs`,
            );
        }
    }

    // Last-green table is the long one; keep it last so the alarming
    // sections are what a reader sees first.
    h1("Last green per cell");
    const byAge = [...health].sort((a, b) => {
        const da = daysSince(a.lastGreen, now) ?? 9999;
        const db = daysSince(b.lastGreen, now) ?? 9999;
        return db - da;
    });
    if (md) {
        line();
        line("| cell | last green | runs | flake |");
        line("|---|---|---|---|");
    }
    for (const h of byAge) {
        line(
            md
                ? `| \`${h.cell}\` | ${ago(h.lastGreen, now)} | ${h.executed} | ${pct(h.flakeRate)} |`
                : `  ${ago(h.lastGreen, now).padEnd(10)} n=${String(h.executed).padStart(3)} flake=${pct(h.flakeRate).padStart(4)}  ${h.cell}`,
        );
    }

    console.log(out.join("\n"));
}

main();
