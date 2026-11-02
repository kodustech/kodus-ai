import { needsGithubInstallationAuthorization } from "./github-installation-authorization";

describe("needsGithubInstallationAuthorization", () => {
    const base = {
        integration: "github",
        installationId: "42",
        githubCode: null,
        githubState: null,
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
