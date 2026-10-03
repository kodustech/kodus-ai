import { NotFoundException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';

import { PERMISSIONS_SERVICE_TOKEN } from '@libs/identity/domain/permissions/contracts/permissions.service.contract';
import { USER_SERVICE_TOKEN } from '@libs/identity/domain/user/contracts/user.service.contract';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';

import { AssignReposUseCase } from './assign-repos.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('AssignReposUseCase — organization isolation', () => {
    const USERS = [
        {
            uuid: 'user-acme',
            email: 'dev@acme.com',
            organization: { uuid: 'org-acme' },
        },
        {
            uuid: 'user-globex',
            email: 'dev@globex.com',
            organization: { uuid: 'org-globex' },
        },
    ];

    // Behaves like the repository: `uuid` always narrows, and an
    // `organization` filter narrows further.
    const findUser = (filter: {
        uuid?: string;
        organization?: { uuid?: string };
    }) =>
        Promise.resolve(
            USERS.find(
                (u) =>
                    u.uuid === filter.uuid &&
                    (!filter.organization?.uuid ||
                        u.organization.uuid === filter.organization.uuid),
            ),
        );

    const build = async () => {
        const users = { findOne: jest.fn(findUser) };
        const permissions = {
            findOne: jest.fn().mockResolvedValue({
                uuid: 'perm-1',
                permissions: { assignedRepositoryIds: [] },
            }),
            create: jest.fn(),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const integrationConfigs = {
            findOne: jest.fn().mockResolvedValue({
                configValue: [{ id: 'repo-1', name: 'storefront' }],
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AssignReposUseCase,
                { provide: USER_SERVICE_TOKEN, useValue: users },
                { provide: PERMISSIONS_SERVICE_TOKEN, useValue: permissions },
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: integrationConfigs,
                },
                { provide: EventEmitter2, useValue: { emit: jest.fn() } },
                {
                    provide: REQUEST,
                    useValue: {
                        user: {
                            uuid: 'owner-acme',
                            email: 'owner@acme.com',
                            organization: { uuid: 'org-acme' },
                        },
                    },
                },
            ],
        }).compile();

        return {
            useCase: module.get(AssignReposUseCase),
            permissions,
            integrationConfigs,
        };
    };

    it('does not change the repositories of a user of another organization', async () => {
        const { useCase, permissions } = await build();

        await expect(
            useCase.execute({
                userId: 'user-globex',
                repoIds: ['repo-1'],
                teamId: 'team-globex',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(permissions.create).not.toHaveBeenCalled();
        expect(permissions.update).not.toHaveBeenCalled();
    });

    it('still assigns repositories to a user of the caller organization', async () => {
        const { useCase, permissions, integrationConfigs } = await build();

        await expect(
            useCase.execute({
                userId: 'user-acme',
                repoIds: ['repo-1'],
                teamId: 'team-acme',
            }),
        ).resolves.toEqual(['repo-1']);

        expect(integrationConfigs.findOne).toHaveBeenCalledWith(
            expect.objectContaining({
                integration: expect.objectContaining({
                    organization: { uuid: 'org-acme' },
                    team: { uuid: 'team-acme' },
                }),
            }),
        );
        expect(permissions.update).toHaveBeenCalledWith('perm-1', {
            permissions: { assignedRepositoryIds: ['repo-1'] },
        });
    });
});
