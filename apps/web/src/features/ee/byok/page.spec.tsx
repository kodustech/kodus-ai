import { getSummaryTokenUsage } from "@services/usage/fetch";

import ByokPage from "./page";

jest.mock("@services/organizationParameters/fetch", () => ({
    getBYOK: jest.fn().mockResolvedValue({
        version: 2,
        credentials: [{ id: "cred-1", provider: "openai_compatible" }],
        models: [{ id: "m-1", credentialId: "cred-1", model: "deepseek-v4" }],
    }),
    getLLMConfigStatus: jest.fn().mockResolvedValue(null),
    getLLMProviderModels: jest.fn().mockResolvedValue([]),
}));
jest.mock("@services/usage/fetch", () => ({
    getSummaryTokenUsage: jest.fn(),
}));
jest.mock("src/core/utils/get-global-selected-team-id", () => ({
    getGlobalSelectedTeamId: jest.fn().mockResolvedValue("team-1"),
}));
jest.mock("src/features/ee/cockpit/_helpers/get-selected-date-range", () => ({
    getSelectedDateRange: jest.fn().mockResolvedValue({
        startDate: "2026-09-21",
        endDate: "2026-10-06",
    }),
}));
jest.mock("src/features/ee/subscription/_services/billing/fetch", () => ({
    validateOrganizationLicense: jest.fn().mockResolvedValue(null),
}));
jest.mock("./_components/page.client", () => ({
    ByokPageClient: () => null,
}));

const summaryMock = getSummaryTokenUsage as jest.Mock;

describe("ByokPage", () => {
    afterEach(() => jest.restoreAllMocks());

    it("renders without cost chips when the usage summary never answers", async () => {
        // The reported case: a high-volume org's summary aggregation runs for
        // minutes, and the page streamed a skeleton for as long as it ran.
        const deadline = new AbortController();
        jest.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
        summaryMock.mockImplementation(
            (_filters, init?: { signal?: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    const signal = init?.signal;
                    if (!signal) return; // unbounded → hangs forever
                    if (signal.aborted) return reject(signal.reason);
                    signal.addEventListener("abort", () =>
                        reject(signal.reason),
                    );
                }),
        );

        const page = ByokPage();
        deadline.abort(new DOMException("timed out", "TimeoutError"));
        const element = await page;

        // No entry → no chip. A "no-usage" entry would claim the model was
        // unused, which a timed-out summary cannot know.
        expect(element.props.costByModelId).toEqual({});
    });

    it("shows no-usage only when the summary answered without that model", async () => {
        summaryMock.mockResolvedValue({ totals: {}, totalCost: {}, byModel: [] });

        const element = await ByokPage();

        expect(element.props.costByModelId).toEqual({
            "m-1": { status: "no-data", reason: "no-usage" },
        });
    });

    it("still shows the cost when the summary answers in time", async () => {
        summaryMock.mockResolvedValue({
            totals: {},
            totalCost: {},
            byModel: [
                {
                    model: "deepseek-v4",
                    pricingSource: "catalog",
                    input: 10,
                    output: 5,
                    total: 15,
                    cost: { input: 1, output: 2, total: 3 },
                },
            ],
        });

        const element = await ByokPage();

        expect(element.props.costByModelId["m-1"]).toMatchObject({
            status: "ok",
            model: "deepseek-v4",
        });
    });
});
