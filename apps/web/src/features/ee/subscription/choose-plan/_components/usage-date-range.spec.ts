import type { OrganizationLicense } from "../../_services/billing/types";
import { getUsageDateRange } from "./usage-date-range";

const now = new Date("2026-11-25T12:00:00Z");

const trial = (fields: Partial<Record<string, string>>): OrganizationLicense =>
    ({
        valid: true,
        subscriptionStatus: "trial",
        trialEnd: "2026-12-02T12:00:00Z",
        ...fields,
    }) as OrganizationLicense;

describe("getUsageDateRange", () => {
    it("starts at the trial's own start, whatever its length", () => {
        expect(
            getUsageDateRange(
                trial({ trialStart: "2026-11-21T12:00:00Z" }),
                now,
            ),
        ).toEqual({
            startDate: "2026-11-21",
            endDate: "2026-11-25",
            daysUsed: 4,
        });
    });

    it("counts from the start for a trial extended far past its usual end", () => {
        expect(
            getUsageDateRange(
                trial({
                    trialStart: "2026-10-27T08:00:00Z",
                    trialEnd: "2027-11-10T08:00:00Z",
                }),
                now,
            ),
        ).toMatchObject({ startDate: "2026-10-27", daysUsed: 29 });
    });

    it.each([
        ["no trialStart", {}],
        ["an invalid trialStart", { trialStart: "not-a-date" }],
    ])("falls back to the 30-day lookback on %s", (_label, fields) => {
        expect(getUsageDateRange(trial(fields), now)).toEqual({
            startDate: "2026-10-26",
            endDate: "2026-11-25",
            daysUsed: 30,
        });
    });

    it("uses the 30-day lookback outside a trial", () => {
        expect(getUsageDateRange(null, now).daysUsed).toBe(30);
    });
});
