import { redirect } from "next/navigation";

import OrganizationSettingsPage from "./page";

const mockGetParameter = jest.fn();
const mockGetFixedEgressIp = jest.fn();

jest.mock("@services/fetch", () => {
    class TypedFetchError extends Error {
        constructor(readonly statusCode: number) {
            super(`HTTP ${statusCode}`);
        }
    }
    return { authorizedFetch: jest.fn(), TypedFetchError };
});
jest.mock("@services/organizationParameters", () => ({
    ORGANIZATION_PARAMETERS_PATHS: {},
}));
jest.mock("@services/organizationParameters/fetch", () => ({
    getOrganizationParameterByKey: (...args: unknown[]) =>
        mockGetParameter(...args),
}));
jest.mock("@services/organizationParameters/fixedEgressIp", () => ({
    getFixedEgressIp: () => mockGetFixedEgressIp(),
}));
jest.mock("@services/organizations/fetch", () => ({
    getOrganizationId: async () => "org-1",
}));
jest.mock("src/core/config/auth", () => ({
    auth: async () => ({ user: { email: "owner@acme.dev" } }),
}));
jest.mock("./_page-component", () => ({
    GeneralOrganizationSettingsPage: () => null,
}));

/** What authorizedFetch throws on a server-side 401: Next's redirect. */
const signOutRedirect = () => {
    try {
        redirect("/sign-out");
    } catch (error) {
        return error;
    }
    throw new Error("redirect did not throw");
};

const SETTING = {
    available: true,
    allowedByPlan: true,
    enabled: false,
    fixedIp: "203.0.113.10",
};

beforeEach(() => {
    mockGetParameter.mockResolvedValue({ configValue: undefined });
    mockGetFixedEgressIp.mockResolvedValue(SETTING);
});

describe("Organization settings page with an expired session", () => {
    it("signs out when the fixed outbound IP read is answered with a 401", async () => {
        const expired = signOutRedirect();
        mockGetFixedEgressIp.mockRejectedValue(expired);

        await expect(OrganizationSettingsPage()).rejects.toBe(expired);
    });

    it("signs out when a parameter read is answered with a 401", async () => {
        const expired = signOutRedirect();
        mockGetParameter.mockRejectedValue(expired);

        await expect(OrganizationSettingsPage()).rejects.toBe(expired);
    });

    it("still renders, saying the card could not load, when the read fails otherwise", async () => {
        mockGetFixedEgressIp.mockRejectedValue(new Error("socket hang up"));

        const page = await OrganizationSettingsPage();

        expect(page.props).toEqual(
            expect.objectContaining({ fixedEgressIpLoadFailed: true }),
        );
    });
});
