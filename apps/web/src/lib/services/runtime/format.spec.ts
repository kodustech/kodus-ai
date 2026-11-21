import {
    durationBetween,
    formatClockTime,
    formatDurationMs,
    formatEstimatedUsd,
    formatGiB,
    formatRate,
    formatUtcClock,
    shortRepositoryName,
    shortSha,
} from "./format";

describe("formatting", () => {
    it("prints the log clock in UTC, the same for every reader", () => {
        expect(formatUtcClock("2026-11-06T18:06:34.512Z")).toBe("18:06:34");
        expect(formatUtcClock(undefined)).toBe("--:--:--");
        expect(formatUtcClock("nope")).toBe("--:--:--");
    });

    it("formats durations at the scale that reads", () => {
        expect(formatDurationMs(850)).toBe("850 ms");
        expect(formatDurationMs(12_000)).toBe("12 s");
        expect(formatDurationMs(185_000)).toBe("3 min 05 s");
        expect(formatDurationMs(3_720_000)).toBe("1 h 02 min");
        expect(formatDurationMs(undefined)).toBe("—");
        expect(formatDurationMs(-1)).toBe("—");
    });

    it("reads a rate outside 0..1 as unknown, not as a percentage", () => {
        expect(formatRate(0.834)).toBe("83%");
        expect(formatRate(1)).toBe("100%");
        expect(formatRate(83)).toBe("—");
        expect(formatRate(undefined)).toBe("—");
    });

    it("prints shas, sizes, names and clock times the same way everywhere", () => {
        expect(shortSha("a".repeat(40))).toBe("aaaaaaa");
        expect(shortSha(undefined)).toBe("—");
        expect(formatGiB(2 ** 31)).toBe("2.0 GiB");
        expect(shortRepositoryName("acme/checkout-api")).toBe("checkout-api");
        expect(shortRepositoryName(undefined)).toBeUndefined();
        expect(formatClockTime(undefined)).toBe("--:--:--.---");
        expect(formatClockTime("nope")).toBe("--:--:--.---");
        expect(
            formatClockTime(new Date(2026, 9, 31, 14, 2, 9, 112).toISOString()),
        ).toBe("14:02:09.112");
        expect(
            durationBetween("2026-10-31T00:00:00Z", "2026-10-31T00:00:02Z"),
        ).toBe(2000);
        expect(
            durationBetween("2026-10-31T00:00:02Z", "2026-10-31T00:00:00Z"),
        ).toBeUndefined();
    });

    it("prints an estimated cost with no more precision than it has", () => {
        expect(formatEstimatedUsd(0.148267)).toBe("≈ $0.15");
        expect(formatEstimatedUsd(1.609267)).toBe("≈ $1.61");
        expect(formatEstimatedUsd(0.00345)).toBe("< $0.01");
        expect(formatEstimatedUsd(0)).toBe("$0.00");
        expect(formatEstimatedUsd(null)).toBe("—");
        expect(formatEstimatedUsd(undefined)).toBe("—");
    });
});
