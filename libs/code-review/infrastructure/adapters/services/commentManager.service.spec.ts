import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { LanguageValue } from '@libs/core/domain/enums/language-parameter.enum';
import {
    BehaviourForExistingDescription,
    ClusteringType,
    SummaryConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

// generateSummaryPR runs through the v5 path (byok-to-vercel + tracedGenerateText);
// capturedPrompts collects the prompts the LLM receives (Bug E) and NEW_SUMMARY_TEXT
// is the deterministic summary returned (Bug A). The legacy BYOKPromptRunner
// (LangChain wrapper) was deleted in plan 03-13, so its module-level mock is gone.
const capturedPrompts: Array<{ prompt: string; role: string }> = [];
const NEW_SUMMARY_TEXT = 'NEW_SUMMARY_CONTENT';

// generateSummaryPR now runs through the v5 path (byok-to-vercel +
// tracedGenerateText) instead of the BYOKPromptRunner builder, so
// Claude-on-Vertex works. Mock that path: capture the system/user prompts
// (Bug E) and return a deterministic summary (Bug A).
jest.mock('@libs/llm/byok-to-vercel', () => ({
    mayUseJsonSchema: jest.fn(() => true),
    markJsonSchemaUnsupported: jest.fn(),
    isJsonSchemaUnsupportedError: jest.fn(() => false),
    // generateSummaryPR (v5 path) now builds via buildModelFromSlot(slot).
    buildModelFromSlot: jest.fn(() => ({ __mockModel: true })),
    // runStructuredReviewCall (clustering path) reads getModelName for the span.
    getModelName: jest.fn(() => 'test-model'),
    // The shared review executor consults the slot's limiter on its error path.
    getLimiterForSlot: jest.fn(() => null),
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
    // The summary now runs through runTextReviewCall, which arms a real 10-min
    // timeoutSignal — stub it so the suite doesn't leak long-lived timers.
    timeoutSignal: jest.fn(() => undefined),
}));
jest.mock('@libs/core/log/langfuse', () => ({
    buildLangfuseTelemetry: () => ({ isEnabled: false, functionId: 'test' }),
    toAiSdkTelemetryArgs: (cfg: any) => ({ telemetry: cfg }),
}));

import { getClassification } from '@libs/llm/error-classifier';
import { tracedGenerateText } from '@libs/llm/llm-call';
import { LLM } from '@libs/llm/llm';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { prompt_repeated_suggestion_clustering_system } from '@libs/common/utils/prompts/repeatedCodeReviewSuggestionClustering';

import {
    CommentManagerService,
    repeatedClusteringSchema,
} from './commentManager.service';

describe('CommentManagerService.generateSummaryPR', () => {
    let service: CommentManagerService;
    let codeManagementService: { getPullRequestByNumber: jest.Mock };
    let observabilityService: {
        runLLMInSpan: jest.Mock;
        runAiSdkLLMInSpan: jest.Mock;
    };
    let parametersService: any;
    let messageProcessor: any;
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
            async ({
                system,
                prompt,
            }: {
                system?: string;
                prompt?: string;
            }) => {
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
                // Run the exec callback so the mocked BYOKPromptRunner
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
        permissionValidationService = {};

        service = new CommentManagerService(
            parametersService,
            messageProcessor,
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
            const result = await genErrorSummary(
                'line one\nline two\nline three',
            );

            // Each single newline becomes a hard break (two trailing spaces)
            // so the note renders on separate lines in the PR comment.
            expect(result).toContain('line one  \nline two  \nline three');
        });
    });
});

// repeatedCodeReviewSuggestionClustering was migrated from the legacy
// STRING/JSON PromptRunner onto runStructuredReviewCall (REQ-NOLC-01). The
// structured result is JSON.stringify'd and fed through LLMResponseProcessor
// exactly as the STRING path did — this suite pins that the downstream
// clustering/enrichment mapping is byte-for-byte identical. It mocks the
// tracedGenerateText seam (like structured-review-call.spec.ts), not the
// LangChain builder that no longer exists on this path.
describe('CommentManagerService.repeatedCodeReviewSuggestionClustering — structured-call parity', () => {
    let service: CommentManagerService;
    let observabilityService: any;
    let parametersService: any;

    const stubOrg = { organizationId: 'org-1', teamId: 'team-1' };

    beforeEach(() => {
        // Shared module-level mock — clear accumulated calls from the summary
        // suite above so the per-test call-count assertion is isolated.
        (tracedGenerateText as jest.Mock).mockClear();
        parametersService = {
            findByKey: jest.fn().mockResolvedValue({ configValue: 'en-US' }),
        };
        observabilityService = {
            runLLMInSpan: jest.fn(),
            // runStructuredReviewCall runs its exec inside runAiSdkLLMInSpan and
            // reads `experimental_output` off the result.
            runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
        };

        service = new CommentManagerService(
            parametersService,
            {} as any,
            observabilityService,
            {} as any,
            {} as any,
        );
    });

    it('re-serializes the structured clustering result and maps it byte-for-byte through enrichment', async () => {
        const codeSuggestions = [
            { id: 'a', relevantFile: 'a.ts', suggestionContent: 'A' },
            { id: 'b', relevantFile: 'b.ts', suggestionContent: 'B' },
            { id: 'c', relevantFile: 'c.ts', suggestionContent: 'C' },
        ];

        // The migrated call is runStructuredReviewCall → tracedGenerateText.
        // Return the structured object the LLM would produce (a and b cluster).
        (tracedGenerateText as jest.Mock).mockResolvedValueOnce({
            experimental_output: {
                codeSuggestions: [
                    {
                        id: 'a',
                        sameSuggestionsId: ['b'],
                        problemDescription: 'dup issue',
                        actionStatement: 'Please fix it',
                    },
                ],
            },
        });

        const result = await service.repeatedCodeReviewSuggestionClustering(
            stubOrg as any,
            7,
            codeSuggestions,
        );

        // c stays non-clustered; a becomes PARENT; b becomes RELATED — the exact
        // enrichment the STRING path produced from the same JSON payload.
        expect(result).toEqual([
            { id: 'c', relevantFile: 'c.ts', suggestionContent: 'C' },
            {
                id: 'a',
                relevantFile: 'a.ts',
                suggestionContent: 'A',
                clusteringInformation: {
                    type: ClusteringType.PARENT,
                    relatedSuggestionsIds: ['b'],
                    problemDescription: 'dup issue',
                    actionStatement: 'Please fix it',
                },
            },
            {
                id: 'b',
                relevantFile: 'b.ts',
                suggestionContent: 'B',
                clusteringInformation: {
                    type: ClusteringType.RELATED,
                    parentSuggestionId: 'a',
                },
            },
        ]);

        // Exactly one structured call — the outer runLLMInSpan wrapper is gone (Q4).
        expect(tracedGenerateText).toHaveBeenCalledTimes(1);
        expect(observabilityService.runLLMInSpan).not.toHaveBeenCalled();
    });

    it('returns the original suggestions unchanged when the model finds no duplicates', async () => {
        const codeSuggestions = [
            { id: 'a', relevantFile: 'a.ts', suggestionContent: 'A' },
        ];
        (tracedGenerateText as jest.Mock).mockResolvedValueOnce({
            experimental_output: { codeSuggestions: [] },
        });

        const result = await service.repeatedCodeReviewSuggestionClustering(
            stubOrg as any,
            7,
            codeSuggestions,
        );

        expect(result).toEqual(codeSuggestions);
    });
});

/**
 * Deterministic helpers in this 2.5k-line service that never touch the LLM or a
 * platform client — pure string/markdown/token math. The behaviour suites above
 * exercise the summary and clustering paths but never these, so their branches
 * were entirely unkilled. Built with inert deps and driven directly.
 */
describe('CommentManagerService — pure helpers', () => {
    const svc = () =>
        new CommentManagerService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        ) as any;

    describe('sanitizeBitbucketMarkdown', () => {
        it('leaves markdown untouched on a non-Bitbucket platform', () => {
            const md = '<details><summary>x</summary>body</details>';
            expect(
                svc().sanitizeBitbucketMarkdown(md, PlatformType.GITHUB),
            ).toBe(md);
        });

        it('strips <details>/<summary> tags and trims on Bitbucket', () => {
            const md = '<details><summary>Title</summary>\nbody\n</details>';
            const out = svc().sanitizeBitbucketMarkdown(
                md,
                PlatformType.BITBUCKET,
            );
            expect(out).not.toMatch(/<\/?details>|<\/?summary>/);
            expect(out).toContain('body');
            expect(out).toBe(out.trim());
        });

        it('strips the kody-codereview marker+zero-width-space on Bitbucket', () => {
            const md = '<!-- kody-codereview -->\n&#8203;real content';
            const out = svc().sanitizeBitbucketMarkdown(
                md,
                PlatformType.BITBUCKET,
            );
            expect(out).toBe('real content');
        });
    });

    describe('resolvePartialErrorsNotice', () => {
        const KEY = 'API_USER_INVITE_BASE_URL';
        let saved: string | undefined;
        beforeEach(() => {
            saved = process.env[KEY];
        });
        afterEach(() => {
            if (saved === undefined) delete process.env[KEY];
            else process.env[KEY] = saved;
        });

        it('substitutes the dashboard placeholder with the public fallback when no env is set', () => {
            delete process.env[KEY];
            const out = svc().resolvePartialErrorsNotice(LanguageValue.ENGLISH);
            expect(out).toContain('https://app.kodus.io/pull-requests');
            expect(out).not.toContain('{{dashboardUrl}}');
        });

        it('uses the configured base URL and strips its trailing slashes', () => {
            process.env[KEY] = 'https://custom.dev//';
            const out = svc().resolvePartialErrorsNotice(LanguageValue.ENGLISH);
            expect(out).toContain('https://custom.dev/pull-requests');
            expect(out).not.toContain('custom.dev//');
        });
    });

    describe('chunkChangedFilesForSummary', () => {
        const files = (n: number, size = 0) =>
            Array.from({ length: n }, (_, i) => ({
                filename: `f${i}.ts`,
                // large payload forces one file per chunk when a budget is set
                fileContent: 'x'.repeat(size),
            }));
        const chunk = (fs: any[], max?: number) =>
            svc().chunkChangedFilesForSummary(fs, '', '', max);

        it('returns a single chunk (all files) when no token budget is configured', () => {
            const fs = files(3);
            expect(chunk(fs, undefined)).toEqual([fs]);
        });

        it('returns a single chunk when the budget is zero or negative', () => {
            const fs = files(3);
            expect(chunk(fs, 0)).toEqual([fs]);
        });

        it('keeps everything in one chunk when it all fits the budget', () => {
            const fs = files(2);
            const out = chunk(fs, 100000);
            expect(out).toHaveLength(1);
            expect(out[0]).toHaveLength(2);
        });

        it('splits into multiple chunks when files exceed the per-chunk budget', () => {
            const out = chunk(files(3, 50000), 1000);
            expect(out).not.toBeNull();
            expect(out.length).toBeGreaterThan(1);
        });

        it('still returns chunks at exactly the max chunk count (boundary is strictly greater-than)', () => {
            // 4 oversized files → 4 chunks == MAX_CHUNKS: must NOT be null.
            const out = chunk(files(4, 50000), 1000);
            expect(out).not.toBeNull();
            expect(out).toHaveLength(4);
        });

        it('bails out with null when the split would exceed the max chunk count', () => {
            expect(chunk(files(6, 50000), 1000)).toBeNull();
        });
    });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LLM.run I/O CONTRACT MATRIX — repeatedCodeReviewSuggestionClustering
 * ─────────────────────────────────────────────────────────────────────────────
 * This boundary is the review chain's clustering parse site. Its declared output
 * schema is D = `repeatedClusteringSchema` = `{ codeSuggestions: Cluster[] }`.
 *
 * SCOPE (deterministic layer only): request assembly (exact schema/system/user/
 * runName/byokConfig/attrs threading), envelope parsing (LLM.run result →
 * JSON.stringify → LLMResponseProcessor.processResponse → enrichment), the
 * documented fail-safe (return the ORIGINAL suggestions, never throw past the
 * boundary, never silently drop the model's clustering decision), and the
 * guaranteed return type (always an array of suggestions).
 *
 * We spy on the REAL LLM.run boundary and control the value it resolves — that
 * value stands in for whatever the structured-output gate hands back: the clean
 * D (strict json_schema models: openai/anthropic/google/moonshotai) OR the full
 * off-schema zoo (json_object-fallback models: kimi/glm/deepseek/z-ai). The
 * boundary applies the SAME processResponse regardless of model, so the E
 * dimension is closed here by (a) threading assertions and (b) running the
 * A/B/C zoo — which represents exactly the json_object-fallback outputs.
 *
 * NON-DEGRADATION (#1786): for every off-schema row the boundary must RECOVER
 * the payload OR FAIL EXPLICITLY (return the input + log). Where prod currently
 * (1) silently drops the model's clusters (data hidden under a wrong key parses
 *     to `{codeSuggestions: []}` → input returned with NO signal), or
 * (2) throws a TypeError past the boundary (processResponse → null →
 *     `null.codeSuggestions` at commentManager.service.ts:1871), or
 * (3) emits contentless phantom suggestions for dangling ids,
 * the CORRECT behavior is pinned as `it.failing` (green today, red on the fix).
 */
describe('CommentManagerService.repeatedCodeReviewSuggestionClustering — LLM.run I/O contract matrix', () => {
    let service: CommentManagerService;
    let parametersService: any;
    let runSpy: jest.SpyInstance;

    const stubOrg = { organizationId: 'org-1', teamId: 'team-1' };
    const PR = 7;

    // Three distinct suggestions; the model clusters a+b (b is a duplicate of a).
    const input3 = () => [
        { id: 'a', relevantFile: 'a.ts', suggestionContent: 'A' },
        { id: 'b', relevantFile: 'b.ts', suggestionContent: 'B' },
        { id: 'c', relevantFile: 'c.ts', suggestionContent: 'C' },
    ];

    // The clean, in-schema payload (D) that clusters a+b.
    const cleanClusterAB = () => ({
        codeSuggestions: [
            {
                id: 'a',
                sameSuggestionsId: ['b'],
                problemDescription: 'dup issue',
                actionStatement: 'Please fix it',
            },
        ],
    });

    // Recovery predicate: the a+b cluster was actually applied (a → PARENT,
    // b → RELATED). Used by the #1786 it.failing rows.
    const clusteringWasApplied = (result: any[]): boolean => {
        const parent = result.find((r) => r?.id === 'a');
        const related = result.find((r) => r?.id === 'b');
        return (
            parent?.clusteringInformation?.type === ClusteringType.PARENT &&
            related?.clusteringInformation?.type === ClusteringType.RELATED
        );
    };

    beforeEach(() => {
        jest.clearAllMocks();
        parametersService = {
            findByKey: jest.fn().mockResolvedValue({ configValue: 'en-US' }),
        };
        service = new CommentManagerService(
            parametersService,
            {} as any,
            { runLLMInSpan: jest.fn(), runAiSdkLLMInSpan: jest.fn() } as any,
            {} as any,
            {} as any,
        );
        // Spy on the REAL boundary; each test sets its own resolved/rejected value.
        runSpy = jest.spyOn(LLM as any, 'run');
    });

    afterEach(() => {
        // Restore so the parity suite above (which drives the real LLM.run →
        // tracedGenerateText seam) is unaffected.
        runSpy.mockRestore();
    });

    // ── Request assembly (deterministic) ────────────────────────────────────
    describe('request assembly', () => {
        it('threads schema, system, user, runName, organizationId, byokConfig and attrs into LLM.run', async () => {
            runSpy.mockResolvedValue(cleanClusterAB());
            const byok: any = { provider: 'openai', model: 'gpt-x' };

            await service.repeatedCodeReviewSuggestionClustering(
                stubOrg as any,
                PR,
                input3(),
                byok,
            );

            expect(runSpy).toHaveBeenCalledTimes(1);
            const arg = runSpy.mock.calls[0][0];
            expect(arg.schema).toBe(repeatedClusteringSchema);
            expect(arg.system).toBe(
                prompt_repeated_suggestion_clustering_system({
                    language: 'en-US',
                }),
            );
            expect(arg.user).toContain('<codeSuggestionsContext>');
            expect(arg.user).toContain('"id":"a"');
            expect(arg.runName).toBe('repeatedCodeReviewSuggestionClustering');
            expect(arg.organizationId).toBe('org-1');
            expect(arg.byokConfig).toBe(byok);
            expect(arg.attrs).toEqual({ organizationId: 'org-1', prNumber: PR });
        });

        it('resolves the language from ParametersService before assembling the prompt', async () => {
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            await service.repeatedCodeReviewSuggestionClustering(
                stubOrg as any,
                PR,
                input3(),
            );
            expect(parametersService.findByKey).toHaveBeenCalledWith(
                ParametersKey.LANGUAGE_CONFIG,
                stubOrg,
            );
        });
    });

    // ── A. Output-shape zoo ─────────────────────────────────────────────────
    describe('A. output-shape zoo', () => {
        // Row 1 — exact D (happy). Enrichment applies a+b clustering.
        it('[1] exact D → applies the clustering (a=PARENT, b=RELATED)', async () => {
            runSpy.mockResolvedValue(cleanClusterAB());
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    input3(),
                );
            expect(clusteringWasApplied(result)).toBe(true);
            // Non-clustered c survives untouched.
            expect(result.find((r) => r.id === 'c')).toEqual({
                id: 'c',
                relevantFile: 'c.ts',
                suggestionContent: 'C',
            });
        });

        // Row 2 — bare array of clusters (D is an object). The real payload sits
        // in the array; prod parses it, finds no top-level `codeSuggestions`, and
        // SILENTLY returns the input unchanged (#1786 drop). CORRECT = recover.
        it.failing(
            '[2] bare array of clusters → recovers and applies clustering (silent-drop today)',
            async () => {
                runSpy.mockResolvedValue([
                    {
                        id: 'a',
                        sameSuggestionsId: ['b'],
                        problemDescription: 'dup',
                        actionStatement: 'fix',
                    },
                ]);
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        input3(),
                    );
                expect(clusteringWasApplied(result)).toBe(true);
            },
        );

        // Row 3 — single object where the inner `codeSuggestions` should be an
        // array. processResponse does `.map` on the object → throws → returns
        // null → `null.codeSuggestions` throws PAST the boundary. CORRECT =
        // fail-safe (return input, never throw).
        it.failing(
            '[3] codeSuggestions as a single object → fail-safe returns input (throws past boundary today)',
            async () => {
                runSpy.mockResolvedValue({
                    codeSuggestions: { id: 'a', sameSuggestionsId: ['b'] },
                });
                const original = input3();
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        original,
                    );
                expect(result).toEqual(original);
            },
        );

        // Row 4 — wrapper key {result: D}. Data hidden under `result` → silent drop.
        it.failing(
            '[4] {result: D} wrapper → recovers and applies clustering (silent-drop today)',
            async () => {
                runSpy.mockResolvedValue({ result: cleanClusterAB() });
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        input3(),
                    );
                expect(clusteringWasApplied(result)).toBe(true);
            },
        );

        // Row 5 — double wrapper {result:{result:D}}.
        it.failing(
            '[5] {result:{result:D}} double wrapper → recovers clustering (silent-drop today)',
            async () => {
                runSpy.mockResolvedValue({
                    result: { result: cleanClusterAB() },
                });
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        input3(),
                    );
                expect(clusteringWasApplied(result)).toBe(true);
            },
        );

        // Row 6 — opaque single-key wrap {content: D}.
        it.failing(
            '[6] {content: D} opaque wrap → recovers clustering (silent-drop today)',
            async () => {
                runSpy.mockResolvedValue({ content: cleanClusterAB() });
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        input3(),
                    );
                expect(clusteringWasApplied(result)).toBe(true);
            },
        );

        // Row 7 — the whole D as a JSON string. `clustered` is a string; it gets
        // re-JSON.stringify'd (double-encoded), parses back to a string (not an
        // object) → null → throws past the boundary. CORRECT = fail-safe.
        it.failing(
            '[7] stringified-JSON payload → fail-safe returns input (throws past boundary today)',
            async () => {
                runSpy.mockResolvedValue(
                    JSON.stringify(cleanClusterAB()) as any,
                );
                const original = input3();
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        original,
                    );
                expect(result).toEqual(original);
            },
        );

        // Row 8 — markdown-fenced payload as a string. Double-encoded like row 7.
        it.failing(
            '[8] markdown-fenced string payload → fail-safe returns input (throws past boundary today)',
            async () => {
                runSpy.mockResolvedValue(
                    ('```json\n' +
                        JSON.stringify(cleanClusterAB()) +
                        '\n```') as any,
                );
                const original = input3();
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        original,
                    );
                expect(result).toEqual(original);
            },
        );

        // Row 9 — prose-wrapped string.
        it.failing(
            '[9] prose-wrapped string payload → fail-safe returns input (throws past boundary today)',
            async () => {
                runSpy.mockResolvedValue(
                    ('Here is the result: ' +
                        JSON.stringify(cleanClusterAB())) as any,
                );
                const original = input3();
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        original,
                    );
                expect(result).toEqual(original);
            },
        );

        // Row 10 — right data, wrong keys.
        it.failing(
            '[10] renamed keys {clusters:[...]} → recovers clustering (silent-drop today)',
            async () => {
                runSpy.mockResolvedValue({
                    clusters: cleanClusterAB().codeSuggestions,
                });
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        input3(),
                    );
                expect(clusteringWasApplied(result)).toBe(true);
            },
        );

        // Row 11 — case/convention mismatch on the top-level key.
        it.failing(
            '[11] case mismatch {CodeSuggestions:[...]} → recovers clustering (silent-drop today)',
            async () => {
                runSpy.mockResolvedValue({
                    CodeSuggestions: cleanClusterAB().codeSuggestions,
                });
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        input3(),
                    );
                expect(clusteringWasApplied(result)).toBe(true);
            },
        );

        // Row 12 — partial cluster object (missing sameSuggestionsId). Passes
        // the array predicate, then extractAllClusteredIds does `.map` on
        // undefined → throws PAST the boundary. CORRECT = fail-safe/tolerate.
        it.failing(
            '[12] cluster missing sameSuggestionsId → does not throw past boundary (crashes today)',
            async () => {
                runSpy.mockResolvedValue({
                    codeSuggestions: [{ id: 'a' }],
                });
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        input3(),
                    );
                // At minimum: return a well-formed array, never throw.
                expect(Array.isArray(result)).toBe(true);
            },
        );

        // Row 13 — extra unknown keys alongside the right ones: must tolerate.
        it('[13] extra unknown keys → tolerated, clustering still applied', async () => {
            runSpy.mockResolvedValue({
                meta: 'ignore-me',
                codeSuggestions: [
                    {
                        id: 'a',
                        sameSuggestionsId: ['b'],
                        problemDescription: 'dup',
                        actionStatement: 'fix',
                        foo: 'bar',
                    },
                ],
            });
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    input3(),
                );
            expect(clusteringWasApplied(result)).toBe(true);
        });

        // Row 14 — empty object. No clusters present → correctly returns input.
        it('[14] empty object {} → safe-default returns the original suggestions', async () => {
            runSpy.mockResolvedValue({});
            const original = input3();
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    original,
                );
            expect(result).toEqual(original);
        });

        // Row 15 — empty array. No clusters → returns input unchanged.
        it('[15] empty array [] → safe-default returns the original suggestions', async () => {
            runSpy.mockResolvedValue([]);
            const original = input3();
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    original,
                );
            expect(result).toEqual(original);
        });

        // Row 16 — empty string. Falsy → "No result" thrown INSIDE the try →
        // caught → returns input. Documented fail-safe (logged).
        it('[16] empty string → fail-safe returns the original suggestions', async () => {
            runSpy.mockResolvedValue('' as any);
            const original = input3();
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    original,
                );
            expect(result).toEqual(original);
        });

        // Row 16b — whitespace-only string is TRUTHY, so it is JSON.stringify'd,
        // parses to a string, and throws past the boundary. CORRECT = fail-safe.
        it.failing(
            '[16w] whitespace-only string → fail-safe returns input (throws past boundary today)',
            async () => {
                runSpy.mockResolvedValue('   ' as any);
                const original = input3();
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        original,
                    );
                expect(result).toEqual(original);
            },
        );

        // Row 17 — null / undefined return. Falsy → fail-safe returns input.
        it('[17] null return → fail-safe returns the original suggestions', async () => {
            runSpy.mockResolvedValue(null as any);
            const original = input3();
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    original,
                );
            expect(result).toEqual(original);
        });

        it('[17b] undefined return → fail-safe returns the original suggestions', async () => {
            runSpy.mockResolvedValue(undefined as any);
            const original = input3();
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    original,
                );
            expect(result).toEqual(original);
        });

        // Row 18 — primitive where object expected. `0` is falsy → fail-safe.
        it('[18a] primitive 0 → fail-safe returns the original suggestions', async () => {
            runSpy.mockResolvedValue(0 as any);
            const original = input3();
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    original,
                );
            expect(result).toEqual(original);
        });

        // Row 18 — `true` is truthy → stringifies to "true", parses to a boolean
        // → null → throws past the boundary. CORRECT = fail-safe.
        it.failing(
            '[18b] primitive true → fail-safe returns input (throws past boundary today)',
            async () => {
                runSpy.mockResolvedValue(true as any);
                const original = input3();
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        original,
                    );
                expect(result).toEqual(original);
            },
        );

        // Row 19 — provider envelope leak. Cluster data buried under choices → drop.
        it.failing(
            '[19] provider envelope {choices:[{message:{content}}]} → recovers clustering (silent-drop today)',
            async () => {
                runSpy.mockResolvedValue({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify(cleanClusterAB()),
                            },
                        },
                    ],
                });
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        input3(),
                    );
                expect(clusteringWasApplied(result)).toBe(true);
            },
        );

        // Row 20 — reasoning/thinking leak: a thinking object with no
        // codeSuggestions key. No recoverable clusters → safe-default returns
        // input (acceptable: nothing to apply, and no data is lost).
        it('[20] thinking-leak object (no codeSuggestions) → safe-default returns input', async () => {
            runSpy.mockResolvedValue({
                thinking: 'let me analyze the duplicates...',
            });
            const original = input3();
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    original,
                );
            expect(result).toEqual(original);
        });
    });

    // ── B. Semantic-but-wrong ───────────────────────────────────────────────
    describe('B. semantic-but-wrong', () => {
        // Row 25 — dangling reference: a cluster referencing an id NOT in the
        // input. Prod emits a contentless phantom suggestion (only
        // clusteringInformation, no id/file/content) → a garbled comment (#1786).
        // CORRECT = drop the unknown reference, never emit a contentless entry.
        it.failing(
            '[25] dangling sameSuggestionsId (unknown id) → no contentless phantom suggestion (garbles today)',
            async () => {
                runSpy.mockResolvedValue({
                    codeSuggestions: [
                        {
                            id: 'a',
                            sameSuggestionsId: ['ghost-does-not-exist'],
                            problemDescription: 'dup',
                            actionStatement: 'fix',
                        },
                    ],
                });
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        input3(),
                    );
                // No emitted suggestion should be a contentless shell.
                const hasPhantom = result.some(
                    (r) =>
                        r?.clusteringInformation &&
                        r?.id === undefined &&
                        r?.suggestionContent === undefined,
                );
                expect(hasPhantom).toBe(false);
            },
        );

        // Row 27 — unicode / escaped newlines / emoji inside string fields must
        // survive into the enriched clustering payload.
        it('[27] unicode/emoji/newlines in cluster fields survive enrichment', async () => {
            const desc = 'café \n dup 🚀 <tag>';
            runSpy.mockResolvedValue({
                codeSuggestions: [
                    {
                        id: 'a',
                        sameSuggestionsId: ['b'],
                        problemDescription: desc,
                        actionStatement: 'fix ✅',
                    },
                ],
            });
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    input3(),
                );
            const parent = result.find((r) => r.id === 'a');
            expect(parent?.clusteringInformation?.problemDescription).toBe(desc);
            expect(parent?.clusteringInformation?.actionStatement).toBe(
                'fix ✅',
            );
        });
    });

    // ── C. Unparseable / transport (fail-safe layer) ────────────────────────
    describe('C. unparseable / transport', () => {
        // Row 30 — LLM.run throws (network/timeout) → caught → returns input.
        it('[30] LLM.run rejects → fail-safe returns the original suggestions', async () => {
            runSpy.mockRejectedValue(new Error('network down'));
            const original = input3();
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    original,
                );
            expect(result).toEqual(original);
        });

        // Row 31 — {error:...} object returned (not thrown). No codeSuggestions →
        // no recoverable clusters → safe-default returns input.
        it('[31] {error} object → safe-default returns the original suggestions', async () => {
            runSpy.mockResolvedValue({ error: 'rate_limited' } as any);
            const original = input3();
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    original,
                );
            expect(result).toEqual(original);
        });

        // Row 32 — empty success (content:''), modeled as an empty string return
        // → falsy → fail-safe returns input.
        it('[32] empty-success (empty string) → fail-safe returns the original suggestions', async () => {
            runSpy.mockResolvedValue('' as any);
            const original = input3();
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    original,
                );
            expect(result).toEqual(original);
        });

        // Row 33 — refusal prose string. Truthy → stringified → parses to a
        // string → null → throws past the boundary. CORRECT = fail-safe.
        it.failing(
            '[33] refusal prose string → fail-safe returns input (throws past boundary today)',
            async () => {
                runSpy.mockResolvedValue(
                    "I'm sorry, I can't help with that." as any,
                );
                const original = input3();
                const result =
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        original,
                    );
                expect(result).toEqual(original);
            },
        );

        // Row 34 — abort surfaces as a rejection (the boundary does not thread an
        // abortSignal INTO LLM.run — see rowsNA). It must still fail-safe.
        it('[34] abort-style rejection → fail-safe returns the original suggestions', async () => {
            runSpy.mockRejectedValue(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
            );
            const original = input3();
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    original,
                );
            expect(result).toEqual(original);
        });
    });

    // ── D. Input variants ───────────────────────────────────────────────────
    describe('D. input variants', () => {
        // Row 35 — empty input.
        it('[35] empty input [] → returns [] and still assembles one call', async () => {
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    [],
                );
            expect(result).toEqual([]);
            expect(runSpy).toHaveBeenCalledTimes(1);
            expect(runSpy.mock.calls[0][0].user).toContain(
                '<codeSuggestionsContext>[]</codeSuggestionsContext>',
            );
        });

        // Row 36 — single item, model finds no duplicates.
        it('[36] single item, no clusters → returns the item unchanged', async () => {
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            const original = [
                { id: 'only', relevantFile: 'x.ts', suggestionContent: 'X' },
            ];
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    original,
                );
            expect(result).toEqual(original);
        });

        // Row 38 — duplicate items (same id) in the input on the no-cluster path.
        it('[38] duplicate-id input, no clusters → returns input without crashing', async () => {
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            const original = [
                { id: 'a', relevantFile: 'a.ts', suggestionContent: 'A1' },
                { id: 'a', relevantFile: 'a.ts', suggestionContent: 'A2' },
            ];
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    original,
                );
            expect(result).toEqual(original);
        });

        // Row 39 — input items with null/undefined fields on the no-cluster path.
        it('[39] null/undefined-field input, no clusters → returns input without crashing', async () => {
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            const original: any[] = [
                { id: 'a', relevantFile: null, suggestionContent: undefined },
                { id: undefined },
            ];
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    original,
                );
            expect(result).toEqual(original);
        });

        // Row 40 — special chars / whitespace inside input are serialized safely
        // into the user prompt (no crash, JSON-escaped).
        it('[40] special-char input → serialized (escaped) into the user prompt', async () => {
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            const original = [
                {
                    id: 'a',
                    suggestionContent: 'weird "quotes" \n \t 🚀 </xml>',
                },
            ];
            const result =
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    original,
                );
            expect(result).toEqual(original);
            // JSON.stringify escaped the embedded double-quotes.
            expect(runSpy.mock.calls[0][0].user).toContain('\\"quotes\\"');
        });

        // Row 42 — order permutation is metamorphic: the same suggestions in a
        // different order, clustered the same way, yield an equivalent result set.
        it('[42] order permutation → equivalent clustering result set', async () => {
            runSpy.mockResolvedValue(cleanClusterAB());
            const r1 = await service.repeatedCodeReviewSuggestionClustering(
                stubOrg as any,
                PR,
                input3(),
            );
            runSpy.mockResolvedValue(cleanClusterAB());
            const permuted = [...input3()].reverse();
            const r2 = await service.repeatedCodeReviewSuggestionClustering(
                stubOrg as any,
                PR,
                permuted,
            );

            const summarize = (rs: any[]) =>
                rs
                    .map(
                        (r) =>
                            `${r.id}:${r.clusteringInformation?.type ?? 'none'}`,
                    )
                    .sort();
            expect(summarize(r1)).toEqual(summarize(r2));
        });
    });

    // ── E. Provider / model matrix ──────────────────────────────────────────
    // The structured-output-gate policy (strict json_schema vs json_object
    // fallback) lives DOWNSTREAM of this boundary, inside LLM.run /
    // runStructuredReviewCall. This boundary applies the SAME processResponse to
    // every model, so E is closed here by (a) verifying byokConfig is threaded
    // verbatim for both a strict-prefix and a fallback-prefix slot, and (b) the
    // A/B/C zoo above, which stands in for the json_object-fallback outputs.
    describe('E. provider/model threading (policy is downstream)', () => {
        it.each([
            ['strict json_schema model', { provider: 'moonshotai', model: 'kimi-k2' }],
            ['json_object fallback model', { provider: 'z-ai', model: 'glm-4' }],
        ])(
            'threads the byokConfig verbatim into LLM.run for a %s',
            async (_label, slot) => {
                runSpy.mockResolvedValue({ codeSuggestions: [] });
                await service.repeatedCodeReviewSuggestionClustering(
                    stubOrg as any,
                    PR,
                    input3(),
                    slot as any,
                );
                expect(runSpy.mock.calls[0][0].byokConfig).toBe(slot);
            },
        );

        it('undefined byokConfig (managed default) is threaded as undefined', async () => {
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            await service.repeatedCodeReviewSuggestionClustering(
                stubOrg as any,
                PR,
                input3(),
            );
            expect(runSpy.mock.calls[0][0].byokConfig).toBeUndefined();
        });
    });

    // ── Declared return type: ALWAYS an array of suggestions ─────────────────
    describe('guaranteed return shape', () => {
        it('returns an array for the happy path, the no-cluster path, and every fail-safe path', async () => {
            // happy
            runSpy.mockResolvedValue(cleanClusterAB());
            expect(
                Array.isArray(
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        input3(),
                    ),
                ),
            ).toBe(true);
            // no-cluster
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            expect(
                Array.isArray(
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        input3(),
                    ),
                ),
            ).toBe(true);
            // fail-safe (rejection)
            runSpy.mockRejectedValue(new Error('boom'));
            expect(
                Array.isArray(
                    await service.repeatedCodeReviewSuggestionClustering(
                        stubOrg as any,
                        PR,
                        input3(),
                    ),
                ),
            ).toBe(true);
        });
    });
});

/**
 * Parse-layer contract — LLMResponseProcessor.processResponse is the envelope
 * parser this clustering boundary delegates to. A few matrix rows are only
 * reachable as a RAW STRING (markdown fences, truncated/malformed JSON, duplicate
 * keys) — through the clustering boundary the value is always re-JSON.stringify'd
 * first, so we pin those rows directly against the parse layer the boundary uses.
 */
describe('LLMResponseProcessor.processResponse — raw-string parse rows', () => {
    const proc = () =>
        (
            new CommentManagerService(
                {} as any,
                {} as any,
                {} as any,
                {} as any,
                {} as any,
            ) as any
        ).llmResponseProcessor;
    const org = { organizationId: 'o', teamId: 't' } as any;

    // Row 8 — markdown-fenced JSON is recovered (the ``` markers are stripped).
    it('[8] markdown-fenced JSON string → recovers codeSuggestions', () => {
        const raw = '```json\n{"codeSuggestions":[{"id":"a"}]}\n```';
        const out = proc().processResponse(org, 1, raw);
        expect(out?.codeSuggestions?.[0]?.id).toBe('a');
    });

    // Row 26 — duplicate keys resolve last-wins (JSON5/JSON semantics).
    it('[26] duplicate codeSuggestions keys → last-wins, deterministic', () => {
        const raw =
            '{"codeSuggestions":[],"codeSuggestions":[{"id":"z"}]}';
        const out = proc().processResponse(org, 1, raw);
        expect(out?.codeSuggestions).toEqual([{ id: 'z' }]);
    });

    // Row 28 — truncated JSON (max_tokens mid-object) → documented null fallback.
    it('[28] truncated JSON → returns null (documented fallback)', () => {
        const raw = '{"codeSuggestions":[{"id":"a"';
        expect(proc().processResponse(org, 1, raw)).toBeNull();
    });

    // Row 29 — malformed JSON that even JSON5 cannot parse → null.
    it('[29] unrecoverably malformed JSON → returns null', () => {
        const raw = 'this is not json at all {{{';
        expect(proc().processResponse(org, 1, raw)).toBeNull();
    });

    // Row 29b — JSON5 tolerates trailing commas / single quotes / unquoted keys,
    // so those "malformed" shapes are actually recovered, not dropped.
    it('[29b] JSON5-tolerant malformations (trailing comma, unquoted key) → recovered', () => {
        const raw = "{codeSuggestions:[{id:'a',},],}";
        const out = proc().processResponse(org, 1, raw);
        expect(out?.codeSuggestions?.[0]?.id).toBe('a');
    });
});
