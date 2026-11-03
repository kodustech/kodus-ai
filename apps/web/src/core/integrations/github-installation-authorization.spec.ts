import {
    githubAuthorizationErrorMessage,
    needsGithubInstallationAuthorization,
    safeReturnPath,
} from "./github-installation-authorization";

describe("needsGithubInstallationAuthorization", () => {
    const base = {
        integration: "github",
        installationId: "42",
        githubCode: null,
        githubState: null,
        githubError: null,
    };

    it("is true for a GitHub installation that has not been through the authorization", () => {
        expect(needsGithubInstallationAuthorization(base)).toBe(true);
    });

    it("is false once the authorization returned its code and state", () => {
        expect(
            needsGithubInstallationAuthorization({
                ...base,
                githubCode: "c",
                githubState: "s",
            }),
        ).toBe(false);
    });

    it("still needs it when only one of code and state came back", () => {
        expect(
            needsGithubInstallationAuthorization({ ...base, githubCode: "c" }),
        ).toBe(true);
    });

    it("is false without an installation or for another provider", () => {
        expect(
            needsGithubInstallationAuthorization({
                ...base,
                installationId: null,
            }),
        ).toBe(false);
        expect(
            needsGithubInstallationAuthorization({
                ...base,
                integration: "gitlab",
            }),
        ).toBe(false);
    });
});

describe("needsGithubInstallationAuthorization after a refusal", () => {
    it("does not start the authorization again when GitHub returned an error", () => {
        expect(
            needsGithubInstallationAuthorization({
                integration: "github",
                installationId: "42",
                githubCode: null,
                githubState: null,
                githubError: "access_denied",
            }),
        ).toBe(false);
    });
});

describe("safeReturnPath", () => {
    it("keeps a path of this site", () => {
        expect(safeReturnPath("/setup/github?installation_id=42")).toBe(
            "/setup/github?installation_id=42",
        );
    });

    it("refuses anything that can point to another origin", () => {
        for (const value of [
            "https://evil.example",
            "//evil.example",
            "/\\evil.example",
            "evil",
            "",
            null,
            undefined,
        ]) {
            expect(safeReturnPath(value)).toBeNull();
        }
    });
});

describe("githubAuthorizationErrorMessage", () => {
    it("tells a cancelled, an expired and any other failed authorization apart", () => {
        expect(githubAuthorizationErrorMessage("access_denied")).toBe(
            "The GitHub authorization was cancelled. Connect GitHub again when you are ready.",
        );
        expect(githubAuthorizationErrorMessage("expired")).toBe(
            "The GitHub authorization took too long or was started in another browser. Start the GitHub connection again.",
        );
        for (const error of ["missing_code", "redirect_uri_mismatch", ""]) {
            expect(githubAuthorizationErrorMessage(error)).toBe(
                "GitHub did not complete the authorization. Start the GitHub connection again.",
            );
        }
    });
});
