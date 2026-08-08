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
const KNOWN_UNCOVERED: Record<string, string[]> = {
    "fast.yml": ["self-hosted × github × license-free"],
    "full.yml": ["self-hosted × github × license-free"],
    "full-no-sso.yml": [
        "self-hosted × github × license-free",
        "cloud × github × trial",
    ],
    "repaired-cells.yml": ["self-hosted × github × license-free"],
    "cloud-reflake.yml": ["cloud × github × trial"],
    "cloud-reflake-2.yml": ["cloud × github × trial"],
};

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

test("no matrix file grows a new cell that nothing can run", () => {
    const files = readdirSync(MATRIX_DIR).filter((f) => f.endsWith(".yml"));
    assert.ok(files.length > 0, "no matrix files found");

    const actual: Record<string, string[]> = {};
    for (const file of files) {
        const uncovered = cellsWithNoScenario(file);
        if (uncovered.length) actual[file] = uncovered;
    }

    assert.deepEqual(
        actual,
        KNOWN_UNCOVERED,
        "matrix coverage changed. A cell that appeared here provisions and runs nothing — " +
            "cover it or remove it. A cell that disappeared is fixed — drop it from KNOWN_UNCOVERED.",
    );
});

test("the release-gating matrices are the ones that matter", () => {
    // fast.yml and full.yml gate releases; the rest are ad-hoc debug files.
    // Kept as a separate assertion so the gap that actually costs a red
    // release run is called out by name.
    assert.deepEqual(cellsWithNoScenario("fast.yml"), [
        "self-hosted × github × license-free",
    ]);
    assert.deepEqual(cellsWithNoScenario("full.yml"), [
        "self-hosted × github × license-free",
    ]);
});
