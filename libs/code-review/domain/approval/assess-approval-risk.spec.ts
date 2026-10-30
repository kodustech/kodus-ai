import { LLM } from '@libs/llm/llm';
import { assessApprovalRisk } from './assess-approval-risk';

jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));

const input = {
    organizationId: 'org-1',
    prNumber: 42,
    title: 'Update login flow',
    body: 'Keep session state after redirect.',
    headSha: 'abc123',
    files: [
        {
            filename: 'src/auth/login.ts',
            status: 'modified' as const,
            additions: 3,
            deletions: 1,
            changes: 4,
            patch: '@@ -1 +1 @@\n-old\n+new',
        },
    ] as any,
    teamInstructions: 'Treat auth changes as consequential.',
};

afterEach(() => jest.clearAllMocks());

it('uses the production model slot and includes area evidence and coverage', async () => {
    (LLM.run as jest.Mock).mockResolvedValue({
        level: 'medium',
        reason: 'Authentication flow needs a human review.',
    });
    const areaMap = {
        version: 'map-v1',
        source: 'github',
        windowStart: '2025-01-01',
        windowEnd: '2025-02-01',
        refreshedAt: '2025-02-02',
        coverage: {
            discoveredMergedPrs: 20,
            scannedPrs: 10,
            prsWithCompleteFiles: 8,
            prsWithIssueSupport: 5,
            scanComplete: false,
        },
        files: [
            {
                path: 'src/auth/login.ts',
                changedPrs: 6,
                linkedBugFixPrs: 2,
                titleBugFixPrs: 1,
                recentEvidence: [],
            },
        ],
        directories: [],
        directDirectories: [],
    };

    const result = await assessApprovalRisk({
        ...input,
        areaMap,
        modelSlot: { provider: 'openai', model: 'gpt-test' } as any,
    });

    expect(result).toEqual({
        level: 'medium',
        reason: 'Authentication flow needs a human review.',
        reviewedHeadSha: 'abc123',
        areaMapVersion: 'map-v1',
    });
    const request = (LLM.run as jest.Mock).mock.calls[0][0];
    expect(request.byokConfig).toMatchObject({ model: 'gpt-test' });
    expect(request.user).toContain('"linkedBugFixPrs":2');
    expect(request.user).toContain('"prsWithCompleteFiles":8');
});

it('returns unknown when the model fails, so approval cannot proceed', async () => {
    (LLM.run as jest.Mock).mockRejectedValue(new Error('timeout'));

    expect(await assessApprovalRisk(input)).toMatchObject({
        level: 'unknown',
        reviewedHeadSha: 'abc123',
    });
});

it.each([
    ['PricingService.cs', '+        if (preco == 0) return 0m;'],
    [
        'EmailService.cs',
        '+        if (IsNullOrWhiteSpace(destinatario)) return false;',
    ],
])(
    'holds an untested control-flow guard in %s even if the model says low',
    async (filename, addedLine) => {
        (LLM.run as jest.Mock).mockResolvedValue({
            level: 'low',
            reason: 'Behavior unchanged.',
        });

        const result = await assessApprovalRisk({
            ...input,
            files: [
                {
                    filename,
                    status: 'modified',
                    patch: `@@ -1 +1 @@\n${addedLine}`,
                } as any,
            ],
        });

        expect(result.level).toBe('medium');
        expect(result.reason).toContain('without test evidence');
    },
);

it('allows a low judgment when the PR includes a test for the control-flow change', async () => {
    (LLM.run as jest.Mock).mockResolvedValue({
        level: 'low',
        reason: 'Behavior is covered by the added test.',
    });

    const result = await assessApprovalRisk({
        ...input,
        files: [
            {
                filename: 'src/EmailService.cs',
                patch: '@@ -1 +1 @@\n+if (missing) return false;',
            } as any,
            {
                filename: 'tests/EmailServiceTests.cs',
                patch: '@@ -1 +1 @@\n+test',
            } as any,
        ],
    });

    expect(result.level).toBe('low');
});

it.each([
    'tests/EmailServiceTests.cs',
    'test_email.py',
    'email_test.go',
    'EmailServiceTest.java',
    'test_email.rs',
])('recognizes added test evidence in %s', async (testPath) => {
    (LLM.run as jest.Mock).mockResolvedValue({
        level: 'low',
        reason: 'Behavior is covered by a changed test.',
    });

    const result = await assessApprovalRisk({
        ...input,
        files: [
            {
                filename: 'src/EmailService.cs',
                status: 'modified',
                patch: '@@ -1 +1 @@\n+if (missing) return false;',
            } as any,
            {
                filename: testPath,
                status: 'modified',
                patch: '@@ -1 +1 @@\n+assert behavior',
            } as any,
        ],
    });

    expect(result.level).toBe('low');
});

it.each([
    { status: 'removed', patch: '@@ -1 +0 @@\n-assert behavior' },
    { status: 'modified', patch: '@@ -1 +0 @@\n-assert behavior' },
])('does not count deleted test evidence (%p)', async (testChange) => {
    (LLM.run as jest.Mock).mockResolvedValue({
        level: 'low',
        reason: 'Behavior unchanged.',
    });

    const result = await assessApprovalRisk({
        ...input,
        files: [
            {
                filename: 'src/EmailService.cs',
                status: 'modified',
                patch: '@@ -1 +1 @@\n+if (missing) return false;',
            } as any,
            { filename: 'tests/EmailServiceTests.cs', ...testChange } as any,
        ],
    });

    expect(result.level).toBe('medium');
});
