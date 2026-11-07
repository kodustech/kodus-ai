import { axiosAuthorized } from "src/core/utils/axios";

import { createOrUpdateCodeReviewParameter } from "./fetch";

jest.mock("src/core/utils/axios", () => ({
    axiosAuthorized: { post: jest.fn() },
}));
jest.mock("@services/fetch", () => ({ authorizedFetch: jest.fn() }));

const post = jest.mocked(axiosAuthorized.post);
beforeEach(() => {
    post.mockReset().mockResolvedValue({ data: { saved: true } } as never);
});

it("sends risk, routing and named policies through the real settings request serializer", async () => {
    const settings = {
        riskAssessmentActive: true,
        riskCriteria: [
            {
                id: "access",
                name: "Access",
                enabled: true,
                instructions: "Check access boundaries.",
                includedFiles: ["src/**/*.{ts,tsx}"],
            },
        ],
        riskReviewRouting: { noRisk: "balanced", riskFound: "heavy" },
        approvalPolicies: [
            {
                id: "docs",
                name: "Docs",
                enabled: false,
                includedFiles: ["docs/**"],
            },
        ],
    } satisfies Parameters<typeof createOrUpdateCodeReviewParameter>[0];
    await createOrUpdateCodeReviewParameter(
        { ...settings, notASetting: true } as never,
        "team",
        "global",
    );
    expect(post).toHaveBeenCalledWith(
        expect.stringContaining("/parameters/create-or-update-code-review"),
        expect.objectContaining({
            configValue: settings,
            repositoryId: undefined,
            organizationAndTeamData: { teamId: "team" },
        }),
    );
});

it("sends explicit risk-off and empty lists rather than silently retaining saved settings", async () => {
    const settings = {
        riskAssessmentActive: false,
        riskCriteria: [],
        approvalPolicies: [],
        riskReviewRouting: { noRisk: "balanced", riskFound: "balanced" },
    } satisfies Parameters<typeof createOrUpdateCodeReviewParameter>[0];
    await createOrUpdateCodeReviewParameter(
        settings,
        "team",
        "repo",
        "directory",
    );
    expect(post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
            configValue: settings,
            repositoryId: "repo",
            directoryId: "directory",
        }),
    );
});
