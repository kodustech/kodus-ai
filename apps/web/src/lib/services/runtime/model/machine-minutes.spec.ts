import {
    machineMinuteLimitWords,
    machineMinutesBlockerWords,
    machineMinutesSummary,
    orgMachineMinuteLimitDraft,
} from "./machine-minutes";

const NOW = new Date("2026-11-12T21:30:00.000Z");
const today = (patch = {}) => ({
    limitMinutes: 100,
    deploymentLimitMinutes: 100,
    orgLimitMinutes: null,
    limitSource: "deployment" as const,
    committedMinutes: 70,
    usedMinutes: 25,
    openRounds: 2,
    remainingMinutes: 30,
    resetsAt: "2026-11-13T00:00:00.000Z",
    ...patch,
});

describe("the org's machine time today", () => {
    it("separates what machines still running may yet use from what was used", () => {
        expect(machineMinutesSummary(today(), NOW)).toMatchObject({
            usedMinutes: 25,
            limitMinutes: 100,
            heldByRunningMinutes: 45,
            runningMachines: 2,
            exhausted: false,
        });
    });

    it("counts down to the reset in hours and minutes", () => {
        expect(machineMinutesSummary(today(), NOW).resetsIn).toBe("2h 30m");
    });

    it("is exhausted once nothing remains, and says new setups and Runs wait for the reset", () => {
        const out = machineMinutesSummary(
            today({ remainingMinutes: 0, committedMinutes: 100 }),
            NOW,
        );
        expect(out.exhausted).toBe(true);
        expect(out.waitWords).toBe(
            machineMinutesBlockerWords({
                signature: "machine_minutes_exhausted",
            }),
        );
    });

    it("is never exhausted without a limit", () => {
        expect(
            machineMinutesSummary(
                today({ limitMinutes: null, remainingMinutes: null }),
                NOW,
            ),
        ).toMatchObject({ exhausted: false, limitMinutes: null });
    });

    it("gives words only to the machine-minutes blocker", () => {
        expect(
            machineMinutesBlockerWords({
                signature: "machine_minutes_exhausted",
            }),
        ).toMatch(/reset/);
        expect(
            machineMinutesBlockerWords({ signature: "org_capacity" }),
        ).toBeUndefined();
    });
});

describe("which daily limit holds the org", () => {
    const limits = (patch = {}) => ({
        limitMinutes: 1000,
        deploymentLimitMinutes: 1000,
        orgLimitMinutes: null,
        limitSource: "deployment" as const,
        ...patch,
    });

    it("names the deployment's limit and invites a lower one of the org's own", () => {
        expect(machineMinuteLimitWords(limits())).toBe(
            "The deployment's limit of 1,000 min a day applies. Set your organization's own to hold it to less.",
        );
    });

    it("names the org's own limit and the deployment's ceiling above it", () => {
        expect(
            machineMinuteLimitWords(
                limits({
                    limitMinutes: 300,
                    orgLimitMinutes: 300,
                    limitSource: "org",
                }),
            ),
        ).toBe(
            "Your organization's limit of 300 min a day applies (the deployment allows up to 1,000 min).",
        );
    });

    it("says the org's limit applies alone on a deployment without one", () => {
        expect(
            machineMinuteLimitWords(
                limits({
                    limitMinutes: 300,
                    deploymentLimitMinutes: null,
                    orgLimitMinutes: 300,
                    limitSource: "org",
                }),
            ),
        ).toBe("Your organization's limit of 300 min a day applies.");
    });

    it("says why an org limit at or above the deployment's does not apply", () => {
        expect(machineMinuteLimitWords(limits({ orgLimitMinutes: 1500 }))).toBe(
            "The deployment's limit of 1,000 min a day applies: your organization's 1,500 min is not below it.",
        );
    });

    it("says there is no daily limit when neither sets one", () => {
        expect(
            machineMinuteLimitWords(
                limits({ limitMinutes: null, deploymentLimitMinutes: null }),
            ),
        ).toBe(
            "No daily limit: neither this deployment nor your organization sets one.",
        );
    });
});

describe("the org's own limit as typed", () => {
    it("takes a positive whole number of minutes", () => {
        expect(orgMachineMinuteLimitDraft("600", 1000)).toEqual({
            minutesPerDay: 600,
        });
        expect(orgMachineMinuteLimitDraft(" 1000 ", 1000)).toEqual({
            minutesPerDay: 1000,
        });
    });

    it("has nothing to save, and no complaint, while empty", () => {
        expect(orgMachineMinuteLimitDraft("", 1000)).toEqual({
            minutesPerDay: null,
        });
    });

    it.each(["0", "-5", "12.5", "abc"])(
        "refuses %s with the rule it breaks",
        (draft) => {
            expect(orgMachineMinuteLimitDraft(draft, 1000)).toEqual({
                minutesPerDay: null,
                error: "Enter a whole number of minutes, 1 or more.",
            });
        },
    );

    it("refuses more than the deployment allows, and says the org's limit only lowers it", () => {
        expect(orgMachineMinuteLimitDraft("1001", 1000)).toEqual({
            minutesPerDay: null,
            error: "This deployment allows up to 1,000 min a day; your organization's limit can only lower it.",
        });
    });

    it("caps at the API's ceiling when the deployment sets no limit", () => {
        expect(orgMachineMinuteLimitDraft("14400000", null)).toEqual({
            minutesPerDay: 14_400_000,
        });
        expect(orgMachineMinuteLimitDraft("14400001", null).error).toMatch(
            /14,400,000/,
        );
    });
});
