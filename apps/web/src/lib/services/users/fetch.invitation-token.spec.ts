import { getInvitationToken } from "./fetch";

const mockFetcher = jest.fn();
jest.mock("src/core/utils/axios", () => ({
    axiosAuthorized: { fetcher: (...args: unknown[]) => mockFetcher(...args) },
}));
jest.mock("src/core/utils/helpers", () => ({
    pathToApiUrl: (path: string) => `https://api.example.test${path}`,
}));

describe("getInvitationToken", () => {
    it("returns the token the API sealed for the user", async () => {
        mockFetcher.mockResolvedValue({ data: { token: "sealed.token" } });

        await expect(getInvitationToken("u/1")).resolves.toBe("sealed.token");
        expect(mockFetcher).toHaveBeenCalledWith(
            "https://api.example.test/user/u%2F1/invitation-token",
        );
    });

    it("throws on a 2xx without a token instead of building /invite/undefined", async () => {
        for (const body of [{ data: {} }, { data: { token: "" } }, {}]) {
            mockFetcher.mockResolvedValue(body);
            await expect(getInvitationToken("u-1")).rejects.toThrow(
                "no invitation token",
            );
        }
    });
});
