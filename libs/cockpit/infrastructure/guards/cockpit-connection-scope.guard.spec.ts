import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
    CockpitConnectionScopeGuard,
    COCKPIT_ORGANIZATION_WIDE,
} from './cockpit-connection-scope.guard';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const contextFor = (
    query: Record<string, unknown>,
    metadata: Record<string, unknown> = {},
) => {
    const handler = () => undefined;
    Reflect.defineMetadata(
        COCKPIT_ORGANIZATION_WIDE,
        metadata[COCKPIT_ORGANIZATION_WIDE],
        handler,
    );
    return {
        getHandler: () => handler,
        getClass: () => class {},
        switchToHttp: () => ({
            getRequest: () => ({
                user: {
                    uuid: 'u-1',
                    role: 'contributor',
                    organization: { uuid: 'org-1' },
                },
                query,
            }),
        }),
    } as any;
};

const restricted = {
    connectionIds: new Set(['gh-a']),
    repositoryIds: new Set(['7']),
    allowsRepository: ({ name }: { name?: unknown }) => name === 'acme/api',
};

describe('CockpitConnectionScopeGuard', () => {
    const build = (restriction: unknown) =>
        new CockpitConnectionScopeGuard(new Reflector(), {
            restrictionFor: jest.fn().mockResolvedValue(restriction),
        } as any);

    it('lets an owner or a member granted every connection read the whole organization', async () => {
        await expect(build(null).canActivate(contextFor({}))).resolves.toBe(
            true,
        );
    });

    it('lets a partially granted member read a repository of a granted connection', async () => {
        await expect(
            build(restricted).canActivate(
                contextFor({ repository: 'acme/api' }),
            ),
        ).resolves.toBe(true);
    });

    it('refuses that member the whole organization, or a repository of another connection', async () => {
        await expect(
            build(restricted).canActivate(contextFor({})),
        ).rejects.toThrow(ForbiddenException);
        await expect(
            build(restricted).canActivate(
                contextFor({ repository: 'group/other' }),
            ),
        ).rejects.toThrow(ForbiddenException);
    });

    it('refuses that member a read that only exists for the whole organization', async () => {
        await expect(
            build(restricted).canActivate(
                contextFor(
                    { repository: 'acme/api' },
                    { [COCKPIT_ORGANIZATION_WIDE]: true },
                ),
            ),
        ).rejects.toThrow(ForbiddenException);
    });
});
