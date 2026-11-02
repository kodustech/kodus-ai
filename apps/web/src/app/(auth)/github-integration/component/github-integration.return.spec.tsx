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
    value: { data: undefined, isLoading: true, error: null } as {
        data: unknown;
        isLoading: boolean;
        error: unknown;
    },
};
jest.mock("@services/setup/hooks", () => ({
    useGetGithubIntegrationByInstallId: () => mockQuery.value,
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

const STORAGE_KEY = "kodus.github-installation-authorization";

describe("GithubIntegrationClient — return from GitHub's authorization", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sessionStorage.clear();
    });

    it("sends the user back to the page that started it, even when it re-renders before navigating", () => {
        // The setup page started the authorization and asked to come back.
        sessionStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                state: "sealed.state",
                returnTo: "/setup/github?installation_id=42",
            }),
        );
        mockSearch.value = new URLSearchParams({
            code: "gh-code",
            state: "sealed.state",
        });
        mockQuery.value = { data: undefined, isLoading: true, error: null };

        const { rerender } = render(<GithubIntegrationClient />);

        // The installation lookup settles before router.replace has changed
        // the URL, so the effect runs again with the same code and state.
        mockQuery.value = {
            data: { status: "x" },
            isLoading: false,
            error: null,
        };
        rerender(<GithubIntegrationClient />);

        expect(mockReplace).toHaveBeenCalled();
        for (const [path] of mockReplace.mock.calls) {
            expect(path).toMatch(/^\/setup\/github\?installation_id=42&/);
            expect(path).toContain("github_code=gh-code");
        }
    });
});

describe("GithubIntegrationClient — install started from the onboarding", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sessionStorage.clear();
        mockSearch.value = new URLSearchParams({ installation_id: "42" });
        mockQuery.value = { data: {}, isLoading: false, error: null };
    });

    it("continues on the setup page instead of asking to log in", () => {
        mockGetCookie.mockImplementation((name: string) =>
            name === "started-setup-from-new-setup-page" ? "true" : undefined,
        );

        const { queryByText } = render(<GithubIntegrationClient />);

        expect(mockReplace).toHaveBeenCalledWith(
            "/setup/github?installation_id=42",
        );
        expect(queryByText("Copy link")).toBeNull();
    });

    it("still asks to log in when neither a team nor the onboarding started it", () => {
        mockGetCookie.mockReturnValue(undefined);

        const { getByText } = render(<GithubIntegrationClient />);

        expect(mockReplace).not.toHaveBeenCalled();
        expect(getByText("Copy link")).toBeTruthy();
    });
});
