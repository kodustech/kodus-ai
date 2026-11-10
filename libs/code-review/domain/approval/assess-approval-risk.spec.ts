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

it.each(['low', 'medium', 'high'])(
    'bounds a long %s rationale without invalidating its judgment',
    async (level) => {
        (LLM.run as jest.Mock).mockImplementationOnce(async ({ schema }) =>
            schema.parse({ level, reason: 'x'.repeat(10_000) }),
        );
        const result = await assessApprovalRisk(input);
        expect(result.level).toBe(level);
        expect(result.reason).toHaveLength(2_000);
        expect(result.reason.endsWith('...')).toBe(true);
        expect(LLM.run).toHaveBeenCalledTimes(1);
    },
);

it.each([
    {
        name: 'AI_NoObjectGeneratedError',
        message: 'response did not match schema',
        category: 'UNKNOWN',
        status: undefined,
    },
    {
        name: 'Error',
        message: 'Rate limit exceeded',
        category: 'RATE_LIMIT',
        status: 429,
    },
    {
        name: 'Error',
        message: 'Insufficient quota',
        category: 'QUOTA_EXCEEDED',
        status: 402,
    },
])(
    'retains safe failure diagnostics for $name/$category',
    async ({ name, message, category, status }) => {
        const error = Object.assign(new Error(message), {
            name,
            statusCode: status,
        });
        (LLM.run as jest.Mock).mockRejectedValueOnce(error);
        const result = await assessApprovalRisk(input);
        expect(result).toMatchObject({
            level: 'unknown',
            failure: { errorName: name, category },
        });
        expect(result.failure).not.toHaveProperty('rawMessage');
        expect(result.failure).not.toHaveProperty('message');
    },
);

it.each([507, 510, 563, 691])(
    'preserves a valid %i-character reason through the production schema',
    async (length) => {
        const reason = 'A consequential change requires review. '.padEnd(
            length,
            'x',
        );
        (LLM.run as jest.Mock).mockImplementationOnce(async ({ schema }) =>
            schema.parse({ level: 'high', reason }),
        );
        expect(await assessApprovalRisk(input)).toMatchObject({
            level: 'high',
            reason,
            reviewedHeadSha: input.headSha,
        });
        expect(LLM.run).toHaveBeenCalledTimes(1);
    },
);

it.each([
    { level: 'safe', reason: 'A sufficiently long explanation.' },
    { level: 'low' },
    { level: 'low', reason: '        ' },
])('keeps invalid output unknown: %j', async (output) => {
    (LLM.run as jest.Mock).mockImplementationOnce(async ({ schema }) =>
        schema.parse(output),
    );
    expect(await assessApprovalRisk(input)).toMatchObject({
        level: 'unknown',
        reviewedHeadSha: input.headSha,
    });
});

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

it.each([
    ['src/status.ts', '+// never return null here'],
    ['src/status.ts', '+/** @return the risk level */'],
    ['src/status.ts', '+const note = "if (disabled) return null";'],
    ['src/status.ts', "+const note = 'throw new Error()';"],
    ['src/status.ts', '+const note = `if (disabled) return null`;'],
    ['src/status.ts', '+const note = /return\\s+null/;'],
    ['src/status.py', '+# return None'],
])(
    'does not treat prose or literals in %s as control flow: %s',
    async (filename, patch) => {
        (LLM.run as jest.Mock).mockResolvedValue({
            level: 'low',
            reason: 'Behavior unchanged.',
        });
        expect(
            (
                await assessApprovalRisk({
                    ...input,
                    files: [{ filename, status: 'modified', patch } as any],
                })
            ).level,
        ).toBe('low');
    },
);

it.each(['+// added test coverage', '+/* tests go here */', '+   '])(
    'does not count a test-only comment or whitespace as coverage: %s',
    async (patch) => {
        (LLM.run as jest.Mock).mockResolvedValue({
            level: 'low',
            reason: 'Behavior unchanged.',
        });
        expect(
            (
                await assessApprovalRisk({
                    ...input,
                    files: [
                        {
                            filename: 'src/status.ts',
                            status: 'modified',
                            patch: '+return allowAccess();',
                        },
                        {
                            filename: 'src/status.spec.ts',
                            status: 'modified',
                            patch,
                        },
                    ] as any,
                })
            ).level,
        ).toBe('medium');
    },
);

it.each([
    ['tests/StatusTests.cs', '+var fixture = @"test fixture";'],
    ['tests/status_test.rs', '+let fixture = r#"return test fixture"#;'],
])(
    'does not accept unverifiable %s text as test evidence',
    async (filename, patch) => {
        (LLM.run as jest.Mock).mockResolvedValue({
            level: 'low',
            reason: 'Behavior unchanged.',
        });
        expect(
            (
                await assessApprovalRisk({
                    ...input,
                    files: [
                        {
                            filename: 'src/status.ts',
                            status: 'modified',
                            patch: '+return authorize();',
                        },
                        { filename, status: 'modified', patch },
                    ] as any,
                })
            ).level,
        ).toBe('medium');
    },
);

it('keeps code after a JS private member visible to the control-flow guard', async () => {
    (LLM.run as jest.Mock).mockResolvedValue({
        level: 'low',
        reason: 'Behavior unchanged.',
    });
    expect(
        (
            await assessApprovalRisk({
                ...input,
                files: [
                    {
                        filename: 'src/status.ts',
                        status: 'modified',
                        patch: '+this.#access = true; return true;',
                    },
                ] as any,
            })
        ).level,
    ).toBe('medium');
});

it.each([
    '+const text = `value: ${(() => { return authorize(); })()}`;',
    '+const ratio = "value" / count; return authorize();',
])('keeps executable code visible around literals: %s', async (patch) => {
    (LLM.run as jest.Mock).mockResolvedValue({
        level: 'low',
        reason: 'Behavior unchanged.',
    });
    expect(
        (
            await assessApprovalRisk({
                ...input,
                files: [
                    { filename: 'src/status.ts', status: 'modified', patch },
                ] as any,
            })
        ).level,
    ).toBe('medium');
});

it.each([
    ['src/status.py', '+count //= 2; return authorize()'],
    ['src/status.go', '+text := `ends with a backslash\\`; return authorize()'],
])('keeps executable code visible in %s fragments', async (filename, patch) => {
    (LLM.run as jest.Mock).mockResolvedValue({
        level: 'low',
        reason: 'Behavior unchanged.',
    });
    expect(
        (
            await assessApprovalRisk({
                ...input,
                files: [{ filename, status: 'modified', patch }] as any,
            })
        ).level,
    ).toBe('medium');
});

it.each([
    ['src/status.cs', '+var text = @"path\\"; return Authorize();'],
    ['src/status.rs', "+fn authorize<'a>() { return true; }"],
    ['src/status.py', '+"""\n+if (disabled) return None\n+"""'],
    [
        'src/status.tsx',
        "+const title = <p>don't</p>; return authorize(); const footer = <p>don't</p>;",
    ],
])(
    'keeps unverifiable %s fragments unknown rather than asserting a code signal',
    async (filename, patch) => {
        (LLM.run as jest.Mock).mockResolvedValue({
            level: 'low',
            reason: 'Behavior unchanged.',
        });
        expect(
            (
                await assessApprovalRisk({
                    ...input,
                    files: [{ filename, status: 'modified', patch }] as any,
                })
            ).level,
        ).toBe('unknown');
    },
);

it('returns unknown when the model fails, so approval cannot proceed', async () => {
    (LLM.run as jest.Mock).mockRejectedValue(new Error('timeout'));

    expect(await assessApprovalRisk(input)).toMatchObject({
        level: 'unknown',
        reviewedHeadSha: 'abc123',
    });
});

it('keeps ambiguous JSX quotes unknown instead of masking executable control flow', async () => {
    (LLM.run as jest.Mock).mockResolvedValue({
        level: 'low',
        reason: 'Behavior unchanged.',
    });
    const result = await assessApprovalRisk({
        ...input,
        files: [
            {
                filename: 'src/status.tsx',
                status: 'modified',
                patch: "+const title = <p>don't change it</p>;\n+return authorize();\n+const footer = <p>don't change it</p>;",
            } as any,
        ],
    });
    expect(result.level).toBe('unknown');
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
