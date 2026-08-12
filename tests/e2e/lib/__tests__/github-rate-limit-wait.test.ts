import { strict as assert } from "node:assert";
import { test } from "node:test";
import { githubRateLimitWaitMs } from "../http.js";

const NOW = 1_800_000_000_000; // fixed epoch ms

function resp(
    status: number,
    headers: Record<string, string> = {},
    raw = "",
) {
    return { status, headers: new Headers(headers), raw };
}

// The whole point: GitHub answers 403 for rate limits, so before this the
// harness saw an ordinary forbidden and skipped the cell.
test("secondary rate limit: waits GitHub's documented ~60s", () => {
    const wait = githubRateLimitWaitMs(
        resp(403, {}, '{"message":"You have exceeded a secondary rate limit"}'),
        NOW,
    );
    assert.equal(wait, 60_000);
});

test("retry-after wins over everything else", () => {
    const wait = githubRateLimitWaitMs(
        resp(
            403,
            { "retry-after": "23", "x-ratelimit-reset": String((NOW + 3_600_000) / 1000) },
            "secondary rate limit",
        ),
        NOW,
    );
    assert.equal(wait, 23_000);
});

test("primary limit: wait is derived from x-ratelimit-reset", () => {
    const wait = githubRateLimitWaitMs(
        resp(403, {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String((NOW + 120_000) / 1000),
        }),
        NOW,
    );
    assert.equal(wait, 120_000);
});

test("a reset already in the past clamps to zero, never negative", () => {
    const wait = githubRateLimitWaitMs(
        resp(403, {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String((NOW - 60_000) / 1000),
        }),
        NOW,
    );
    assert.equal(wait, 0);
});

// The dangerous false positive: retrying a permissions 403 would turn a
// missing-scope bug into a silent stall and then the same failure anyway.
test("a plain 403 (missing scope) is NOT a rate limit", () => {
    assert.equal(
        githubRateLimitWaitMs(
            resp(403, {}, '{"message":"Resource not accessible by integration"}'),
            NOW,
        ),
        null,
    );
});

test("quota headers with budget left are not a rate limit", () => {
    assert.equal(
        githubRateLimitWaitMs(
            resp(403, { "x-ratelimit-remaining": "4231" }, '{"message":"Forbidden"}'),
            NOW,
        ),
        null,
    );
});

test("non-403/429 statuses are never treated as rate limits", () => {
    assert.equal(githubRateLimitWaitMs(resp(200), NOW), null);
    assert.equal(githubRateLimitWaitMs(resp(404), NOW), null);
    assert.equal(
        githubRateLimitWaitMs(resp(500, {}, "secondary rate limit"), NOW),
        null,
        "a 5xx mentioning the phrase is still a server error, not quota",
    );
});
