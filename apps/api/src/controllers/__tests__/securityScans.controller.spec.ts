import { ForbiddenException } from '@nestjs/common';

import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';

import { SecurityScansController } from '../securityScans.controller';

describe('SecurityScansController.start', () => {
    const setup = (allowed: string[]) => {
        const startSecurityScan = {
            execute: jest.fn(async () => ({ uuid: 'scan-1' })),
        };
        const authorizationService = {
            ensure: jest.fn(async ({ repoIds }: { repoIds: string[] }) => {
                if (!repoIds.every((id) => allowed.includes(id))) {
                    throw new ForbiddenException();
                }
            }),
        };
        const controller = new SecurityScansController(
            { user: { uuid: 'u-1', organization: { uuid: 'org-1' } } } as any,
            startSecurityScan as any,
            {} as any,
            {} as any,
            authorizationService as any,
            { isEnabledFor: jest.fn(async () => true) } as any,
        );
        return { controller, startSecurityScan, authorizationService };
    };

    it('authorizes the repository the scan runs on, and starts nothing for one the caller may not scan', async () => {
        const { controller, startSecurityScan, authorizationService } = setup([
            'repo-allowed',
        ]);

        await expect(
            controller.start({
                teamId: 't-1',
                repositoryId: 'repo-other',
                maxUsd: 5,
            } as any),
        ).rejects.toThrow(ForbiddenException);

        expect(authorizationService.ensure).toHaveBeenCalledWith(
            expect.objectContaining({ repoIds: ['repo-other'] }),
        );
        expect(startSecurityScan.execute).not.toHaveBeenCalled();
    });

    it('starts the scan of a repository the caller may scan, once authorized on it', async () => {
        const { controller, startSecurityScan, authorizationService } = setup([
            'repo-allowed',
        ]);

        await controller.start({
            teamId: 't-1',
            repositoryId: 'repo-allowed',
            maxUsd: 5,
        } as any);

        expect(authorizationService.ensure).toHaveBeenCalledWith(
            expect.objectContaining({ repoIds: ['repo-allowed'] }),
        );

        expect(startSecurityScan.execute).toHaveBeenCalledWith(
            expect.objectContaining({ repositoryId: 'repo-allowed' }),
        );
    });
});

describe('SecurityScansController.cancel', () => {
    const scan = {
        uuid: '507f1f77bcf86cd799439011',
        repository: { id: 'repo-allowed' },
    };

    const setup = (allowed: string[]) => {
        const getSecurityScans = {
            get: jest.fn(async () => scan),
            isInRepositoryScope: jest.fn(
                async (
                    _org: string,
                    current: { repository: { id: string } },
                    ids: string[] | undefined,
                ) => ids === undefined || ids.includes(current.repository.id),
            ),
        };
        const cancelSecurityScan = {
            execute: jest.fn(async () => ({ ...scan, status: 'cancelled' })),
        };
        const authorizationService = {
            ensure: jest.fn(async ({ repoIds }: { repoIds: string[] }) => {
                if (!repoIds.every((id) => allowed.includes(id))) {
                    throw new ForbiddenException();
                }
            }),
            getRepositoryScope: jest.fn(async () => allowed),
        };
        const controller = new SecurityScansController(
            { user: { uuid: 'u-1', organization: { uuid: 'org-1' } } } as any,
            {} as any,
            getSecurityScans as any,
            cancelSecurityScan as any,
            authorizationService as any,
            { isEnabledFor: jest.fn(async () => true) } as any,
        );
        return {
            controller,
            getSecurityScans,
            cancelSecurityScan,
            authorizationService,
        };
    };

    it('cancels a scan of a repository the caller may scan', async () => {
        const {
            controller,
            getSecurityScans,
            cancelSecurityScan,
            authorizationService,
        } = setup(['repo-allowed']);

        await controller.cancel(scan.uuid);

        expect(getSecurityScans.get).toHaveBeenCalledWith(
            'org-1',
            scan.uuid,
            undefined,
        );
        expect(authorizationService.getRepositoryScope).toHaveBeenCalledWith(
            expect.objectContaining({
                action: Action.Create,
                resource: ResourceType.SecurityScan,
            }),
        );
        expect(getSecurityScans.isInRepositoryScope).toHaveBeenCalledWith(
            'org-1',
            scan,
            ['repo-allowed'],
        );
        expect(authorizationService.ensure).toHaveBeenCalledWith(
            expect.objectContaining({
                action: Action.Create,
                resource: ResourceType.SecurityScan,
                repoIds: ['repo-allowed'],
            }),
        );
        expect(cancelSecurityScan.execute).toHaveBeenCalledWith({
            organizationId: 'org-1',
            scanId: scan.uuid,
        });
    });

    it('cancels nothing when the caller may not scan that repository', async () => {
        const { controller, cancelSecurityScan } = setup(['repo-other']);

        await expect(controller.cancel(scan.uuid)).rejects.toThrow(
            ForbiddenException,
        );
        expect(cancelSecurityScan.execute).not.toHaveBeenCalled();
    });

    it('cancels nothing when the resolved write set does not include the scan', async () => {
        const { controller, getSecurityScans, cancelSecurityScan } = setup([
            'repo-allowed',
        ]);
        getSecurityScans.isInRepositoryScope.mockResolvedValueOnce(false);

        await expect(controller.cancel(scan.uuid)).rejects.toThrow(
            ForbiddenException,
        );
        expect(cancelSecurityScan.execute).not.toHaveBeenCalled();
    });
});
