import { LLM } from '@libs/llm/llm';
import {
    applicableRiskCriteria,
    assessPrRisk,
    prRiskSnapshot,
    type AssessPrRiskInput,
} from './assess-pr-risk';

jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));

const input: AssessPrRiskInput = {
    organizationId: 'org',
    repositoryId: 'repo',
    prNumber: 4,
    baseSha: 'base',
    headSha: 'head',
    title: 'Move code',
    files: [
        {
            filename: 'docs/auth.ts',
            previous_filename: 'src/auth.ts',
            status: 'renamed',
            additions: 0,
            deletions: 0,
            patch: '',
        },
    ] as any,
};
const criterion = {
    id: 'access',
    name: 'Access control',
    enabled: true,
    instructions: 'Check isolation across accounts.',
    includedFiles: ['src/**'],
};
beforeEach(() => jest.resetAllMocks());

it('assesses without team criteria and makes one shared model call', async () => {
    jest.mocked(LLM.run).mockResolvedValue({
        judgment: 'no-risk',
        reason: 'Equivalent refactor preserves behavior.',
    } as any);
    expect(await assessPrRisk(input)).toMatchObject({
        status: 'assessed',
        riskIdentified: false,
    });
    expect(LLM.run).toHaveBeenCalledTimes(1);
    const request = jest.mocked(LLM.run).mock.calls[0][0];
    expect(request.runName).toBe('pr-risk-assessment');
    expect(JSON.parse(request.user as string).teamCriteria).toEqual([]);
    expect(request.system).toContain('independently of approval');
    expect(request.system).toContain('untrusted data');
});

it('sends both rename paths and removed files, never just the latest incremental files', async () => {
    jest.mocked(LLM.run).mockResolvedValue({
        judgment: 'risk-found',
        reason: 'An authorization guard was removed.',
    } as any);
    const files = [
        ...input.files,
        {
            filename: 'src/guard.ts',
            status: 'removed',
            patch: '-guard()',
            deletions: 1,
            additions: 0,
        },
    ] as any;
    expect(await assessPrRisk({ ...input, files })).toMatchObject({
        status: 'assessed',
        riskIdentified: true,
    });
    const data = JSON.parse(
        jest.mocked(LLM.run).mock.calls[0][0].user as string,
    );
    expect(data.pullRequestData.files).toHaveLength(2);
    expect(data.pullRequestData.files[0]).toMatchObject({
        previousPath: 'src/auth.ts',
        path: 'docs/auth.ts',
    });
    expect(data.pullRequestData.files[1]).toMatchObject({
        status: 'removed',
        diff: '-guard()',
    });
    expect(data.historyCoverage).toBeNull();
});

it('applies optional guidance to both rename paths and respects exclusions and disabled criteria', () => {
    expect(
        applicableRiskCriteria([criterion], input.files)[0].matchingPaths,
    ).toEqual(['src/auth.ts']);
    expect(
        applicableRiskCriteria(
            [{ ...criterion, excludedFiles: ['src/**'] }],
            input.files,
        ),
    ).toEqual([]);
    expect(
        applicableRiskCriteria([{ ...criterion, enabled: false }], input.files),
    ).toEqual([]);
});

it.each([
    undefined,
    {},
    { judgment: 'no-risk', reason: '' },
    { judgment: 'low', reason: 'Old risk format.' },
])('fails closed for malformed or empty result %j', async (result) => {
    jest.mocked(LLM.run).mockResolvedValue(result as any);
    expect(await assessPrRisk(input)).toMatchObject({ status: 'unavailable' });
});

it('keeps insufficient context distinct from no risk', async () => {
    jest.mocked(LLM.run).mockResolvedValue({
        judgment: 'insufficient-context',
        reason: 'The affected contract is not available.',
    } as any);
    expect(await assessPrRisk(input)).toMatchObject({
        status: 'unavailable',
        reason: 'The affected contract is not available.',
    });
});

it('retains a long valid judgment and bounds only its explanation', async () => {
    jest.mocked(LLM.run).mockResolvedValue({
        judgment: 'risk-found',
        reason: 'x'.repeat(10_000),
    } as any);
    const result = await assessPrRisk(input);
    expect(result).toMatchObject({ status: 'assessed', riskIdentified: true });
    expect('reason' in result && result.reason).toHaveLength(2000);
});

it('does not disclose a provider error or secret in an unavailable result', async () => {
    jest.mocked(LLM.run).mockRejectedValue(
        new Error('private credential and provider message'),
    );
    const result = await assessPrRisk(input);
    expect(result).toMatchObject({
        status: 'unavailable',
        failure: { errorName: 'Error' },
    });
    expect(JSON.stringify(result)).not.toContain('private credential');
});

it.each([
    { baseSha: '' },
    { headSha: '' },
    { files: [] },
    { files: [{ ...input.files[0], patch: 'x'.repeat(100_001) }] },
])(
    'does not call the model for an incomplete or oversized snapshot %j',
    async (overrides) => {
        expect(await assessPrRisk({ ...input, ...overrides })).toMatchObject({
            status: 'unavailable',
        });
        expect(LLM.run).not.toHaveBeenCalled();
    },
);

it('invalidates identity when guidance, model, history, PR data or the diff changes', () => {
    const key = prRiskSnapshot(input).assessmentKey;
    for (const overrides of [
        { criteria: [criterion] },
        { title: 'Changed' },
        { body: 'New context' },
        { modelSlot: { provider: 'openai', model: 'other' } as any },
        { areaMap: { version: 'new-history' } as any },
        { files: [{ ...input.files[0], patch: '+new()' }] },
    ])
        expect(
            prRiskSnapshot({ ...input, ...overrides }).assessmentKey,
        ).not.toBe(key);
    expect(
        prRiskSnapshot({
            ...input,
            modelSlot: {
                provider: 'openai',
                model: 'same',
                apiKey: 'secret-a',
            } as any,
        }).assessmentKey,
    ).toBe(
        prRiskSnapshot({
            ...input,
            modelSlot: {
                provider: 'openai',
                model: 'same',
                apiKey: 'secret-b',
            } as any,
        }).assessmentKey,
    );
});
