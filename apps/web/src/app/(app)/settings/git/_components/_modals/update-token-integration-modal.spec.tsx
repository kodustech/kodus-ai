/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { createCodeManagementIntegration } from "@services/codeManagement/fetch";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthMode, PlatformType } from "src/core/types";

import { UpdateTokenIntegrationModal } from "./update-token-integration-modal";

jest.mock("@services/codeManagement/fetch", () => ({
    createCodeManagementIntegration: jest.fn().mockResolvedValue({}),
}));

jest.mock("@components/ui/magic-modal", () => ({
    magicModal: {
        lock: jest.fn(),
        unlock: jest.fn(),
        hide: jest.fn(),
    },
    useMagicModalState: () => ({ closeable: true }),
}));

jest.mock("@components/ui/toaster/use-toast", () => ({
    toast: jest.fn(),
}));

jest.mock("@hooks/use-invalidate-queries", () => ({
    useReactQueryInvalidateQueries: () => ({
        invalidateQueries: jest.fn().mockResolvedValue(undefined),
        generateQueryKey: jest.fn().mockReturnValue(["key"]),
    }),
}));

jest.mock("src/core/utils/revalidate-server-side", () => ({
    revalidateServerSidePath: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@components/system/git-token-docs", () => ({
    GitTokenDocs: () => null,
}));

const createIntegrationMock =
    createCodeManagementIntegration as jest.MockedFunction<
        typeof createCodeManagementIntegration
    >;

const renderModal = (host?: string) =>
    render(
        <UpdateTokenIntegrationModal
            host={host}
            platformKey="gitlab"
            platformName="GitLab"
            teamId="team-1"
        />,
    );

describe("UpdateTokenIntegrationModal", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // The regression #1874 is about: rotating a token on a self-hosted
    // connection must keep pointing at the same instance. The modal is the only
    // place that decides what `host` the upsert receives, so assert the payload
    // rather than the prefill alone.
    it("sends the stored host back when rotating a self-hosted token", async () => {
        renderModal("https://gitlab.example.com");

        expect(
            screen.getByDisplayValue("https://gitlab.example.com"),
        ).toBeInTheDocument();

        fireEvent.change(screen.getByPlaceholderText("Personal Access Token"), {
            target: { value: "glpat-new" },
        });
        fireEvent.click(screen.getByRole("button", { name: /update token/i }));

        await waitFor(() => {
            expect(createIntegrationMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    integrationType: PlatformType.GITLAB,
                    authMode: AuthMode.TOKEN,
                    token: "glpat-new",
                    host: "https://gitlab.example.com",
                    organizationAndTeamData: { teamId: "team-1" },
                }),
            );
        });
    });

    it("leaves the host undefined for a cloud connection", async () => {
        renderModal(undefined);

        fireEvent.change(screen.getByPlaceholderText("Personal Access Token"), {
            target: { value: "glpat-cloud" },
        });
        fireEvent.click(screen.getByRole("button", { name: /update token/i }));

        await waitFor(() => {
            expect(createIntegrationMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    token: "glpat-cloud",
                    host: undefined,
                }),
            );
        });
    });
});
