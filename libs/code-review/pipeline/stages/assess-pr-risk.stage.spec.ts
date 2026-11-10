import { AssessPrRiskStage } from './assess-pr-risk.stage';
import { PrRiskAssessmentService } from '../services/pr-risk-assessment.service';
import {
    assessPrRisk,
    prRiskSnapshot,
} from '@libs/code-review/domain/risk/assess-pr-risk';
import type { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

jest.mock('@libs/code-review/domain/risk/assess-pr-risk', () => ({
    ...jest.requireActual('@libs/code-review/domain/risk/assess-pr-risk'),
    assessPrRisk: jest.fn(),
}));

const files = [
    {
        filename: 'src/auth.ts',
        status: 'removed',
        deletions: 1,
        additions: 0,
        patch: '-guard()',
    },
];
const live = { head: { sha: 'head' }, base: { sha: 'base' } };
const context = (config = {}): CodeReviewPipelineContext =>
    ({
        organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
        repository: { id: 'repo', name: 'repo' },
        pullRequest: {
            ...live,
            number: 4,
            title: 'Change',
            stats: { total_files: 1 },
        },
        codeReviewConfig: {
            riskAssessmentActive: true,
            pullRequestApprovalActive: false,
            ignorePaths: ['src/**'],
            ...config,
        },
        preliminaryFiles: [{ filename: 'incremental-only.ts' }],
        origin: 'webhook',
    }) as any;

const management = {
    getFilesByPullRequestId: jest.fn(),
    getPullRequest: jest.fn(),
};
const maps = { read: jest.fn() };
const parameters = { findByKey: jest.fn() };
const access = { isEnabled: jest.fn() };
const permissions = { gateKodusCreditsForSlot: jest.fn() };
const service = new PrRiskAssessmentService(
    management as any,
    maps as any,
    parameters as any,
    access,
    permissions as any,
);
const stage = new AssessPrRiskStage(service);

beforeEach(() => {
    jest.resetAllMocks();
    management.getFilesByPullRequestId.mockResolvedValue(files);
    management.getPullRequest.mockResolvedValue(live);
    access.isEnabled.mockResolvedValue(true);
    permissions.gateKodusCreditsForSlot.mockResolvedValue(null);
    jest.mocked(assessPrRisk).mockResolvedValue({
        status: 'assessed',
        riskIdentified: true,
        reason: 'Removed access check.',
        snapshot: {
            organizationId: 'org',
            repositoryId: 'repo',
            prNumber: 4,
            headSha: 'head',
            baseSha: 'base',
            assessmentKey: 'key',
        },
    });
});

it('assesses once with auto-approval off, using the complete unfiltered provider diff', async () => {
    const result = await stage.execute(context());
    expect(result.riskAssessment).toMatchObject({
        status: 'assessed',
        riskIdentified: true,
    });
    expect(result.fullPrFiles).toEqual(files);
    expect(assessPrRisk).toHaveBeenCalledTimes(1);
    expect(assessPrRisk).toHaveBeenCalledWith(
        expect.objectContaining({
            files,
            repositoryId: 'repo',
            baseSha: 'base',
            headSha: 'head',
        }),
    );
});

it.each([false, undefined])(
    'does no provider, history or model work when shared risk is %s',
    async (active) => {
        expect(
            (await stage.execute(context({ riskAssessmentActive: active })))
                .riskAssessment,
        ).toEqual({ status: 'disabled' });
        expect(management.getFilesByPullRequestId).not.toHaveBeenCalled();
        expect(maps.read).not.toHaveBeenCalled();
        expect(assessPrRisk).not.toHaveBeenCalled();
    },
);

it('does not broaden existing entitlement checks', async () => {
    access.isEnabled.mockResolvedValue(false);
    expect((await stage.execute(context())).riskAssessment).toMatchObject({
        status: 'unavailable',
    });
    expect(assessPrRisk).not.toHaveBeenCalled();
});

it.each([
    { head: { sha: 'new-head' }, base: { sha: 'base' } },
    { head: { sha: 'head' }, base: { sha: 'new-base' } },
    undefined,
])(
    'holds an unavailable result when the snapshot changes during collection',
    async (pr) => {
        management.getPullRequest.mockResolvedValue(pr);
        expect((await stage.execute(context())).riskAssessment).toMatchObject({
            status: 'unavailable',
        });
        expect(assessPrRisk).not.toHaveBeenCalled();
    },
);

it('does not score when the provider rejects an incomplete file listing', async () => {
    const ctx = context();
    management.getFilesByPullRequestId.mockRejectedValueOnce(
        new Error('Truncated provider diff'),
    );
    expect((await stage.execute(ctx)).riskAssessment).toMatchObject({
        status: 'unavailable',
    });
    expect(assessPrRisk).not.toHaveBeenCalled();
});

it('does not score a resolved provider listing with missing file paths', async () => {
    management.getFilesByPullRequestId.mockResolvedValue([
        { ...files[0], filename: undefined },
    ]);
    expect((await stage.execute(context())).riskAssessment).toMatchObject({
        status: 'unavailable',
        reason: 'Kody could not verify the complete PR diff.',
    });
    expect(assessPrRisk).not.toHaveBeenCalled();
});

it('keeps history failure unavailable instead of claiming no risk', async () => {
    maps.read.mockRejectedValue(new Error('database failed'));
    expect((await stage.execute(context())).riskAssessment).toMatchObject({
        status: 'unavailable',
    });
    expect(assessPrRisk).not.toHaveBeenCalled();
});

it('does not call a model when assessment credits are exhausted', async () => {
    permissions.gateKodusCreditsForSlot.mockResolvedValue({
        reason: 'credits',
    });
    expect((await stage.execute(context())).riskAssessment).toMatchObject({
        status: 'unavailable',
    });
    expect(assessPrRisk).not.toHaveBeenCalled();
});

it('uses the dedicated risk task model rather than the already-selected review slot', async () => {
    parameters.findByKey.mockResolvedValue({
        configValue: {
            version: 2,
            credentials: [
                {
                    id: 'credential',
                    provider: 'openai',
                    apiKey: 'encrypted-key',
                },
            ],
            models: [
                { id: 'review', credentialId: 'credential', model: 'gpt-4o' },
                {
                    id: 'risk',
                    credentialId: 'credential',
                    model: 'gpt-4o-mini',
                },
            ],
            routing: {
                defaultModelId: 'review',
                taskOverrides: { riskAssessment: 'risk' },
            },
        },
    });
    await stage.execute(
        context({
            resolvedModelSlot: {
                provider: 'openai',
                model: 'some-review-model',
            },
        }),
    );
    expect(assessPrRisk).toHaveBeenCalledWith(
        expect.objectContaining({
            modelSlot: expect.objectContaining({
                model: 'gpt-4o-mini',
                route: 'riskAssessment',
                apiKey: 'encrypted-key',
            }),
        }),
    );
});

it('does not silently ignore malformed stored criteria', async () => {
    const ctx = context({
        riskCriteria: [
            {
                id: 'access',
                name: 'Access',
                enabled: true,
                instructions: 'Check access.',
                includedFiles: ['src/['],
            },
        ],
    });
    expect((await stage.execute(ctx)).riskAssessment).toMatchObject({
        status: 'unavailable',
        reason: 'Risk criteria are invalid.',
    });
    expect(assessPrRisk).not.toHaveBeenCalled();
});

it('does not treat a local CLI diff as a provider PR', async () => {
    const ctx = context();
    ctx.origin = 'cli';
    expect((await stage.execute(ctx)).riskAssessment).toMatchObject({
        status: 'unavailable',
    });
    expect(management.getFilesByPullRequestId).not.toHaveBeenCalled();
});

it('reuses an exact saved snapshot without another model call and reassesses changed guidance', async () => {
    jest.mocked(assessPrRisk).mockImplementation(async (input) => ({
        status: 'assessed',
        riskIdentified: false,
        reason: 'No material exposure.',
        snapshot: prRiskSnapshot(input),
    }));
    const first = await stage.execute(context());
    const ctx = {
        ...context(),
        lastExecution: { riskAssessment: first.riskAssessment },
    };
    const second = await stage.execute(ctx);
    expect(second.riskAssessment).toEqual(first.riskAssessment);
    expect(assessPrRisk).toHaveBeenCalledTimes(1);
    expect(permissions.gateKodusCreditsForSlot).toHaveBeenCalledTimes(1);
    await stage.execute({
        ...ctx,
        codeReviewConfig: {
            ...ctx.codeReviewConfig,
            riskCriteria: [
                {
                    id: 'data',
                    name: 'Customer data',
                    enabled: true,
                    instructions: 'Check cross-account reads.',
                },
            ],
        },
    });
    expect(assessPrRisk).toHaveBeenCalledTimes(2);
});

it.each([0, 1])(
    'reassesses after a stable-ID endpoint edit on model %s',
    async (edited) => {
        const stored = {
            version: 2,
            credentials: ['primary', 'fallback'].map((id) => ({
                id,
                provider: 'openai',
                apiKey: 'encrypted',
                settings: { baseURL: `https://${id}.example/v1` },
            })),
            models: [
                { id: 'primary', credentialId: 'primary', model: 'gpt-4o' },
                {
                    id: 'fallback',
                    credentialId: 'fallback',
                    model: 'gpt-4o-mini',
                },
            ],
            routing: { defaultModelId: 'primary', fallbackModelId: 'fallback' },
        };
        parameters.findByKey.mockResolvedValue({ configValue: stored });
        jest.mocked(assessPrRisk).mockImplementation(async (input) => ({
            status: 'assessed',
            riskIdentified: false,
            reason: 'No material exposure.',
            snapshot: prRiskSnapshot(input),
        }));
        const first = await stage.execute(context());
        const ctx = {
            ...context(),
            lastExecution: { riskAssessment: first.riskAssessment },
        };
        await stage.execute(ctx);
        expect(assessPrRisk).toHaveBeenCalledTimes(1);
        stored.credentials[edited].settings.baseURL =
            'https://edited.example/v1';
        const changed = await stage.execute(ctx);
        expect(assessPrRisk).toHaveBeenCalledTimes(2);
        if (
            changed.riskAssessment.status !== 'assessed' ||
            first.riskAssessment.status !== 'assessed'
        )
            throw new Error(
                'Both model configurations must produce assessed snapshots.',
            );
        expect(changed.riskAssessment.snapshot.configurationKey).not.toBe(
            first.riskAssessment.snapshot.configurationKey,
        );
        stored.credentials[edited].apiKey = 'rotated-secret';
        await stage.execute({
            ...ctx,
            lastExecution: { riskAssessment: changed.riskAssessment },
        });
        expect(assessPrRisk).toHaveBeenCalledTimes(2);
    },
);
