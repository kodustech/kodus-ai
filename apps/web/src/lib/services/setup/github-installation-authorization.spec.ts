/** @jest-environment jsdom */
import { startGithubInstallationAuthorization } from "./github-installation-authorization";

const mockUrl = jest.fn();
const mockCookieOptions = jest.fn();
jest.mock("src/core/utils/cookie", () => {
    const actual = jest.requireActual("src/core/utils/cookie");
    return {
        ...actual,
        ClientSideCookieHelpers: (name: string, options: unknown) => {
            mockCookieOptions(name, options);
            return actual.ClientSideCookieHelpers(name, options);
        },
    };
});
jest.mock("./fetch", () => ({
    getGithubInstallationAuthorizationUrl: (id: string) => mockUrl(id),
}));

describe("startGithubInstallationAuthorization", () => {
    // jsdom does not navigate; record where the page was sent.
    const navigate = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        document.cookie = "github-installation-return-to=; path=/; max-age=0";
    });

    it("keeps where to come back in a cookie and goes to GitHub", async () => {
        mockUrl.mockResolvedValue(
            "https://github.com/login/oauth/authorize?state=s",
        );

        await startGithubInstallationAuthorization(
            "42",
            "/setup/github?installation_id=42",
            navigate,
        );

        expect(mockUrl).toHaveBeenCalledWith("42");
        expect(decodeURIComponent(document.cookie)).toContain(
            "github-installation-return-to=/setup/github?installation_id=42",
        );
        expect(navigate).toHaveBeenCalledWith(
            "https://github.com/login/oauth/authorize?state=s",
        );
        // Site-wide, so the return route under /api/auth reads it, and sent
        // on GitHub's top-level redirect back.
        expect(mockCookieOptions).toHaveBeenCalledWith(
            "github-installation-return-to",
            { path: "/", maxAge: 600, sameSite: "lax" },
        );
    });

    it("refuses a return path of another site before asking the API", async () => {
        await expect(
            startGithubInstallationAuthorization(
                "42",
                "//evil.example/x",
                navigate,
            ),
        ).rejects.toThrow("Not a path of this site");
        expect(mockUrl).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        expect(document.cookie).not.toContain("github-installation-return-to");
    });

    it("leaves no cookie behind when the API refuses", async () => {
        mockUrl.mockRejectedValue(new Error("400"));

        await expect(
            startGithubInstallationAuthorization(
                "42",
                "/setup/github",
                navigate,
            ),
        ).rejects.toThrow("400");
        expect(document.cookie).not.toContain("github-installation-return-to");
    });
});
