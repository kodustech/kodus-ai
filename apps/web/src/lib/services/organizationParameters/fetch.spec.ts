jest.mock("@services/fetch", () => ({
    authorizedFetch: jest.fn(),
}));

jest.mock(".", () => ({
    ORGANIZATION_PARAMETERS_PATHS: {
        GET_BY_KEY: "/organization-parameters/find-by-key",
    },
}));

describe("organization parameter fetchers", () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it("fetches BYOK config with no-store cache", async () => {
        const { authorizedFetch } = await import("@services/fetch");
        const { getBYOK } = await import("./fetch");

        (authorizedFetch as jest.Mock).mockResolvedValue({
            configValue: { main: null, fallback: null },
        });

        await getBYOK();

        expect(authorizedFetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                params: { key: "byok_config" },
                cache: "no-store",
            }),
        );
    });
});
