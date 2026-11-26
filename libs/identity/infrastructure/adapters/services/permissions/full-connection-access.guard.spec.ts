import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
    BillingManagersReadEveryConnection,
    FullConnectionAccessGuard,
} from './full-connection-access.guard';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const contextFor = (controller: object = class {}) =>
    ({
        getHandler: () => () => undefined,
        getClass: () => controller,
        switchToHttp: () => ({
            getRequest: () => ({
                user: {
                    uuid: 'u-1',
                    role: 'billing_manager',
                    organization: { uuid: 'org-1' },
                },
                route: { path: '/usage/tokens/summary' },
            }),
        }),
    }) as any;

describe('FullConnectionAccessGuard', () => {
    it('lets through a member who reads every Git connection', async () => {
        const guard = new FullConnectionAccessGuard(
            {
                restrictionFor: jest.fn().mockResolvedValue(null),
            } as any,
            new Reflector(),
        );

        await expect(guard.canActivate(contextFor())).resolves.toBe(true);
    });

    it('refuses an organization-wide read to a member granted only some connections', async () => {
        const guard = new FullConnectionAccessGuard(
            {
                restrictionFor: jest.fn().mockResolvedValue({
                    connectionIds: new Set(['gh-a']),
                    repositoryIds: new Set(),
                    allowsRepository: () => false,
                }),
            } as any,
            new Reflector(),
        );

        await expect(guard.canActivate(contextFor())).rejects.toThrow(
            ForbiddenException,
        );
    });

    it('lets a billing manager read token usage across every connection, as before connections existed', async () => {
        @BillingManagersReadEveryConnection()
        class TokenUsage {}
        const guard = new FullConnectionAccessGuard(
            {
                restrictionFor: jest.fn().mockResolvedValue({
                    connectionIds: new Set(['gh-a']),
                    repositoryIds: new Set(),
                    allowsRepository: () => false,
                }),
            } as any,
            new Reflector(),
        );

        await expect(guard.canActivate(contextFor(TokenUsage))).resolves.toBe(
            true,
        );
    });
});
