import { PrDecisionRecorderService } from './pr-decision-recorder.service';

describe('PrDecisionRecorderService', () => {
    const INPUT = {
        organizationId: 'org-1',
        repositoryId: 'repo-1',
        prNumber: 142,
        headSha: 'a1b2c3d4e5f6',
        baseSha: 'e5f6a7b8c9d0',
        decision: 'approve' as const,
        reason: "Policy 'docs/**' matched.",
        occurredAt: '2026-11-20T13:50:00.000Z',
    };

    function buildService(over: { set?: jest.Mock } = {}) {
        const pullRequests = {
            setApprovalReasonDeliveryFailure:
                over.set ?? jest.fn().mockResolvedValue(true),
        };
        const service = new PrDecisionRecorderService(pullRequests as any);
        return { service, pullRequests };
    }

    it('writes one row with the decision, reason and snapshot', async () => {
        const { service, pullRequests } = buildService();

        await service.record(INPUT);

        expect(
            pullRequests.setApprovalReasonDeliveryFailure,
        ).toHaveBeenCalledTimes(1);
        const [orgId, repoId, prNumber, failure] =
            pullRequests.setApprovalReasonDeliveryFailure.mock.calls[0];
        expect(orgId).toBe('org-1');
        expect(repoId).toBe('repo-1');
        expect(prNumber).toBe(142);
        expect(failure).toEqual({
            decision: 'approve',
            reason: "Policy 'docs/**' matched.",
            occurredAt: '2026-11-20T13:50:00.000Z',
            reviewedHeadSha: 'a1b2c3d4e5f6',
            reviewedBaseSha: 'e5f6a7b8c9d0',
        });
    });

    it('passes no guard when the decision carries no notAfter', async () => {
        const { service, pullRequests } = buildService();

        await service.record(INPUT);

        expect(
            pullRequests.setApprovalReasonDeliveryFailure.mock.calls[0][4],
        ).toBeUndefined();
    });

    it('passes the notAfter guard for a hold', async () => {
        const { service, pullRequests } = buildService();

        await service.record({
            ...INPUT,
            decision: 'hold',
            notAfter: '2026-11-20T13:55:00.000Z',
        });

        expect(
            pullRequests.setApprovalReasonDeliveryFailure.mock.calls[0][4],
        ).toEqual({ notAfter: '2026-11-20T13:55:00.000Z' });
    });

    it('swallows a failed write — the decision is already committed and projected', async () => {
        const { service } = buildService({
            set: jest.fn().mockRejectedValue(new Error('mongo down')),
        });

        await expect(service.record(INPUT)).resolves.toBeUndefined();
    });

    it('swallows a rejected persistence (the guard rejects a superseded notice)', async () => {
        const { service } = buildService({
            set: jest.fn().mockResolvedValue(false),
        });

        await expect(service.record(INPUT)).resolves.toBeUndefined();
    });
});
