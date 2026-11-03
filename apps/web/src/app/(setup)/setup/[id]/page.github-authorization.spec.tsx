/** @jest-environment jsdom */
import { act, render } from "@testing-library/react";

import Redirect from "./page";

const mockReplace = jest.fn();
const mockSearch = { value: new URLSearchParams() };
jest.mock("next/navigation", () => ({
    useParams: () => ({ id: "github" }),
    useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
    useSearchParams: () => mockSearch.value,
}));
const mockToast = jest.fn();
jest.mock("@components/ui/toaster/use-toast", () => ({
    toast: (arg: unknown) => mockToast(arg),
}));
jest.mock("@hooks/use-invalidate-queries", () => ({
    useReactQueryInvalidateQueries: () => ({
        removeQueries: jest.fn(),
        generateQueryKey: jest.fn(),
    }),
}));
const mockCreate = jest.fn();
jest.mock("@services/codeManagement/fetch", () => ({
    createCodeManagementIntegration: (arg: unknown) => mockCreate(arg),
}));
jest.mock("@services/setup/hooks", () => ({
    useGetGithubOrganizationName: () => ({ data: undefined }),
}));
const mockStart = jest.fn();
jest.mock("@services/setup/github-installation-authorization", () => ({
    startGithubInstallationAuthorization: (...args: unknown[]) =>
        mockStart(...args),
}));
jest.mock("src/core/providers/auth.provider", () => ({
    useAuth: () => ({ userId: "u1" }),
}));
jest.mock("src/core/providers/selected-team-context", () => ({
    useSelectedTeamId: () => ({ teamId: "team-1" }),
}));
jest.mock("src/features/organization/_providers/organization-context", () => ({
    useOrganizationContext: () => ({ organizationId: "org-1" }),
}));

const setOnboarding = (on: boolean) => {
    document.cookie = on
        ? "started-setup-from-new-setup-page=true; path=/"
        : "started-setup-from-new-setup-page=; path=/; max-age=0";
};

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

/**
 * The setup page links a GitHub App installation after GitHub's user
 * authorization. Whatever happens on GitHub's side, the user is told why and
 * sent back to where they started, never left on a blank or stuck page.
 */
describe("setup page — GitHub authorization", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        setOnboarding(false);
    });

    it("starts the authorization and shows progress meanwhile", async () => {
        mockStart.mockReturnValue(new Promise(() => {}));
        mockSearch.value = new URLSearchParams({ installation_id: "42" });

        const { getByText } = render(<Redirect />);
        await flush();

        expect(mockStart).toHaveBeenCalledWith(
            "42",
            "/setup/github?installation_id=42",
        );
        expect(getByText(/Connecting GITHUB/)).toBeTruthy();
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it("goes back to the onboarding with the reason when GitHub's authorization was cancelled", async () => {
        setOnboarding(true);
        mockSearch.value = new URLSearchParams({
            installation_id: "42",
            github_error: "access_denied",
        });

        render(<Redirect />);
        await flush();

        expect(mockStart).not.toHaveBeenCalled();
        expect(mockCreate).not.toHaveBeenCalled();
        expect(mockToast.mock.calls[0][0].description).toMatch(/cancelled/);
        expect(mockReplace).toHaveBeenCalledWith("/setup/connecting-git-tool");
        // The marker stays, so the next try still belongs to the onboarding.
        expect(document.cookie).toContain("started-setup-from-new-setup-page");
    });

    it("shows the API's reason and leaves when the authorization cannot start", async () => {
        mockStart.mockRejectedValue({
            response: {
                data: { message: "Neither API_FRONTEND_URL nor NEXTAUTH_URL is configured" },
            },
        });
        mockSearch.value = new URLSearchParams({ installation_id: "42" });

        render(<Redirect />);
        await flush();

        expect(mockToast.mock.calls[0][0].description).toMatch(
            /API_FRONTEND_URL/,
        );
        expect(mockReplace).toHaveBeenCalledWith("/settings/git");
    });

    it("links the installation once GitHub's code and state are back", async () => {
        mockCreate.mockResolvedValue({ data: { status: "SUCCESS" } });
        mockSearch.value = new URLSearchParams({
            installation_id: "42",
            github_code: "gh-code",
            github_state: "sealed.state",
        });

        render(<Redirect />);
        await flush();

        expect(mockStart).not.toHaveBeenCalled();
        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                installationId: "42",
                githubCode: "gh-code",
                githubState: "sealed.state",
            }),
        );
    });
});
