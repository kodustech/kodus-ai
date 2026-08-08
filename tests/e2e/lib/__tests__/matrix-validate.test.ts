import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parse } from "yaml";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appliesToCell } from "../runner.js";
import { allScenarios } from "../../scenarios/index.js";
import type { MatrixCell } from "../types.js";

const MATRIX_DIR = join(import.meta.dirname, "../../matrix");

/**
 * A cell no scenario applies to provisions infrastructure, runs nothing, and
 * produces a run that verified zero cells. `run-matrix --validate` now fails
 * on that at plan time (before a droplet exists); this test keeps the shipped
 * matrix files honest so the CI check never has to fire.
 *
 * The map below is the CURRENT inventory of uncovered cells, pinned on
 * purpose. The assertion is an exact match, so:
 *   - a NEW uncovered cell fails here instead of burning a droplet;
 *   - FIXING one also fails here, telling you to drop it from the map rather
 *     than leaving a stale exception behind.
 *
 * Every entry is a real coverage gap, not a quirk of the checker:
 *   fast.yml / full-no-sso.yml / repaired-cells.yml
 *     self-hosted × github × license-free — no scenario covers the
 *     self-hosted free tier. license-attribution explicitly excludes it
 *     (self-hosted has no state where Kody posts a license notice), and
 *     nothing replaced that coverage.
 *   cloud-reflake*.yml / full-no-sso.yml
 *     cloud × github × trial — these files carry a narrowed scenario list
 *     that happens to exclude every trial-scoped scenario.
 */
function cellsWithNoScenario(file: string): string[] {
    const m = parse(readFileSync(join(MATRIX_DIR, file), "utf8")) as {
        scenarios: string[];
        cells: MatrixCell[];
    };
    const scenarios = m.scenarios
        .map((id) => allScenarios[id])
        .filter(Boolean);
    return m.cells
        .filter((cell) => !scenarios.some((s) => appliesToCell(s, cell)))
        .map((c) => `${c.target} × ${c.provider} × ${c.license}`);
}

test("every cell in every matrix file has something to run", () => {
    const files = readdirSync(MATRIX_DIR).filter((f) => f.endsWith(".yml"));
    assert.ok(files.length > 0, "no matrix files found");

    const offenders: string[] = [];
    for (const file of files) {
        for (const cell of cellsWithNoScenario(file)) {
            offenders.push(`${file}: ${cell}`);
        }
    }

    assert.deepEqual(
        offenders,
        [],
        `these cells would provision infrastructure and run nothing:\n${offenders.join("\n")}\n` +
            "Cover the cell with a scenario, or remove it from the matrix file.",
    );
});

test("the release-gating matrices are clean", () => {
    // fast.yml and full.yml gate releases; called out separately so a
    // regression there is unmistakable in the failure output.
    assert.deepEqual(cellsWithNoScenario("fast.yml"), []);
    assert.deepEqual(cellsWithNoScenario("full.yml"), []);
});

/**
 * The mirror of the check above: a scenario listed in a matrix that no cell can
 * run. The cell-side check cannot catch it — every cell still has work, the
 * scenario just has no home — and it is silent coverage loss, which is the
 * failure mode this whole area exists to eliminate.
 *
 * Caught live: moving the cloud github cells to the GitHub App orphaned
 * `stripe-billing`, which was pinned to `provider: ["github"]`.
 */
function scenariosWithNoCell(file: string): string[] {
    const m = parse(readFileSync(join(MATRIX_DIR, file), "utf8")) as {
        scenarios: string[];
        cells: MatrixCell[];
    };
    return m.scenarios.filter((id) => {
        const s = allScenarios[id];
        if (!s) return false;
        return !m.cells.some((cell) => appliesToCell(s, cell));
    });
}

test("every scenario in every matrix file has a cell to run on", () => {
    const files = readdirSync(MATRIX_DIR).filter((f) => f.endsWith(".yml"));
    const offenders: string[] = [];
    for (const file of files) {
        for (const id of scenariosWithNoCell(file)) {
            offenders.push(`${file}: ${id}`);
        }
    }
    assert.deepEqual(
        offenders,
        [],
        `these scenarios are listed but can never execute:\n${offenders.join("\n")}\n` +
            "Widen the scenario's appliesTo, add a cell it matches, or drop it from the list.",
    );
});
