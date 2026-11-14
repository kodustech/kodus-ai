import { LLM } from '@libs/llm/llm';
import * as contextWindows from '@libs/llm/model-context-window';
import { assessApprovalRisk } from './assess-approval-risk';

jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));
jest.mock('@libs/llm/model-context-window', () => ({
    ...jest.requireActual('@libs/llm/model-context-window'),
    resolveContextWindowWithSource: jest.fn(),
}));

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

beforeEach(() => {
    jest.mocked(
        contextWindows.resolveContextWindowWithSource,
    ).mockImplementation(
        jest.requireActual('@libs/llm/model-context-window')
            .resolveContextWindowWithSource,
    );
});
afterEach(() => jest.clearAllMocks());

it.each([
    ['byok', 'unknown', 0],
    ['litellm', 'unknown', 0],
    ['override', 'low', 1],
    ['models.dev', 'low', 1],
    ['default', 'low', 1],
] as const)(
    'uses a %s window only when its source is authoritative',
    async (source, level, calls) => {
        jest.mocked(
            contextWindows.resolveContextWindowWithSource,
        ).mockReturnValue({
            source,
            tokens: 2048,
        });
        jest.mocked(LLM.run).mockResolvedValue({
            level: 'low',
            reason: 'The provider accepted the complete input.',
        } as any);

        const result = await assessApprovalRisk({
            ...input,
            body: 'documentation '.repeat(5000),
        });

        expect(result.level).toBe(level);
        expect(LLM.run).toHaveBeenCalledTimes(calls);
    },
);

it.each(['title', 'body', 'teamInstructions'])(
    'checks the complete prompt when %s exceeds the configured model input window',
    async (field) => {
        jest.mocked(LLM.run).mockResolvedValue({
            level: 'low',
            reason: 'The patch alone looks harmless.',
        } as any);
        const result = await assessApprovalRisk({
            ...input,
            [field]: 'documentation '.repeat(5000),
            modelSlot: {
                provider: 'openai',
                model: 'gpt-4o-mini',
                maxInputTokens: 2048,
            } as any,
        });

        expect(result).toMatchObject({
            level: 'unknown',
            failure: { category: 'CONTEXT_OVERFLOW', code: 'diff_too_large' },
        });
        expect(LLM.run).not.toHaveBeenCalled();
    },
);

it.each([
    [2048, 'unknown', 0],
    [16384, 'low', 1],
])(
    'uses the configured %i-token input window for the same complete diff',
    async (maxInputTokens, level, calls) => {
        jest.mocked(LLM.run).mockResolvedValue({
            level: 'low',
            reason: 'The complete documentation diff preserves behavior.',
        } as any);
        const result = await assessApprovalRisk({
            ...input,
            files: [
                {
                    filename: 'docs/guide.md',
                    status: 'added',
                    additions: 1,
                    deletions: 0,
                    patch: `@@ -0,0 +1 @@\n+${'documentation '.repeat(5000)}`,
                },
            ],
            modelSlot: {
                provider: 'openai',
                model: 'gpt-4o-mini',
                maxInputTokens,
            } as any,
        });

        expect(result.level).toBe(level);
        expect(LLM.run).toHaveBeenCalledTimes(calls);
    },
);

it('does not substitute a fixed input ceiling for an unknown model window', async () => {
    jest.mocked(LLM.run).mockResolvedValue({
        level: 'low',
        reason: 'The configured provider accepted the complete input.',
    } as any);
    const body = 'documentation '.repeat(200_000);
    const result = await assessApprovalRisk({
        ...input,
        body,
        modelSlot: {
            provider: 'openai_compatible',
            model: 'completely-unknown-model-xyz',
        } as any,
    });

    expect(result.level).toBe('low');
    expect(LLM.run).toHaveBeenCalledTimes(1);
    expect(
        JSON.parse(jest.mocked(LLM.run).mock.calls[0][0].user as string).body,
    ).toBe(body);
});

it.each([1, 51])(
    'sends the complete legacy approval diff above 50k characters across %i files',
    async (fileCount) => {
        const padding = 'documentation '.repeat(
            Math.ceil(60_000 / (fileCount * 14)),
        );
        const files = Array.from({ length: fileCount }, (_, index) => ({
            filename: `docs/change-${index}.md`,
            status: 'added' as const,
            additions: 2,
            deletions: 0,
            patch: `@@ -0,0 +1,2 @@\n+${padding}\n+end-of-file-${index}`,
        }));
        jest.mocked(LLM.run).mockResolvedValue({
            level: 'low',
            reason: 'The complete documentation diff preserves behavior.',
        } as any);

        expect(await assessApprovalRisk({ ...input, files })).toMatchObject({
            level: 'low',
            reviewedHeadSha: input.headSha,
        });
        expect(LLM.run).toHaveBeenCalledTimes(1);
        const data = JSON.parse(
            jest.mocked(LLM.run).mock.calls[0][0].user as string,
        );
        expect(data.fileCount).toBe(fileCount);
        expect(data.diff.length).toBeGreaterThan(50_000);
        expect(data.diff.endsWith(files[fileCount - 1].patch)).toBe(true);
        expect(data.diffWasTruncated).toBe(false);
    },
);

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
    ['src/status.py', '+note = f"return {name}"'],
    ['src/status.py', '+note = r"return text"'],
    ['src/status.py', '+note = b"return bytes"'],
    ['src/status.rs', '+let note = b"return bytes";'],
    ['src/status.py', '+note = f"{{return placeholder}}"'],
    [
        'src/status.tsx',
        "--- a/return.tsx\n+++ b/return.tsx\n@@ -1 +1 @@\n+const title = <p>don't</p>;",
    ],
    [
        'src/status.ts',
        '--- a/return.ts\n+++ b/return.ts\n@@ -1 +1 @@\n+const count = 1;',
    ],
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

it.each([
    '+// added test coverage',
    '+/* tests go here */',
    '+   ',
    '--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n+// test coverage',
    '--- a/test.ts\n+++ b/test.ts\n',
    '+++ b/test.ts\n',
    'diff --git a/test.ts b/test.ts\nold mode 100644\nnew mode 100755\n',
])(
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
    '@@ -1 +1,2 @@\n+if\n+(authorize());',
    '@@ -1 +1,2 @@\n+if /* permission check */\n+(authorize());',
    '@@ -1 +1,3 @@\n+if\n+/* permission check */\n+(authorize());',
    '++value; return authorize();',
    '+++value; return authorize();',
    '@@ -1 +1 @@\n+++ value; return authorize();',
    '--- a/status.ts\n+++ b/status.ts\n@@ -1 +1 @@\n+++value; return authorize();',
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
    ['src/status.py', '+text = f"{allow if (ready) else deny}"'],
    ['src/status.py', '+text = f"\\{allow if (ready) else deny}"'],
    ['src/status.py', '+text = f"{f\'{allow if (ready) else deny}\'}"'],
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
    [
        'src/AuthService.cs',
        '+var response = $"Authorized: {new Func<bool>(() => { return Authorize(user); })()}";',
    ],
    ['src/status.rs', "+fn authorize<'a>() { return true; }"],
    ['src/return.ts', '--- a/return.ts\n+++ b/return.ts\n'],
    ['src/return.ts', '+++ b/return.ts\n'],
    ['src/status.ts', '+++ value; return authorize();'],
    [
        'src/status.ts',
        'diff --git a/status.ts b/status.ts\nold mode 100644\nnew mode 100755\n',
    ],
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
    ['test_status.py', '+assert render() == f"Hello {name}"'],
    ['test_status.py', '+assert render() == rf"Hello {name}"'],
    ['test_status.py', '+assert read() == b"data"'],
    ['test_status.py', '+assert read() == u"text"'],
    ['test_status.py', '+assert read() == r"abc"'],
    ['test_status.py', '+assert read() == rb"abc"'],
    ['tests/status_test.rs', '+assert_eq!(read(), b"bytes");'],
])(
    'keeps assertions around prefixed literals in %s',
    async (filename, patch) => {
        (LLM.run as jest.Mock).mockResolvedValue({
            level: 'low',
            reason: 'Behavior covered by tests.',
        });
        const result = await assessApprovalRisk({
            ...input,
            files: [
                {
                    filename: 'src/status.ts',
                    status: 'modified',
                    patch: '+return authorize();',
                },
                { filename, status: 'modified', patch },
            ] as any,
        });
        expect(result.level).toBe('low');
    },
);

it.each([
    ['test_status.py', '+b"placeholder"'],
    ['test_status.py', '+f"placeholder"'],
    ['test_status.py', '+f"{{return placeholder}}"'],
    ['tests/status_test.rs', '+b"placeholder"'],
])(
    'does not count a literal prefix alone as test evidence in %s',
    async (filename, patch) => {
        (LLM.run as jest.Mock).mockResolvedValue({
            level: 'low',
            reason: 'Behavior unchanged.',
        });
        const result = await assessApprovalRisk({
            ...input,
            files: [
                {
                    filename: 'src/status.ts',
                    status: 'modified',
                    patch: '+return authorize();',
                },
                { filename, status: 'modified', patch },
            ] as any,
        });
        expect(result.level).toBe('medium');
    },
);

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
