/** @jest-environment node */
import { NextRequest } from "next/server";

import { GET } from "./route";

const call = (
    query: string,
    returnTo?: string,
    extraCookies: Record<string, string> = {},
) => {
    const cookies = {
        ...(returnTo !== undefined
            ? { "github-installation-return-to": returnTo }
            : {}),
        ...extraCookies,
    };
    const response = GET(
        new NextRequest(
            `https://app.example.test/api/auth/callback/github/installation${query}`,
            {
                headers: {
                    cookie: Object.entries(cookies)
                        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
                        .join("; "),
                },
            },
        ),
    );
    return {
        location: response.headers.get("location"),
        clearsCookie: /github-installation-return-to=;/.test(
            response.headers.get("set-cookie") ?? "",
        ),
    };
};

describe("GitHub installation authorization callback", () => {
    it("goes back to the page that started it with the code and state", () => {
        const { location, clearsCookie } = call(
            "?code=gh-code&state=sealed.state",
            "/setup/github?installation_id=42",
        );

        expect(location).toBe(
            "/setup/github?installation_id=42&github_code=gh-code&github_state=sealed.state",
        );
        expect(clearsCookie).toBe(true);
    });

    it("passes on GitHub's refusal instead of dropping it", () => {
        expect(
            call(
                "?error=access_denied&state=sealed.state",
                "/setup/github?installation_id=42",
            ).location,
        ).toBe("/setup/github?installation_id=42&github_error=access_denied");
    });

    it("logs why GitHub refused, without the code or state", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            call(
                "?error=redirect_uri_mismatch&error_description=The+redirect_uri+MUST+match&state=sealed.state",
                "/setup/github?installation_id=42",
            );
            expect(warn).toHaveBeenCalledWith(
                "GitHub installation authorization did not complete",
                {
                    error: "redirect_uri_mismatch",
                    description: "The redirect_uri MUST match",
                },
            );
            expect(JSON.stringify(warn.mock.calls)).not.toContain(
                "sealed.state",
            );
        } finally {
            warn.mockRestore();
        }
    });

    it("says the authorization expired when the return path is gone", () => {
        expect(call("?code=gh-code&state=sealed.state").location).toBe(
            "/github-integration?github_error=expired",
        );
    });

    it("sends an onboarding user back to the setup page when the return path is gone", () => {
        expect(
            call("?code=gh-code&state=s", undefined, {
                "started-setup-from-new-setup-page": "true",
            }).location,
        ).toBe("/setup/github?github_error=expired");
    });

    it("keeps a hash out of the redirect and the code and state in the query", () => {
        expect(
            call("?code=c&state=s", "/setup/github?installation_id=42#x")
                .location,
        ).toBe("/setup/github?installation_id=42&github_code=c&github_state=s");
    });

    it("never redirects to another site, whatever the cookie holds", () => {
        for (const returnTo of [
            "https://evil.example/x",
            "//evil.example/x",
            "/\\evil.example/x",
            "/.//evil.example/x",
            "/\t/evil.example/x",
            "/\n/evil.example/x",
            "/a/..//evil.example/x",
            "/%2e%2e//evil.example/x",
        ]) {
            const { location } = call("?code=c&state=s", returnTo);
            expect(location?.startsWith("/")).toBe(true);
            expect(location?.startsWith("//")).toBe(false);
            expect(location).not.toContain("evil.example");
        }
    });
});
