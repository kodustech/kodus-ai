import type { NextAuthConfig } from "next-auth";

/**
 * OAuth signups never go through the sign-up form: the organization is created
 * by POST /auth/oauth, called from NextAuth's signIn callback on the server.
 * That callback must forward the first-touch cookie from the provider's
 * redirect back to us.
 */
let config: NextAuthConfig;

jest.mock("next-auth", () => ({
    __esModule: true,
    default: (c: NextAuthConfig) => {
        config = c;
        return {
            auth: jest.fn(),
            handlers: {},
            signIn: jest.fn(),
            unstable_update: jest.fn(),
            signOut: jest.fn(),
        };
    },
}));
jest.mock("next-auth/providers/credentials", () => ({
    __esModule: true,
    default: (p: object) => p,
}));
jest.mock("next-auth/providers/github", () => ({
    __esModule: true,
    default: (p: object) => p,
}));
jest.mock("next-auth/providers/gitlab", () => ({
    __esModule: true,
    default: (p: object) => p,
}));

const cookieValue = jest.fn<string | undefined, [string]>();
jest.mock("next/headers", () => ({
    cookies: async () => ({
        get: (name: string) => {
            const value = cookieValue(name);
            return value === undefined ? undefined : { name, value };
        },
    }),
}));

const loginOAuth = jest.fn();
jest.mock("src/lib/auth/fetchers", () => ({
    loginOAuth: (...args: unknown[]) => loginOAuth(...args),
    loginEmailPassword: jest.fn(),
    refreshAccessToken: jest.fn(),
}));

const signInWithGithub = () =>
    config.callbacks!.signIn!({
        account: {
            provider: "github",
            access_token: "gho_token",
            type: "oauth",
            providerAccountId: "1",
        },
        user: { name: "Jane", email: "jane@acme.com" },
    } as any);

describe("NextAuth signIn callback — first touch", () => {
    beforeAll(async () => {
        // Loaded here, not imported: imports are hoisted above `config`.
        await import("./auth");
    });

    beforeEach(() => {
        jest.clearAllMocks();
        loginOAuth.mockResolvedValue({
            data: { data: { accessToken: "a", refreshToken: "r" } },
        });
    });

    it("sends the kodus_first_touch cookie along with the OAuth login", async () => {
        const touch = { utm_source: "google", gclid: "TEST" };
        // Next's cookies() hands the value over already URI-decoded.
        cookieValue.mockImplementation((name) =>
            name === "kodus_first_touch" ? JSON.stringify(touch) : undefined,
        );

        await expect(signInWithGithub()).resolves.toBe(true);

        expect(loginOAuth).toHaveBeenCalledWith(
            "Jane",
            "jane@acme.com",
            "gho_token",
            "github",
            touch,
        );
    });

    it("logs in without attribution when there is no cookie or it is unreadable", async () => {
        cookieValue
            .mockReturnValueOnce(undefined)
            .mockReturnValueOnce("not json");

        await expect(signInWithGithub()).resolves.toBe(true);
        await expect(signInWithGithub()).resolves.toBe(true);

        expect(loginOAuth.mock.calls[0][4]).toBeUndefined();
        expect(loginOAuth.mock.calls[1][4]).toBeUndefined();
    });
});
