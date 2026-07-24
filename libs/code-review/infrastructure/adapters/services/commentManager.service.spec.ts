import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    BehaviourForExistingDescription,
    SummaryConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

// Mock BYOKPromptRunnerService at module level so we can capture the
// SYSTEM prompt the LLM receives (Bug E) and short-circuit the LLM
// call to a deterministic summary (Bug A).
const capturedPrompts: Array<{ prompt: string; role: string }> = [];
const NEW_SUMMARY_TEXT = 'NEW_SUMMARY_CONTENT';

jest.mock(
    '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service',
    () => ({
        BYOKPromptRunnerService: jest
            .fn()
            .mockImplementation(() => ({
                executeMode: 'mock',
                builder: () => {
                    const chain: any = {
                        setParser: () => chain,
                        setLLMJsonMode: () => chain,
                        setPayload: () => chain,
                        addPrompt: (p: { prompt: string; role: string }) => {
                            capturedPrompts.push(p);
                            return chain;
                        },
                        addMetadata: () => chain,
                        addCallbacks: () => chain,
                        setRunName: () => chain,
                        setTemperature: () => chain,
                        execute: async () => NEW_SUMMARY_TEXT,
                    };
                    return chain;
                },
            })),
    }),
);

// generateSummaryPR now runs through the v5 path (byok-to-vercel +
// tracedGenerateText) instead of the v2 BYOKPromptRunnerService builder, so
// Claude-on-Vertex works. Mock that path: capture the system/user prompts
// (Bug E) and return a deterministic summary (Bug A).
jest.mock('@libs/llm/byok-to-vercel', () => ({
    byokToVercelModel: jest.fn(() => ({ __mockModel: true })),
}));
// `tracedGenerateText` moved to @libs/llm/llm-call (the legacy
// agents/engine/agent-loop module was removed). requireActual keeps the rest of
// the module (AGENT_TIMEOUT_MS, etc.) and overrides only the LLM call.
jest.mock('@libs/llm/llm-call', () => ({
    ...jest.requireActual('@libs/llm/llm-call'),
    tracedGenerateText: jest.fn(
        async ({ system, prompt }: { system?: string; prompt?: string }) => {
            if (system) {
                capturedPrompts.push({ prompt: system, role: 'system' });
            }
            if (prompt) {
                capturedPrompts.push({ prompt, role: 'user' });
            }
            return { text: NEW_SUMMARY_TEXT };
        },
    ),
}));
jest.mock('@libs/core/log/langfuse', () => ({
    buildLangfuseTelemetry: () => ({ isEnabled: false, functionId: 'test' }),
}));

import { getClassification } from '@libs/llm/error-classifier';
import { tracedGenerateText } from '@libs/llm/llm-call';

import { CommentManagerService } from './commentManager.service';

describe('CommentManagerService.generateSummaryPR', () => {
    let service: CommentManagerService;
    let codeManagementService: { getPullRequestByNumber: jest.Mock };
    let observabilityService: {
        runLLMInSpan: jest.Mock;
        runAiSdkLLMInSpan: jest.Mock;
    };
    let parametersService: any;
    let messageProcessor: any;
    let promptRunnerService: any;
    let permissionValidationService: any;

    const stubRepository = { name: 'sample', id: 'repo-id' };
    const stubOrg = { organizationId: 'org-1', teamId: 'team-1' };
    const stubPR = {
        number: 7,
        title: 'feat: example',
        head: { ref: 'feat/x', repo: { fullName: 'kodus/sample' } },
        base: { ref: 'main' },
    };
    const summaryConfig: SummaryConfig = {
        generatePRSummary: true,
        behaviourForExistingDescription:
            BehaviourForExistingDescription.CONCATENATE,
    } as any;

    beforeEach(() => {
        capturedPrompts.length = 0;

        // Restore the happy-path LLM stub — the failure tests below swap it
        // for a rejection and must not leak into the prompt-shape tests.
        (tracedGenerateText as jest.Mock).mockImplementation(
            async ({ system, prompt }: { system?: string; prompt?: string }) => {
                if (system) {
                    capturedPrompts.push({ prompt: system, role: 'system' });
                }
                if (prompt) {
                    capturedPrompts.push({ prompt, role: 'user' });
                }
                return { text: NEW_SUMMARY_TEXT };
            },
        );

        codeManagementService = { getPullRequestByNumber: jest.fn() };

        observabilityService = {
            runLLMInSpan: jest.fn(async ({ exec }) => {
                // Run the exec callback so the mocked BYOKPromptRunnerService
                // (above) actually receives the prompts via addPrompt(...).
                const result = await exec(() => {});
                return { result };
            }),
            // generateSummaryPR now uses runAiSdkLLMInSpan (AI SDK usage path).
            // It returns the exec result directly; the caller reads `.text`.
            runAiSdkLLMInSpan: jest.fn(async ({ exec }) => exec()),
        };

        parametersService = {};
        messageProcessor = {};
        promptRunnerService = {};
        permissionValidationService = {};

        service = new CommentManagerService(
            parametersService,
            messageProcessor,
            promptRunnerService,
            observabilityService as any,
            permissionValidationService,
            codeManagementService as any,
        );
    });

    describe('Bug A — re-run dedup of <!-- kody-pr-summary --> block (issue #1019)', () => {
        const startMarker = '<!-- kody-pr-summary:start -->';
        const endMarker = '<!-- kody-pr-summary:end -->';
        const countMarkers = (s: string) =>
            (s.match(new RegExp(startMarker, 'g')) ?? []).length;

        it('strips the previous block on re-run when CONCATENATE is set', async () => {
            // Simulate a re-run: the PR body already has a Kody summary
            // block (from the previous run), joined to the user's
            // original text by the `\n\n---\n\n` separator we emit.
            const userText = 'User-authored description text';
            const previousBlock = `${startMarker}\nOLD SUMMARY CONTENT\n${endMarker}`;
            codeManagementService.getPullRequestByNumber.mockResolvedValue({
                body: `${userText}\n\n---\n\n${previousBlock}`,
            });

            const result = await service.generateSummaryPR(
                stubPR,
                stubRepository,
                [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                stubOrg,
                'en-US',
                summaryConfig,
                null,
                /* isCommitRun */ false,
                /* prPreview */ false,
                /* externalPromptContext */ undefined,
                PlatformType.GITHUB,
            );

            // Exactly ONE summary block — the old one was stripped, the
            // freshly generated one was added in its place. Without the
            // fix, the old block survives and the new one is appended,
            // producing two start/end pairs.
            expect(countMarkers(result)).toBe(1);
            expect(result).toContain(NEW_SUMMARY_TEXT);
            // The user's original text outside the block is preserved.
            expect(result).toContain(userText);
            // The old summary content is gone.
            expect(result).not.toContain('OLD SUMMARY CONTENT');
        });

        it('does not stack blocks across multiple consecutive re-runs (anti-regression)', async () => {
            // Body that already accumulated TWO summary blocks (worst-case
            // legacy data from before the fix). The new code should still
            // collapse to a single block.
            const userText = 'Original text';
            codeManagementService.getPullRequestByNumber.mockResolvedValue({
                body:
                    `${userText}\n\n---\n\n${startMarker}\nFirst run\n${endMarker}` +
                    `\n\n---\n\n${startMarker}\nSecond run\n${endMarker}`,
            });

            const result = await service.generateSummaryPR(
                stubPR,
                stubRepository,
                [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                stubOrg,
                'en-US',
                summaryConfig,
                null,
                false,
                false,
                undefined,
                PlatformType.GITHUB,
            );

            expect(countMarkers(result)).toBe(1);
            expect(result).not.toContain('First run');
            expect(result).not.toContain('Second run');
            expect(result).toContain(NEW_SUMMARY_TEXT);
            expect(result).toContain(userText);
        });

        it('appends a fresh block to a clean body (first-ever run, no stripping needed)', async () => {
            const userText = 'I wrote this PR description';
            codeManagementService.getPullRequestByNumber.mockResolvedValue({
                body: userText,
            });

            const result = await service.generateSummaryPR(
                stubPR,
                stubRepository,
                [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                stubOrg,
                'en-US',
                summaryConfig,
                null,
                false,
                false,
                undefined,
                PlatformType.GITHUB,
            );

            expect(countMarkers(result)).toBe(1);
            expect(result).toContain(userText);
            expect(result).toContain(NEW_SUMMARY_TEXT);
        });

        it('handles a body with the marker but no separator (legacy data shape)', async () => {
            const userText = 'Old style body';
            // No `\n\n---\n\n` between user text and the block — older
            // version of Kody appended directly. The fix should still
            // strip the standalone block via the second regex.
            codeManagementService.getPullRequestByNumber.mockResolvedValue({
                body: `${userText}${startMarker}\nlegacy\n${endMarker}`,
            });

            const result = await service.generateSummaryPR(
                stubPR,
                stubRepository,
                [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                stubOrg,
                'en-US',
                summaryConfig,
                null,
                false,
                false,
                undefined,
                PlatformType.GITHUB,
            );

            expect(countMarkers(result)).toBe(1);
            expect(result).not.toContain('legacy');
            expect(result).toContain(userText);
        });
    });

    describe('Bug E — Length Constraint hint in the LLM prompt (Azure-only)', () => {
        beforeEach(() => {
            codeManagementService.getPullRequestByNumber.mockResolvedValue({
                body: 'irrelevant for prompt-shape tests',
            });
        });

        it('includes the Length Constraint block when platformType is AZURE_REPOS', async () => {
            await service.generateSummaryPR(
                stubPR,
                stubRepository,
                [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                stubOrg,
                'en-US',
                summaryConfig,
                null,
                false,
                false,
                undefined,
                PlatformType.AZURE_REPOS,
            );

            const systemPrompt =
                capturedPrompts.find((p) => p.role === 'system')?.prompt ??
                capturedPrompts.map((p) => p.prompt).join('\n');

            expect(systemPrompt).toContain('Length Constraint (Azure DevOps)');
            // Target = 80% of 4000 → 3,200. The literal value is what
            // the prompt formatter emits via toLocaleString.
            expect(systemPrompt).toContain('3,200');
            // The hard limit appears too — same toLocaleString format.
            expect(systemPrompt).toContain('4,000');
        });

        it('omits the Length Constraint block when platformType is GITHUB', async () => {
            await service.generateSummaryPR(
                stubPR,
                stubRepository,
                [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                stubOrg,
                'en-US',
                summaryConfig,
                null,
                false,
                false,
                undefined,
                PlatformType.GITHUB,
            );

            const systemPrompt =
                capturedPrompts.find((p) => p.role === 'system')?.prompt ??
                capturedPrompts.map((p) => p.prompt).join('\n');

            expect(systemPrompt).not.toContain('Length Constraint');
        });

        it('omits the Length Constraint block when platformType is undefined', async () => {
            await service.generateSummaryPR(
                stubPR,
                stubRepository,
                [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                stubOrg,
                'en-US',
                summaryConfig,
                null,
                false,
                false,
                undefined,
                /* platformType */ undefined,
            );

            const systemPrompt =
                capturedPrompts.find((p) => p.role === 'system')?.prompt ??
                capturedPrompts.map((p) => p.prompt).join('\n');

            expect(systemPrompt).not.toContain('Length Constraint');
        });
    });

    // A provider failure and a deliberate skip must not share a return value.
    // `null` means "we chose not to generate one" (summary disabled, license
    // denied, diff too large) — callers treat it as a non-event. When the LLM
    // itself is unreachable the caller has to be able to tell, or the review is
    // reported as clean and the PR auto-approved without any analysis (#1568).
    describe('provider failure is thrown, not returned as null', () => {
        const providerError = Object.assign(
            new Error('Path not found: /chat/completions'),
            { name: 'AI_APICallError', statusCode: 404 },
        );

        it('throws after exhausting its retries when the LLM call keeps failing', async () => {
            codeManagementService.getPullRequestByNumber.mockResolvedValue({
                body: '',
            });
            (tracedGenerateText as jest.Mock).mockRejectedValue(providerError);

            await expect(
                service.generateSummaryPR(
                    stubPR,
                    stubRepository,
                    [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                    stubOrg,
                    'en-US',
                    summaryConfig,
                    null,
                ),
            ).rejects.toThrow('Path not found: /chat/completions');
        });

        it('classifies the thrown error so the PR comment can name the cause', async () => {
            codeManagementService.getPullRequestByNumber.mockResolvedValue({
                body: '',
            });
            (tracedGenerateText as jest.Mock).mockRejectedValue(providerError);

            const thrown = await service
                .generateSummaryPR(
                    stubPR,
                    stubRepository,
                    [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                    stubOrg,
                    'en-US',
                    summaryConfig,
                    null,
                )
                .catch((e) => e);

            expect(getClassification(thrown)).toBeDefined();
        });

        it('still returns null for the deliberate skip (summary disabled)', async () => {
            const result = await service.generateSummaryPR(
                stubPR,
                stubRepository,
                [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                stubOrg,
                'en-US',
                { ...summaryConfig, generatePRSummary: false } as any,
                null,
            );

            expect(result).toBeNull();
        });
    });

    // Error message (issue #1452): the team's optional note is appended below
    // Kody's default error comment; the technical reason is always preserved.
    describe('error message custom note', () => {
        const genErrorSummary = (customNote?: string) =>
            (service as any).generatePullRequestFinishSummaryMarkdown(
                stubOrg,
                7,
                [], // commentResults
                { languageResultPrompt: 'en-US' } as any, // codeReviewConfig
                [], // prLevelCommentResults
                true, // reviewFailed
                'invalid or missing API key', // reviewErrorMessage (the reason)
                false, // reviewHasPartialErrors
                customNote, // reviewErrorCustomMessage
            );

        beforeEach(() => {
            // Isolate the error comment from the always-appended config guide.
            (service as any).generateConfigReviewMarkdown = jest
                .fn()
                .mockResolvedValue('');
        });

        it('appends the custom note below the default error comment', async () => {
            const result = await genErrorSummary('Ping #devops for help.');

            // Default reason preserved AND the note appended after it.
            expect(result).toContain('Code Review Could Not Complete');
            expect(result).toContain('invalid or missing API key');
            expect(result).toContain('Ping #devops for help.');
            expect(result.indexOf('invalid or missing API key')).toBeLessThan(
                result.indexOf('Ping #devops for help.'),
            );
        });

        it('posts only the default comment when there is no custom note', async () => {
            const result = await genErrorSummary(undefined);

            expect(result).toContain('Code Review Could Not Complete');
            expect(result).toContain('invalid or missing API key');
        });

        it('preserves the author line breaks as Markdown hard breaks', async () => {
            const result = await genErrorSummary('line one\nline two\nline three');

            // Each single newline becomes a hard break (two trailing spaces)
            // so the note renders on separate lines in the PR comment.
            expect(result).toContain('line one  \nline two  \nline three');
        });
    });
});
