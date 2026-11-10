import {
    ApprovalPoliciesService,
    type ApprovalPoliciesRequest,
} from './approval-policies.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { LLM } from '@libs/llm/llm';
import { routeCodeReviewModel } from '../stages/route-code-review-model';

jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));
const policy = {
    id: 'docs',
    name: 'Docs',
    enabled: true,
    instruction: 'Only documentation changes.',
};
const file = {
    filename: 'docs/readme.md',
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: '+New docs',
};
const live = {
    head: { sha: 'head' },
    base: { sha: 'base' },
    title: 'Update docs',
    body: '',
    user: { login: 'alice' },
    labels: ['docs'],
};
const request = (
    override: Partial<ApprovalPoliciesRequest> = {},
): ApprovalPoliciesRequest => ({
    organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
    repository: { id: 'repo', name: 'acme/repo' },
    pullRequest: { number: 4, head: { sha: 'head' }, base: { sha: 'base' } },
    config: {
        pullRequestApprovalActive: true,
        riskAssessmentActive: false,
        approvalPolicies: [policy],
    } as any,
    platformType: PlatformType.GITHUB,
    reviewClean: true,
    ...override,
});
const code = {
    getPullRequest: jest.fn(),
    getFilesByPullRequestId: jest.fn(),
    getApprovalTeamMembership: jest.fn(),
};
const org = { findByKey: jest.fn() };
const access = { isEnabled: jest.fn() };
const permissions = { gateKodusCreditsForSlot: jest.fn() };
const service = () =>
    new ApprovalPoliciesService(
        code as any,
        org as any,
        access as any,
        permissions as any,
    );
beforeEach(() => {
    jest.resetAllMocks();
    code.getPullRequest.mockResolvedValue(live);
    code.getFilesByPullRequestId.mockResolvedValue([file]);
    access.isEnabled.mockResolvedValue(true);
    permissions.gateKodusCreditsForSlot.mockResolvedValue(undefined);
    jest.mocked(LLM.run).mockResolvedValue({ judgment: 'eligible' } as any);
});

it('never echoes private configuration errors in an approval decision', async () => {
    const input = request();
    input.config.reviewSettingsError =
        'PRIVATE-INSTRUCTIONS from a malformed saved setting';
    expect((await service().evaluate(input)).decision).toMatchObject({
        kind: 'hold',
        reason: 'Risk or approval settings are invalid. Check your configuration.',
    });
    expect(code.getPullRequest).not.toHaveBeenCalled();
});

it('uses the complete PR diff and persists explicit eligibility on the reviewed snapshot', async () => {
    const result = await service().evaluate(request());
    expect(result.decision).toMatchObject({
        kind: 'approve',
        matchedPolicy: { id: 'docs', name: 'Docs' },
        reviewedHeadSha: 'head',
        reviewedBaseSha: 'base',
    });
    expect(Object.values(result.eligibility)).toEqual([
        { status: 'eligible', key: expect.any(String) },
    ]);
    expect(code.getFilesByPullRequestId).toHaveBeenCalledWith(
        expect.objectContaining({ headSha: 'head', prNumber: 4 }),
    );
    expect(LLM.run).toHaveBeenCalledTimes(1);
});

it('holds a line-limited policy for a modified binary renamed without a verified line count', async () => {
    code.getFilesByPullRequestId.mockResolvedValue([
        {
            filename: 'assets/new.bin',
            previous_filename: 'assets/old.bin',
            status: 'renamed',
            additions: 0,
            deletions: 0,
        },
    ]);
    const result = await service().evaluate(
        request({
            config: {
                ...request().config,
                approvalPolicies: [
                    {
                        id: 'small',
                        name: 'Small changes',
                        enabled: true,
                        maxChangedLines: 10,
                    },
                ],
            } as any,
        }),
    );
    expect(result.decision.kind).not.toBe('approve');
    expect(JSON.stringify(result.decision)).toContain('line-count-unavailable');
    expect(LLM.run).not.toHaveBeenCalled();
});

it.each([
    { reviewClean: false },
    {
        config: { ...request().config, riskAssessmentActive: true },
        risk: { status: 'unavailable', reason: 'Failure' },
    },
    { config: { ...request().config, pullRequestApprovalActive: false } },
    { pullRequest: { number: 4, head: { sha: 'head' } } },
])(
    'rejects unsafe or incomplete review states before provider/model work: %j',
    async (override) => {
        const result = await service().evaluate(request(override as any));
        expect(result.decision.kind).not.toBe('approve');
        expect(LLM.run).not.toHaveBeenCalled();
        expect(code.getPullRequest).not.toHaveBeenCalled();
    },
);

it('reuses exact eligibility without another model call or credit check', async () => {
    const first = await service().evaluate(request());
    jest.mocked(LLM.run).mockClear();
    permissions.gateKodusCreditsForSlot.mockClear();
    const second = await service().evaluate(
        request({ previousEligibility: first.eligibility }),
    );
    expect(second.decision.kind).toBe('approve');
    expect(LLM.run).not.toHaveBeenCalled();
    expect(permissions.gateKodusCreditsForSlot).not.toHaveBeenCalled();
});

it.each([{ byokModelId: 'pinned' }, { byokModel: 'gpt-4o-mini' }])(
    'reuses pipeline eligibility in cron with the same scoped model: %j',
    async (override) => {
        const stored = {
            version: 2,
            credentials: [
                { id: 'credential', provider: 'openai', apiKey: 'ciphertext' },
            ],
            models: [
                { id: 'default', credentialId: 'credential', model: 'gpt-4o' },
                {
                    id: 'pinned',
                    credentialId: 'credential',
                    model: 'gpt-4o-mini',
                },
            ],
            routing: { defaultModelId: 'default' },
        };
        org.findByKey.mockResolvedValue({ configValue: stored });
        const config = { ...request().config, ...override };
        const routed = routeCodeReviewModel(stored, config);
        expect(routed.resolvedModelSlot?.model).toBe('gpt-4o-mini');
        const pipeline = await service().evaluate(
            request({ config: { ...config, ...routed } }),
        );
        expect(pipeline.decision.kind).toBe('approve');
        jest.mocked(LLM.run).mockClear();
        permissions.gateKodusCreditsForSlot.mockClear();
        const cron = await service().evaluate(
            request({ config, previousEligibility: pipeline.eligibility }),
        );
        expect(cron.decision.kind).toBe('approve');
        expect(cron.eligibility).toEqual(pipeline.eligibility);
        expect(LLM.run).not.toHaveBeenCalled();
        expect(permissions.gateKodusCreditsForSlot).not.toHaveBeenCalled();
        const changed = await service().evaluate(
            request({
                config: { ...request().config, byokModelId: 'default' },
                previousEligibility: pipeline.eligibility,
            }),
        );
        expect(changed.decision.kind).toBe('approve');
        expect(LLM.run).toHaveBeenCalledTimes(1);
        expect(changed.eligibility).not.toEqual(pipeline.eligibility);
    },
);

it('invalidates cached eligibility when the PR body changes on the same head', async () => {
    const first = await service().evaluate(request());
    code.getPullRequest.mockResolvedValue({
        ...live,
        body: 'Change new behavior.',
    });
    jest.mocked(LLM.run).mockResolvedValue({ judgment: 'ineligible' } as any);
    expect(
        (
            await service().evaluate(
                request({ previousEligibility: first.eligibility }),
            )
        ).decision.kind,
    ).toBe('out-of-scope');
    expect(LLM.run).toHaveBeenCalledTimes(2);
});

it('does not reuse an unavailable result', async () => {
    jest.mocked(LLM.run).mockRejectedValueOnce(new Error('Timeout'));
    const first = await service().evaluate(request());
    expect(first.decision.kind).toBe('out-of-scope');
    const second = await service().evaluate(
        request({ previousEligibility: first.eligibility }),
    );
    expect(second.decision.kind).toBe('approve');
    expect(LLM.run).toHaveBeenCalledTimes(2);
});

it('reuses the independently fetched complete diff instead of fetching again', async () => {
    await service().evaluate(request({ fullPrFiles: [file] as any }));
    expect(code.getFilesByPullRequestId).not.toHaveBeenCalled();
    expect(LLM.run).toHaveBeenCalledTimes(1);
});

it('prevents approval when the head or base changes while eligibility runs', async () => {
    code.getPullRequest
        .mockResolvedValueOnce(live)
        .mockResolvedValue({ ...live, base: { sha: 'new-base' } });
    expect((await service().evaluate(request())).decision).toMatchObject({
        kind: 'hold',
        reason: expect.stringContaining('changed'),
    });
});

it.each([
    { labels: [] },
    { body: 'New description' },
    { user: { login: 'bob' } },
])(
    'invalidates approval for same-head metadata changes while the model runs: %j',
    async (change) => {
        code.getPullRequest
            .mockResolvedValueOnce(live)
            .mockResolvedValue({ ...live, ...change });
        expect((await service().evaluate(request())).decision.kind).toBe(
            'hold',
        );
    },
);

it('holds for missing files, inaccessible provider or insufficient credits', async () => {
    code.getFilesByPullRequestId.mockResolvedValue([]);
    expect((await service().evaluate(request())).decision.kind).toBe('hold');
    code.getFilesByPullRequestId.mockResolvedValue([file]);
    permissions.gateKodusCreditsForSlot.mockResolvedValue('limit');
    expect((await service().evaluate(request())).decision.kind).toBe(
        'out-of-scope',
    );
    expect(LLM.run).not.toHaveBeenCalled();
});

it('keeps an explicit empty policy list empty', async () => {
    const result = await service().evaluate(
        request({ config: { ...request().config, approvalPolicies: [] } }),
    );
    expect(result.decision.kind).toBe('hold');
    expect(LLM.run).not.toHaveBeenCalled();
});

it('preserves unrestricted legacy approval without conditional feature access', async () => {
    access.isEnabled.mockResolvedValue(false);
    const config = {
        ...request().config,
        approvalPolicies: [
            {
                id: 'legacy-approval',
                name: 'Existing approval policy',
                enabled: true,
            },
        ],
    };
    expect((await service().evaluate(request({ config }))).decision.kind).toBe(
        'approve',
    );
    expect(LLM.run).not.toHaveBeenCalled();
});

it('preserves ignored legacy Bitbucket labels without allowing new label conditions', async () => {
    const config = {
        ...request().config,
        approvalPolicies: [
            {
                id: 'legacy-approval',
                name: 'Existing approval policy',
                enabled: true,
                labels: ['legacy-label'],
            },
        ],
    };
    expect(
        (
            await service().evaluate(
                request({ config, platformType: PlatformType.BITBUCKET }),
            )
        ).decision.kind,
    ).toBe('approve');
    config.approvalPolicies[0].id = 'new-policy';
    expect(
        (
            await service().evaluate(
                request({ config, platformType: PlatformType.BITBUCKET }),
            )
        ).decision.kind,
    ).toBe('out-of-scope');
});

it('performs team membership lookups afresh even when eligibility was cached', async () => {
    const config = {
        ...request().config,
        approvalPolicies: [{ ...policy, authorTeams: ['acme/docs'] }],
    };
    code.getApprovalTeamMembership
        .mockResolvedValueOnce('member')
        .mockResolvedValue('not-member');
    const first = await service().evaluate(request({ config }));
    expect(first.decision.kind).toBe('approve');
    const second = await service().evaluate(
        request({ config, previousEligibility: first.eligibility }),
    );
    expect(second.decision.kind).toBe('out-of-scope');
    expect(code.getApprovalTeamMembership).toHaveBeenCalledTimes(2);
    expect(LLM.run).toHaveBeenCalledTimes(1);
});

it('reports the failing approval phase without exporting private error content', async () => {
    const current = service();
    const warn = jest
        .spyOn((current as any).logger, 'warn')
        .mockImplementation(() => undefined);
    const secret = 'private-token-canary';
    const error = new TypeError(secret);
    error.stack = `TypeError: ${secret}\n at libs/code-review/${secret}.ts:123:1`;
    code.getPullRequest.mockRejectedValue(error);
    try {
        expect((await current.evaluate(request())).decision).toMatchObject({
            kind: 'hold',
            reason: 'Approval conditions could not be verified.',
        });
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    phase: 'pr-snapshot',
                    errorType: 'TypeError',
                    repositoryId: 'repo',
                }),
            }),
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
        expect(warn.mock.calls[0][0]).not.toHaveProperty('error');
    } finally {
        warn.mockRestore();
    }
});
