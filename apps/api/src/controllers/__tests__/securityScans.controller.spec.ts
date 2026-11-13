import { ForbiddenException } from '@nestjs/common';

import { SecurityScansController } from '../securityScans.controller';

describe('SecurityScansController.start', () => {
    const setup = (allowed: string[]) => {
        const startSecurityScan = { execute: jest.fn(async () => ({ uuid: 'scan-1' })) };
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
            authorizationService as any,
            { isEnabledFor: jest.fn(async () => true) } as any,
        );
        return { controller, startSecurityScan, authorizationService };
    };

    it('authorizes the repository the scan runs on, and starts nothing for one the caller may not scan', async () => {
        const { controller, startSecurityScan, authorizationService } = setup(['repo-allowed']);

        await expect(
            controller.start({ teamId: 't-1', repositoryId: 'repo-other', maxUsd: 5 } as any),
        ).rejects.toThrow(ForbiddenException);

        expect(authorizationService.ensure).toHaveBeenCalledWith(
            expect.objectContaining({ repoIds: ['repo-other'] }),
        );
        expect(startSecurityScan.execute).not.toHaveBeenCalled();
    });

    it('starts the scan of a repository the caller may scan, once authorized on it', async () => {
        const { controller, startSecurityScan, authorizationService } = setup(['repo-allowed']);

        await controller.start({ teamId: 't-1', repositoryId: 'repo-allowed', maxUsd: 5 } as any);

        expect(authorizationService.ensure).toHaveBeenCalledWith(
            expect.objectContaining({ repoIds: ['repo-allowed'] }),
        );

        expect(startSecurityScan.execute).toHaveBeenCalledWith(
            expect.objectContaining({ repositoryId: 'repo-allowed' }),
        );
    });
});
