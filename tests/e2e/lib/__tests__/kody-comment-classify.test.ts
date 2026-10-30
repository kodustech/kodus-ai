import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyKodyComment } from "../../providers/github.js";

const MARKER = "<!-- kody-codereview -->";
const badge = (sev: string) =>
    `![kody code-review](https://img.shields.io/badge/kody-code--review-312B4B) ![Security](https://img.shields.io/badge/Security-D50000) ![${sev}](https://img.shields.io/badge/severity_level-${sev}-FF3D3D)`;

test("a comment without the marker is somebody else's", () => {
    assert.equal(classifyKodyComment("just a human comment"), "review");
});

test("the completion notice is not a license block", () => {
    assert.equal(
        classifyKodyComment(`${MARKER} kody-codereview-completed 🔥`),
        "review",
    );
});

test("a real license notice is recognised", () => {
    assert.equal(
        classifyKodyComment(`${MARKER}\nYour trial has ended — activate your plan`),
        "license-block",
    );
    assert.equal(
        classifyKodyComment(`${MARKER}\nConfigure BYOK to keep reviewing`),
        "license-block",
    );
});

// The bug: on THIS codebase a security finding routinely says "BYOK" or "API
// key", because that is what the product's features are called. Cloud run
// 31616209955 failed license-attribution × community-byok on a genuine
// Security/critical finding about /stats exposing an API key.
test("a finding that mentions BYOK is a finding, not a license notice", () => {
    const finding = `${badge("critical")}\n\n${MARKER}\n\nThe /stats endpoint exposes the BYOK api key in its response.`;

    assert.equal(classifyKodyComment(finding), "review");
});

test("severity decides regardless of the wording", () => {
    for (const sev of ["critical", "high", "medium", "low"]) {
        const body = `${badge(sev)}\n${MARKER}\nTrial has ended handling is wrong here`;
        assert.equal(classifyKodyComment(body), "review");
    }
});

// A license notice carries no severity badge, so the keyword path must still
// be reachable — otherwise the guard would swallow the case it protects.
test("the guard does not swallow genuine notices", () => {
    assert.equal(
        classifyKodyComment(
            `${MARKER}\nYour trial has expired. Talk to our founders.`,
        ),
        "license-block",
    );
});

test("anything else from Kody is the start placeholder", () => {
    assert.equal(
        classifyKodyComment(`${MARKER}\nCode Review Started! 🚀`),
        "started",
    );
});
