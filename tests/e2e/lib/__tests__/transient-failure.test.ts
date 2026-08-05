import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
    absenceRetryDelayMs,
    isTransientFailure,
    shouldRetryFailure,
} from "../runner.js";

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

// shouldRetryFailure gates a transient-shaped failure on whether a WORST-CASE
// second attempt (unconditional settle + a full scenario-timeout poll) still
// finishes before the run deadline — not on a fraction of the scenario budget.
// Absence failures surface at the poll ceiling, so a lost-webhook flake and a
// slow review are indistinguishable by duration; the deciding factor is the
// wall-clock left before the job/step deadline. Signature is
// (message, scenarioTimeoutMs, nowMs, deadlineMs) — we pin now + deadline so the
// tests are deterministic. See fix/review-timeout-robustness.
const T = 1_000_000_000_000; // fixed "now" epoch
const MIN = 60_000;
const deadline60 = T + 60 * MIN; // a 60-min run window starting at T

test("shouldRetryFailure: absence retries when a worst-case retry fits before the deadline", () => {
    // kody-rules regression guard: 1200s scenario whose 720s poll is > 50% of
    // its budget. Worst case = 120s settle + 1200s = 22min; early in a 60-min
    // window it fits, so it MUST retry — the old fraction gate wrongly killed it.
    const msg =
        "Assertion failed: No review activity on PR https://x/-/merge_requests/74 within timeout";
    assert.ok(shouldRetryFailure(msg, 1200 * 1000, T, deadline60));
});

test("shouldRetryFailure: absence does NOT retry when a worst-case retry would overrun the deadline", () => {
    // The original command-review-focus failure: a 1800s scenario 36min into a
    // 60-min window — a worst-case ~32min second attempt lands past the deadline.
    const msg =
        'Assertion failed: No review on PR/MR #8 within 1502s after posting "@kody review".';
    assert.ok(isTransientFailure(msg), "shape is still transient");
    assert.ok(!shouldRetryFailure(msg, 1800 * 1000, T + 36 * MIN, deadline60));
});

test("shouldRetryFailure: same slow scenario DOES retry early with the whole window ahead", () => {
    const msg =
        'Assertion failed: No review on PR/MR #8 within 1502s after posting "@kody review".';
    assert.ok(shouldRetryFailure(msg, 1800 * 1000, T, deadline60));
});

test("shouldRetryFailure: a FAST-failing absence is still charged a full second attempt", () => {
    // "within 60s" fails fast, but attempt-2 can run the full poll window, so the
    // gate charges the scenario timeout — not the (tiny) first-attempt duration.
    const msg =
        "[provider:github] No kody-codereview status comment on PR #23 within 60s — review pipeline likely never started.";
    assert.ok(isTransientFailure(msg), "fast absence is still a transient shape");
    // Late in the job the worst-case retry overruns → no retry...
    assert.ok(!shouldRetryFailure(msg, 1800 * 1000, T + 40 * MIN, deadline60));
    // ...but early, the same fast failure retries.
    assert.ok(shouldRetryFailure(msg, 1800 * 1000, T, deadline60));
});

test("shouldRetryFailure: deterministic mismatch never retries, even with the whole window ahead", () => {
    const msg =
        "Assertion failed: Expected NO real review for license=free but Kody posted one.";
    assert.ok(!shouldRetryFailure(msg, 1800 * 1000, T, deadline60));
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
