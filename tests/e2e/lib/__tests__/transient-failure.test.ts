import { strict as assert } from "node:assert";
import { test } from "node:test";
import { absenceRetryDelayMs, isTransientFailure } from "../runner.js";

// The retry classifier decides which cell failures get ONE automatic
// re-run. The split is ABSENCE/NETWORK (retry — a lost webhook or provider
// hiccup can produce them) vs DETERMINISTIC MISMATCH (never retry — a wrong
// value stays wrong, the retry only burns an LLM review). Every message
// below is a REAL failure string observed in matrix runs.

const TRANSIENT = [
    // kody-rules × gitlab, 2026-06-04 run 26953557579 — lost webhook
    "Assertion failed: No review activity on PR https://gitlab.com/x/-/merge_requests/74 within timeout",
    // license-attribution expectReview path: review never materialized
    "Assertion failed: Expected a real review for license=trial but none arrived within 900s. licenseBlockedNotice=undefined",
    // blocked-tier notice that never showed up (absence)
    "Assertion failed: License=free should have triggered a trial-ended / BYOK / no-license notice from Kody, but the PR has no such comment after 180s. review={}",
    // command-review: no findings after the command (absence)
    'Assertion failed: No review findings on PR/MR #8 within 900s after posting "@kody review". pre-command findings count was 0.',
    // network / gateway shapes
    "onboarding:login HTTP 502: <html>Bad Gateway</html>",
    "request to https://qa.web.kodus.io failed, reason: ECONNRESET",
    "GET featured-reviews: HTTP 503",
    "This operation was aborted",
    "github:openPRFromBranches:commit exited with code 128\nfatal: unable to access '…': Recv failure",
];

const DETERMINISTIC = [
    // rbac route-guard verdict mismatch — re-running cannot flip a policy
    "Frontend route mismatches (2):\n  billing_manager on /settings/git: expected deny, got allow",
    // entitlement gate posted the WRONG thing (value present, not absent)
    'Assertion failed: Expected NO real review for license=free but Kody posted one: {"reviewComments":1}',
    // wrong subscription state — fresh org provisioning produced bad data
    "Assertion failed: Expected subscriptionStatus='trial' (the state that makes the entitlement gate allow managed reviews with no BYOK), got 'active'. Full license={}",
    // registry/config errors
    "Unknown scenario: does-not-exist. Known: code-review-basic",
    "route manifest looks empty (0) — regenerate with UPDATE_ROUTE_MANIFEST=1",
];

test("isTransientFailure: absence/network shapes RETRY", () => {
    for (const msg of TRANSIENT) {
        assert.ok(isTransientFailure(msg), `should be transient: ${msg.slice(0, 80)}`);
    }
});

test("isTransientFailure: deterministic mismatches do NOT retry", () => {
    for (const msg of DETERMINISTIC) {
        assert.ok(!isTransientFailure(msg), `should NOT be transient: ${msg.slice(0, 80)}`);
    }
});

test("isTransientFailure: tolerates empty/undefined", () => {
    assert.equal(isTransientFailure(""), false);
    assert.equal(isTransientFailure(undefined as unknown as string), false);
});

test("absenceRetryDelayMs: review-never-started shapes get the 120s settle", () => {
    const absent = [
        "[provider:github] No kody-codereview status comment on PR #23 within 60s — review pipeline likely never started (check droplet worker logs and the webhook delivery list).",
        "Assertion failed: No review activity on PR https://gitlab.com/x/-/merge_requests/79 within timeout",
        "Expected a real review for license=trial but none arrived within 900s.",
    ];
    for (const msg of absent) {
        assert.equal(absenceRetryDelayMs(msg), 120_000, msg.slice(0, 60));
    }
});

test("absenceRetryDelayMs: transport noise retries immediately (0ms)", () => {
    const transport = [
        "TypeError: fetch failed",
        "HTTP 502\n<html>Bad Gateway</html>",
        "request to https://qa.web.kodus.io failed, reason: ECONNRESET",
    ];
    for (const msg of transport) {
        assert.equal(absenceRetryDelayMs(msg), 0, msg.slice(0, 60));
    }
    assert.equal(absenceRetryDelayMs(""), 0);
});
