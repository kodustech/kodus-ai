import { ForbiddenException, NotFoundException } from '@nestjs/common';

import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';

import { SecurityScansController } from '../securityScans.controller';
import { SecurityScanSchedulesUseCase } from '@libs/security-scan/application/security-scan-schedules.use-case';

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
            {} as any,
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

    const setup = (allowed: string[] | null) => {
        const getSecurityScans = {
            get: jest.fn(
                async (
                    _org: string,
                    _id: string,
                    ids: string[] | undefined,
                ) => {
                    if (ids && !ids.includes(scan.repository.id)) {
                        throw new NotFoundException('Security scan not found.');
                    }
                    return scan;
                },
            ),
        };
        const cancelSecurityScan = {
            execute: jest.fn(async () => ({ ...scan, status: 'cancelled' })),
        };
        const authorizationService = {
            getRepositoryScope: jest.fn(async () => allowed),
        };
        const controller = new SecurityScansController(
            { user: { uuid: 'u-1', organization: { uuid: 'org-1' } } } as any,
            {} as any,
            getSecurityScans as any,
            cancelSecurityScan as any,
            authorizationService as any,
            { isEnabledFor: jest.fn(async () => true) } as any,
            {} as any,
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

        expect(authorizationService.getRepositoryScope).toHaveBeenCalledWith(
            expect.objectContaining({
                action: Action.Create,
                resource: ResourceType.SecurityScan,
            }),
        );
        expect(getSecurityScans.get).toHaveBeenCalledWith('org-1', scan.uuid, [
            'repo-allowed',
        ]);
        expect(cancelSecurityScan.execute).toHaveBeenCalledWith({
            organizationId: 'org-1',
            scanId: scan.uuid,
        });
    });

    it('loads the scan organization-wide for an organization-wide grant', async () => {
        const { controller, getSecurityScans, cancelSecurityScan } =
            setup(null);

        await controller.cancel(scan.uuid);

        expect(getSecurityScans.get).toHaveBeenCalledWith(
            'org-1',
            scan.uuid,
            undefined,
        );
        expect(cancelSecurityScan.execute).toHaveBeenCalled();
    });

    it('answers not found, cancelling nothing, when the caller may not scan that repository', async () => {
        const { controller, cancelSecurityScan } = setup(['repo-other']);

        await expect(controller.cancel(scan.uuid)).rejects.toThrow(
            NotFoundException,
        );
        expect(cancelSecurityScan.execute).not.toHaveBeenCalled();
    });
});

describe('SecurityScansController — reads by a member granted some Git connections', () => {
    // The guard lets a connection-scoped read through only to a handler marked
    // as narrowing it itself.
    it.each(['list', 'get', 'listSchedules'] as const)(
        '%s is marked as narrowing itself',
        (handler) => {
            expect(
                Reflect.getMetadata(
                    'applies_connection_scope',
                    SecurityScansController.prototype[handler],
                ),
            ).toBe(true);
        },
    );

    it('lists only the schedules of the repositories the caller sees', async () => {
        const key = { platform: 'GITHUB', host: 'github.com' };
        const stored = [
            { uuid: 'granted', repository: { ...key, id: 'repo-gh' } },
            { uuid: 'ungranted', repository: { ...key, id: 'repo-gl' } },
        ];
        const listSchedules = new SecurityScanSchedulesUseCase(
            { list: jest.fn().mockResolvedValue(stored) } as any,
            {} as any,
            {} as any,
            {
                repositoryScope: jest.fn(async (_org: string, ids: string[]) =>
                    ids.map((id) => ({ ...key, id })),
                ),
            } as any,
        );
        const controller = new SecurityScansController(
            { user: { organization: { uuid: 'org-1' } } } as any,
            {} as any,
            {} as any,
            {} as any,
            {
                getRepositoryScope: jest.fn().mockResolvedValue(['repo-gh']),
            } as any,
            { isEnabledFor: jest.fn().mockResolvedValue(true) } as any,
            listSchedules,
        );

        await expect(controller.listSchedules()).resolves.toEqual([stored[0]]);
    });
});
