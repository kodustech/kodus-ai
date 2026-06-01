import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { MatrixCell, ProviderName, Target } from "../types.js";

interface MatrixFile {
    id: string;
    scenarios: string[];
    cells: MatrixCell[];
}

function loadMatrix(name: string): MatrixFile {
    const path = resolve(import.meta.dirname, "..", "..", "matrix", name);
    return parseYaml(readFileSync(path, "utf8")) as MatrixFile;
}

const validTargets: Target[] = ["cloud", "self-hosted"];
// All provider IDs that can legitimately appear in a matrix cell. Note
// github-app is a separate ID from github even though it talks to the
// same platform — they exercise different auth code paths.
const validProviders: ProviderName[] = [
    "github",
    "github-app",
    "gitlab",
    "bitbucket",
    "azure-devops",
];
// Platform providers that fast.yml MUST cover at least once. github-app
// is intentionally excluded — it's an auth-mode variant of github, not
// a separate platform; running it is a release-gate concern, not a
// platform-coverage one.
const platformProviders: ProviderName[] = [
    "github",
    "gitlab",
    "bitbucket",
    "azure-devops",
];

test("fast.yml loads and has expected shape", () => {
    const m = loadMatrix("fast.yml");
    assert.equal(m.id, "fast");
    assert.ok(Array.isArray(m.scenarios));
    assert.ok(m.scenarios.length > 0);
    assert.ok(Array.isArray(m.cells));
    assert.ok(m.cells.length > 0);
});

test("full.yml loads and includes lifecycle scenarios", () => {
    const m = loadMatrix("full.yml");
    assert.equal(m.id, "full");
    for (const id of [
        "upgrade-n-1-to-n",
        "sso-cookie-domain",
        "sso-multi-user",
        "stripe-billing",
    ]) {
        assert.ok(
            m.scenarios.includes(id),
            `full.yml missing lifecycle scenario: ${id}`,
        );
    }
});

test("full.yml is a strict superset of fast.yml (scenarios + cells)", () => {
    const fast = loadMatrix("fast.yml");
    const full = loadMatrix("full.yml");
    for (const id of fast.scenarios) {
        assert.ok(
            full.scenarios.includes(id),
            `full.yml is missing fast.yml scenario "${id}". Mirror it.`,
        );
    }
    const cellKey = (c: MatrixCell) =>
        `${c.target}|${c.provider}|${c.license}`;
    const fullCells = new Set(full.cells.map(cellKey));
    for (const fc of fast.cells) {
        assert.ok(
            fullCells.has(cellKey(fc)),
            `full.yml is missing fast.yml cell ${cellKey(fc)}. Mirror it.`,
        );
    }
});

test("every cell in every matrix uses valid axes", () => {
    for (const name of ["fast.yml", "full.yml"]) {
        const m = loadMatrix(name);
        for (const cell of m.cells) {
            assert.ok(
                validTargets.includes(cell.target),
                `${name}: invalid target ${cell.target}`,
            );
            assert.ok(
                validProviders.includes(cell.provider),
                `${name}: invalid provider ${cell.provider}`,
            );
            assert.ok(
                [
                    "free",
                    "trial",
                    "paid",
                    "community-byok",
                    "license-paid",
                    "license-free",
                ].includes(cell.license),
                `${name}: invalid license ${cell.license}`,
            );
        }
    }
});

test("fast.yml has at least one cell per platform provider (covering all 4)", () => {
    const m = loadMatrix("fast.yml");
    const providers = new Set(m.cells.map((c) => c.provider));
    for (const p of platformProviders) {
        assert.ok(providers.has(p), `fast.yml missing platform provider: ${p}`);
    }
});

test("fast.yml covers both targets", () => {
    const m = loadMatrix("fast.yml");
    const targets = new Set(m.cells.map((c) => c.target));
    assert.ok(targets.has("cloud"), "fast.yml missing cloud target");
    assert.ok(
        targets.has("self-hosted"),
        "fast.yml missing self-hosted target",
    );
});

test("fast.yml license matrix has at least free/trial/paid for cloud", () => {
    const m = loadMatrix("fast.yml");
    const cloudLicenses = new Set(
        m.cells.filter((c) => c.target === "cloud").map((c) => c.license),
    );
    assert.ok(cloudLicenses.has("free"), "cloud missing free");
    assert.ok(cloudLicenses.has("trial"), "cloud missing trial");
    assert.ok(cloudLicenses.has("paid"), "cloud missing paid");
});

test("fast.yml license matrix has paid and free for self-hosted", () => {
    const m = loadMatrix("fast.yml");
    const shLicenses = new Set(
        m.cells.filter((c) => c.target === "self-hosted").map((c) => c.license),
    );
    assert.ok(shLicenses.has("license-paid"), "self-hosted missing license-paid");
    assert.ok(shLicenses.has("license-free"), "self-hosted missing license-free");
});
