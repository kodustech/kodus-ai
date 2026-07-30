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
jest.mock("./utils", () => ({ billingFetch: jest.fn() }));
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
            request: { teamSize: 12, message: "Evaluating for the platform team" },
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
