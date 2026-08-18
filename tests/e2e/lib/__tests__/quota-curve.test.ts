import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
    IDLE,
    describeQuotaCurve,
    startQuotaSampler,
    summarizeQuotaCurve,
} from "../quota-curve.js";

const M = 60_000;

test("attributes a burn to whatever was running when it happened", () => {
    const summary = summarizeQuotaCurve(
        [
            { atMs: 0, remaining: 5000 },
            { atMs: M, remaining: 4900 },
            { atMs: 2 * M, remaining: 4890 },
        ],
        [{ atMs: 0, label: "code-review-basic" }],
    );

    assert.equal(summary.totalSpent, 110);
    assert.equal(summary.windows[0].during, "code-review-basic");
});

// The reason this file exists. The backfill is dispatched in the background,
// so the spend keeps going after the scenario that triggered it has ended --
// per-scenario deltas charge it to whatever ran next.
test("separates a background burn that outlives the scenario that started it", () => {
    const summary = summarizeQuotaCurve(
        [
            { atMs: 0, remaining: 5000 },
            { atMs: M, remaining: 4990 },
            { atMs: 2 * M, remaining: 4500 },
            { atMs: 3 * M, remaining: 4100 },
        ],
        [
            { atMs: 0, label: "onboarding" },
            { atMs: 90_000, label: "code-review-basic" },
        ],
    );

    const byActivity = Object.fromEntries(
        summary.windows.map((w) => [w.during, w.spent]),
    );
    assert.equal(byActivity["onboarding"], 500);
    assert.equal(byActivity["code-review-basic"], 400);
});

test("reports rate, not just size — the shape is the evidence", () => {
    const summary = summarizeQuotaCurve(
        [
            { atMs: 0, remaining: 5000 },
            { atMs: 30_000, remaining: 4700 },
        ],
        [{ atMs: 0, label: "onboarding" }],
    );

    assert.equal(summary.windows[0].spent, 300);
    assert.equal(summary.windows[0].ratePerMin, 600);
});

// GitHub's hourly window resets mid-run. Treating the jump as spend would
// report a credit of thousands of requests and make the total meaningless.
test("a rising remaining is a window reset, not negative spend", () => {
    const summary = summarizeQuotaCurve([
        { atMs: 0, remaining: 200 },
        { atMs: M, remaining: 100 },
        { atMs: 2 * M, remaining: 5000 },
        { atMs: 3 * M, remaining: 4950 },
    ]);

    assert.equal(summary.totalSpent, 150);
});

test("flags a burn still in flight at the last sample", () => {
    const stillGoing = summarizeQuotaCurve([
        { atMs: 0, remaining: 5000 },
        { atMs: M, remaining: 4000 },
    ]);
    assert.equal(stillGoing.truncated, true);

    const settled = summarizeQuotaCurve([
        { atMs: 0, remaining: 5000 },
        { atMs: M, remaining: 4000 },
        { atMs: 2 * M, remaining: 4000 },
    ]);
    assert.equal(settled.truncated, false);
});

test("keeps a paused-and-resumed burn as two windows, not one average", () => {
    const summary = summarizeQuotaCurve(
        [
            { atMs: 0, remaining: 5000 },
            { atMs: M, remaining: 4500 },
            { atMs: 2 * M, remaining: 4500 },
            { atMs: 3 * M, remaining: 4000 },
        ],
        [{ atMs: 0, label: "onboarding" }],
    );

    assert.equal(summary.windows.length, 2);
    assert.equal(summary.windows[0].ratePerMin, 500);
});

test("spend before any mark is idle, not the first scenario", () => {
    const summary = summarizeQuotaCurve(
        [
            { atMs: 0, remaining: 5000 },
            { atMs: M, remaining: 4800 },
        ],
        [{ atMs: 5 * M, label: "later-scenario" }],
    );

    assert.equal(summary.windows[0].during, IDLE);
});

test("no samples, or a flat curve, says nothing rather than guessing", () => {
    assert.deepEqual(summarizeQuotaCurve([]), {
        totalSpent: 0,
        truncated: false,
        windows: [],
    });
    assert.equal(
        summarizeQuotaCurve([
            { atMs: 0, remaining: 5000 },
            { atMs: M, remaining: 5000 },
        ]).windows.length,
        0,
    );
    assert.match(
        describeQuotaCurve({ totalSpent: 0, truncated: false, windows: [] })[0],
        /no GitHub spend/,
    );
});

test("sampler records what the probe returns and stops cleanly", async () => {
    let t = 0;
    const remaining = [5000, 4900, 4700];
    let i = 0;
    let cleared = false;
    const sampler = startQuotaSampler({
        probe: async () => ({ remaining: remaining[Math.min(i++, 2)] }),
        now: () => t,
        setIntervalFn: (() => ({ unref() {} })) as any,
        clearIntervalFn: (() => {
            cleared = true;
        }) as any,
    });

    await new Promise((r) => setImmediate(r));
    sampler.mark("scenario-a");
    t = M;
    await (sampler as any).samples.push({ atMs: M, remaining: 4900 });
    const summary = sampler.stop();

    assert.equal(cleared, true);
    assert.equal(summary.totalSpent, 100);
});

// An observer that can fail the run is worse than no observer.
test("a failing probe is skipped, never recorded as zero movement", async () => {
    const sampler = startQuotaSampler({
        probe: async () => {
            throw new Error("network");
        },
        setIntervalFn: (() => ({ unref() {} })) as any,
        clearIntervalFn: (() => {}) as any,
    });

    await new Promise((r) => setImmediate(r));
    assert.equal(sampler.samples.length, 0);
    assert.equal(sampler.stop().totalSpent, 0);
});
