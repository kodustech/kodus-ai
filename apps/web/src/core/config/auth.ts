import { UserRole } from "@enums";
import NextAuth, { NextAuthConfig } from "next-auth";
import { JWT } from "next-auth/jwt";
import CredentialsProvider from "next-auth/providers/credentials";
import GithubProvider from "next-auth/providers/github";
import GitlabProvider from "next-auth/providers/gitlab";
import {
    loginEmailPassword,
    loginOAuth,
    refreshAccessToken,
} from "src/lib/auth/fetchers";
import { AuthProviders } from "src/lib/auth/types";

import { isJwtExpired, parseJwt } from "../utils/helpers";

const getDataFromPayload = (accessToken: string) => {
    const payload = parseJwt(accessToken)?.payload;
    if (!payload) return {};

    return {
        userId: payload.sub,
        email: payload.email,
        status: payload.status,
        organizationId: payload.organizationId,
        role: payload.role ?? UserRole.CONTRIBUTOR,
        iat: payload.iat,
        exp: payload.exp,
        jti: payload.jti,
    } satisfies Partial<JWT>;
};

const credentialsProvider = CredentialsProvider({
    id: AuthProviders.CREDENTIALS,
    name: AuthProviders.CREDENTIALS,
    credentials: {
        email: { label: "Email", type: "text" },
        password: { label: "Password", type: "password" },
    },
    async authorize(credentials) {
        try {
            const response = await loginEmailPassword({
                email: credentials.email as string,
                password: credentials.password as string,
            });

            return response?.data?.data;
        } catch (error: any) {
            console.error("loginEmailPassword:", error);
            return null;
        }
    },
});

const githubProvider = GithubProvider({
    id: AuthProviders.GITHUB,
    clientId: process.env.WEB_OAUTH_GITHUB_CLIENT_ID!,
    clientSecret: process.env.WEB_OAUTH_GITHUB_CLIENT_SECRET!,
});

const gitlabBaseUrl = process.env.WEB_GITLAB_OAUTH_URL
    ? new URL(process.env.WEB_GITLAB_OAUTH_URL).origin
    : "https://gitlab.com";

const gitlabProvider = GitlabProvider({
    id: AuthProviders.GITLAB,
    clientId: process.env.WEB_OAUTH_GITLAB_CLIENT_ID!,
    clientSecret: process.env.WEB_OAUTH_GITLAB_CLIENT_SECRET!,
    baseUrl: gitlabBaseUrl,
});

const ssoProvider = CredentialsProvider({
    id: AuthProviders.SSO,
    name: AuthProviders.SSO,
    credentials: {
        accessToken: { label: "AccessToken", type: "password" },
        refreshToken: { label: "RefreshToken", type: "password" },
    },
    async authorize(credentials) {
        if (credentials.accessToken && credentials.refreshToken) {
            return {
                accessToken: credentials.accessToken as string,
                refreshToken: credentials.refreshToken as string,
            };
        }

        console.error("SSO credentials not found");
        return null;
    },
});

const authOptions: NextAuthConfig = {
    providers: [
        credentialsProvider,
        githubProvider,
        gitlabProvider,
        ssoProvider,
    ],
    session: { strategy: "jwt" },
    secret:
        process.env.WEB_NEXTAUTH_SECRET ??
        process.env.NEXTAUTH_SECRET ??
        process.env.AUTH_SECRET ??
        (process.env.NODE_ENV !== "production"
            ? "kodus-web-dev-insecure-secret"
            : undefined),
    pages: { signIn: "/sign-in", error: "/error" },
    callbacks: {
        redirect: ({ url }) => url, // let middleware control redirects
        authorized: ({ auth }) => !!auth,
        async jwt({ token, user, trigger, session: _session }) {
            // on trigger update
            if (trigger === "update") {
                const session = _session as JWT;

                return {
                    ...token,
                    ...session,
                    reason: undefined,
                    ...getDataFromPayload(session.accessToken),
                };
            }

            // on token expiration
            const exp = getDataFromPayload(token?.accessToken)?.exp;
            if (exp && isJwtExpired(exp)) {
                try {
                    const newTokens = await refreshAccessToken({
                        refreshToken: token.refreshToken,
                    });

                    return {
                        ...token,
                        accessToken: newTokens.accessToken,
                        refreshToken: newTokens.refreshToken,
                        reason: "expired-token",
                        ...getDataFromPayload(newTokens.accessToken),
                    };
                } catch (e) {
                    console.error(e);
                    return null;
                }
            }

            // on user login by oauth or credentials
            if (user) {
                return {
                    ...token,
                    accessToken: user.accessToken,
                    refreshToken: user.refreshToken,
                    reason: undefined,
                    ...getDataFromPayload(user.accessToken),
                };
            }

            // already logged, only return data
            return {
                ...token,
                accessToken: token.accessToken,
                refreshToken: token.refreshToken,
                reason: undefined,
                ...getDataFromPayload(token.accessToken),
            };
        },
        async session({ session, token }) {
            return { ...session, user: token };
        },
        async signIn({ account, user }) {
            switch (account?.provider) {
                case AuthProviders.GITHUB:
                case AuthProviders.GITLAB:
                case AuthProviders.GOOGLE:
                    if (!user.name || !user.email || !account.access_token) {
                        return false;
                    }

                    try {
                        const { data: response } = await loginOAuth(
                            user.name,
                            user.email,
                            account.access_token,
                            account.provider as AuthProviders,
                        );

                        if (response && response?.data) {
                            Object.assign(user, {
                                accessToken: response.data.accessToken,
                                refreshToken: response.data.refreshToken,
                            });
                            return true;
                        }
                    } catch (error) {
                        console.error("OAuth login error", error);
                        return false;
                    }

                    return false;
                case AuthProviders.SSO:
                case AuthProviders.CREDENTIALS:
                    return true;
                default:
                    return false;
            }
        },
    },
    trustHost: true,
};

export const { auth, handlers, signIn, unstable_update, signOut } =
    NextAuth(authOptions);
