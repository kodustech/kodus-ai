/** @jest-environment node */
import { NextRequest } from "next/server";

jest.mock("./core/config/auth", () => ({
    auth: (handler: unknown) => handler,
}));
jest.mock("./core/utils/permissions", () => ({
    handleAuthenticated: (_req: unknown, _path: unknown, _s: unknown, next: unknown) =>
        next,
}));

// eslint-disable-next-line import/first
import { proxy } from "./proxy";

/**
 * GitHub's post-install return lands on /setup/github. Started from this
 * browser's onboarding it stays there, so the setup page links the
 * installation to the team being set up; otherwise /github-integration takes
 * it (a team picked in settings, or someone else installing from a link).
 */
describe("proxy — GitHub App post-install return", () => {
    const run = async (cookies: Record<string, string>) => {
        const req = new NextRequest(
            "https://app.example.test/setup/github?setup_action=install&installation_id=42",
            {
                headers: {
                    cookie: Object.entries(cookies)
                        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
                        .join("; "),
                },
            },
        ) as NextRequest & { auth: unknown };
        req.auth = {
            user: { status: "active", accessToken: "t", reason: undefined },
        };
        const res = (await (proxy as any)(req)) as Response;
        return res.headers.get("location");
    };

    it("keeps an install started from the onboarding on the setup page", async () => {
        expect(
            await run({ "started-setup-from-new-setup-page": "true" }),
        ).toBeNull();
    });

    it("sends an install started from settings to /github-integration", async () => {
        expect(
            await run({
                "started-setup-from-new-setup-page": "true",
                selectedTeam: JSON.stringify({ uuid: "team-1" }),
            }),
        ).toBe("https://app.example.test/github-integration?installation_id=42");
    });

    it("sends an install from someone else to /github-integration", async () => {
        expect(await run({})).toBe(
            "https://app.example.test/github-integration?installation_id=42",
        );
    });
});
