import { SecurityScanStatus } from '../domain/security-scan.types';
import {
    CancelSecurityScanUseCase,
    SCAN_NOT_CANCELLABLE_MESSAGE,
} from './cancel-security-scan.use-case';

const id = '507f1f77bcf86cd799439011';

function setup(
    scan: Record<string, unknown> | null = {
        uuid: id,
        organizationId: 'org-1',
        status: SecurityScanStatus.QUEUED,
    },
) {
    const scans = {
        findById: jest.fn(async () => scan),
        update: jest.fn(async (_uuid: string, changes: any) =>
            scan ? { ...scan, ...changes } : null,
        ),
    };
    const jobs = {
        findMany: jest.fn(async () => ({ data: [{ id: 'job-1' }] })),
        update: jest.fn(async () => undefined),
    };
    return {
        scans,
        jobs,
        useCase: new CancelSecurityScanUseCase(scans as any, jobs as any),
    };
}

describe('CancelSecurityScanUseCase', () => {
    it('cancels a queued scan and its pending jobs, freeing the repository', async () => {
        const { useCase, scans, jobs } = setup();

        const result = await useCase.execute({
            organizationId: 'org-1',
            scanId: id,
        });

        expect(result.status).toBe(SecurityScanStatus.CANCELLED);
        expect(result.finishedAt).toBeTruthy();
        expect(scans.update).toHaveBeenCalledWith(
            id,
            expect.objectContaining({ status: SecurityScanStatus.CANCELLED }),
            undefined,
            {
                statuses: [
                    SecurityScanStatus.QUEUED,
                    SecurityScanStatus.RUNNING,
                ],
            },
        );
        expect(jobs.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ correlationId: id, status: 'PENDING' }),
        );
        expect(jobs.update).toHaveBeenCalledWith(
            'job-1',
            expect.objectContaining({ status: 'CANCELLED' }),
        );
    });

    it('cancels a running scan the same way', async () => {
        const { useCase, scans } = setup({
            uuid: id,
            organizationId: 'org-1',
            status: SecurityScanStatus.RUNNING,
        });

        await expect(
            useCase.execute({ organizationId: 'org-1', scanId: id }),
        ).resolves.toEqual(
            expect.objectContaining({ status: SecurityScanStatus.CANCELLED }),
        );
        expect(scans.update).toHaveBeenCalled();
    });

    it('refuses a scan that already finished', async () => {
        const { useCase, scans, jobs } = setup({
            uuid: id,
            organizationId: 'org-1',
            status: SecurityScanStatus.COMPLETED,
        });

        await expect(
            useCase.execute({ organizationId: 'org-1', scanId: id }),
        ).rejects.toThrow(SCAN_NOT_CANCELLABLE_MESSAGE);
        expect(scans.update).not.toHaveBeenCalled();
        expect(jobs.findMany).not.toHaveBeenCalled();
    });

    it('does not cancel a scan of another organization', async () => {
        const { useCase, scans } = setup({
            uuid: id,
            organizationId: 'other-org',
            status: SecurityScanStatus.QUEUED,
        });

        await expect(
            useCase.execute({ organizationId: 'org-1', scanId: id }),
        ).rejects.toThrow('Security scan not found');
        expect(scans.update).not.toHaveBeenCalled();
    });

    it('treats an invalid id as not found', async () => {
        const { useCase, scans } = setup();

        await expect(
            useCase.execute({ organizationId: 'org-1', scanId: 'not-an-id' }),
        ).rejects.toThrow('Security scan not found');
        expect(scans.findById).not.toHaveBeenCalled();
    });

    it('still cancels the scan when marking its jobs fails', async () => {
        const { useCase, jobs } = setup();
        jobs.findMany.mockRejectedValue(new Error('postgres down'));

        await expect(
            useCase.execute({ organizationId: 'org-1', scanId: id }),
        ).resolves.toEqual(
            expect.objectContaining({ status: SecurityScanStatus.CANCELLED }),
        );
    });
});
