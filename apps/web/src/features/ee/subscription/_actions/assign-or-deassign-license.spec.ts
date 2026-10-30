import { assignOrDeassignUserLicenseAction } from "./assign-or-deassign-license";
import { assignOrDeassignUserLicense } from "../_services/billing/fetch";

jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));

jest.mock("src/core/config/auth", () => ({
    auth: jest.fn().mockResolvedValue({
        user: { userId: "user-1", email: "admin@example.com" },
    }),
}));

jest.mock("../_services/billing/fetch", () => ({
    assignOrDeassignUserLicense: jest.fn(),
}));

const mockedAssign = assignOrDeassignUserLicense as jest.MockedFunction<
    typeof assignOrDeassignUserLicense
>;

describe("assignOrDeassignUserLicenseAction", () => {
    const params = {
        teamId: "team-1",
        user: {
            git_id: "4242",
            git_tool: "github",
            licenseStatus: "active" as const,
        },
    };

    afterEach(() => jest.clearAllMocks());

    it("surfaces a refusal reported by the billing service as `error`", async () => {
        mockedAssign.mockResolvedValue({
            successful: [],
            error: [{ error: "No seats left" }],
        } as never);

        const result = await assignOrDeassignUserLicenseAction(params);

        expect(result.failures).toEqual([{ error: "No seats left" }]);
    });

    // The self-hosted API names this field `failed`. Reading only `error`
    // made a rejected self-hosted assignment look like a success.
    it("surfaces a refusal reported by the self-hosted API as `failed`", async () => {
        mockedAssign.mockResolvedValue({
            successful: [],
            failed: [{ error: "No seats left" }],
        } as never);

        const result = await assignOrDeassignUserLicenseAction(params);

        expect(result.failures).toEqual([{ error: "No seats left" }]);
    });

    it("reports no failures when the seat is assigned", async () => {
        mockedAssign.mockResolvedValue({
            successful: [{ git_id: "4242" }],
            error: [],
        } as never);

        const result = await assignOrDeassignUserLicenseAction(params);

        expect(result.failures).toEqual([]);
        expect(result.successful).toEqual([{ git_id: "4242" }]);
    });

    it("treats a response carrying neither field as no failure", async () => {
        mockedAssign.mockResolvedValue({ successful: [] } as never);

        const result = await assignOrDeassignUserLicenseAction(params);

        expect(result.failures).toEqual([]);
    });
});
