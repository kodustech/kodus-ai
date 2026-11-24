import type { HostContext } from '@libs/code-review/domain/risk/pr-decision-applier';

import { PrDecisionHostDriverService } from './pr-decision-host-driver.service';

describe('PrDecisionHostDriverService', () => {
    const HOST = {
        repoId: 'repo-1',
        prNumber: 142,
        headSha: 'a1b2c3d4e5f6',
    };

    const CONTEXT: HostContext = {
        organizationAndTeamData: {
            organizationId: 'org-1',
            teamId: 'team-1',
        },
        repository: { id: 'repo-1', name: 'repo' },
    };

    function buildService(
        over: {
            dismiss?: jest.Mock;
            approve?: jest.Mock;
            comment?: jest.Mock;
        } = {},
    ) {
        const codeManagement = {
            dismissOwnPullRequestApprovals:
                over.dismiss ?? jest.fn().mockResolvedValue(0),
            approvePullRequest: over.approve ?? jest.fn().mockResolvedValue({}),
        };
        const commentManager = {
            postApprovalReason:
                over.comment ?? jest.fn().mockResolvedValue(undefined),
        };
        const service = new PrDecisionHostDriverService(
            codeManagement as any,
            commentManager as any,
        );
        return { service, codeManagement, commentManager };
    }

    describe('dismissIfNeeded', () => {
        it('calls the provider dismissal with the context it was given', async () => {
            const { service, codeManagement } = buildService();

            const result = await service.dismissIfNeeded(HOST, CONTEXT);

            expect(result.status).toBe('ok');
            expect(
                codeManagement.dismissOwnPullRequestApprovals,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    prNumber: 142,
                    repository: { id: 'repo-1', name: 'repo' },
                }),
            );
        });

        it('writes to the repository ITS context carries', async () => {
            // The reconciler may run for several PRs concurrently in one
            // worker process, so the driver must not hold the repository.
            const { service, codeManagement } = buildService();
            const other: HostContext = {
                ...CONTEXT,
                repository: { id: 'repo-OTHER', name: 'other' },
            };

            await service.dismissIfNeeded(HOST, other);

            expect(
                codeManagement.dismissOwnPullRequestApprovals.mock.calls[0][0]
                    .repository,
            ).toEqual({ id: 'repo-OTHER', name: 'other' });
        });

        it('is retry when the provider fails transiently', async () => {
            const { service } = buildService({
                dismiss: jest.fn().mockRejectedValue(new Error('timeout')),
            });

            const result = await service.dismissIfNeeded(HOST, CONTEXT);

            expect(result.status).toBe('retry');
        });
    });

    describe('approve', () => {
        it('passes the head SHA so the provider reviews the right commit', async () => {
            const { service, codeManagement } = buildService();

            const result = await service.approve(HOST, CONTEXT);

            expect(result.status).toBe('ok');
            expect(codeManagement.approvePullRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    prNumber: 142,
                    headSha: 'a1b2c3d4e5f6',
                }),
            );
        });

        it('is retry when the provider fails transiently', async () => {
            const { service } = buildService({
                approve: jest
                    .fn()
                    .mockRejectedValue(new Error('502 bad gateway')),
            });

            const result = await service.approve(HOST, CONTEXT);

            expect(result.status).toBe('retry');
            expect(result.status === 'ok' ? '' : result.reason).toMatch(/502/);
        });

        it('is fatal on a 403 — retrying would fail identically', async () => {
            const error: any = new Error('forbidden');
            error.status = 403;
            const { service } = buildService({
                approve: jest.fn().mockRejectedValue(error),
            });

            expect((await service.approve(HOST, CONTEXT)).status).toBe('fatal');
        });

        it('is fatal on a 401', async () => {
            const error: any = new Error('unauthorized');
            error.status = 401;
            const { service } = buildService({
                approve: jest.fn().mockRejectedValue(error),
            });

            expect((await service.approve(HOST, CONTEXT)).status).toBe('fatal');
        });

        it('is fatal on a 404 — the PR is gone', async () => {
            const error: any = new Error('not found');
            error.status = 404;
            const { service } = buildService({
                approve: jest.fn().mockRejectedValue(error),
            });

            expect((await service.approve(HOST, CONTEXT)).status).toBe('fatal');
        });

        it('is fatal when the message says forbidden but there is no status', async () => {
            const { service } = buildService({
                approve: jest.fn().mockRejectedValue(new Error('Forbidden')),
            });

            expect((await service.approve(HOST, CONTEXT)).status).toBe('fatal');
        });

        it('is retry for a network error', async () => {
            const { service } = buildService({
                approve: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
            });

            expect((await service.approve(HOST, CONTEXT)).status).toBe('retry');
        });
    });

    describe('upsertDecisionComment', () => {
        it('posts the approve comment with the kind and reason', async () => {
            const { service, commentManager } = buildService();

            const result = await service.upsertDecisionComment(
                HOST,
                { kind: 'approve', reason: "Policy 'docs/**' matched." },
                CONTEXT,
            );

            expect(result.status).toBe('ok');
            expect(commentManager.postApprovalReason).toHaveBeenCalledWith(
                CONTEXT.organizationAndTeamData,
                142,
                { id: 'repo-1', name: 'repo' },
                "Policy 'docs/**' matched.",
                'approve',
            );
        });

        it('posts the hold comment with the kind and reason', async () => {
            const { service, commentManager } = buildService();

            await service.upsertDecisionComment(
                HOST,
                { kind: 'hold', reason: 'L2 risk found: auth path compromise' },
                CONTEXT,
            );

            expect(commentManager.postApprovalReason).toHaveBeenCalledWith(
                expect.anything(),
                142,
                expect.anything(),
                'L2 risk found: auth path compromise',
                'hold',
            );
        });

        it('is retry when the comment write fails transiently', async () => {
            const { service } = buildService({
                comment: jest.fn().mockRejectedValue(new Error('timeout')),
            });

            expect(
                (
                    await service.upsertDecisionComment(
                        HOST,
                        { kind: 'approve', reason: 'r' },
                        CONTEXT,
                    )
                ).status,
            ).toBe('retry');
        });
    });

    describe('idempotency', () => {
        it('repeated calls produce the same calls — the applier may retry the whole sequence', async () => {
            const { service, codeManagement, commentManager } = buildService();

            await service.dismissIfNeeded(HOST, CONTEXT);
            await service.approve(HOST, CONTEXT);
            await service.upsertDecisionComment(
                HOST,
                { kind: 'approve', reason: 'r' },
                CONTEXT,
            );
            await service.dismissIfNeeded(HOST, CONTEXT);
            await service.approve(HOST, CONTEXT);
            await service.upsertDecisionComment(
                HOST,
                { kind: 'approve', reason: 'r' },
                CONTEXT,
            );

            // The provider calls are the same shape each time; the comment
            // manager's own upsert (find-then-update-or-create) is what makes
            // the repeat safe on the host.
            expect(codeManagement.approvePullRequest).toHaveBeenCalledTimes(2);
            expect(commentManager.postApprovalReason).toHaveBeenCalledTimes(2);
            expect(codeManagement.approvePullRequest.mock.calls[0]).toEqual(
                codeManagement.approvePullRequest.mock.calls[1],
            );
        });
    });
});
