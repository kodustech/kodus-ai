import type { NamedApprovalPolicy } from '@libs/core/infrastructure/config/types/general/approval-policies';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    approvalPoliciesFromConfig,
    evaluateApprovalPolicies,
    type ApprovalPolicyInput,
} from './approval-policies';

const policy = (
    id: string,
    over: Partial<NamedApprovalPolicy> = {},
): NamedApprovalPolicy => ({ id, name: id, enabled: true, ...over });
const file = (filename: string) => ({
    filename,
    additions: 1,
    deletions: 0,
    patch: '+change',
});
const run = (over: Partial<ApprovalPolicyInput> = {}) =>
    evaluateApprovalPolicies({
        approvalActive: true,
        reviewClean: true,
        riskEnabled: false,
        currentHeadSha: 'head',
        policies: [policy('Docs', { includedFiles: ['docs/**'] })],
        files: [file('docs/readme.md')],
        ...over,
    });
const risk = (riskIdentified: boolean) => ({
    status: 'assessed' as const,
    riskIdentified,
    reason: 'Assessment reason.',
    snapshot: {
        organizationId: 'org',
        repositoryId: 'repo',
        prNumber: 1,
        baseSha: 'base',
        headSha: 'head',
        assessmentKey: 'key',
    },
});

it('allows non-overlapping policies to approve only their own PRs', async () => {
    const policies = [
        policy('Docs', { includedFiles: ['docs/**'] }),
        policy('Dependencies', {
            includedFiles: ['package.json', 'yarn.lock'],
            authors: ['dependabot[bot]'],
        }),
    ];
    expect((await run({ policies })).matchedPolicy?.name).toBe('Docs');
    expect(
        (
            await run({
                policies,
                author: 'dependabot[bot]',
                files: [file('package.json')],
            })
        ).matchedPolicy?.name,
    ).toBe('Dependencies');
    expect(
        (
            await run({
                policies,
                author: 'alice',
                files: [file('package.json')],
            })
        ).kind,
    ).toBe('out-of-scope');
    expect((await run({ policies, files: [file('src/auth.ts')] })).kind).toBe(
        'out-of-scope',
    );
});

it('ANDs groups within a policy and ORs enabled policies', async () => {
    const policies = [
        policy('Bot', {
            labels: ['ready', 'dependencies'],
            authors: ['dependabot[bot]'],
        }),
        policy('Docs', { includedFiles: ['docs/**'] }),
    ];
    expect(
        (
            await run({
                policies,
                author: 'Dependabot[bot]',
                labels: ['DEPENDENCIES'],
                files: [file('package.json')],
            })
        ).matchedPolicy?.name,
    ).toBe('Bot');
    expect(
        (
            await run({
                policies,
                author: 'alice',
                labels: ['dependencies'],
                files: [file('package.json')],
            })
        ).kind,
    ).toBe('out-of-scope');
    expect(
        (await run({ policies, author: 'alice', labels: [] })).matchedPolicy
            ?.name,
    ).toBe('Docs');
});

it('never lets a disabled policy approve, including an unrestricted one', async () => {
    const result = await run({
        policies: [policy('All clean PRs', { enabled: false })],
    });
    expect(result.kind).toBe('hold');
    expect(result.policies[0].status).toBe('disabled');
});

it('shows unrestricted policies explicitly in the result without requiring a new all-PRs input', async () => {
    const result = await run({
        policies: [policy('All clean PRs')],
        files: undefined,
    });
    expect(result.kind).toBe('approve');
    expect(result.reason).toContain('All clean PRs');
});

it.each([
    { includedFiles: ['src/**'] },
    { excludedFiles: ['docs/**'] },
    { maxChangedLines: 0 },
    { authors: ['other'] },
    { labels: ['ready'] },
])('does not approve when a fixed condition fails: %j', async (condition) => {
    expect(
        (await run({ policies: [policy('Condition', condition)] })).kind,
    ).toBe('out-of-scope');
});

it('never uses an instruction to override a failed file condition', async () => {
    const judgeEligibility = jest
        .fn()
        .mockResolvedValue({ status: 'eligible' });
    const result = await run({
        policies: [
            policy('Dependency', {
                includedFiles: ['package.json'],
                instruction: 'Only dependency bumps.',
            }),
        ],
        judgeEligibility,
    });
    expect(result.kind).toBe('out-of-scope');
    expect(judgeEligibility).not.toHaveBeenCalled();
});

it('evaluates instructions only for policies whose fixed conditions pass, stopping at the first yes', async () => {
    const judgeEligibility = jest
        .fn()
        .mockResolvedValue({ status: 'eligible' });
    const policies = [
        policy('Outside', { labels: ['missing'], instruction: 'No.' }),
        policy('First', { instruction: 'Yes.' }),
        policy('Second', { instruction: 'Also yes.' }),
    ];
    const result = await run({ policies, labels: [], judgeEligibility });
    expect(result.matchedPolicy?.name).toBe('First');
    expect(judgeEligibility).toHaveBeenCalledTimes(1);
    expect(judgeEligibility).toHaveBeenCalledWith(policies[1]);
    expect(result.policies[2]).toMatchObject({
        status: 'not-evaluated',
        reason: 'earlier-policy-matched',
    });
});

it('allows a later policy when an earlier instruction is unavailable, without treating the failed policy as a match', async () => {
    const result = await run({
        policies: [
            policy('Instruction', { instruction: 'Check intent.' }),
            policy('Docs'),
        ],
        judgeEligibility: async () => {
            throw new Error('Timeout');
        },
    });
    expect(result.matchedPolicy?.name).toBe('Docs');
    expect(result.policies[0]).toMatchObject({
        status: 'unavailable',
        reason: 'instruction-unavailable',
    });
});

it.each([
    true,
    { status: 'unavailable', reason: 'Failed.' },
    undefined,
    { status: 'disabled' },
])('vetoes every policy for unconfirmed safe risk %j', async (assessment) => {
    const judgeEligibility = jest.fn();
    const result = await run({
        riskEnabled: true,
        risk: assessment === true ? risk(true) : (assessment as any),
        policies: [policy('All', { instruction: 'Approve everything.' })],
        judgeEligibility,
    });
    expect(result.kind).toBe('hold');
    expect(judgeEligibility).not.toHaveBeenCalled();
});

it('requires current no-risk evidence when assessment is enabled and removes only that veto when disabled', async () => {
    expect((await run({ riskEnabled: true, risk: risk(false) })).kind).toBe(
        'approve',
    );
    expect(
        (
            await run({
                riskEnabled: true,
                risk: risk(false),
                currentHeadSha: 'new',
            })
        ).kind,
    ).toBe('hold');
    expect((await run({ riskEnabled: false, risk: risk(true) })).kind).toBe(
        'approve',
    );
    expect((await run({ riskEnabled: false, reviewClean: false })).kind).toBe(
        'hold',
    );
});

it('keeps sensitive paths global even when a later unrestricted policy matches', async () => {
    expect(
        (await run({ policies: [policy('All')], sensitivePaths: ['docs/**'] }))
            .kind,
    ).toBe('hold');
});

it('matches usernames and provider team membership as alternative author choices', async () => {
    const resolveTeamMembership = jest.fn().mockResolvedValue('member');
    const policies = [
        policy('Team', {
            authors: ['dependabot[bot]'],
            authorTeams: ['acme/backend'],
        }),
    ];
    expect(
        (await run({ policies, author: 'alice', resolveTeamMembership })).kind,
    ).toBe('approve');
    resolveTeamMembership.mockClear();
    expect(
        (
            await run({
                policies,
                author: 'dependabot[bot]',
                resolveTeamMembership,
            })
        ).kind,
    ).toBe('approve');
    expect(resolveTeamMembership).not.toHaveBeenCalled();
});

it('never assumes membership from an error or missing permission and caches only within one evaluation', async () => {
    const resolveTeamMembership = jest
        .fn()
        .mockRejectedValue(new Error('Forbidden'));
    const policies = [
        policy('Team one', { authorTeams: ['acme/backend'] }),
        policy('Team two', { authorTeams: ['acme/backend'] }),
    ];
    const result = await run({
        policies,
        author: 'alice',
        resolveTeamMembership,
    });
    expect(result.kind).toBe('out-of-scope');
    expect(resolveTeamMembership).toHaveBeenCalledTimes(1);
    expect(
        result.policies.every((row) => row.reason === 'author-unavailable'),
    ).toBe(true);
    await run({ policies, author: 'alice', resolveTeamMembership });
    expect(resolveTeamMembership).toHaveBeenCalledTimes(2);
});

it('publishes a reason per enabled non-matching policy without exposing instructions or filter values', async () => {
    const result = await run({
        policies: [
            policy('Labels', { labels: ['private-label'] }),
            policy('Instruction', { instruction: 'Our private strategy.' }),
        ],
        labels: [],
        judgeEligibility: async () => ({ status: 'ineligible' }),
    });
    expect(result.reason).toContain('Labels: Required labels did not match.');
    expect(result.reason).toContain(
        'Instruction: The eligibility instruction did not match.',
    );
    expect(result.reason).not.toContain('private-label');
    expect(result.reason).not.toContain('private strategy');
});

it('refuses unsupported provider labels instead of silently widening a new policy', async () => {
    expect(
        (
            await run({
                platformType: PlatformType.BITBUCKET,
                policies: [policy('Label', { labels: ['ready'] })],
                labels: ['ready'],
            })
        ).kind,
    ).toBe('out-of-scope');
});

it('migrates the legacy single scope and preserves an explicitly empty policy list', () => {
    expect(
        approvalPoliciesFromConfig({
            approvalLabels: ['ready'],
            approvalAuthors: ['alice'],
        }),
    ).toEqual([
        policy('legacy-approval', {
            name: 'Existing approval policy',
            labels: ['ready'],
            authors: ['alice'],
        }),
    ]);
    expect(approvalPoliciesFromConfig({ approvalPolicies: [] })).toEqual([]);
});
