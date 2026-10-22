import { CommentManagerService } from './commentManager.service';
import { formatApprovalReasonComment } from '@libs/code-review/infrastructure/approval/approval-reason-comment';

it('updates the existing approval reason after a review hold', async () => {
    const codeManagement = {
        getAllCommentsInPullRequest: jest.fn().mockResolvedValue([
            {
                id: 42,
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
    );

    await service.postApprovalHoldReason(
        { organizationId: 'org', teamId: 'team' },
        12,
        { id: 'repo', name: 'api' },
        'Current reason',
    );

    expect(codeManagement.updateIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({
            commentId: 42,
            body: formatApprovalReasonComment('hold', 'Current reason'),
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
    );

    await service.postApprovalHoldReason(
        { organizationId: 'org', teamId: 'team' },
        12,
        { id: 'repo', name: 'api' },
        'Current reason',
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
        );
        const posting = service.postApprovalHoldReason(
            { organizationId: 'org', teamId: 'team' },
            12,
            { id: 'repo', name: 'api' },
            'Current reason',
        );
        const outcome = expect(posting).rejects.toThrow(
            'approval hold comment create org=org team=team repo=repo pr=12 bounded timeout after 15000ms',
        );
        await jest.advanceTimersByTimeAsync(15_000);
        await outcome;
    } finally {
        jest.useRealTimers();
    }
});
