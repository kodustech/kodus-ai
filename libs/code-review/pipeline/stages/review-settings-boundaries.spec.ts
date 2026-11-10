import type { RiskAssessmentResult } from '@libs/code-review/domain/risk/risk-assessment';
import * as yaml from 'js-yaml';
import CodeBaseConfigService from '@libs/ee/codeBase/codeBaseConfig.service';
import { GitlabMappedPlatform } from '@libs/common/utils/webhooks/gitlab';
import { GithubMappedPlatform } from '@libs/common/utils/webhooks/github';
import { GitlabService } from '@libs/platform/infrastructure/adapters/services/gitlab.service';
import { AzureReposService } from '@libs/platform/infrastructure/adapters/services/azureRepos/azureRepos.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { PullRequestHandlerService } from '@libs/code-review/infrastructure/adapters/services/pullRequestManager.service';
import { PrRiskAssessmentService } from '../services/pr-risk-assessment.service';
import { ApprovalPoliciesService } from '../services/approval-policies.service';
import { PreviewPrRiskUseCase } from '@libs/code-review/application/use-cases/risk/preview-pr-risk.use-case';
import { ResolveConfigStage } from './resolve-config.stage';
import { AssessPrRiskStage } from './assess-pr-risk.stage';
import { FetchChangedFilesStage } from './fetch-changed-files.stage';
import { DecidePrApprovalStage } from './decide-pr-approval.stage';
import { RequestChangesOrApproveStage } from './finish-process-review.stage';
import { LLM } from '@libs/llm/llm';
import { CommentManagerService } from '@libs/code-review/infrastructure/adapters/services/commentManager.service';
import { UpdateCommentsAndGenerateSummaryStage } from './finish-comments.stage';
import { BehaviourForExistingDescription } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PullRequestMessageStatus } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';

jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));

function snapshotOf(risk: RiskAssessmentResult) {
    if (risk.status !== 'assessed')
        throw new Error('Expected an assessed risk snapshot');
    return risk.snapshot;
}

const org = { organizationId: 'org', teamId: 'team' };
const repository = { id: 'repo', name: 'api' };
const change = (filename: string, status = 'modified') => ({
    filename,
    status,
    additions: 1,
    deletions: 1,
    patch: '@@ -1 +1 @@\n-const amount = 1;\n+const amount = 2;',
});
const livePr = {
    number: 7,
    title: 'Change',
    head: { sha: 'head' },
    base: { sha: 'base' },
    user: { login: 'dev' },
    labels: [],
};
const policy = {
    id: 'scoped',
    name: 'Scoped',
    enabled: true,
    includedFiles: ['**'],
};

function setup(
    configs: object = {},
    options: {
        files?: any[];
        directories?: any[];
        file?: object;
        incremental?: boolean;
    } = {},
) {
    const files = options.files ?? [change('src/a.ts')];
    const stored = {
        configs: { pullRequestApprovalActive: true, ...configs },
        repositories: [
            {
                ...repository,
                isSelected: true,
                configs: {
                    kodusConfigFileOverridesWebPreferences: !!options.file,
                },
                directories: options.directories ?? [],
            },
        ],
    };
    const parameters = {
        findOne: jest.fn(async () => ({ configValue: stored })),
        findByKey: jest.fn(async () => null),
    };
    const host = {
        getPullRequest: jest.fn(async (_input?: any): Promise<any> => livePr),
        getFilesByPullRequestId: jest.fn(async () => files),
        getPullRequestByNumber: jest.fn(async () => livePr),
        verifyConnection: jest.fn(async () => ({
            hasConnection: true,
            isSetupComplete: true,
        })),
        getTypeIntegration: jest.fn(async () => PlatformType.GITHUB),
        getDefaultBranch: jest.fn(async () => 'main'),
        getRepositoryContentFile: jest.fn(async () =>
            options.file
                ? { data: { content: yaml.dump(options.file) } }
                : undefined,
        ),
        approvePullRequest: jest.fn(async () => undefined),
        getReviewStatusByPullRequest: jest.fn(async () => 'COMMENTED'),
        dismissOwnPullRequestApprovals: jest.fn(async () => 0),
    };
    const access = { isEnabled: jest.fn(async () => true) };
    const permissions = {
        shouldLimitResources: async () => false,
        gateKodusCreditsForSlot: async () => null,
    };
    const config = new CodeBaseConfigService(
        {} as any,
        {} as any,
        {} as any,
        parameters as any,
        {
            findByOrganizationId: async () => null,
            syncRulesWithPlanLimit: async () => null,
        } as any,
        {} as any,
        host as any,
        {
            filterKodyRules: () => ({ standardRules: [], memoryRules: [] }),
        } as any,
        permissions as any,
        {} as any,
    );
    const handler = new PullRequestHandlerService(host as any, {} as any);
    const metadata = {
        getPullRequestDetails: handler.getPullRequestDetails.bind(handler),
        getChangedFilesMetadata: jest.fn(async (_org, _repo, _pr, last) =>
            last ? [files[0]] : files,
        ),
        enrichFilesWithContent: jest.fn(
            async (_org, _repo, _pr, selected) => selected,
        ),
    };
    const messages = { postApprovalReason: jest.fn(async () => undefined) };
    const resolve = new ResolveConfigStage(
        config,
        metadata as any,
        { findOne: async () => null } as any,
        parameters as any,
        {} as any,
    );
    const riskService = new PrRiskAssessmentService(
        host as any,
        { read: async () => null } as any,
        { findByKey: async () => null } as any,
        access,
        permissions as any,
    );
    const risk = new AssessPrRiskStage(riskService);
    const approval = new ApprovalPoliciesService(
        host as any,
        { findByKey: async () => null } as any,
        access,
        permissions as any,
    );
    const decide = new DecidePrApprovalStage(
        host as any,
        { read: async () => null } as any,
        access,
        approval,
    );
    const finish = new RequestChangesOrApproveStage(
        host as any,
        {} as any,
        {} as any,
        messages as any,
    );
    const context = {
        organizationAndTeamData: org,
        repository,
        pullRequest: { ...livePr },
        origin: 'webhook',
        platformType: PlatformType.GITHUB,
        lineComments: [],
        prLevelCommentResults: [],
        ...(options.incremental
            ? { lastExecution: { lastAnalyzedCommit: 'previous' } }
            : {}),
    } as any;
    return {
        config,
        stored,
        host,
        metadata,
        resolve,
        risk,
        riskService,
        decide,
        finish,
        messages,
        context,
        fetch: new FetchChangedFilesStage(metadata as any),
    };
}

beforeEach(() => {
    jest.mocked(LLM.run).mockResolvedValue({
        level: 'low',
        reason: 'No risk found.',
    } as any);
});
afterEach(() => jest.clearAllMocks());

it('hydrates a real GitLab webhook through the normalized provider before risk and approval', async () => {
    const s = setup({ riskAssessmentActive: true, approvalPolicies: [policy] });
    const provider = new (GitlabService as any)();
    provider.getAuthDetails = async () => ({});
    provider.instanceGitlabApi = () => ({
        MergeRequests: {
            show: async () => ({
                iid: 7,
                title: 'Change',
                diff_refs: { head_sha: 'head', start_sha: 'base' },
                author: { username: 'dev' },
            }),
        },
    });
    s.host.getPullRequest.mockImplementation((input: any) =>
        provider.getPullRequest(input),
    );
    s.context.platformType = PlatformType.GITLAB;
    s.context.pullRequest = new GitlabMappedPlatform().mapPullRequest({
        payload: {
            object_attributes: {
                iid: 7,
                title: 'Change',
                last_commit: { id: 'head' },
                target_branch: 'main',
            },
        } as any,
    });
    expect(s.context.pullRequest.base.sha).toBeUndefined();
    const resolved = await s.resolve.execute(s.context);
    const result = await s.decide.execute(
        await s.fetch.execute(await s.risk.execute(resolved)),
    );
    expect(result.pullRequest.base.sha).toBe('base');
    expect(result.riskAssessment.status).toBe('assessed');
    expect(result.approvalDecision).toEqual(
        expect.objectContaining({
            reason: 'Approved by policy “Scoped”.',
            kind: 'approve',
            reviewedBaseSha: 'base',
        }),
    );
});

it('never replaces a stale webhook head during hydration', async () => {
    const s = setup({ riskAssessmentActive: true, approvalPolicies: [policy] });
    s.context.pullRequest = { ...livePr, head: { sha: 'old-head' }, base: {} };
    const result = await s.decide.execute(
        await s.risk.execute(await s.resolve.execute(s.context)),
    );
    expect(result.pullRequest.head.sha).toBe('old-head');
    expect(result.pullRequest.base.sha).toBeUndefined();
    expect(result.riskAssessment.status).toBe('unavailable');
    expect(result.approvalDecision.kind).toBe('hold');
});

it('preserves rate-limit handling for essential snapshot hydration', async () => {
    const s = setup({ riskAssessmentActive: true });
    s.context.pullRequest = { ...livePr, base: {} };
    s.metadata.getPullRequestDetails = async () => {
        throw { status: 429 };
    };
    const result = await s.resolve.execute(s.context);
    expect(result.statusInfo.status).toBe(AutomationStatus.SKIPPED);
    expect(result.statusInfo.message).toContain('rate-limit');
    expect(s.metadata.getChangedFilesMetadata).not.toHaveBeenCalled();
    expect(LLM.run).not.toHaveBeenCalled();
});

it.each(['removed', 'ignored', 'incremental'])(
    'does not confuse analysed-file stats with the full PR diff (%s)',
    async (variant) => {
        const s = setup(
            {
                riskAssessmentActive: true,
                approvalPolicies: [policy],
                ignorePaths: ['**/*.lock'],
            },
            {
                incremental: variant === 'incremental',
                files: [
                    change('src/a.ts'),
                    change(
                        variant === 'ignored' ? 'pnpm.lock' : 'src/b.ts',
                        variant === 'removed' ? 'removed' : 'modified',
                    ),
                ],
            },
        );
        const reviewed = await s.fetch.execute(
            await s.risk.execute(await s.resolve.execute(s.context)),
        );
        expect(reviewed.pullRequest.stats.total_files).toBe(1);
        expect(reviewed.fullPrFiles?.length ?? 0).toBe(2);
        // A second consumer may assess after the filtered stats have been set.
        expect((await s.risk.execute(reviewed)).riskAssessment.status).toBe(
            'assessed',
        );
        expect(
            (await s.decide.execute(reviewed)).approvalDecision,
        ).toMatchObject({
            kind: 'approve',
            reason: 'Approved by policy “Scoped”.',
        });
    },
);

it('accepts a complete PR with fewer files than an incremental diff that reverts earlier changes', async () => {
    const s = setup(
        { riskAssessmentActive: true, approvalPolicies: [policy] },
        { incremental: true },
    );
    s.context.pullRequest.changedFilesCount = 1;
    s.metadata.getChangedFilesMetadata.mockImplementation(
        async (_o, _r, _p, last) =>
            last
                ? [
                      change('src/a.ts'),
                      change('src/reverted-b.ts'),
                      change('src/reverted-c.ts'),
                  ]
                : [change('src/a.ts')],
    );
    const reviewed = await s.fetch.execute(
        await s.risk.execute(await s.resolve.execute(s.context)),
    );
    expect(reviewed.pullRequest.stats.total_files).toBe(3);
    expect(reviewed.fullPrFiles).toHaveLength(1);
    expect((await s.risk.execute(reviewed)).riskAssessment.status).toBe(
        'assessed',
    );
    expect((await s.decide.execute(reviewed)).approvalDecision.kind).toBe(
        'approve',
    );
});

it('reassesses rather than reusing a stored result with a stale description key', async () => {
    const s = setup({ riskAssessmentActive: true });
    const resolved = await s.resolve.execute(s.context);
    const first = await s.risk.execute(resolved);
    const stored = {
        ...first.riskAssessment,
        snapshot: {
            ...snapshotOf(first.riskAssessment),
            descriptionKey: 'stale-key',
        },
    };
    jest.mocked(LLM.run).mockClear();
    const result = await s.risk.execute({
        ...resolved,
        lastExecution: { riskAssessment: stored },
    } as any);
    expect(LLM.run).toHaveBeenCalledTimes(1);
    expect(snapshotOf(result.riskAssessment).descriptionKey).toBe(
        snapshotOf(first.riskAssessment).descriptionKey,
    );
});

it('holds risk and file policies when the live provider count proves the list is truncated', async () => {
    const s = setup({ riskAssessmentActive: true, approvalPolicies: [policy] });
    s.host.getPullRequest.mockResolvedValue({
        ...livePr,
        changedFilesCount: 2,
    });
    const result = await s.risk.execute(await s.resolve.execute(s.context));
    expect(result.riskAssessment).toMatchObject({
        status: 'unavailable',
        reason: 'Kody could not verify the complete PR diff.',
    });
    expect(LLM.run).not.toHaveBeenCalled();
    const noRisk = {
        ...result,
        codeReviewConfig: {
            ...result.codeReviewConfig,
            riskAssessmentActive: false,
        },
    };
    expect((await s.decide.execute(noRisk)).approvalDecision).toMatchObject({
        kind: 'hold',
        reason: 'The complete PR file list could not be verified.',
    });
});

it('skips an incomplete primary review diff when its provider count is already known', async () => {
    const s = setup({ riskAssessmentActive: false });
    s.context.pullRequest = new GithubMappedPlatform().mapPullRequest({
        payload: {
            pull_request: {
                number: 7,
                title: 'Change',
                changed_files: 2,
                head: { sha: 'head', ref: 'feature' },
                base: { sha: 'base', ref: 'main' },
            },
        } as any,
    });
    expect(s.context.pullRequest.changedFilesCount).toBe(2);
    const result = await s.resolve.execute(s.context);
    expect(result.statusInfo.status).toBe(AutomationStatus.SKIPPED);
    expect(result.codeReviewConfig).toBeUndefined();
    expect(LLM.run).not.toHaveBeenCalled();
});

it('checks possible risk activation without rereading common policies per directory', async () => {
    const readsFor = async (count: number) => {
        const s = setup(
            { riskAssessmentActive: false },
            {
                directories: Array.from({ length: count }, (_, i) => ({
                    id: `d${i}`,
                    path: `dir${i}`,
                    configs: {},
                })),
            },
        );
        let reads = 0;
        Object.defineProperty(s.stored.configs, 'approvalPolicies', {
            enumerable: true,
            get: () => {
                reads++;
                return [policy];
            },
        });
        const resolved = await s.resolve.execute(s.context);
        expect(resolved.codeReviewConfig.riskAssessmentMayBeActive).toBe(false);
        return reads;
    };
    expect(await readsFor(200)).toBe(await readsFor(2));
});

it('does not fetch a full incremental diff or invent a risk veto for an organization with risk off everywhere', async () => {
    const s = setup({}, { incremental: true });
    s.metadata.getChangedFilesMetadata.mockImplementation(
        async (_o, _r, _p, last) => {
            if (!last) throw new Error('502');
            return [change('src/a.ts')];
        },
    );
    const result = await s.decide.execute(
        await s.fetch.execute(
            await s.risk.execute(await s.resolve.execute(s.context)),
        ),
    );
    expect(s.metadata.getChangedFilesMetadata).toHaveBeenCalledTimes(1);
    expect(result.codeReviewConfig.riskAssessmentMayBeActive).toBe(false);
    expect(result.riskAssessment.status).toBe('disabled');
    expect(result.approvalDecision).toBeUndefined();
    await s.finish.execute(result);
    expect(s.host.approvePullRequest).toHaveBeenCalledTimes(1);
});

it('uses approval settings from the full PR on a docs-only follow-up', async () => {
    const s = setup(
        { riskAssessmentActive: false },
        {
            incremental: true,
            files: [change('docs/readme.md'), change('services/payments/a.ts')],
            directories: [
                {
                    id: 'payments',
                    path: 'services/payments',
                    configs: { approvalLabels: ['automerge'] },
                },
            ],
        },
    );
    const result = await s.decide.execute(
        await s.fetch.execute(await s.resolve.execute(s.context)),
    );
    expect(s.metadata.getChangedFilesMetadata).toHaveBeenCalledTimes(2);
    expect(result.codeReviewConfig.riskAssessmentActive).toBe(false);
    expect(result.codeReviewConfig.approvalLabels).toEqual(['automerge']);
    expect(result.approvalDecision.kind).toBe('out-of-scope');
    await s.finish.execute(result);
    expect(s.host.approvePullRequest).not.toHaveBeenCalled();
});

it.each([502, 429])(
    'continues incremental review in the default mode when a required full diff fails (%s)',
    async (status) => {
        const s = setup(
            { riskAssessmentActive: false },
            {
                incremental: true,
                directories: [
                    {
                        id: 'auth',
                        path: 'src/auth',
                        configs: { riskAssessmentActive: true },
                    },
                ],
            },
        );
        s.metadata.getChangedFilesMetadata.mockImplementation(
            async (_o, _r, _p, last) => {
                if (!last)
                    throw Object.assign(new Error('provider failure'), {
                        status,
                    });
                return [change('docs/readme.md')];
            },
        );
        const result = await s.decide.execute(
            await s.fetch.execute(
                await s.risk.execute(await s.resolve.execute(s.context)),
            ),
        );
        expect(result.changedFiles).toHaveLength(1);
        expect(result.statusInfo?.status).not.toBe(AutomationStatus.SKIPPED);
        expect(result.riskAssessment.status).toBe('unavailable');
        expect(result.approvalDecision.kind).toBe('hold');
    },
);

it('does not approve a clean legacy PR when independent risk confirms risk', async () => {
    const s = setup({ riskAssessmentActive: true });
    jest.mocked(LLM.run).mockResolvedValue({
        level: 'high',
        reason: 'Risk found.',
    } as any);
    const result = await s.decide.execute(
        await s.fetch.execute(
            await s.risk.execute(await s.resolve.execute(s.context)),
        ),
    );
    expect(result.approvalDecision.kind).toBe('hold');
    await s.finish.execute(result);
    expect(s.host.approvePullRequest).not.toHaveBeenCalled();
});

it('binds migrated conditional approvals to the same reviewed head, base and metadata', async () => {
    const s = setup({ approvalRiskActive: true });
    const assessed = await s.risk.execute(await s.resolve.execute(s.context));
    const result = await s.decide.execute(await s.fetch.execute(assessed));
    expect(result.approvalDecision).toMatchObject({
        kind: 'approve',
        reviewedHeadSha: 'head',
        reviewedBaseSha: 'base',
        reviewedMetadataKey: expect.any(String),
    });
    s.host.getPullRequest.mockResolvedValue({
        ...livePr,
        base: { sha: 'moved-base' },
    });
    const stale = await s.decide.execute(await s.fetch.execute(assessed));
    expect(stale.approvalDecision.kind).toBe('hold');
    await s.finish.execute(result);
    expect(s.host.approvePullRequest).not.toHaveBeenCalled();
});

it.each([
    [BehaviourForExistingDescription.CONCATENATE, false],
    [BehaviourForExistingDescription.REPLACE, false],
    [BehaviourForExistingDescription.REPLACE, true],
])(
    'binds the real summary write only while the assessed context is current (%s, author edit=%s)',
    async (behaviour, authorEdit) => {
        const s = setup({
            riskAssessmentActive: true,
            approvalPolicies: [policy],
            summary: {
                generatePRSummary: true,
                behaviourForExistingDescription: behaviour,
            },
        });
        let live = { ...livePr, body: 'Human-authored context. Closes #12' };
        s.context.pullRequest = live;
        s.context.initialCommentData = { commentId: 1 };
        s.host.getPullRequest.mockImplementation(async () => live);
        s.host.getPullRequestByNumber.mockImplementation(async () => live);
        const writer = new CommentManagerService(
            {} as any,
            {} as any,
            {} as any,
            { resolveTaskSlot: async () => undefined } as any,
            {
                ...s.host,
                updateDescriptionInPullRequest: async ({ summary }) => {
                    live = { ...live, body: summary };
                },
            } as any,
            {} as any,
        );
        // Script the model output; use production summary formatting and host writing.
        jest.spyOn(writer as any, 'runSummaryPromptV5').mockImplementation(
            async () => {
                if (authorEdit)
                    live = {
                        ...live,
                        body: 'New human context while the model was running.',
                    };
                return '## Summary\nUpdated the constant.';
            },
        );
        const stage = new UpdateCommentsAndGenerateSummaryStage(
            writer,
            s.metadata as any,
            {} as any,
            s.host as any,
        );
        const assessed = await s.fetch.execute(
            await s.risk.execute(await s.resolve.execute(s.context)),
        );
        const result = await s.decide.execute(
            await stage.execute({
                ...assessed,
                pullRequestMessagesConfig: {
                    endReviewMessage: { status: PullRequestMessageStatus.OFF },
                },
            } as any),
        );
        expect(live.body).not.toBe(s.context.pullRequest.body);
        expect(result.approvalDecision.kind).toBe(
            authorEdit ? 'hold' : 'approve',
        );
        if (authorEdit) {
            expect(live.body).toBe(
                'New human context while the model was running.',
            );
            expect(snapshotOf(result.riskAssessment).descriptionKey).toBe(
                snapshotOf(assessed.riskAssessment).descriptionKey,
            );
        } else
            expect(snapshotOf(result.riskAssessment).descriptionKey).not.toBe(
                snapshotOf(assessed.riskAssessment).descriptionKey,
            );
        await s.finish.execute(result);
        expect(s.host.approvePullRequest).toHaveBeenCalledTimes(
            authorEdit ? 0 : 1,
        );
    },
);

it('keeps parser details private and logs the actual configuration scope', async () => {
    const s = setup(
        { approvalPolicies: [policy] },
        { file: { approvalLabels: ['automerge'] } },
    );
    const warn = jest.spyOn((s.config as any).logger, 'warn');
    try {
        const result = await s.decide.execute(
            await s.fetch.execute(await s.resolve.execute(s.context)),
        );
        expect(result.codeReviewConfig.reviewSettingsError).toContain(
            'Legacy approval filters',
        );
        expect(result.approvalDecision.reason).toBe(
            'Risk or approval settings are invalid. Check your configuration.',
        );
        await s.finish.execute(result);
        expect(s.messages.postApprovalReason).toHaveBeenCalledWith(
            org,
            7,
            repository,
            'Risk or approval settings are invalid. Check your configuration.',
            'hold',
        );
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.objectContaining({
                    message: expect.stringContaining('Legacy approval filters'),
                }),
                metadata: expect.objectContaining({
                    organizationAndTeamData: org,
                    repositoryId: 'repo',
                    defaultBranch: 'main',
                }),
            }),
        );
    } finally {
        warn.mockRestore();
    }
});

it.each([false, true])(
    'holds an assessment when its PR description changes before approval (named=%s)',
    async (named) => {
        const s = setup({
            riskAssessmentActive: true,
            ...(named ? { approvalPolicies: [policy] } : {}),
        });
        const assessed = await s.risk.execute(
            await s.resolve.execute(s.context),
        );
        s.host.getPullRequest.mockResolvedValue({
            ...livePr,
            title: 'Changed context after assessment',
        });
        const result = await s.decide.execute(await s.fetch.execute(assessed));
        expect(result.riskAssessment.status).toBe('assessed');
        expect(result.approvalDecision.kind).toBe('hold');
        await s.finish.execute(result);
        expect(s.host.approvePullRequest).not.toHaveBeenCalled();
    },
);

it.each([
    {
        file: {
            riskCriteria: [{ id: 'bad' }],
            ignoredTitleKeywords: ['keep-review-setting'],
        },
    },
    {
        file: {
            approvalPolicies: 'invalid',
            ignoredTitleKeywords: ['keep-review-setting'],
        },
    },
    {
        file: {
            approvalLabels: ['automerge'],
            ignoredTitleKeywords: ['keep-review-setting'],
        },
    },
])(
    'keeps code review available and holds approval for bad or conflicting YAML (%j)',
    async (options) => {
        const s = setup({ approvalPolicies: [policy] }, options);
        const result = await s.decide.execute(
            await s.fetch.execute(await s.resolve.execute(s.context)),
        );
        expect(result.statusInfo?.status).not.toBe(AutomationStatus.SKIPPED);
        expect(result.changedFiles).toHaveLength(1);
        expect(result.codeReviewConfig.ignoredTitleKeywords).toEqual([
            'keep-review-setting',
        ]);
        expect(result.approvalDecision.kind).toBe('hold');
        expect(result.approvalDecision.reason).toMatch(
            /invalid|Legacy approval filters/i,
        );
        await s.finish.execute(result);
        expect(s.host.approvePullRequest).not.toHaveBeenCalled();
    },
);

it('preserves plain legacy approval with a PR-level comment through real config resolution', async () => {
    const s = setup();
    s.context.prLevelCommentResults = [{ body: 'PR note' }];
    const result = await s.decide.execute(
        await s.fetch.execute(await s.resolve.execute(s.context)),
    );
    await s.finish.execute(result);
    expect(s.host.approvePullRequest).toHaveBeenCalledTimes(1);
    expect(result.codeReviewConfig.approvalPolicySource).toBe('legacy');
});

it('keeps an unmatched migrated label policy quiet when there was no earlier decision note', async () => {
    const s = setup({ approvalLabels: ['automerge'] });
    const result = await s.decide.execute(
        await s.fetch.execute(await s.resolve.execute(s.context)),
    );
    expect(result.approvalDecision.kind).toBe('out-of-scope');
    await s.finish.execute(result);
    expect(s.messages.postApprovalReason).toHaveBeenCalledWith(
        org,
        7,
        repository,
        expect.any(String),
        'hold',
        { onlyIfPresent: true },
    );
    expect(s.host.approvePullRequest).not.toHaveBeenCalled();
});

it('previews Azure PRs through its real normalized provider response', async () => {
    const s = setup();
    const provider = new (AzureReposService as any)();
    provider.getAuthDetails = async () => ({});
    provider.getProjectIdFromRepository = async () => 'project';
    provider.azureReposRequestHelper = {
        getPullRequestDetails: async () => ({
            pullRequestId: 7,
            title: 'Change',
            repository,
            sourceRefName: 'refs/heads/feature',
            targetRefName: 'refs/heads/main',
            lastMergeSourceCommit: { commitId: 'head' },
            lastMergeTargetCommit: { commitId: 'base' },
        }),
    };
    s.host.getPullRequest.mockImplementation((input: any) =>
        provider.getPullRequest(input),
    );
    const useCase = new PreviewPrRiskUseCase(
        { findByKey: async () => ({ configValue: s.stored }) } as any,
        {
            ...s.host,
            getPullRequestByNumber:
                provider.getPullRequestByNumber.bind(provider),
        } as any,
        s.riskService,
    );
    const result = await useCase.execute({
        organizationAndTeamData: org,
        repositoryId: 'repo',
        prNumber: 7,
    });
    expect(result.assessment.status).toBe('assessed');
    expect(s.host.getPullRequest).toHaveBeenCalledTimes(2);
});
