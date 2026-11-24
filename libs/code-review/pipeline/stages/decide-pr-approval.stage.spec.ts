import { prRiskDescriptionKey } from '@libs/code-review/domain/risk/risk-configuration';
import { LLM } from '@libs/llm/llm';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { CodeAreaRiskMapService } from '@libs/platformData/infrastructure/adapters/services/code-area-risk-map.service';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { DecidePrApprovalStage } from './decide-pr-approval.stage';

jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const codeManagement = {
    getPullRequest: jest.fn(),
    getFilesByPullRequestId: jest.fn(),
};
const areaMaps = { read: jest.fn() };
const conditionalApprovalAccess = {
    isEnabled: jest.fn().mockResolvedValue(true),
};
const stage = new DecidePrApprovalStage(
    codeManagement as unknown as CodeManagementService,
    areaMaps as unknown as CodeAreaRiskMapService,
    conditionalApprovalAccess as any,
    { evaluate: jest.fn() } as any,
);

const context = (
    config: Record<string, unknown> = {},
    platformType = PlatformType.GITHUB,
) =>
    frozenContext({
        platformType,
        organizationAndTeamData: {
            organizationId: 'org-1',
            teamId: 'team-1',
        },
        repository: { id: 'repo-1', name: 'api' },
        pullRequest: {
            number: 42,
            title: 'Update login',
            body: '',
            head: { sha: 'head-1' },
            user: { login: 'alice' },
        },
        origin: 'github',
        lineComments: [],
        preliminaryFiles: [{ filename: 'src/auth/login.ts' }],
        changedFiles: [
            {
                filename: 'src/auth/login.ts',
                status: 'modified',
                patch: '@@ -1 +1 @@\n-old\n+new',
                additions: 1,
                deletions: 1,
            },
        ],
        codeReviewConfig: { pullRequestApprovalActive: true, ...config },
    } as any);

beforeEach(() => {
    jest.clearAllMocks();
    conditionalApprovalAccess.isEnabled.mockResolvedValue(true);
    areaMaps.read.mockResolvedValue(null);
    codeManagement.getPullRequest.mockResolvedValue({
        labels: ['ready'],
        head: { sha: 'head-1' },
        user: { login: 'alice' },
    });
    codeManagement.getFilesByPullRequestId.mockResolvedValue([
        {
            filename: 'src/auth/login.ts',
            status: 'modified',
            patch: '@@ -1 +1 @@\n-old\n+new',
            additions: 1,
            deletions: 1,
        },
    ]);
});

it.each([
    {
        riskIdentified: true,
        liveBase: 'base',
        kind: 'hold',
        reason: 'Risk was identified in this PR.',
    },
    { riskIdentified: false, liveBase: 'base', kind: 'approve' },
    {
        riskIdentified: false,
        liveBase: 'base-2',
        kind: 'hold',
        reason: 'Risk assessment is unavailable for the current PR base.',
    },
])(
    'decides $kind for risk=$riskIdentified and base=$liveBase without another model call',
    async ({ riskIdentified, liveBase, kind, reason }) => {
        codeManagement.getPullRequest.mockResolvedValueOnce({
            labels: ['ready'],
            head: { sha: 'head-1' },
            base: { sha: liveBase },
            user: { login: 'alice' },
        });
        const ctx = {
            ...context({ riskAssessmentActive: true }),
            riskAssessment: {
                status: 'assessed' as const,
                riskIdentified,
                reason: 'Shared risk explanation.',
                snapshot: {
                    organizationId: 'org-1',
                    repositoryId: 'repo-1',
                    prNumber: 42,
                    baseSha: 'base',
                    headSha: 'head-1',
                    assessmentKey: 'key',
                    descriptionKey: prRiskDescriptionKey({}),
                },
            },
        };
        const result = await stage.execute(ctx);
        expect(result.approvalDecision).toMatchObject({
            kind,
            ...(reason && { reason }),
        });
        expect(LLM.run).not.toHaveBeenCalled();
        expect(areaMaps.read).not.toHaveBeenCalled();
    },
);

it('uses fixed approval conditions without legacy risk when the independent toggle is off', async () => {
    const result = await stage.execute(
        context({
            riskAssessmentActive: false,
            approvalRiskActive: true,
            approvalLabels: ['ready'],
        }),
    );
    expect(result.approvalDecision.kind).toBe('approve');
    expect(LLM.run).not.toHaveBeenCalled();
});

it('blocks approval on shared assessment failure while leaving the review available', async () => {
    const result = await stage.execute({
        ...context({ riskAssessmentActive: true }),
        riskAssessment: { status: 'unavailable', reason: 'Timeout.' },
    });
    expect(result.approvalDecision.kind).toBe('hold');
    expect(LLM.run).not.toHaveBeenCalled();
});

const sharedRiskFailure = {
    stage: 'AssessPrRiskStage',
    severity: 'partial' as const,
    error: new Error('Kody could not assess risk for this PR.'),
    metadata: { reason: 'approval_risk_assessment_failed' },
};

it('names a failed shared assessment in the hold and does not record it twice', async () => {
    const result = await stage.execute({
        ...context({ riskAssessmentActive: true }),
        riskAssessment: {
            status: 'unavailable',
            reason: 'Kody could not assess risk for this PR.',
            failure: { category: 'unexpected', errorName: 'Error' },
        },
        errors: [sharedRiskFailure],
    });
    expect(result.approvalDecision).toMatchObject({
        kind: 'hold',
        reason: 'Risk assessment is unavailable: Kody could not assess risk for this PR.',
    });
    expect(result.errors).toEqual([sharedRiskFailure]);
});

it('does not count a failed shared assessment as an unclean review for named policies', async () => {
    const evaluate = jest.fn().mockResolvedValue({
        decision: { kind: 'hold', reason: 'Risk assessment is unavailable.' },
        eligibility: {},
    });
    const policyStage = new DecidePrApprovalStage(
        codeManagement as unknown as CodeManagementService,
        areaMaps as unknown as CodeAreaRiskMapService,
        conditionalApprovalAccess as any,
        { evaluate } as any,
    );
    const result = await policyStage.execute({
        ...context({ riskAssessmentActive: true, approvalPolicies: [] }),
        errors: [sharedRiskFailure],
    });
    expect(evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ reviewClean: true }),
    );
    expect(result.approvalReviewSummary.complete).toBe(true);
});

it('records the exact posted comment IDs and missing delivery evidence for named approval', async () => {
    const decision = { kind: 'hold', reason: 'The review is not clean.' };
    const evaluate = jest.fn().mockResolvedValue({ decision, eligibility: {} });
    const policyStage = new DecidePrApprovalStage(
        codeManagement as unknown as CodeManagementService,
        areaMaps as unknown as CodeAreaRiskMapService,
        conditionalApprovalAccess as any,
        { evaluate } as any,
    );
    const result = await policyStage.execute({
        ...context({ approvalPolicies: [] }),
        lineComments: [
            {
                comment: {
                    path: 'src/auth/login.ts',
                    body: 'Replaced finding',
                },
                deliveryStatus: DeliveryStatus.REPLACED,
            },
            {
                comment: {
                    path: 'src/auth/login.ts',
                    body: 'Fallback finding',
                },
                deliveryStatus: DeliveryStatus.SENT,
                codeReviewFeedbackData: {
                    commentId: 42,
                    pullRequestReviewId: 1,
                    suggestionId: 'posted',
                },
            },
            {
                comment: { path: 'src/auth/login.ts', body: 'Another finding' },
                deliveryStatus: DeliveryStatus.FAILED,
                codeReviewFeedbackData: {
                    commentId: 71,
                    pullRequestReviewId: 1,
                    suggestionId: 'failed',
                },
            },
            {
                comment: {
                    path: 'src/auth/login.ts',
                    body: 'Untracked finding',
                },
                deliveryStatus: DeliveryStatus.SENT,
            },
        ],
    });
    expect(result.approvalReviewSummary).toMatchObject({
        complete: true,
        lineFindings: 4,
        lineCommentIds: [null, '42', null, null],
    });
    expect(evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ reviewClean: false }),
    );
    expect(result.approvalDecision).toEqual(decision);
});

it('holds a saved conditional policy when beta or paid access is unavailable', async () => {
    conditionalApprovalAccess.isEnabled.mockResolvedValueOnce(false);
    const result = await stage.execute(context({ approvalLabels: ['ready'] }));
    expect(result.approvalDecision?.kind).toBe('hold');
    expect(codeManagement.getPullRequest).not.toHaveBeenCalled();
});

it('preserves unknown risk and hold while recording an assessment failure as partial', async () => {
    (LLM.run as jest.Mock).mockRejectedValueOnce(
        new Error('Model unavailable'),
    );
    const result = await stage.execute(context({ approvalRiskActive: true }));
    expect(result.approvalRisk).toMatchObject({
        level: 'unknown',
        reviewedHeadSha: 'head-1',
    });
    expect(result.approvalDecision?.kind).toBe('hold');
    expect(result.errors).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                stage: 'DecidePrApprovalStage',
                severity: 'partial',
                metadata: expect.objectContaining({
                    reason: 'approval_risk_assessment_failed',
                    errorName: 'Error',
                }),
            }),
        ]),
    );
});

it.each(['medium', 'high'])(
    'treats a valid %s judgment as a successful assessment that holds approval',
    async (level) => {
        (LLM.run as jest.Mock).mockResolvedValueOnce({
            level,
            reason: 'A person should review this change.',
        });
        const result = await stage.execute(
            context({ approvalRiskActive: true }),
        );
        expect(result.approvalDecision?.kind).toBe('hold');
        expect(result.errors ?? []).toEqual([]);
    },
);

it('keeps explicit parent-off authoritative even when risk is enabled', async () => {
    const result = await stage.execute(
        context({ pullRequestApprovalActive: false, approvalRiskActive: true }),
    );
    expect(result.approvalRisk).toBeUndefined();
    expect(LLM.run).not.toHaveBeenCalled();
});

it('ignores inherited label restrictions on Bitbucket', async () => {
    const result = await stage.execute(
        context({ approvalLabels: ['ready'] }, PlatformType.BITBUCKET),
    );
    expect(result.approvalDecision).toBeUndefined();
    expect(codeManagement.getPullRequest).not.toHaveBeenCalled();
});

it('holds Azure label policies until PR labels can be verified', async () => {
    const result = await stage.execute(
        context({ approvalLabels: ['ready'] }, PlatformType.AZURE_REPOS),
    );
    expect(result.approvalDecision?.kind).toBe('hold');
    expect(codeManagement.getPullRequest).not.toHaveBeenCalled();
});

it('preserves the old path without extra calls when no policy is configured', async () => {
    const result = await stage.execute(context());
    expect(result.approvalDecision).toBeUndefined();
    expect(LLM.run).not.toHaveBeenCalled();
    expect(codeManagement.getPullRequest).not.toHaveBeenCalled();
});

it('does not fetch file content for a label-only policy', async () => {
    const result = await stage.execute(context({ approvalLabels: ['ready'] }));
    expect(result.approvalDecision?.kind).toBe('approve');
    expect(codeManagement.getFilesByPullRequestId).not.toHaveBeenCalled();
});

it('skips risk assessment for an author outside the approval scope', async () => {
    const result = await stage.execute(
        context({ approvalAuthors: ['bob'], approvalRiskActive: true }),
    );

    expect(result.approvalDecision?.kind).toBe('out-of-scope');
    expect(codeManagement.getFilesByPullRequestId).not.toHaveBeenCalled();
    expect(LLM.run).not.toHaveBeenCalled();
});

it('judges an in-scope PR with the review model and records the map version', async () => {
    (LLM.run as jest.Mock).mockResolvedValue({
        level: 'low',
        reason: 'Limited change with focused tests.',
    });
    areaMaps.read.mockResolvedValue({
        version: 'map-1',
        files: [],
        coverage: { scannedPrs: 1, scanComplete: true },
    });
    const result = await stage.execute(
        context({
            approvalLabels: ['ready'],
            approvalRiskActive: true,
            resolvedModelSlot: { provider: 'openai', model: 'test-model' },
        }),
    );
    expect(result.approvalDecision?.kind).toBe('approve');
    expect(result.approvalRisk).toMatchObject({
        reviewedHeadSha: 'head-1',
        areaMapVersion: 'map-1',
    });
    expect(LLM.run).toHaveBeenCalledTimes(1);
});

it('passes positive evidence and coverage from an unfinished history scan', async () => {
    (LLM.run as jest.Mock).mockResolvedValue({
        level: 'medium',
        reason: 'The change needs human review.',
    });
    areaMaps.read.mockResolvedValue({
        version: 'partial-map',
        files: [
            {
                path: 'src/auth/login.ts',
                linkedBugFixPrs: 5,
                recentEvidence: [],
            },
        ],
        coverage: { scannedPrs: 1, scanComplete: false },
    });

    const result = await stage.execute(context({ approvalRiskActive: true }));

    expect(result.approvalDecision?.kind).toBe('hold');
    expect(result.approvalRisk?.areaMapVersion).toBe('partial-map');
    const request = (LLM.run as jest.Mock).mock.calls[0][0];
    expect(JSON.parse(request.user)).toMatchObject({
        historyCoverage: { scannedPrs: 1, scanComplete: false },
        historicalAreas: [{ path: 'src/auth/login.ts', linkedBugFixPrs: 5 }],
    });
});

it('passes capped historical coverage into the risk judgment', async () => {
    (LLM.run as jest.Mock).mockResolvedValue({
        level: 'low',
        reason: 'Small isolated change.',
    });
    areaMaps.read.mockResolvedValue({
        version: 'sampled-map',
        files: [
            {
                path: 'src/auth/login.ts',
                linkedBugFixPrs: 0,
                recentEvidence: [],
            },
        ],
        coverage: { scannedPrs: 100, scanComplete: true, sampled: true },
    });

    const result = await stage.execute(context({ approvalRiskActive: true }));

    expect(result.approvalRisk?.areaMapVersion).toBe('sampled-map');
    const request = (LLM.run as jest.Mock).mock.calls[0][0];
    expect(JSON.parse(request.user)).toMatchObject({
        historyCoverage: { scannedPrs: 100, scanComplete: true, sampled: true },
    });
});

it('vetoes a sensitive path before paying for a model call', async () => {
    const result = await stage.execute(
        context({
            approvalRiskActive: true,
            approvalSensitivePaths: ['src/auth/**'],
        }),
    );
    expect(result.approvalDecision?.kind).toBe('hold');
    expect(LLM.run).not.toHaveBeenCalled();
});

it('checks sensitive paths across the complete PR on an incremental review', async () => {
    codeManagement.getFilesByPullRequestId.mockResolvedValueOnce([
        { filename: 'src/auth/login.ts' },
        { filename: 'secrets/rotation.ts' },
    ]);
    const result = await stage.execute(
        context({
            approvalRiskActive: true,
            approvalSensitivePaths: ['secrets/**'],
        }),
    );
    expect(result.approvalDecision?.kind).toBe('hold');
    expect(LLM.run).not.toHaveBeenCalled();
});

it('holds a PR that moves a file out of a sensitive path', async () => {
    codeManagement.getFilesByPullRequestId.mockResolvedValueOnce([
        {
            filename: 'libs/ledger.ts',
            previous_filename: 'secrets/ledger.ts',
            status: 'renamed',
        },
    ]);
    const result = await stage.execute(
        context({ approvalSensitivePaths: ['secrets/**'] }),
    );
    expect(result.approvalDecision?.kind).toBe('hold');
    expect(result.approvalDecision?.reason).toContain('secrets/ledger.ts');
});

it('holds when the complete PR diff cannot be loaded', async () => {
    codeManagement.getFilesByPullRequestId.mockResolvedValueOnce(null);
    const result = await stage.execute(context({ approvalRiskActive: true }));
    expect(result.approvalDecision?.kind).toBe('hold');
    expect(LLM.run).not.toHaveBeenCalled();
});

it('saves risk outside label scope so a later label can be checked by the cron', async () => {
    (LLM.run as jest.Mock).mockResolvedValue({
        level: 'medium',
        reason: 'The change affects authentication behavior.',
    });
    const result = await stage.execute(
        context({ approvalLabels: ['later'], approvalRiskActive: true }),
    );

    expect(result.approvalDecision?.kind).toBe('out-of-scope');
    expect(result.approvalRisk?.level).toBe('medium');
    // One judgment, then the medium rating's second look at the PR head: the
    // scripted model answers no tool, so the first judgment stands.
    expect(LLM.run).toHaveBeenCalledTimes(2);
    expect(jest.mocked(LLM.run).mock.calls[1][0]).toHaveProperty('loop');
});

it('holds approval when a new commit arrives during review', async () => {
    codeManagement.getPullRequest.mockResolvedValueOnce({
        head: { sha: 'new-head' },
        labels: ['ready'],
    });
    const result = await stage.execute(context({ approvalLabels: ['ready'] }));

    expect(result.approvalDecision).toEqual({
        kind: 'hold',
        reason: 'A newer commit arrived while Kody reviewed this one; Kody decides on the next reviewed commit.',
    });
    expect(LLM.run).not.toHaveBeenCalled();
});

it.each([
    [
        'the PR cannot be read',
        null,
        'Kody could not read the current PR from the Git provider.',
    ],
    [
        'the target branch moved',
        { head: { sha: 'head-1' }, base: { sha: 'base-2' }, labels: ['ready'] },
        'The target branch changed during the review, so this review cannot approve the PR.',
    ],
    [
        'labels cannot be read',
        { head: { sha: 'head-1' }, base: { sha: 'base-1' } },
        'Kody could not read the PR labels from the Git provider.',
    ],
])('holds with its own reason when %s', async (_case, livePr, reason) => {
    codeManagement.getPullRequest.mockResolvedValueOnce(livePr);
    const ctx = context({ approvalLabels: ['ready'] });

    const result = await stage.execute({
        ...ctx,
        pullRequest: { ...ctx.pullRequest, base: { sha: 'base-1' } },
    });

    expect(result.approvalDecision).toEqual({ kind: 'hold', reason });
});
