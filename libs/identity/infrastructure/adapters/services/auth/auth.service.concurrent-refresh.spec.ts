import { AuthProvider } from '@libs/core/domain/enums';

import { AuthService } from './auth.service';

const logged: Array<{ level: string; entry: unknown }> = [];
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: (entry: unknown) => logged.push({ level: 'log', entry }),
        debug: (entry: unknown) => logged.push({ level: 'debug', entry }),
        warn: (entry: unknown) => logged.push({ level: 'warn', entry }),
        error: (entry: unknown) => logged.push({ level: 'error', entry }),
    }),
}));

/**
 * Two refreshes of the same token in the same second sign the same JWT (no
 * jti, iat in seconds), so the second INSERT hits the unique constraint on
 * "refreshToken" for a token that is already stored.
 */
describe('AuthService.refreshToken, concurrent refresh of the same token', () => {
    const NEW_REFRESH_TOKEN = 'header.payload-new.signature';

    const makeService = (saveRefreshToken: jest.Mock) =>
        new AuthService(
            {
                get: () => ({
                    secret: 's',
                    refreshSecret: 'r',
                    expiresIn: '15m',
                    refreshExpiresIn: '7d',
                }),
            } as any,
            {
                verify: () => ({ sub: 'user-1' }),
                signAsync: async () => NEW_REFRESH_TOKEN,
            } as any,
            {
                findRefreshToken: async () => ({
                    used: false,
                    authProvider: AuthProvider.GITHUB,
                    authDetails: {},
                }),
                updateRefreshToken: async () => undefined,
                saveRefreshToken,
            } as any,
            {
                findOne: async () => ({
                    uuid: 'user-1',
                    organization: { uuid: 'org-1' },
                }),
            } as any,
            { findOne: async () => null } as any,
        );

    beforeEach(() => {
        logged.length = 0;
    });

    it('does not report the session as lost when the identical token was already stored by the twin request', async () => {
        const duplicate = Object.assign(
            new Error(
                'duplicate key value violates unique constraint "UQ_5fb5d6abb950a839551fe3c5de9"',
            ),
            {
                code: '23505',
                constraint: 'UQ_5fb5d6abb950a839551fe3c5de9',
                parameters: ['uuid', NEW_REFRESH_TOKEN],
            },
        );
        const service = makeService(jest.fn().mockRejectedValue(duplicate));

        await expect(service.refreshToken('old-token')).resolves.toEqual(
            expect.objectContaining({ refreshToken: NEW_REFRESH_TOKEN }),
        );

        expect(logged.filter((l) => l.level === 'error')).toEqual([]);
        expect(JSON.stringify(logged)).not.toContain(NEW_REFRESH_TOKEN);
    });

    it('still reports any other failure to store the token', async () => {
        const service = makeService(
            jest.fn().mockRejectedValue(new Error('connection terminated')),
        );

        await service.refreshToken('old-token');

        expect(logged.filter((l) => l.level === 'error')).toHaveLength(1);
    });
});
