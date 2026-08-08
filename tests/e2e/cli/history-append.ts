#!/usr/bin/env -S node --experimental-strip-types
/**
 * Append a finished matrix run to the durable history log.
 *
 * The run already wrote everything we need (`result.json` + `notify.json`),
 * but only inside a CI artifact that expires. This flattens it into
 * append-only JSONL that survives, so `e2e:report` can answer "when did this
 * cell last pass?" and "what is actually flaky?" across runs.
 *
 * usage: history-append [--evidence <dir>] [--history <file>] [--matrix-id <id>]
 *
 * Defaults: newest directory under tests/e2e/evidence, history file from
 * E2E_HISTORY_FILE or tests/e2e/history/e2e-history.jsonl.
 */
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logger } from "../lib/log.js";
import { serializeRows, toHistoryRows } from "../lib/history.js";
import type { EvidenceBundle } from "../lib/evidence.js";
import type { RunVerdict } from "../lib/types.js";

const log = logger("cli:history");

const DEFAULT_HISTORY = "history/e2e-history.jsonl";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function newestEvidenceDir(root: string): string | undefined {
    if (!existsSync(root)) return undefined;
    const dirs = readdirSync(root)
        .map((d) => join(root, d))
        .filter((p) => {
            try {
                return statSync(p).isDirectory() && existsSync(join(p, "result.json"));
            } catch {
                return false;
            }
        })
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return dirs[0];
}

function main(): void {
    const evidenceDir =
        arg("evidence") ?? newestEvidenceDir(resolve(process.cwd(), "evidence"));
    if (!evidenceDir) {
        // Not an error: a run that died before writing evidence has nothing to
        // append, and failing here would turn a reporting gap into a red job.
        log.info("No evidence directory with a result.json — nothing to append.");
        return;
    }

    const bundle = JSON.parse(
        readFileSync(join(evidenceDir, "result.json"), "utf8"),
    ) as EvidenceBundle;

    // notify.json carries the run-level verdict. Absent (older run, or the
    // matrix died before writing it) → the rows still go in without it.
    let verdict: RunVerdict | undefined;
    const notifyPath = join(evidenceDir, "notify.json");
    if (existsSync(notifyPath)) {
        try {
            verdict = JSON.parse(readFileSync(notifyPath, "utf8")).verdict;
        } catch {
            /* keep going — the results matter more than the verdict */
        }
    }

    const rows = toHistoryRows(bundle, {
        matrixId: arg("matrix-id") ?? process.env.MATRIX_FILE?.replace(/^matrix\//, "").replace(/\.ya?ml$/, "") ?? "unknown",
        verdict,
        ref: process.env.GITHUB_SHA,
        ciRunId: process.env.GITHUB_RUN_ID,
    });

    const historyFile = resolve(
        process.cwd(),
        arg("history") ?? process.env.E2E_HISTORY_FILE ?? DEFAULT_HISTORY,
    );
    mkdirSync(dirname(historyFile), { recursive: true });
    appendFileSync(historyFile, serializeRows(rows));
    log.ok(`Appended ${rows.length} row(s) for run ${bundle.runId} → ${historyFile}`);
}

main();
