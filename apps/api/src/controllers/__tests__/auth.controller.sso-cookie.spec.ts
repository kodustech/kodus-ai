import { Request, Response } from 'express';

import { AuthController } from '../auth.controller';

/**
 * Integration test for the SSO handoff cookie's `Domain` attribute.
 *
 * Walks through `AuthController.ssoCallback` end-to-end with mocked
 * request/response and the real `deriveSsoCookieDomain` utility, so it
 * catches:
 *   1. The utility itself (covered exhaustively by its own spec).
 *   2. The wiring in the controller — that `req.get('host')` is read,
 *      that `process.env.API_NODE_ENV` flows through, that the result
 *      lands in `res.cookie(..., { domain })`.
 *
 * If a future refactor breaks the wiring (e.g. someone re-hardcodes
 * `.kodus.io` or drops the host argument), this spec fails on the
 * Dmitry / self-hosted shape — the exact regression we just fixed.
 */
describe('AuthController.ssoCallback — SSO handoff cookie Domain', () => {
    let controller: AuthController;
    let ssoLoginUseCase: { execute: jest.Mock };
    let ssoTestSessionService: {
        getSession: jest.Mock;
        markSessionSuccess: jest.Mock;
        markSessionFailed: jest.Mock;
    };
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };

        ssoLoginUseCase = {
            execute: jest
                .fn()
                .mockResolvedValue({
                    accessToken: 'access-token-test',
                    refreshToken: 'refresh-token-test',
                }),
        };

        ssoTestSessionService = {
            getSession: jest.fn().mockResolvedValue(null),
            markSessionSuccess: jest.fn(),
            markSessionFailed: jest.fn(),
        };

        controller = new AuthController(
            {} as any, // loginUseCase
            {} as any, // refreshTokenUseCase
            {} as any, // logoutUseCase
            {} as any, // signUpUseCase
            {} as any, // oAuthLoginUseCase
            {} as any, // forgotPasswordUseCase
            {} as any, // resetPasswordUseCase
            {} as any, // confirmEmailUseCase
            {} as any, // resendEmailUseCase
            ssoLoginUseCase as any,
            {} as any, // ssoCheckUseCase
            ssoTestSessionService as any,
        );
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    /**
     * Helper: invoke ssoCallback with a custom (host, frontendUrl, env)
     * triple and return whatever was passed to res.cookie + res.redirect.
     */
    async function callSsoCallback(opts: {
        apiHost: string;
        frontendUrl: string;
        nodeEnv: string;
    }) {
        process.env.API_FRONTEND_URL = opts.frontendUrl;
        process.env.API_NODE_ENV = opts.nodeEnv;

        const req = {
            user: { id: 'user-test' },
            body: {},
            query: {},
            get: jest.fn((header: string) =>
                header.toLowerCase() === 'host' ? opts.apiHost : undefined,
            ),
        } as unknown as Request;

        const res = {
            cookie: jest.fn().mockReturnThis(),
            redirect: jest.fn().mockReturnThis(),
        } as unknown as Response;

        await controller.ssoCallback(req, res, 'test-org-id');

        const cookieCall = (res.cookie as jest.Mock).mock.calls[0];
        const redirectCall = (res.redirect as jest.Mock).mock.calls[0];

        return {
            cookieName: cookieCall?.[0],
            cookiePayload: cookieCall?.[1],
            cookieOptions: cookieCall?.[2] ?? {},
            redirectUrl: redirectCall?.[0],
        };
    }

    describe('SaaS topology', () => {
        it('sets Domain=.kodus.io for api.kodus.io + app.kodus.io in production', async () => {
            const r = await callSsoCallback({
                apiHost: 'api.kodus.io',
                frontendUrl: 'https://app.kodus.io',
                nodeEnv: 'production',
            });
            expect(r.cookieName).toBe('sso_handoff');
            expect(r.cookieOptions.domain).toBe('.kodus.io');
            expect(r.cookieOptions.secure).toBe(true);
            expect(r.cookieOptions.sameSite).toBe('lax');
            expect(r.redirectUrl).toBe('https://app.kodus.io/sso-callback');
        });
    });

    describe('self-hosted topology (Dmitry repro)', () => {
        it('sets Domain=.web.scorpion.co for the original Dmitry host shape in production', async () => {
            const r = await callSsoCallback({
                apiHost: 'kodus-api-dev.web.scorpion.co',
                frontendUrl: 'https://kodus-dev.web.scorpion.co',
                nodeEnv: 'production',
            });
            expect(r.cookieOptions.domain).toBe('.web.scorpion.co');
            expect(r.cookieOptions.secure).toBe(true);
            expect(r.redirectUrl).toBe(
                'https://kodus-dev.web.scorpion.co/sso-callback',
            );
        });

        it('does NOT regress to a hardcoded .kodus.io for non-kodus deployments', async () => {
            const r = await callSsoCallback({
                apiHost: 'kodus-api-dev.web.scorpion.co',
                frontendUrl: 'https://kodus-dev.web.scorpion.co',
                nodeEnv: 'production',
            });
            expect(r.cookieOptions.domain).not.toBe('.kodus.io');
        });
    });

    describe('apex topology', () => {
        it('handles api+frontend on the same apex domain', async () => {
            const r = await callSsoCallback({
                apiHost: 'kodus.io',
                frontendUrl: 'https://kodus.io',
                nodeEnv: 'production',
            });
            expect(r.cookieOptions.domain).toBe('.kodus.io');
        });
    });

    describe('public-suffix protection', () => {
        it('returns undefined Domain when only ".io" would be common', async () => {
            const r = await callSsoCallback({
                apiHost: 'api.kodus.io',
                frontendUrl: 'https://app.foo.io',
                nodeEnv: 'production',
            });
            expect(r.cookieOptions.domain).toBeUndefined();
        });

        it('returns undefined Domain when only ".com" would be common', async () => {
            const r = await callSsoCallback({
                apiHost: 'api.foo.com',
                frontendUrl: 'https://app.bar.com',
                nodeEnv: 'production',
            });
            expect(r.cookieOptions.domain).toBeUndefined();
        });
    });

    describe('no common parent', () => {
        it('returns undefined Domain when api and frontend share no DNS suffix', async () => {
            const r = await callSsoCallback({
                apiHost: 'api.foo.com',
                frontendUrl: 'https://app.bar.io',
                nodeEnv: 'production',
            });
            expect(r.cookieOptions.domain).toBeUndefined();
        });
    });

    describe('IP / numeric hosts', () => {
        it('returns undefined Domain for IPv4 hosts', async () => {
            const r = await callSsoCallback({
                apiHost: '192.168.1.10',
                frontendUrl: 'http://192.168.1.10',
                nodeEnv: 'production',
            });
            expect(r.cookieOptions.domain).toBeUndefined();
        });
    });

    describe('development mode', () => {
        it('omits Domain entirely (host-only cookie) and uses non-secure', async () => {
            const r = await callSsoCallback({
                apiHost: 'localhost',
                frontendUrl: 'http://localhost:3000',
                nodeEnv: 'development',
            });
            expect(r.cookieOptions.domain).toBeUndefined();
            expect(r.cookieOptions.secure).toBe(false);
        });
    });

    describe('cookie payload + flags', () => {
        it('serializes both tokens into the sso_handoff cookie value', async () => {
            const r = await callSsoCallback({
                apiHost: 'api.kodus.io',
                frontendUrl: 'https://app.kodus.io',
                nodeEnv: 'production',
            });
            const payload = JSON.parse(r.cookiePayload);
            expect(payload.accessToken).toBe('access-token-test');
            expect(payload.refreshToken).toBe('refresh-token-test');
        });

        it('keeps httpOnly=false (frontend reads cookie via JS)', async () => {
            const r = await callSsoCallback({
                apiHost: 'api.kodus.io',
                frontendUrl: 'https://app.kodus.io',
                nodeEnv: 'production',
            });
            expect(r.cookieOptions.httpOnly).toBe(false);
        });

        it('keeps a short maxAge (15s) on the handoff cookie', async () => {
            const r = await callSsoCallback({
                apiHost: 'api.kodus.io',
                frontendUrl: 'https://app.kodus.io',
                nodeEnv: 'production',
            });
            expect(r.cookieOptions.maxAge).toBe(15 * 1000);
        });
    });
});
