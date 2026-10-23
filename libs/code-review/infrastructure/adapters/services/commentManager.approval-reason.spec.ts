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
            body: formatApprovalReasonComment('hold', 'Current reason'),
        }),
    );
    expect(codeManagement.createIssueComment).not.toHaveBeenCalled();
});

it('replaces a previous hold with the completed approval reason', async () => {
    const codeManagement = {
        getAllCommentsInPullRequest: jest
            .fn()
            .mockResolvedValue([
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
        );
        const posting = service.postApprovalReason(
            { organizationId: 'org', teamId: 'team' },
            12,
            { id: 'repo', name: 'api' },
            'Current reason',
            'hold',
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
