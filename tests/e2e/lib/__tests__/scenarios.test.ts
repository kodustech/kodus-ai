import { strict as assert } from "node:assert";
import { test } from "node:test";
import { allScenarios, resolveScenarios } from "../../scenarios/index.js";

test("allScenarios: includes the registered release-gate scenarios", () => {
    const ids = Object.keys(allScenarios).sort();
    assert.deepEqual(ids, [
        "centralized-config-sync",
        "cockpit-analytics",
        "code-review-basic",
        "code-review-vertex-byok",
        "command-review",
        "conversation-vertex-byok",
        "kody-rules-create-and-apply",
        "license-attribution",
        "onboarding-webhook-registration",
        "per-seat-license-toggle",
        "public-pr-demo",
        "rbac-authorization",
        "rbac-frontend-routes",
        "rbac-ui-render",
        "sso-cookie-domain",
        "sso-multi-user",
        "stripe-billing",
        "trial-credits-consume",
        "trial-entitlement-gate",
        "trial-managed-review",
        "upgrade-n-1-to-n",
    ]);
});

test("centralized-config-sync: single cell per target — github × paid/license-paid", () => {
    const s = allScenarios["centralized-config-sync"];
    assert.deepEqual(s.appliesTo.target, ["cloud", "self-hosted"]);
    assert.deepEqual(s.appliesTo.provider, ["github"]);
    assert.deepEqual(s.appliesTo.license, ["paid", "license-paid"]);
});

test("centralized-config-sync: single cell per target — github × paid/license-paid", () => {
    const s = allScenarios["centralized-config-sync"];
    assert.deepEqual(s.appliesTo.target, ["cloud", "self-hosted"]);
    assert.deepEqual(s.appliesTo.provider, ["github"]);
    assert.deepEqual(s.appliesTo.license, ["paid", "license-paid"]);
});

test("command-review: cloud + self-hosted × github + github-app + 3 others × paid/license-paid", () => {
    const s = allScenarios["command-review"];
    assert.deepEqual(s.appliesTo.target, ["cloud", "self-hosted"]);
    assert.deepEqual(s.appliesTo.provider, [
        "github",
        "github-app",
        "gitlab",
        "bitbucket",
        "azure-devops",
    ]);
    // `trial` moved to the dedicated trial-entitlement-gate scenario (a
    // standing trial expires after 14 days and broke this every release).
    assert.deepEqual(s.appliesTo.license, ["paid", "license-paid"]);
});

test("sso-multi-user: single-cell self-hosted × github × license-paid", () => {
    const s = allScenarios["sso-multi-user"];
    assert.deepEqual(s.appliesTo.target, ["self-hosted"]);
    assert.deepEqual(s.appliesTo.provider, ["github"]);
    assert.deepEqual(s.appliesTo.license, ["license-paid"]);
});

test("stripe-billing: single-cell cloud × github × paid", () => {
    const s = allScenarios["stripe-billing"];
    assert.deepEqual(s.appliesTo.target, ["cloud"]);
    assert.deepEqual(s.appliesTo.provider, ["github"]);
    assert.deepEqual(s.appliesTo.license, ["paid"]);
});

test("sso-cookie-domain: single-cell self-hosted × github × license-paid", () => {
    const s = allScenarios["sso-cookie-domain"];
    assert.deepEqual(s.appliesTo.target, ["self-hosted"]);
    assert.deepEqual(s.appliesTo.provider, ["github"]);
    assert.deepEqual(s.appliesTo.license, ["license-paid"]);
});

test("per-seat-license-toggle: self-hosted × all 4 providers × license-paid", () => {
    const s = allScenarios["per-seat-license-toggle"];
    assert.deepEqual(s.appliesTo.target, ["self-hosted"]);
    assert.deepEqual(s.appliesTo.provider, [
        "github",
        "gitlab",
        "bitbucket",
        "azure-devops",
    ]);
    assert.deepEqual(s.appliesTo.license, ["license-paid"]);
});

test("resolveScenarios: returns scenarios in given order", () => {
    const resolved = resolveScenarios([
        "code-review-basic",
        "license-attribution",
    ]);
    assert.equal(resolved.length, 2);
    assert.equal(resolved[0].id, "code-review-basic");
    assert.equal(resolved[1].id, "license-attribution");
});

test("resolveScenarios: throws on unknown id with helpful message", () => {
    assert.throws(
        () => resolveScenarios(["does-not-exist"]),
        /Unknown scenario: does-not-exist/,
    );
});

test("each scenario has required fields", () => {
    for (const s of Object.values(allScenarios)) {
        assert.ok(s.id, `scenario missing id`);
        assert.ok(s.title, `scenario ${s.id} missing title`);
        assert.ok(["P0", "P1", "P2"].includes(s.priority), `scenario ${s.id} invalid priority`);
        assert.ok(s.appliesTo, `scenario ${s.id} missing appliesTo`);
        assert.equal(typeof s.run, "function", `scenario ${s.id} missing run`);
    }
});

test("code-review-basic applies to paid/license-paid but not trial/free/license-free", () => {
    const s = allScenarios["code-review-basic"];
    assert.ok(s.appliesTo.license);
    assert.ok(s.appliesTo.license.includes("paid"));
    assert.ok(s.appliesTo.license.includes("license-paid"));
    // `trial` moved to trial-entitlement-gate (standing trial expires).
    assert.ok(!s.appliesTo.license.includes("trial"));
    assert.ok(!s.appliesTo.license.includes("free"));
    assert.ok(!s.appliesTo.license.includes("license-free"));
});

test("license-attribution applies to every reviewable license mode except trial and self-hosted license-free", () => {
    const s = allScenarios["license-attribution"];
    assert.ok(s.appliesTo.license);
    for (const m of [
        "free",
        "paid",
        "community-byok",
        "license-paid",
    ] as const) {
        assert.ok(s.appliesTo.license.includes(m), `missing license: ${m}`);
    }
    // `trial` is intentionally excluded: a standing trial expires after 14
    // days (no reset endpoint) and broke this scenario every release. The
    // trial entitlement is proved webhook-free against a fresh org by
    // trial-entitlement-gate instead.
    assert.ok(
        !s.appliesTo.license.includes("trial"),
        "trial must NOT be in scope (covered by trial-entitlement-gate)",
    );
    // self-hosted `license-free` is intentionally excluded: an absent or
    // invalid self-hosted license drops to Community Edition (reviews fire,
    // no notice), so the scenario's "no review + trial/BYOK notice"
    // assertion is structurally unprovable there. The blocked-tier mechanic
    // is covered on cloud `free` instead.
    assert.ok(
        !s.appliesTo.license.includes("license-free"),
        "license-free must NOT be in scope (notice unreachable on self-hosted)",
    );
});

test("trial-entitlement-gate: single-cell cloud × github × trial", () => {
    const s = allScenarios["trial-entitlement-gate"];
    assert.deepEqual(s.appliesTo.target, ["cloud"]);
    assert.deepEqual(s.appliesTo.provider, ["github"]);
    assert.deepEqual(s.appliesTo.license, ["trial"]);
});

test("trial-managed-review: single-cell cloud × github × trial (the only managed-LLM review cell)", () => {
    const s = allScenarios["trial-managed-review"];
    assert.deepEqual(s.appliesTo.target, ["cloud"]);
    assert.deepEqual(s.appliesTo.provider, ["github"]);
    assert.deepEqual(s.appliesTo.license, ["trial"]);
});

test("upgrade-n-1-to-n only applies to self-hosted", () => {
    const s = allScenarios["upgrade-n-1-to-n"];
    assert.deepEqual(s.appliesTo.target, ["self-hosted"]);
});

test("onboarding-webhook-registration applies to 4 platform providers (NOT github-app)", () => {
    const s = allScenarios["onboarding-webhook-registration"];
    assert.ok(s.appliesTo.provider);
    for (const p of [
        "github",
        "gitlab",
        "bitbucket",
        "azure-devops",
    ] as const) {
        assert.ok(
            s.appliesTo.provider.includes(p),
            `webhook scenario missing provider: ${p}`,
        );
    }
    // github-app must NOT be in this list — GitHub Apps deliver
    // webhooks at the App level, not via /repos/.../hooks REST
    // entries, so this scenario would always fail for it.
    assert.ok(
        !s.appliesTo.provider.includes("github-app"),
        "webhook scenario must exclude github-app — GitHub Apps don't register per-repo hooks via REST",
    );
});
