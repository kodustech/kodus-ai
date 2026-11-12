import CodeBaseConfigService from '@libs/ee/codeBase/codeBaseConfig.service';
import { LLM } from '@libs/llm/llm';
import { ResolveConfigStage } from './resolve-config.stage';
import { AssessPrRiskStage } from './assess-pr-risk.stage';
import { PrRiskAssessmentService } from '../services/pr-risk-assessment.service';
import { riskApprovalVeto } from '@libs/code-review/domain/risk/risk-assessment';
import { resolveRiskReviewMode } from '@libs/code-review/domain/review-mode';

jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));

function setup(renamed = false) {
    const org = { organizationId: 'org', teamId: 'team' };
    const repo = { id: 'repo', name: 'api' };
    const docs = {
        filename: 'docs/readme.md',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '+Docs',
    };
    const auth = {
        filename: renamed ? 'docs/session.ts' : 'src/auth/session.ts',
        previous_filename: renamed ? 'src/auth/session.ts' : undefined,
        status: renamed ? 'renamed' : 'modified',
        additions: 1,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-return verify(user);\n+return true;',
    };
    const files = [auth, docs];
    const pr = {
        number: 1,
        title: 'Update session',
        head: { sha: 'head' },
        base: { sha: 'base' },
        stats: { total_files: 2 },
    };
    const stored = {
        configs: { riskAssessmentActive: false },
        repositories: [
            {
                id: 'repo',
                name: 'api',
                isSelected: true,
                configs: {},
                directories: [
                    {
                        id: 'auth',
                        name: 'Auth',
                        isSelected: true,
                        folders: [
                            {
                                id: 'auth-folder',
                                name: 'Auth',
                                path: 'src/auth',
                            },
                        ],
                        configs: {
                            riskAssessmentActive: true,
                            reviewMode: 'heavy',
                            riskCriteria: [
                                {
                                    id: 'auth',
                                    name: 'Auth',
                                    enabled: true,
                                    instructions: 'Check permission bypasses.',
                                },
                            ],
                        },
                    },
                ],
            },
        ],
    };
    const host = {
        getFilesByPullRequestId: jest.fn(async () => files),
        getPullRequest: jest.fn(async () => pr),
        getRepositoryContentFile: jest.fn(async () => undefined),
    };
    const base = new CodeBaseConfigService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        host as any,
        {} as any,
        {} as any,
        {} as any,
    );
    const configuration = {
        getConfig: (o, r, f) =>
            base.getMergedCodeReviewConfigs(o, r, stored as any, 'main', f),
    };
    const metadata = {
        getChangedFilesMetadata: jest.fn(async (_o, _r, _pr, last) =>
            last ? [docs] : files,
        ),
    };
    const resolve = new ResolveConfigStage(
        configuration as any,
        metadata as any,
        { findOne: async () => null } as any,
        { findByKey: async () => null } as any,
        {} as any,
    );
    const risk = new AssessPrRiskStage(
        new PrRiskAssessmentService(
            host as any,
            { read: async () => null } as any,
            { findByKey: async () => null } as any,
            { isEnabled: async () => true },
            { gateKodusCreditsForSlot: async () => null } as any,
        ),
    );
    const context = (incremental: boolean) =>
        ({
            organizationAndTeamData: org,
            repository: repo,
            pullRequest: pr,
            origin: 'webhook',
            ...(incremental
                ? { lastExecution: { lastAnalyzedCommit: 'previous' } }
                : {}),
        }) as any;
    return { resolve, risk, context, metadata, docs, files };
}

afterEach(() => jest.clearAllMocks());

it.each([false, true])(
    'uses complete PR paths for risk on a docs-only follow-up (renamed=%s)',
    async (renamed) => {
        jest.mocked(LLM.run).mockResolvedValue({
            level: 'high',
            reason: 'The session bypasses authorization.',
        } as any);
        const { resolve, risk, context, docs, files } = setup(renamed);
        const incremental = await risk.execute(
            await resolve.execute(context(true)),
        );
        const full = await risk.execute(await resolve.execute(context(false)));
        expect(incremental.preliminaryFiles).toEqual([docs]);
        expect(incremental.fullPrFiles).toEqual(files);
        for (const result of [incremental, full]) {
            expect(result.codeReviewConfig.riskAssessmentActive).toBe(true);
            expect(result.riskAssessment).toMatchObject({
                status: 'assessed',
                riskIdentified: true,
            });
            expect(
                riskApprovalVeto(true, result.riskAssessment, 'head'),
            ).toBeDefined();
            expect(
                resolveRiskReviewMode({
                    risk: result.riskAssessment,
                    configured: result.codeReviewConfig.reviewMode,
                    routing: result.codeReviewConfig.riskReviewRouting,
                    currentHeadSha: 'head',
                    heavyAllowed: true,
                }),
            ).toBe('heavy');
        }
        expect(incremental.riskAssessment).toEqual(full.riskAssessment);
    },
);

it('keeps the incremental review available when complete risk settings cannot be read', async () => {
    const { resolve, risk, context, metadata, docs } = setup();
    metadata.getChangedFilesMetadata.mockImplementation(
        async (_o, _r, _pr, last) => {
            if (!last) throw new Error('Complete diff unavailable');
            return [docs];
        },
    );
    const result = await risk.execute(await resolve.execute(context(true)));
    expect(result.preliminaryFiles).toEqual([docs]);
    expect(result.statusInfo?.status).not.toBe('skipped');
    expect(result.riskAssessment).toMatchObject({ status: 'unavailable' });
    expect(
        riskApprovalVeto(
            result.codeReviewConfig.riskAssessmentActive,
            result.riskAssessment,
            'head',
        ),
    ).toBeDefined();
    expect(LLM.run).not.toHaveBeenCalled();
    expect(
        resolveRiskReviewMode({
            risk: result.riskAssessment,
            configured: result.codeReviewConfig.reviewMode,
            routing: result.codeReviewConfig.riskReviewRouting,
            currentHeadSha: 'head',
            heavyAllowed: true,
        }),
    ).toBe('balanced');
});
