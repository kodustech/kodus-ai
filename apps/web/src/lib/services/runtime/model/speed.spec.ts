import type { RuntimeSpeed, SpeedStat } from "../contracts";
import { formatSpeedMs, speedTakeaway, speedValue } from "./speed";

const stat = (
    n: number,
    p50Ms: number | null,
    p95Ms: number | null = p50Ms,
): SpeedStat => ({
    n,
    tooFew: p50Ms === null,
    p50Ms,
    p95Ms,
});
const metrics = (
    verdict: SpeedStat,
    ready: SpeedStat = verdict,
    queue: SpeedStat = verdict,
) => ({ verdict, ready, queue });
const empty = metrics(stat(0, null));
const speed = (over: Partial<RuntimeSpeed> = {}): RuntimeSpeed => ({
    windowDays: 7,
    since: "2026-11-10T12:00:00.000Z",
    until: "2026-11-17T12:00:00.000Z",
    minRuns: 20,
    considered: 60,
    counted: 50,
    excluded: {
        cancelledOrSuperseded: 6,
        skipped: 2,
        unfinished: 1,
        noVerdict: 1,
    },
    missing: { verdict: 0, ready: 3, queue: 0 },
    truncated: false,
    all: metrics(stat(50, 252_000, 600_000), stat(47, 41_000), stat(50, 800)),
    bySource: {
        warm_pool: metrics(stat(25, 200_000), stat(25, 9_000)),
        cold_boot: metrics(stat(22, 300_000), stat(22, 71_500)),
        baked: empty,
        unknown: empty,
    },
    byHost: { kodus_cloud: empty, own_host: empty, unknown: empty },
    byEnvironment: [],
    ...over,
});

describe("formatSpeedMs", () => {
    it("reads milliseconds, seconds, minutes and hours", () => {
        expect(formatSpeedMs(800)).toBe("800 ms");
        expect(formatSpeedMs(9_000)).toBe("9.0 s");
        expect(formatSpeedMs(252_000)).toBe("4 min 12 s");
        expect(formatSpeedMs(3_960_000)).toBe("1 h 6 min");
    });
});

describe("speedValue", () => {
    it('says "too few Runs" for a bucket without a number', () => {
        expect(speedValue(stat(19, null), "p50Ms")).toBe("too few Runs");
        expect(speedValue(stat(20, 1_500), "p50Ms")).toBe("1.5 s");
    });
});

describe("speedTakeaway", () => {
    it("says when half the Runs reach a verdict and how much faster warm-pool Runs are ready than cold boots", () => {
        expect(speedTakeaway(speed())).toBe(
            "Half the Runs reach a verdict within 4 min 12 s; warm-pool Runs are ready 1 min 3 s faster than cold boots.",
        );
    });

    it("says there are too few Runs to compare warm pool and cold boot when either bucket is short", () => {
        const s = speed({
            bySource: {
                ...speed().bySource,
                cold_boot: metrics(stat(3, null)),
            },
        });
        expect(speedTakeaway(s)).toBe(
            "Half the Runs reach a verdict within 4 min 12 s; too few warm-pool and cold-boot Runs yet to compare them.",
        );
    });

    it("says how many Runs it has when there are too few to quote", () => {
        expect(
            speedTakeaway(speed({ counted: 7, all: metrics(stat(7, null)) })),
        ).toBe(
            "Too few Runs in the last 7 days to quote a speed: 7 of the 20 needed.",
        );
    });
});
