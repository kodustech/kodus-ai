import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CreatePrLevelCommentsStage } from './create-pr-level-comments.stage';
import { CreateFileCommentsStage } from './create-file-comments.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { LLM } from '@libs/llm/llm';
import { PlatformType } from '@libs/core/domain/enums';

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

const makeContext = () =>
    frozenContext({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'repo-1', language: 'ts' },
        pullRequest: { number: 7 },
        platformType: PlatformType.GITHUB,
        changedFiles: [{ filename: FILE, patch: PATCH }],
        prAllCommits: [{ sha: 'head' }],
        codeReviewConfig: {
            reviewOptions: {},
            heavy: false,
            resolvedModelSlot: { provider: 'openai', model: 'gpt-4o-mini' },
            kodyRules: [
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

const runChain = async (input: any[]) => {
    const s = buildStages();
    s.reviewOrchestrator.execute.mockResolvedValue({
        suggestions: input,
        agentResults: [],
        failures: [],
        incomplete: [],
        warnings: [],
    });

    let ctx = await (s.agentReview as any).executeStage(makeContext());
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
