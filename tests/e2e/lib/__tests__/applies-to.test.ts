import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { MatrixCell, Scenario } from "../types.js";
// Import the SHIPPED implementation. This file used to re-declare its own
// copy, so the test could stay green while the real matcher drifted.
import { appliesToCell } from "../runner.js";

const dummyRun = async () => ({});

const scenario: Scenario = {
    id: "test",
    title: "test",
    priority: "P0",
    appliesTo: {
        target: ["cloud"],
        provider: ["github", "gitlab"],
        license: ["paid"],
    },
    run: dummyRun,
};

test("appliesToCell: match exact cell", () => {
    const cell: MatrixCell = { target: "cloud", provider: "github", license: "paid" };
    assert.equal(appliesToCell(scenario, cell), true);
});

test("appliesToCell: reject wrong target", () => {
    const cell: MatrixCell = {
        target: "self-hosted",
        provider: "github",
        license: "paid",
    };
    assert.equal(appliesToCell(scenario, cell), false);
});

test("appliesToCell: reject wrong provider", () => {
    const cell: MatrixCell = {
        target: "cloud",
        provider: "bitbucket",
        license: "paid",
    };
    assert.equal(appliesToCell(scenario, cell), false);
});

test("appliesToCell: reject wrong license", () => {
    const cell: MatrixCell = { target: "cloud", provider: "github", license: "free" };
    assert.equal(appliesToCell(scenario, cell), false);
});

test("appliesToCell: empty appliesTo applies to everything", () => {
    const wildcard: Scenario = {
        id: "wild",
        title: "wild",
        priority: "P0",
        appliesTo: {},
        run: dummyRun,
    };
    const cells: MatrixCell[] = [
        { target: "cloud", provider: "github", license: "free" },
        { target: "self-hosted", provider: "azure-devops", license: "license-paid" },
        { target: "cloud", provider: "bitbucket", license: "trial" },
    ];
    for (const c of cells) assert.equal(appliesToCell(wildcard, c), true);
});

test("appliesToCell: partial appliesTo (only license)", () => {
    const onlyLicense: Scenario = {
        id: "onlyLicense",
        title: "onlyLicense",
        priority: "P0",
        appliesTo: { license: ["license-paid"] },
        run: dummyRun,
    };
    assert.equal(
        appliesToCell(onlyLicense, {
            target: "self-hosted",
            provider: "gitlab",
            license: "license-paid",
        }),
        true,
    );
    assert.equal(
        appliesToCell(onlyLicense, {
            target: "self-hosted",
            provider: "gitlab",
            license: "license-free",
        }),
        false,
    );
});
