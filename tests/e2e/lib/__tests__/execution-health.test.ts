import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findExecutionStatus } from "../execution-health.js";

const row = (prNumber: number, status: string) => ({
    prNumber,
    automationExecution: { status },
});

const listing = (...rows: unknown[]) => ({ data: rows });

test("a settled review reports its status", () => {
    assert.equal(
        findExecutionStatus(listing(row(10, "success")), 10),
        "success",
    );
    assert.equal(findExecutionStatus(listing(row(10, "error")), 10), "error");
});

test("success anywhere wins over an incidental skip", () => {
    assert.equal(
        findExecutionStatus(listing(row(10, "skipped"), row(10, "success")), 10),
        "success",
    );
});

// The bug behind #1699. Bitbucket delivers the @kody comment webhook twice;
// the product dedupes the second into a `skipped` row while the real review
// is still running. Ranking that skip above the running row made the poll
// verdict "skipped" at 90s, for a review that had not finished yet.
test("a running review outranks a duplicate's skip", () => {
    assert.equal(
        findExecutionStatus(
            listing(row(10, "skipped"), row(10, "in_progress")),
            10,
        ),
        null,
    );
    assert.equal(
        findExecutionStatus(listing(row(10, "skipped"), row(10, "pending")), 10),
        null,
    );
});

test("a running review also outranks a failed sibling — the run is not over", () => {
    assert.equal(
        findExecutionStatus(listing(row(10, "error"), row(10, "in_progress")), 10),
        null,
    );
});

test("with nothing running, a real failure outranks a skip", () => {
    assert.equal(
        findExecutionStatus(listing(row(10, "skipped"), row(10, "error")), 10),
        "error",
    );
    assert.equal(
        findExecutionStatus(
            listing(row(10, "skipped"), row(10, "partial_error")),
            10,
        ),
        "partial_error",
    );
});

test("a lone skip is still a skip", () => {
    assert.equal(findExecutionStatus(listing(row(10, "skipped")), 10), "skipped");
});

test("rows for other pull requests are ignored", () => {
    assert.equal(
        findExecutionStatus(listing(row(11, "success"), row(10, "skipped")), 10),
        "skipped",
    );
    assert.equal(findExecutionStatus(listing(row(11, "success")), 10), null);
});

test("finds rows nested anywhere in the envelope", () => {
    assert.equal(
        findExecutionStatus(
            { data: { items: [{ nested: [row(10, "success")] }] } },
            10,
        ),
        "success",
    );
});

// The flat-shape fallback must not read PR states as execution states, or an
// open PR would report health on the strength of the word "open".
test("PR states are not mistaken for execution states", () => {
    assert.equal(
        findExecutionStatus(listing({ prNumber: 10, status: "open" }), 10),
        null,
    );
    assert.equal(
        findExecutionStatus(listing({ prNumber: 10, status: "success" }), 10),
        "success",
    );
});

test("no rows at all is not a verdict", () => {
    assert.equal(findExecutionStatus(listing(), 10), null);
    assert.equal(findExecutionStatus(null, 10), null);
});
