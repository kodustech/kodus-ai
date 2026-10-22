import { LLM } from '@libs/llm/llm';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { CodeAreaRiskMapService } from '@libs/platformData/infrastructure/adapters/services/code-area-risk-map.service';
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
const stage = new DecidePrApprovalStage(
    codeManagement as unknown as CodeManagementService,
    areaMaps as unknown as CodeAreaRiskMapService,
);

const context = (config: Record<string, unknown> = {}) =>
    frozenContext({
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

it('judges an in-scope PR with the review model and records the map version', async () => {
    (LLM.run as jest.Mock).mockResolvedValue({
        level: 'low',
        reason: 'Limited change with focused tests.',
    });
    areaMaps.read.mockResolvedValue({
        version: 'map-1',
        files: [],
        coverage: { scannedPrs: 0 },
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
    expect(LLM.run).toHaveBeenCalledTimes(1);
});

it('holds approval when a new commit arrives during review', async () => {
    codeManagement.getPullRequest.mockResolvedValueOnce({
        head: { sha: 'new-head' },
        labels: ['ready'],
    });
    const result = await stage.execute(context({ approvalLabels: ['ready'] }));

    expect(result.approvalDecision?.kind).toBe('hold');
    expect(LLM.run).not.toHaveBeenCalled();
});
