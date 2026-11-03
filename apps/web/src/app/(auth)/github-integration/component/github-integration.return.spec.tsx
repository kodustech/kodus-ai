/** @jest-environment jsdom */
import { render } from "@testing-library/react";

import GithubIntegrationClient from "./github-integration";

const mockReplace = jest.fn();
const mockSearch = { value: new URLSearchParams() };
jest.mock("next/navigation", () => ({
    useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
    useSearchParams: () => mockSearch.value,
}));

const mockQuery = {
    value: { data: {}, isLoading: false, error: null } as {
        data: unknown;
        isLoading: boolean;
        error: unknown;
    },
};
jest.mock("@services/setup/hooks", () => ({
    useGetGithubIntegrationByInstallId: () => mockQuery.value,
}));
const mockStart = jest.fn(() => Promise.resolve());
jest.mock("@services/setup/github-installation-authorization", () => ({
    startGithubInstallationAuthorization: (...args: unknown[]) =>
        mockStart(...(args as [])),
}));
jest.mock("@services/codeManagement/fetch", () => ({
    createCodeManagementIntegration: jest.fn(),
}));
jest.mock("src/core/utils/axios", () => ({
    axiosAuthorized: { fetcher: jest.fn() },
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));
const mockGetCookie = jest.fn();
jest.mock("cookies-next/client", () => ({
    getCookie: (name: string) => mockGetCookie(name),
    deleteCookie: jest.fn(),
}));

describe("GithubIntegrationClient", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockQuery.value = { data: {}, isLoading: false, error: null };
        mockGetCookie.mockReturnValue(undefined);
    });

    it("starts GitHub's authorization for the team picked in settings", () => {
        mockSearch.value = new URLSearchParams({ installation_id: "42" });
        mockGetCookie.mockImplementation((name: string) =>
            name === "selectedTeam"
                ? JSON.stringify({ uuid: "team-1", name: "Team" })
                : undefined,
        );

        render(<GithubIntegrationClient />);

        expect(mockStart).toHaveBeenCalledWith(
            "42",
            "/github-integration?installation_id=42",
        );
    });

    it("shows why when GitHub's authorization was cancelled", () => {
        mockSearch.value = new URLSearchParams({
            installation_id: "42",
            github_error: "access_denied",
        });

        const { getByText } = render(<GithubIntegrationClient />);

        expect(getByText(/authorization was cancelled/)).toBeTruthy();
        expect(mockStart).not.toHaveBeenCalled();
    });

    it("says the authorization expired when the return path was lost", () => {
        mockSearch.value = new URLSearchParams({ github_error: "expired" });

        const { getByText } = render(<GithubIntegrationClient />);

        expect(getByText(/took too long/)).toBeTruthy();
    });

    it("asks to log in when no team started the install", () => {
        mockSearch.value = new URLSearchParams({ installation_id: "42" });

        const { getByText } = render(<GithubIntegrationClient />);

        expect(mockReplace).not.toHaveBeenCalled();
        expect(mockStart).not.toHaveBeenCalled();
        expect(getByText("Copy link")).toBeTruthy();
    });
});
