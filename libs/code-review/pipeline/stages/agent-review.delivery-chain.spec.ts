import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CreatePrLevelCommentsStage } from './create-pr-level-comments.stage';
import { CreateFileCommentsStage } from './create-file-comments.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { LLM } from '@libs/llm/llm';
import { PlatformType } from '@libs/core/domain/enums';
import { formatSuggestionContent } from '@libs/code-review/infrastructure/agents/engine/format-suggestion-content';

jest.mock(
    '@libs/code-review/infrastructure/agents/engine/classify-severity',
    () => ({ classifySeverity: jest.fn().mockResolvedValue(new Map()) }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/engine/format-suggestion-content',
    () => ({ formatSuggestionContent: jest.fn().mockResolvedValue(new Map()) }),
);
jest.mock('@libs/llm/managed-slot', () => {
    const actual = jest.requireActual('@libs/llm/managed-slot');
    return { ...actual, hasManagedModelKey: jest.fn(() => false) };
});

/**
 * Delivery contract across the real stages, in pipeline order:
 * AgentReviewStage → CreatePrLevelCommentsStage → CreateFileCommentsStage.
 *
 * Every finding must be delivered exactly once, through the channel that can
 * anchor it: a PR-level Kody Rules finding as a PR comment, a finding on a
 * changed line as a line comment. Production (2026-09-22) showed PR-level
 * findings reaching BOTH channels — 28/28 PRs with a path-less line comment
 * failure had also posted that finding as a PR comment.
 *
 * Only the edges are faked: the orchestrator returns the findings, the comment
 * manager records what each stage asked the provider to post, and persistence
 * records what each stage saved.
 */

const CONTEXT_RULE = 'rule-needs-context';
const PR_RULE = 'rule-pr-wide';
const FILE = 'src/user.ts';
// One hunk covering new-file lines 10-12.
const PATCH = ['@@ -10,2 +10,3 @@', ' const a = 1;', '+const b = 2;'].join(
    '\n',
);

// Shapes as mapped by finding-mapper and seen in production logs.
const findings = {
    // A — a PR-wide rule: no file, no line (the 54/day "path, line weren't supplied").
    prWide: {
        label: 'kody_rules',
        severity: 'medium',
        brokenKodyRulesIds: [PR_RULE],
        oneSentenceSummary: 'A: PR description is missing a changelog',
        suggestionContent: 'A: PR description is missing a changelog',
        existingCode: '',
        improvedCode: '',
        llmPrompt: 'A',
    },
    // B — a context rule's finding outside the hunk → file-anchored, PR-level.
    fileAnchored: {
        relevantFile: FILE,
        relevantLinesStart: 120,
        relevantLinesEnd: 180,
        label: 'kody_rules',
        severity: 'high',
        brokenKodyRulesIds: [CONTEXT_RULE],
        oneSentenceSummary: 'B: this function is far too long',
        suggestionContent: 'B: this function is far too long',
        improvedCode: '',
    },
    // C — an ordinary bug on a changed line → inline.
    inline: {
        relevantFile: FILE,
        relevantLinesStart: 11,
        relevantLinesEnd: 11,
        label: 'bug',
        severity: 'high',
        oneSentenceSummary: 'C: b is never used',
        suggestionContent: 'C: b is never used',
        existingCode: 'const b = 2;',
        improvedCode: '',
    },
};

const tag = (s: any) => String(s?.oneSentenceSummary ?? '').slice(0, 2);

const buildStages = () => {
    const reviewOrchestrator = { execute: jest.fn() };
    const agentReview = new AgentReviewStage(
        {
            findLatestStageLog: jest.fn(),
            updateCodeReview: jest.fn(),
            updateStageLog: jest.fn(),
        } as any,
        { findByExternalId: jest.fn().mockResolvedValue(null) } as any,
        reviewOrchestrator as any,
        { runLLMInSpan: jest.fn(async ({ runFn }: any) => runFn?.()) } as any,
        { generateContext: jest.fn(), generateContextLegacy: jest.fn() } as any,
        { isEnabled: jest.fn().mockResolvedValue(false) } as any,
        { getReleaseTrack: jest.fn().mockResolvedValue('stable') } as any,
        {
            getRepositories: jest.fn().mockResolvedValue([]),
            getCloneParams: jest.fn().mockResolvedValue(null),
        } as any,
    );

    const posted = { prLevel: [] as any[], inline: [] as any[] };
    const saved = { prLevel: [] as any[], fileLevel: [] as any[] };

    const commentManager = {
        createPrLevelReviewComments: jest.fn(
            async (_o: any, _n: any, _r: any, suggestions: any[]) => {
                posted.prLevel.push(...suggestions);
                return {
                    commentResults: suggestions.map((suggestion) => ({
                        comment: { type: 'pr_level', suggestion },
                        deliveryStatus: 'sent',
                    })),
                };
            },
        ),
        createLineComments: jest.fn(
            async (_o: any, _n: any, _r: any, lineComments: any[]) => {
                posted.inline.push(...lineComments);
                return {
                    lastAnalyzedCommit: { sha: 'head' },
                    commits: [],
                    commentResults: lineComments.map((comment) => ({
                        comment,
                        deliveryStatus: 'sent',
                    })),
                };
            },
        ),
    };
    const suggestionService = {
        resolveImplementedSuggestionsOnPlatform: jest.fn(),
        transformCommentResultsToPrLevelSuggestions: jest.fn((results: any[]) =>
            results.map((r) => r.comment.suggestion),
        ),
        verifyIfSuggestionsWereSent: jest.fn(
            async (_o: any, _p: any, suggestions: any[]) => suggestions,
        ),
        extractRepriorizedSuggestions: jest.fn((_r: any, discarded: any[]) => ({
            repriorizedSuggestions: [],
            filteredDiscardedSuggestions: discarded,
        })),
    };
    const pullRequests = {
        addPrLevelSuggestions: jest.fn(
            async (_n: any, _r: any, suggestions: any[]) => {
                saved.prLevel.push(...suggestions);
            },
        ),
        aggregateAndSaveDataStructure: jest.fn(
            async (_pr: any, _repo: any, _files: any, prioritized: any[]) => {
                saved.fileLevel.push(...prioritized);
            },
        ),
    };

    const prLevelStage = new CreatePrLevelCommentsStage(
        commentManager as any,
        suggestionService as any,
        pullRequests as any,
    );
    const fileStage = new CreateFileCommentsStage(
        commentManager as any,
        pullRequests as any,
        suggestionService as any,
    );

    return {
        reviewOrchestrator,
        agentReview,
        prLevelStage,
        fileStage,
        posted,
        saved,
    };
};

const makeContext = (
    over: {
        changedFiles?: any[];
        kodyRules?: any[];
    } = {},
) =>
    frozenContext({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'repo-1', language: 'ts' },
        pullRequest: { number: 7 },
        platformType: PlatformType.GITHUB,
        changedFiles: over.changedFiles ?? [{ filename: FILE, patch: PATCH }],
        prAllCommits: [{ sha: 'head' }],
        codeReviewConfig: {
            reviewOptions: {},
            heavy: false,
            resolvedModelSlot: { provider: 'openai', model: 'gpt-4o-mini' },
            kodyRules: over.kodyRules ?? [
                {
                    uuid: CONTEXT_RULE,
                    title: 'functions stay under 50 lines',
                    rule: 'A function must not exceed 50 lines.',
                    severity: 'high',
                    contextNeed: {
                        need: 'enclosing-scope',
                        sourceHash: 'h',
                        source: 'compiler',
                        inferredAt: new Date(0),
                    },
                },
                {
                    uuid: PR_RULE,
                    title: 'PRs carry a changelog',
                    rule: 'Every PR description has a changelog.',
                    severity: 'medium',
                },
            ],
        },
        heavy: false,
        validSuggestions: [],
        discardedSuggestions: [],
        errors: [],
    }) as any as CodeReviewPipelineContext;

const runChain = async (
    input: any[],
    over: { changedFiles?: any[]; kodyRules?: any[] } = {},
) => {
    const s = buildStages();
    s.reviewOrchestrator.execute.mockResolvedValue({
        suggestions: input,
        agentResults: [],
        failures: [],
        incomplete: [],
        warnings: [],
    });

    let ctx = await (s.agentReview as any).executeStage(makeContext(over));
    ctx = await (s.prLevelStage as any).executeStage(ctx);
    ctx = await (s.fileStage as any).executeStage(ctx);

    return { ...s, ctx };
};

describe('delivery chain — AgentReview → CreatePrLevelComments → CreateFileComments', () => {
    let runSpy: jest.SpyInstance;
    beforeEach(() => {
        runSpy = jest
            .spyOn(LLM, 'run')
            .mockImplementation(
                async () => ({ groups: [], unique: [0, 1, 2] }) as any,
            );
    });
    afterEach(() => {
        runSpy.mockRestore();
        jest.clearAllMocks();
    });

    it('delivers every finding exactly once, through the channel that can anchor it', async () => {
        const { posted } = await runChain([
            findings.prWide,
            findings.fileAnchored,
            findings.inline,
        ]);

        expect(posted.prLevel.map(tag).sort()).toEqual(['A:', 'B:']);
        expect(posted.inline.map((c) => tag(c.suggestion))).toEqual(['C:']);
    });

    it('never asks the provider for a line comment without a path or a line', async () => {
        const { posted } = await runChain([
            findings.prWide,
            findings.fileAnchored,
            findings.inline,
        ]);

        for (const comment of posted.inline) {
            expect(comment.path).toBeTruthy();
            expect(comment.line).toBeTruthy();
        }
    });

    it('persists a PR-level finding once, as PR-level — not again under the file', async () => {
        const { saved } = await runChain([
            findings.prWide,
            findings.fileAnchored,
            findings.inline,
        ]);

        expect(saved.prLevel.map(tag).sort()).toEqual(['A:', 'B:']);
        expect(saved.fileLevel.map(tag)).toEqual(['C:']);
    });

    it('a PR with only PR-level findings posts no line comments and still records the analyzed commit', async () => {
        const { posted, ctx } = await runChain([
            findings.prWide,
            findings.fileAnchored,
        ]);

        expect(posted.prLevel.map(tag).sort()).toEqual(['A:', 'B:']);
        expect(posted.inline).toEqual([]);
        expect(ctx.lastAnalyzedCommit).toEqual({ sha: 'head' });
    });

    it('a PR with only inline findings is unchanged: posted inline, nothing PR-level', async () => {
        const { posted, saved } = await runChain([findings.inline]);

        expect(posted.inline.map((c) => tag(c.suggestion))).toEqual(['C:']);
        expect(posted.prLevel).toEqual([]);
        expect(saved.fileLevel.map(tag)).toEqual(['C:']);
    });
});

/**
 * Issue #2015: the "Also found in" list of a merged Kody Rules comment was
 * appended to suggestionContent at dedup time, BEFORE formatSuggestionContent
 * rewrote that field from scratch. The rewrite folded or dropped it, so every
 * location but the kept one vanished from the posted comment. The list now
 * travels on the suggestion and is rendered after the formatter runs.
 */
describe('delivery chain: a merged Kody Rule comment keeps its other locations (#2015)', () => {
    const RULE = 'rule-stock-levels';
    const RULE_FILE = 'app/controllers/top_sellers_report_controller.rb';
    // The reported patch: a new file, one hunk covering lines 1-29.
    const WHOLE_FILE_PATCH = [
        '@@ -0,0 +1,29 @@',
        ...Array.from({ length: 29 }, (_, i) => `+ line ${i + 1}`),
    ].join('\n');

    const rules = () => [
        {
            uuid: RULE,
            title: 'stock levels are computed once per report',
            rule: 'The stock level must not be recomputed inside the row loop.',
            severity: 'high',
        },
    ];

    // Two violations of the SAME rule in the SAME file.
    // dedupKodyRulesByRuleUuid keeps the longest suggestionContent, so finding
    // A (14-17) is the kept representative and B (27-27) is the location that
    // must still be named in A's comment.
    const mergedFindings = () => [
        {
            relevantFile: RULE_FILE,
            relevantLinesStart: 14,
            relevantLinesEnd: 17,
            label: 'kody_rules',
            severity: 'high',
            brokenKodyRulesIds: [RULE],
            oneSentenceSummary: 'A: the stock level is recomputed per row',
            suggestionContent:
                'A: WHAT: the stock level is recomputed for every row. WHY: that is one query per row. HOW: compute it once before the loop.',
            existingCode: '',
            improvedCode: '',
        },
        {
            relevantFile: RULE_FILE,
            relevantLinesStart: 27,
            relevantLinesEnd: 27,
            label: 'kody_rules',
            severity: 'high',
            brokenKodyRulesIds: [RULE],
            oneSentenceSummary: 'B: the same rule is violated again',
            suggestionContent: 'B: the same rule is violated again',
            existingCode: '',
            improvedCode: '',
        },
    ];

    const over = () => ({
        changedFiles: [{ filename: RULE_FILE, patch: WHOLE_FILE_PATCH }],
        kodyRules: rules(),
    });

    const formatter = formatSuggestionContent as unknown as jest.Mock;
    const body = (comment: { body?: { suggestionContent?: string } }) =>
        String(comment?.body?.suggestionContent ?? '');
    const countOf = (text: string, needle: string) =>
        text.split(needle).length - 1;

    afterEach(() => {
        // The module-level mock is shared with the cases above; restore its
        // default so an override here cannot leak into them.
        formatter.mockReset();
        formatter.mockResolvedValue(new Map());
    });

    it('keeps the kept anchor and still names the other location after the formatter rewrote the prose', async () => {
        // Production formatter behavior: the rewrite returns one reworded
        // sentence and repeats nothing the stage appended.
        formatter.mockResolvedValue(
            new Map([
                [
                    0,
                    {
                        suggestionContent:
                            'The stock level is recomputed inside the row loop; compute it once before iterating.',
                    },
                ],
            ]),
        );

        const { posted } = await runChain(mergedFindings(), over());

        // One comment, anchored on the kept finding (14-17)...
        expect(posted.inline).toHaveLength(1);
        const [comment] = posted.inline;
        expect(comment.start_line).toBe(14);
        expect(comment.line).toBe(17);

        // ...and the other violation location is still named in its body.
        expect(body(comment)).toContain('Also found in');
        expect(body(comment)).toContain(':27-27');
        expect(countOf(body(comment), 'Also found in')).toBe(1);

        // The same list has to reach llmPrompt too: the per-comment "Prompt
        // for LLM" copy block and the consolidated @agentPrompt read it, and
        // validate-suggestions hands it to the fixer agent as the instruction.
        // A prompt naming only the kept location makes an agent fix line 17 and
        // miss line 27.
        const prompt = String(comment.suggestion?.llmPrompt ?? '');
        expect(prompt).toContain('Also found in');
        expect(prompt).toContain(':27-27');
        expect(countOf(prompt, 'Also found in')).toBe(1);

        // Ordering the fix establishes: the list is not part of what the
        // formatter sees, so nothing can rewrite it away.
        const formatterInput = formatter.mock.calls[0][0] as Array<{
            suggestionContent?: string;
        }>;
        expect(formatterInput).toHaveLength(1);
        expect(
            formatterInput.filter((s) =>
                String(s.suggestionContent).includes('Also found in'),
            ),
        ).toEqual([]);
    });

    it('control: a formatter that returns its input unchanged still yields the list exactly once', async () => {
        // The shape every real run has on models that leave the prose alone.
        formatter.mockImplementation(
            async (items: any[]) =>
                new Map(
                    items.map((item, i) => [
                        i,
                        { suggestionContent: item.suggestionContent },
                    ]),
                ),
        );

        const { posted } = await runChain(mergedFindings(), over());

        expect(posted.inline).toHaveLength(1);
        const [comment] = posted.inline;
        expect(comment.start_line).toBe(14);
        expect(comment.line).toBe(17);
        expect(body(comment)).toContain(':27-27');
        expect(countOf(body(comment), 'Also found in')).toBe(1);
        // The prompt copy carries the list in this shape too.
        expect(String(comment.suggestion?.llmPrompt ?? '')).toContain(':27-27');
    });
});

describe('delivery chain: a merged finding keeps its other locations', () => {
    const DUP_FILE = 'src/discount.ts';
    const WHOLE_FILE_PATCH = [
        '@@ -0,0 +1,29 @@',
        ...Array.from({ length: 29 }, (_, i) => `+ line ${i + 1}`),
    ].join('\n');

    // The same bug found twice; lexically close enough for the dedup guard to
    // honor the LLM's grouping without embeddings.
    const duplicateFindings = () => [
        {
            relevantFile: DUP_FILE,
            relevantLinesStart: 19,
            relevantLinesEnd: 19,
            label: 'bug',
            severity: 'high',
            oneSentenceSummary: 'coupon is dereferenced without a null guard',
            suggestionContent:
                'WHAT: coupon is dereferenced without a null guard. WHY: findCoupon returns undefined when no coupon matches, so applyCoupon throws. HOW: return the subtotal when coupon is undefined.',
            existingCode: '',
            improvedCode: '',
        },
        {
            relevantFile: DUP_FILE,
            relevantLinesStart: 23,
            relevantLinesEnd: 23,
            label: 'bug',
            severity: 'high',
            oneSentenceSummary: 'coupon is dereferenced without a null guard',
            suggestionContent:
                'WHAT: coupon is dereferenced without a null guard. WHY: findCoupon returns undefined, so applyCoupon throws.',
            existingCode: '',
            improvedCode: '',
        },
    ];

    const over = () => ({
        changedFiles: [{ filename: DUP_FILE, patch: WHOLE_FILE_PATCH }],
        kodyRules: [],
    });

    const formatter = formatSuggestionContent as unknown as jest.Mock;
    const body = (comment: { body?: { suggestionContent?: string } }) =>
        String(comment?.body?.suggestionContent ?? '');
    const countOf = (text: string, needle: string) =>
        text.split(needle).length - 1;

    let runSpy: jest.SpyInstance;
    beforeEach(() => {
        runSpy = jest.spyOn(LLM, 'run').mockImplementation(
            async () =>
                ({
                    groups: [{ keep: 0, duplicates: [1] }],
                    unique: [],
                }) as any,
        );
    });
    afterEach(() => {
        runSpy.mockRestore();
        formatter.mockReset();
        formatter.mockResolvedValue(new Map());
        jest.clearAllMocks();
    });

    it.each([
        {
            name: 'normal group',
            groups: [{ keep: 0, duplicates: [1] }],
            unique: [],
        },
        {
            name: 'keep also listed as unique',
            groups: [{ keep: 0, duplicates: [1] }],
            unique: [0],
        },
        {
            name: 'overlapping groups',
            unique: [],
            groups: [
                { keep: 0, duplicates: [] },
                { keep: 0, duplicates: [1, 1] },
            ],
        },
    ])(
        'preserves other locations once after formatting ($name)',
        async ({ groups, unique }) => {
            runSpy.mockResolvedValue({ groups, unique });
            // A rewrite of two full sentences: the cap leaves nothing room for an
            // appended list, which is how the list was lost.
            formatter.mockResolvedValue(
                new Map([
                    [
                        0,
                        {
                            suggestionContent:
                                'findCoupon returns undefined when nothing matches, so applyCoupon throws. Return the subtotal when coupon is undefined.',
                        },
                    ],
                ]),
            );

            const { posted } = await runChain(duplicateFindings(), over());

            expect(posted.inline).toHaveLength(1);
            const [comment] = posted.inline;
            expect(comment.line).toBe(19);

            expect(body(comment)).toContain('Also found in');
            expect(body(comment)).toContain(':23-23');
            expect(countOf(body(comment), 'Also found in')).toBe(1);

            const prompt = String(comment.suggestion?.llmPrompt ?? '');
            expect(prompt).toContain(':23-23');
            expect(countOf(prompt, 'Also found in')).toBe(1);

            const formatterInput = formatter.mock.calls[0][0] as Array<{
                suggestionContent?: string;
            }>;
            expect(
                formatterInput.filter((s) =>
                    String(s.suggestionContent).includes('Also found in'),
                ),
            ).toEqual([]);
        },
    );
});
