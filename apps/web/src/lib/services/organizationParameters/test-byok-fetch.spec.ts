/**
 * The client half of the connection-probe contract.
 *
 * The probe only proves the config being SAVED if the form's advanced settings
 * survive the trip. This is the first hop — drop a field here and it is gone
 * before the controller (whose own passthrough is pinned in
 * organizationParameters.controller.test-byok.spec) ever sees it, so the probe
 * silently runs a weaker config than the one about to be persisted.
 */
// @ts-nocheck

// fetch.ts transitively pulls the authorized-fetch stack (next-auth, ESM),
// which jest can't load as CommonJS — the sibling fetch.spec stubs it the same
// way. Nothing here exercises that path.
jest.mock("@services/fetch", () => ({
    authorizedFetch: jest.fn(),
}));

jest.mock("src/core/utils/axios", () => ({
    axiosAuthorized: { post: jest.fn() },
}));

jest.mock(".", () => ({
    ORGANIZATION_PARAMETERS_PATHS: {
        TEST_BYOK: "/organization-parameters/test-byok",
        TEST_BYOK_MODEL: "/organization-parameters/test-byok-model",
    },
}));

describe("testBYOK — what the connect form sends to the probe", () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    const post = async () => {
        const { axiosAuthorized } = await import("src/core/utils/axios");
        return axiosAuthorized.post as jest.Mock;
    };

    it("sends the advanced tuning alongside the credentials", async () => {
        const postMock = await post();
        postMock.mockResolvedValue({ data: { ok: true } });
        const { testBYOK } = await import("./fetch");

        await testBYOK({
            provider: "open_router",
            apiKey: "sk-test",
            baseURL: "https://openrouter.ai/api/v1",
            model: "anthropic/claude-x",
            temperature: 0.3,
            reasoningEffort: "high",
            reasoningConfigOverride: '{"reasoning":{"effort":"high"}}',
            maxOutputTokens: 2048,
            openrouterProviderOrder: ["anthropic"],
            openrouterAllowFallbacks: false,
        });

        expect(postMock).toHaveBeenCalledWith(
            "/organization-parameters/test-byok",
            expect.objectContaining({
                reasoningConfigOverride: '{"reasoning":{"effort":"high"}}',
                maxOutputTokens: 2048,
                openrouterProviderOrder: ["anthropic"],
                openrouterAllowFallbacks: false,
                temperature: 0.3,
                reasoningEffort: "high",
            }),
        );
    });

    it("hits the probe endpoint and unwraps the envelope", async () => {
        const postMock = await post();
        postMock.mockResolvedValue({
            data: { ok: false, code: "auth", latencyMs: 9 },
        });
        const { testBYOK } = await import("./fetch");

        const result = await testBYOK({
            provider: "openai",
            apiKey: "sk-bad",
            model: "gpt-x",
        });

        expect(result).toEqual({ ok: false, code: "auth", latencyMs: 9 });
    });
});

describe("testBYOKModel — the saved-credential probe", () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    /**
     * 607c773c5: this path reuses the org's STORED secret, resolved server-side.
     * Accepting a caller-supplied baseURL here would let an authorized caller
     * point it at any public host and exfiltrate a credential they can't read.
     * Changing an endpoint has to go through testBYOK with the caller's own key.
     */
    it("never carries a baseURL, only the safe non-secret overrides", async () => {
        const { axiosAuthorized } = await import("src/core/utils/axios");
        const postMock = axiosAuthorized.post as jest.Mock;
        postMock.mockResolvedValue({ data: { ok: true } });
        const { testBYOKModel } = await import("./fetch");

        await testBYOKModel({
            provider: "amazon_bedrock",
            model: "anthropic.claude-x",
            awsRegion: "us-east-1",
            vertexLocation: "global",
        });

        const sent = postMock.mock.calls[0][1];
        expect(sent).not.toHaveProperty("baseURL");
        expect(sent).not.toHaveProperty("apiKey");
        expect(sent).toMatchObject({
            provider: "amazon_bedrock",
            model: "anthropic.claude-x",
            awsRegion: "us-east-1",
            vertexLocation: "global",
        });
    });
});
