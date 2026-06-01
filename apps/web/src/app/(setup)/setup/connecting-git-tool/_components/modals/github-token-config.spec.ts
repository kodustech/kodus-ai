import {
    getGithubTokenConfig,
    getGithubTokenErrorMessage,
    isValidGithubEnterpriseUrl,
    resolveGithubTokenHost,
} from "./github-token-config";

describe("github-token-config", () => {
    describe("getGithubTokenConfig", () => {
        it("enables the self-hosted controls when the feature flag is enabled", () => {
            expect(
                getGithubTokenConfig({
                    githubEnterpriseServerPatEnabled: true,
                }),
            ).toEqual({
                showSelfHosted: true,
            });
        });

        it("keeps the self-hosted controls hidden when the feature flag is disabled", () => {
            expect(
                getGithubTokenConfig({
                    githubEnterpriseServerPatEnabled: false,
                }),
            ).toEqual({
                showSelfHosted: false,
            });
        });
    });

    describe("resolveGithubTokenHost", () => {
        it("returns the enterprise host when the flag is enabled and self-hosted is selected", () => {
            expect(
                resolveGithubTokenHost({
                    githubEnterpriseServerPatEnabled: true,
                    selfHosted: true,
                    selfHostedUrl: "https://github.acme.internal",
                }),
            ).toBe("https://github.acme.internal");
        });

        it("ignores the host when the feature flag is disabled", () => {
            expect(
                resolveGithubTokenHost({
                    githubEnterpriseServerPatEnabled: false,
                    selfHosted: true,
                    selfHostedUrl: "https://github.acme.internal",
                }),
            ).toBeUndefined();
        });

        it("ignores the host when the enterprise url is empty", () => {
            expect(
                resolveGithubTokenHost({
                    githubEnterpriseServerPatEnabled: true,
                    selfHosted: true,
                    selfHostedUrl: "",
                }),
            ).toBeUndefined();
        });

        it("ignores the host when self-hosted is not selected", () => {
            expect(
                resolveGithubTokenHost({
                    githubEnterpriseServerPatEnabled: true,
                    selfHosted: false,
                    selfHostedUrl: "https://github.acme.internal",
                }),
            ).toBeUndefined();
        });
    });

    describe("isValidGithubEnterpriseUrl", () => {
        it("accepts valid http and https urls", () => {
            expect(
                isValidGithubEnterpriseUrl("https://github.acme.internal"),
            ).toBe(true);
            expect(isValidGithubEnterpriseUrl("http://localhost:3000")).toBe(
                true,
            );
        });

        it("rejects malformed urls", () => {
            expect(isValidGithubEnterpriseUrl("github acme internal")).toBe(
                false,
            );
            expect(
                isValidGithubEnterpriseUrl("ftp://github.acme.internal"),
            ).toBe(false);
        });
    });

    describe("getGithubTokenErrorMessage", () => {
        it("returns a host-aware message in self-hosted mode", () => {
            expect(getGithubTokenErrorMessage({ selfHosted: true })).toBe(
                "Invalid Token or GitHub Enterprise URL",
            );
        });

        it("returns the token-only message in cloud mode", () => {
            expect(getGithubTokenErrorMessage({ selfHosted: false })).toBe(
                "Invalid Token",
            );
        });
    });
});
