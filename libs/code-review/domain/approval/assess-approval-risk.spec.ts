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
    ['override', 'unknown', 0],
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

it.each([
    ['qwen', 40_000],
    ['llama3', 140_000],
    ['deepseek-chat-v4', 140_000],
] as const)(
    'lets the provider decide the window for the %s model alias',
    async (model, repetitions) => {
        const body = 'documentation '.repeat(repetitions);
        jest.mocked(LLM.run).mockResolvedValue({
            level: 'low',
            reason: 'The provider accepted the complete input.',
        } as any);

        const result = await assessApprovalRisk({
            ...input,
            body,
            modelSlot: { provider: 'openai_compatible', model } as any,
        });

        expect(result.level).toBe('low');
        expect(LLM.run).toHaveBeenCalledTimes(1);
        expect(
            JSON.parse(jest.mocked(LLM.run).mock.calls[0][0].user as string)
                .body,
        ).toBe(body);
    },
);

it('enforces trusted model windows while leaving routing aliases to the provider', async () => {
    jest.mocked(LLM.run).mockResolvedValue({
        level: 'low',
        reason: 'The provider accepted the complete input.',
    } as any);
    for (const [model, repetitions] of [
        ['gpt-4o-mini', 140_000],
        ['GPT_4O_MINI', 140_000],
        ['glm-4-7', 210_000],
    ] as const) {
        const result = await assessApprovalRisk({
            ...input,
            body: 'documentation '.repeat(repetitions),
            modelSlot: { provider: 'openai_compatible', model } as any,
        });

        expect({ model, result }).toMatchObject({
            model,
            result: {
                level: 'unknown',
                failure: {
                    errorName: 'RiskPromptTooLargeError',
                    category: 'CONTEXT_OVERFLOW',
                    code: 'diff_too_large',
                },
            },
        });
        expect(LLM.run).not.toHaveBeenCalled();
    }
    const body = 'documentation '.repeat(140_000);
    for (const model of ['auto', 'openrouter/auto', 'coder']) {
        jest.mocked(LLM.run).mockClear();
        const result = await assessApprovalRisk({
            ...input,
            body,
            modelSlot: { provider: 'openai_compatible', model } as any,
        });
        expect({ model, level: result.level }).toEqual({ model, level: 'low' });
        expect(LLM.run).toHaveBeenCalledTimes(1);
        expect(
            JSON.parse(jest.mocked(LLM.run).mock.calls[0][0].user as string)
                .body,
        ).toBe(body);
    }
});

it('classifies provider overflow after deferring a partial model match', async () => {
    jest.mocked(LLM.run).mockRejectedValue(
        new Error('maximum context length exceeded'),
    );
    const result = await assessApprovalRisk({
        ...input,
        body: 'documentation '.repeat(40_000),
        modelSlot: {
            provider: 'openai_compatible',
            model: 'qwen',
        } as any,
    });

    expect(LLM.run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
        level: 'unknown',
        failure: {
            errorName: 'Error',
            category: 'CONTEXT_OVERFLOW',
            code: 'diff_too_large',
        },
    });
});

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

it('returns unknown when the model fails, so approval cannot proceed', async () => {
    (LLM.run as jest.Mock).mockRejectedValue(new Error('timeout'));

    expect(await assessApprovalRisk(input)).toMatchObject({
        level: 'unknown',
        reviewedHeadSha: 'abc123',
    });
});
