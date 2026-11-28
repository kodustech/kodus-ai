/**
 * requestTrialExtension goes through the API (/license/trial-extension-request),
 * which owns the Discord webhook secret and resolves org/user from the JWT.
 * The client only sends teamId + the form fields, and failures must surface
 * honestly (no fake success when the channel is down or unconfigured).
 */

const authorizedFetchMock = jest.fn();
jest.mock("@services/fetch", () => ({
    authorizedFetch: (...args: unknown[]) => authorizedFetchMock(...args),
}));
jest.mock("src/core/utils/helpers", () => ({
    pathToApiUrl: (p: string) => `API${p}`,
}));

// fetch.ts pulls these in at module scope for sibling functions; stub them
// so importing the module under test stays isolated.
const billingRequestMock = jest.fn();
jest.mock("./utils", () => ({
    billingFetch: jest.fn(),
    billingRequest: (...args: unknown[]) => billingRequestMock(...args),
}));
jest.mock("@services/organizations/fetch", () => ({
    getOrganizationId: jest.fn().mockResolvedValue("org-1"),
}));
jest.mock("src/core/utils/self-hosted", () => ({ isSelfHosted: false }));

describe("requestTrialExtension", () => {
    beforeEach(() => {
        authorizedFetchMock.mockReset();
    });

    it("posts teamId + form fields to the API trial-extension endpoint", async () => {
        authorizedFetchMock.mockResolvedValue({ success: true });
        const { requestTrialExtension } = await import("./fetch");

        const result = await requestTrialExtension({
            teamId: "team-1",
            request: {
                teamSize: 12,
                message: "Evaluating for the platform team",
            },
        });

        expect(result).toEqual({ success: true });

        const [url, config] = authorizedFetchMock.mock.calls[0];
        expect(url).toBe("API/license/trial-extension-request");
        expect(config.method).toBe("POST");
        expect(JSON.parse(config.body)).toEqual({
            teamId: "team-1",
            teamSize: 12,
            message: "Evaluating for the platform team",
        });
        // The secret-bearing org/user context is resolved server-side.
        expect(config.body).not.toContain("organizationId");
    });

    it("fails honestly when the API reports the channel is unconfigured", async () => {
        authorizedFetchMock.mockResolvedValue({
            success: false,
            message: "Trial request channel is not configured yet.",
        });
        const { requestTrialExtension } = await import("./fetch");

        const result = await requestTrialExtension({
            teamId: "team-1",
            request: {},
        });

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/not configured/i);
    });

    it("does not fake success when the request throws", async () => {
        authorizedFetchMock.mockRejectedValue(new Error("network down"));
        const { requestTrialExtension } = await import("./fetch");

        const result = await requestTrialExtension({
            teamId: "team-1",
            request: {},
        });

        expect(result.success).toBe(false);
    });
});

describe("updateCreditAutoTopUp monthly cap contract", () => {
    it.each([100, 0, null, undefined])(
        "forwards the cap %p without changing its meaning",
        async (monthlyLimitUsd) => {
            billingRequestMock.mockResolvedValue({ monthlyLimitUsd });
            const { updateCreditAutoTopUp } = await import("./fetch");
            const result = await updateCreditAutoTopUp({
                teamId: "team-1",
                enabled: true,
                monthlyLimitUsd,
            });
            expect(billingRequestMock).toHaveBeenLastCalledWith(
                "credits/auto-topup",
                {
                    method: "POST",
                    body: {
                        organizationId: "org-1",
                        teamId: "team-1",
                        enabled: true,
                        monthlyLimitUsd,
                    },
                },
            );
            expect(result).toEqual({ monthlyLimitUsd });
        },
    );
});

describe("getTrialTerms", () => {
    const billingFetchMock = () =>
        jest.requireMock("./utils").billingFetch as jest.Mock;

    beforeEach(() => billingFetchMock().mockReset());

    it("returns billing's length and included reviews for a new trial", async () => {
        billingFetchMock().mockResolvedValue({
            trialDays: 7,
            trialReviewCreditsIncluded: 5,
        });
        const { getTrialTerms } = await import("./fetch");

        await expect(getTrialTerms()).resolves.toEqual({
            trialDays: 7,
            trialReviewCreditsIncluded: 5,
        });
        expect(billingFetchMock()).toHaveBeenCalledWith("trial-terms");
    });

    it("returns null on self-hosted without asking billing", async () => {
        // fetch.ts reads the flag at call time, so flipping the mocked
        // module's export is enough.
        const selfHosted = jest.requireMock("src/core/utils/self-hosted");
        selfHosted.isSelfHosted = true;
        try {
            const { getTrialTerms } = await import("./fetch");

            await expect(getTrialTerms()).resolves.toBeNull();
            expect(billingFetchMock()).not.toHaveBeenCalled();
        } finally {
            selfHosted.isSelfHosted = false;
        }
    });

    it.each([
        [
            "billing predates the route (404)",
            () =>
                billingFetchMock().mockRejectedValue(
                    Object.assign(new Error("404"), { statusCode: 404 }),
                ),
        ],
        [
            "a number is missing",
            () => billingFetchMock().mockResolvedValue({ trialDays: 7 }),
        ],
    ])(
        "returns null when %s, so no number is guessed",
        async (_label, arrange) => {
            arrange();
            const { getTrialTerms } = await import("./fetch");

            await expect(getTrialTerms()).resolves.toBeNull();
        },
    );

    it.each([
        ["a 5xx", Object.assign(new Error("503"), { statusCode: 503 })],
        ["a network failure", new Error("Network error: fetch failed")],
    ])("throws on %s, so the query retries", async (_label, error) => {
        billingFetchMock().mockRejectedValue(error);
        const { getTrialTerms } = await import("./fetch");

        await expect(getTrialTerms()).rejects.toBe(error);
    });
});
