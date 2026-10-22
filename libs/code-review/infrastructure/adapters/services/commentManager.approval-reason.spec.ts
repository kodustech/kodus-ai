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
