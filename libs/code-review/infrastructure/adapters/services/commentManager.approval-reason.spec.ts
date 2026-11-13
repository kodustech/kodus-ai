import { CommentManagerService } from './commentManager.service';
import {
    APPROVAL_REASON_WRITE_TIMEOUT_MS,
    formatApprovalReasonComment,
} from '@libs/code-review/infrastructure/approval/approval-reason-comment';

it('updates the existing approval reason after a review hold', async () => {
    const codeManagement = {
        getAllCommentsInPullRequest: jest.fn().mockResolvedValue([
            {
                id: 42,
                threadId: 99,
                body: formatApprovalReasonComment('hold', 'Previous reason'),
            },
        ]),
        updateIssueComment: jest.fn().mockResolvedValue(undefined),
        createIssueComment: jest.fn().mockResolvedValue(undefined),
    };
    const pullRequests = { setApprovalReasonDeliveryFailure: jest.fn() };
    const service = new CommentManagerService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        codeManagement as any,
        pullRequests as any,
    );

    await service.postApprovalReason(
        { organizationId: 'org', teamId: 'team' },
        12,
        { id: 'repo', name: 'api' },
        'Current reason',
        'hold',
    );

    expect(codeManagement.updateIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({
            commentId: 42,
            threadId: 99,
            body: formatApprovalReasonComment('hold', 'Current reason'),
        }),
    );
    expect(codeManagement.createIssueComment).not.toHaveBeenCalled();
    expect(codeManagement.getAllCommentsInPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ failOnError: true }),
    );
    expect(pullRequests.setApprovalReasonDeliveryFailure).toHaveBeenCalledWith(
        'org',
        'repo',
        12,
        null,
        { notAfter: expect.any(String) },
    );
});

it('clears a stale delivery warning when the approval comment already matches', async () => {
    const body = formatApprovalReasonComment('hold', 'Current reason');
    const codeManagement = {
        getAllCommentsInPullRequest: jest
            .fn()
            .mockResolvedValue([{ id: 42, body }]),
        updateIssueComment: jest.fn(),
        createIssueComment: jest.fn(),
    };
    const pullRequests = { setApprovalReasonDeliveryFailure: jest.fn() };
    const service = new CommentManagerService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        codeManagement as any,
        pullRequests as any,
    );

    await service.postApprovalReason(
        { organizationId: 'org', teamId: 'team' },
        12,
        { id: 'repo', name: 'api' },
        'Current reason',
        'hold',
    );

    expect(codeManagement.updateIssueComment).not.toHaveBeenCalled();
    expect(codeManagement.createIssueComment).not.toHaveBeenCalled();
    expect(pullRequests.setApprovalReasonDeliveryFailure).toHaveBeenCalledWith(
        'org',
        'repo',
        12,
        null,
        { notAfter: expect.any(String) },
    );
});

it('does not create an approval reason when the comment lookup fails', async () => {
    const codeManagement = {
        getAllCommentsInPullRequest: jest.fn().mockResolvedValue(null),
        createIssueComment: jest.fn(),
    };
    const pullRequests = { setApprovalReasonDeliveryFailure: jest.fn() };
    const service = new CommentManagerService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        codeManagement as any,
        pullRequests as any,
    );

    await expect(
        service.postApprovalReason(
            { organizationId: 'org', teamId: 'team' },
            12,
            { id: 'repo', name: 'api' },
            'Current reason',
            'hold',
        ),
    ).rejects.toThrow('Approval reason comment lookup returned no result');
    expect(codeManagement.createIssueComment).not.toHaveBeenCalled();
    expect(
        pullRequests.setApprovalReasonDeliveryFailure,
    ).not.toHaveBeenCalled();
});

it('replaces a previous hold with the completed approval reason', async () => {
    const codeManagement = {
        getAllCommentsInPullRequest: jest.fn().mockResolvedValue([
            {
                id: 42,
                body: formatApprovalReasonComment('hold', 'Old risk'),
            },
        ]),
        updateIssueComment: jest.fn().mockResolvedValue(undefined),
        createIssueComment: jest.fn().mockResolvedValue(undefined),
    };
    const service = new CommentManagerService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        codeManagement as any,
        { setApprovalReasonDeliveryFailure: jest.fn() } as any,
    );

    await service.postApprovalReason(
        { organizationId: 'org', teamId: 'team' },
        12,
        { id: 'repo', name: 'api' },
        'Clean review',
        'approve',
    );

    expect(codeManagement.updateIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({
            commentId: 42,
            body: formatApprovalReasonComment('approve', 'Clean review'),
        }),
    );
    expect(codeManagement.createIssueComment).not.toHaveBeenCalled();
});

it('uses a numeric fallback ID when the provider supplies a string ID', async () => {
    const codeManagement = {
        getAllCommentsInPullRequest: jest.fn().mockResolvedValue([
            {
                id: 'opaque-id',
                note_id: 42,
                body: formatApprovalReasonComment('hold', 'Previous reason'),
            },
        ]),
        updateIssueComment: jest.fn().mockResolvedValue(undefined),
        createIssueComment: jest.fn().mockResolvedValue(undefined),
    };
    const service = new CommentManagerService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        codeManagement as any,
        { setApprovalReasonDeliveryFailure: jest.fn() } as any,
    );

    await service.postApprovalReason(
        { organizationId: 'org', teamId: 'team' },
        12,
        { id: 'repo', name: 'api' },
        'Current reason',
        'hold',
    );

    expect(codeManagement.updateIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({ commentId: 42 }),
    );
    expect(codeManagement.createIssueComment).not.toHaveBeenCalled();
});

it('bounds a stalled hold-comment write', async () => {
    jest.useFakeTimers();
    try {
        const codeManagement = {
            getAllCommentsInPullRequest: jest.fn().mockResolvedValue([]),
            createIssueComment: jest
                .fn()
                .mockReturnValue(new Promise(() => {})),
        };
        const service = new CommentManagerService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            codeManagement as any,
            { setApprovalReasonDeliveryFailure: jest.fn() } as any,
        );
        const posting = service.postApprovalReason(
            { organizationId: 'org', teamId: 'team' },
            12,
            { id: 'repo', name: 'api' },
            'Current reason',
            'hold',
        );
        const outcome = expect(posting).rejects.toThrow(
            `approval hold comment create org=org team=team repo=repo pr=12 bounded timeout after ${APPROVAL_REASON_WRITE_TIMEOUT_MS}ms`,
        );
        await jest.advanceTimersByTimeAsync(APPROVAL_REASON_WRITE_TIMEOUT_MS);
        await outcome;
    } finally {
        jest.useRealTimers();
    }
});

// The write that timed out at 15s in production landed a second later (#2534).
it('records a hold-comment write that waits 60s in the provider queue as delivered', async () => {
    jest.useFakeTimers();
    try {
        const codeManagement = {
            getAllCommentsInPullRequest: jest.fn().mockResolvedValue([]),
            createIssueComment: jest
                .fn()
                .mockReturnValue(
                    new Promise((resolve) =>
                        setTimeout(() => resolve({ id: 7 }), 60_000),
                    ),
                ),
        };
        const pullRequests = { setApprovalReasonDeliveryFailure: jest.fn() };
        const service = new CommentManagerService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            codeManagement as any,
            pullRequests as any,
        );
        const posting = service.postApprovalReason(
            { organizationId: 'org', teamId: 'team' },
            12,
            { id: 'repo', name: 'api' },
            'Current reason',
            'hold',
        );
        await jest.advanceTimersByTimeAsync(60_000);
        await expect(posting).resolves.toBeUndefined();
        expect(codeManagement.createIssueComment).toHaveBeenCalledTimes(1);
        expect(
            pullRequests.setApprovalReasonDeliveryFailure,
        ).toHaveBeenCalledTimes(1);
        expect(
            pullRequests.setApprovalReasonDeliveryFailure,
        ).toHaveBeenCalledWith('org', 'repo', 12, null, {
            notAfter: expect.any(String),
        });
    } finally {
        jest.useRealTimers();
    }
});

it.each([
    { existing: true, method: 'updateIssueComment', action: 'update' },
    { existing: false, method: 'createIssueComment', action: 'create' },
])(
    'reports a provider $action failure returned as null',
    async ({ existing, method, action }) => {
        const codeManagement = {
            getAllCommentsInPullRequest: jest.fn().mockResolvedValue(
                existing
                    ? [
                          {
                              id: 42,
                              body: formatApprovalReasonComment(
                                  'hold',
                                  'Old reason',
                              ),
                          },
                      ]
                    : [],
            ),
            updateIssueComment: jest.fn().mockResolvedValue(null),
            createIssueComment: jest.fn().mockResolvedValue(null),
        };
        const pullRequests = { setApprovalReasonDeliveryFailure: jest.fn() };
        const service = new CommentManagerService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            codeManagement as any,
            pullRequests as any,
        );

        await expect(
            service.postApprovalReason(
                { organizationId: 'org', teamId: 'team' },
                12,
                { id: 'repo', name: 'api' },
                'Current reason',
                'hold',
            ),
        ).rejects.toThrow(`Approval reason comment ${action} returned null`);
        expect(codeManagement[method]).toHaveBeenCalledTimes(1);
        expect(
            pullRequests.setApprovalReasonDeliveryFailure,
        ).not.toHaveBeenCalled();
    },
);

it.each([
    ['opens no note when none exists', [], 0, 0],
    [
        'updates the earlier note when one exists',
        [{ id: 42, body: formatApprovalReasonComment('hold', 'Old reason') }],
        1,
        0,
    ],
])('with onlyIfPresent, %s', async (_label, comments, updates, creates) => {
    const codeManagement = {
        getAllCommentsInPullRequest: jest.fn().mockResolvedValue(comments),
        updateIssueComment: jest.fn().mockResolvedValue({}),
        createIssueComment: jest.fn().mockResolvedValue({}),
    };
    const service = new CommentManagerService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        codeManagement as any,
        { setApprovalReasonDeliveryFailure: jest.fn() } as any,
    );

    await service.postApprovalReason(
        { organizationId: 'org', teamId: 'team' },
        12,
        { id: 'repo', name: 'api' },
        'The PR does not carry a configured approval label.',
        'hold',
        { onlyIfPresent: true },
    );

    expect(codeManagement.updateIssueComment).toHaveBeenCalledTimes(updates);
    expect(codeManagement.createIssueComment).toHaveBeenCalledTimes(creates);
});

it.each(['lookup', 'create', 'update'])(
    'records confirmed approval delivery failure during %s and preserves the original error',
    async (operation) => {
        const error = new Error('Provider unavailable');
        const code = {
            getAllCommentsInPullRequest: jest.fn().mockResolvedValue(
                operation === 'update'
                    ? [
                          {
                              id: 42,
                              body: formatApprovalReasonComment(
                                  'hold',
                                  'Earlier hold',
                              ),
                          },
                      ]
                    : [],
            ),
            createIssueComment: jest.fn().mockResolvedValue({ id: 42 }),
            updateIssueComment: jest.fn().mockResolvedValue({ id: 42 }),
        };
        code[
            operation === 'lookup'
                ? 'getAllCommentsInPullRequest'
                : operation === 'create'
                  ? 'createIssueComment'
                  : 'updateIssueComment'
        ].mockRejectedValueOnce(error);
        const pullRequests = {
            setApprovalReasonDeliveryFailure: jest.fn().mockResolvedValue(true),
        };
        const manager = new CommentManagerService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            code as any,
            pullRequests as any,
        );
        await expect(
            manager.postApprovalReason(
                { organizationId: 'org', teamId: 'team' },
                1,
                { id: 'repo', name: 'api' },
                'Approved by policy “Docs”.',
                'approve',
                { confirmedApproval: { headSha: 'head', baseSha: 'base' } },
            ),
        ).rejects.toBe(error);
        expect(
            pullRequests.setApprovalReasonDeliveryFailure,
        ).toHaveBeenCalledWith(
            'org',
            'repo',
            1,
            expect.objectContaining({
                decision: 'approve',
                reason: 'Approved by policy “Docs”.',
                reviewedHeadSha: 'head',
                reviewedBaseSha: 'base',
            }),
        );
    },
);

it('records only confirmed approval failures and preserves the original error', async () => {
    const error = new Error('Lookup failed');
    const code = {
        getAllCommentsInPullRequest: jest.fn().mockRejectedValue(error),
    };
    const pullRequests = { setApprovalReasonDeliveryFailure: jest.fn() };
    const manager = new CommentManagerService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        code as any,
        pullRequests as any,
    );
    for (const kind of ['hold', 'approve'] as const) {
        await expect(
            manager.postApprovalReason(
                { organizationId: 'org', teamId: 'team' },
                1,
                { id: 'repo', name: 'api' },
                'Reason',
                kind,
            ),
        ).rejects.toBe(error);
        expect(
            pullRequests.setApprovalReasonDeliveryFailure,
        ).not.toHaveBeenCalled();
    }
    await expect(
        manager.postApprovalReason(
            { organizationId: 'org', teamId: 'team' },
            1,
            { id: 'repo', name: 'api' },
            'Reason',
            'approve',
            { confirmedApproval: { headSha: 'head', baseSha: 'base' } },
        ),
    ).rejects.toBe(error);
    expect(pullRequests.setApprovalReasonDeliveryFailure).toHaveBeenCalledWith(
        'org',
        'repo',
        1,
        expect.objectContaining({
            decision: 'approve',
            reason: 'Reason',
            reviewedHeadSha: 'head',
            reviewedBaseSha: 'base',
        }),
    );
});

it('propagates publication and delivery-state errors together', async () => {
    const publication = new Error('Publication failed');
    const persistence = new Error('Mongo unavailable');
    const manager = new CommentManagerService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {
            getAllCommentsInPullRequest: jest
                .fn()
                .mockRejectedValue(publication),
        } as any,
        {
            setApprovalReasonDeliveryFailure: jest
                .fn()
                .mockRejectedValue(persistence),
        } as any,
    );
    const result = manager.postApprovalReason(
        { organizationId: 'org', teamId: 'team' },
        1,
        { id: 'repo', name: 'api' },
        'Reason',
        'approve',
        { confirmedApproval: { headSha: 'head', baseSha: 'base' } },
    );
    await expect(result).rejects.toMatchObject({
        errors: [publication, persistence],
        cause: publication,
    });
});

it('reports a refused failure write without replacing the publication error', async () => {
    const error = new Error('Publication failed');
    const manager = new CommentManagerService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {
            getAllCommentsInPullRequest: jest.fn().mockRejectedValue(error),
        } as any,
        {
            setApprovalReasonDeliveryFailure: jest
                .fn()
                .mockResolvedValue(false),
        } as any,
    );
    const warn = jest.spyOn((manager as any).logger, 'warn');
    await expect(
        manager.postApprovalReason(
            { organizationId: 'org', teamId: 'team' },
            1,
            { id: 'repo', name: 'api' },
            'Reason',
            'approve',
            { confirmedApproval: { headSha: 'head', baseSha: 'base' } },
        ),
    ).rejects.toBe(error);
    expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
            message: expect.stringContaining('PR missing or notice superseded'),
            metadata: expect.objectContaining({
                repositoryId: 'repo',
                prNumber: 1,
            }),
        }),
    );
});
