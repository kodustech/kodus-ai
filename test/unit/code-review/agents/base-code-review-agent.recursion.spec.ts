/**
 * Tests covering the recursion bug in BaseCodeReviewAgentProvider and the
 * two-pronged guarantee: no-recursion when chunking can't help, and a
 * defense-in-depth depth cap if anything else manages to recurse.
 *
 *   - Original "Fix B" (fail fast with AGENT_PROMPT_OVERHEAD_EXCEEDS_BUDGET)
 *     was replaced by a pre-check inside execute(): when the chunker would
 *     return a single chunk containing every file, we skip executeChunked
 *     and fall through to a single runAgentLoop call instead of recursing.
 *     The agent's own assertContextWindowFitsOverhead preflight handles
 *     the genuine "overhead larger than the model can hold" case earlier,
 *     so there's no need to abort in executeChunked too. This avoids a
 *     false-positive abort when small files just pack comfortably into
 *     one chunk (caught by the adaptive-fit benchmark — see
 *     base-code-review-agent.provider.ts pre-check around the
 *     `estimatedPromptTokens > promptBudget` branch).
 *
 *   - Opção A (defense in depth): execute() enforces a recursion depth
 *     limit, throwing AGENT_RECURSION_LIMIT_EXCEEDED if any future code
 *     path manages to recurse past 2 levels. recursionDepth is forwarded
 *     by executeChunked when it calls execute() per-batch.
 *
 *   - Log readability: batchLabel is built from the unmodified
 *     baseIdentity.name so the agent name in logs stays bounded instead
 *     of growing one " batch X/Y" suffix per recursion level.
 *
 * The healthy paths (chunking that legitimately reduces file count, and
 * small PRs that bypass chunking entirely) are also covered as regression
 * guards: they must keep working after the fixes are applied.
 *
 * Mocks are scoped to external collaborators only. The recursion mechanics
 * (estimatePromptTokens, chunkFilesByTokenBudget) are exercised with real
 * inputs because those are the gates the bug rides on.
 */

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

jest.mock(
    '@/code-review/infrastructure/agents/llm/byok-to-vercel',
    () => ({
        byokToVercelModel: jest.fn(() => ({ id: 'fake-model' })),
        getModelName: jest.fn(() => 'fake-model'),
    }),
);

jest.mock(
    '@/code-review/infrastructure/agents/llm/model-context-window',
    () => ({
        resolveContextWindow: jest.fn(() => 200_000),
    }),
);

jest.mock('@libs/core/log/langfuse', () => ({
    shouldTrace: jest.fn(() => false),
}));

jest.mock('@/code-review/infrastructure/agents/llm/agent-loop', () => ({
    runAgentLoop: jest.fn(async () => ({
        findings: { suggestions: [] },
        text: '',
        steps: 0,
        toolCalls: [],
        finishReason: 'stop',
        source: 'empty',
        usage: {
            inputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
        },
        discardedBySeverity: [],
        droppedByVerify: [],
        coverage: {
            totalTargets: 0,
            touchedTargets: 0,
            pendingTargets: 0,
            touchedFiles: [],
            pendingFiles: [],
            criticalTotal: 0,
            criticalTouched: 0,
            criticalPending: 0,
            warmTotal: 0,
            warmTouched: 0,
            warmPending: 0,
            optionalTotal: 0,
            optionalTouched: 0,
            optionalPending: 0,
        },
        verification: null,
        anomalies: {
            stepsLe2: false,
            zeroToolCalls: false,
            zeroStrongEvidenceFiles: false,
            zeroCoverage: false,
            lowCoverage: false,
            lowStrongEvidenceFiles: false,
        },
    })),
}));

import {
    BaseCodeReviewAgentProvider,
    type ReviewAgentIdentity,
    type ReviewAgentInput,
} from '@/code-review/infrastructure/agents/base-code-review-agent.provider';
import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

class TestAgent extends BaseCodeReviewAgentProvider {
    constructor() {
        const permissionService: any = {
            getBYOKConfig: jest.fn().mockResolvedValue(null),
        };
        super(null as any, permissionService, null as any);
    }

    protected getIdentity(): ReviewAgentIdentity {
        return {
            name: 'kodus-test-agent',
            description: 'test',
            goal: 'test',
            expertise: ['test'],
        };
    }

    protected getCategoryPrompt(): string {
        return 'category-prompt-stub';
    }

    protected getCategoryLabel(): string {
        return 'bug';
    }
}

function makeFile(name: string, patchChars: number): FileChange {
    const patch = 'a'.repeat(patchChars);
    return {
        filename: name,
        sha: 'abc',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch,
        patchWithLinesStr: patch,
    } as any;
}

const BASE_INPUT_FIELDS = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    prNumber: 42,
    repositoryFullName: 'kodus/test',
    languageResultPrompt: 'en',
    remoteCommands: undefined,
    // 'deep' skips the aggressive filter / tiering branch so the chunking
    // gate is the only branch exercised here.
    reviewMode: 'deep' as const,
    maxSteps: 1,
};

/**
 * Pathological scenario: three tiny files plus a 400k-char callGraph.
 *   estimatePromptTokens ≈ 115k tokens (> promptBudget = 110k → gate fires)
 *   chunkFilesByTokenBudget(files, 94_500) → ONE chunk with all 3 files
 *     because each diff is ~20 tokens, well below the chunk budget.
 * executeChunked then calls execute() with the same 3 files, the gate
 * fires again, and we recurse forever.
 */
function makePathologicalInput(): ReviewAgentInput {
    return {
        ...BASE_INPUT_FIELDS,
        changedFiles: [
            makeFile('src/a.ts', 80),
            makeFile('src/b.ts', 80),
            makeFile('src/c.ts', 80),
        ],
        callGraph: 'x'.repeat(400_000),
    } as ReviewAgentInput;
}

/**
 * Healthy scenario: two 200k-char diffs. Each file individually fits in
 * chunkDiffBudget (50k ≤ 94.5k tokens) but the pair doesn't, so the
 * chunker produces two chunks of one file each. No recursion.
 */
function makeHealthyChunkingInput(): ReviewAgentInput {
    return {
        ...BASE_INPUT_FIELDS,
        changedFiles: [
            makeFile('src/large1.ts', 200_000),
            makeFile('src/large2.ts', 200_000),
        ],
    } as ReviewAgentInput;
}

/**
 * Small scenario: one tiny file, no callGraph. estimatedPromptTokens
 * stays well below promptBudget → chunking gate never fires.
 */
function makeSmallInput(): ReviewAgentInput {
    return {
        ...BASE_INPUT_FIELDS,
        changedFiles: [makeFile('src/tiny.ts', 80)],
    } as ReviewAgentInput;
}

/**
 * Marginal-overflow scenario. Diffs sum to ~93k tokens, comfortably under
 * the legacy chunkDiffBudget of 94.5k (which only subtracted the static
 * overhead) so the chunker packed every file into ONE chunk and the
 * recursion guard killed the review. With the fix the chunk budget also
 * subtracts the dynamic overhead (callGraph + coverage list + PR
 * context), drops to ~92k, and the chunker correctly produces two chunks.
 *
 * Numbers: 3 files × 124_000 chars (≈31k tokens each) + 10_000-char
 * callGraph. estimatePromptTokens ≈ 111k tokens (> promptBudget 110k →
 * gate fires).
 */
function makeMarginalOverflowInput(): ReviewAgentInput {
    return {
        ...BASE_INPUT_FIELDS,
        changedFiles: [
            makeFile('src/a.ts', 124_000),
            makeFile('src/b.ts', 124_000),
            makeFile('src/c.ts', 124_000),
        ],
        callGraph: 'x'.repeat(10_000),
    } as ReviewAgentInput;
}

/**
 * Real-world replay using the exact numbers captured in the prod
 * observability trace that surfaced this bug:
 *   - 77 changed files (post aggressive filter; we use 'deep' mode here
 *     to skip that branch and feed the chunker the same shape directly)
 *   - average diff per file 4_800 chars (~1_200 tokens)
 *   - callGraph 10_938 chars (~2_734 tokens)
 *   - contextWindow 200_000, promptBudget 110_000
 *
 * Expected accounting (post-fix):
 *   diff total          ≈ 92_400 tokens
 *   + static overhead   = 15_500
 *   + callGraph         = 2_734
 *   + coverage list     = 1_540  (77 × 80 / 4)
 *   + PR context        =    25  (post user-tweak with MIN(500))
 *   ────────────────────────────
 *   estimatedPrompt     ≈ 112_200 tokens  > 110_000 → gate fires
 *
 *   chunkDiffBudget OLD = 110_000 − 15_500 = 94_500
 *     → 92_400 ≤ 94_500 → 1 chunk → guard throws (the bug)
 *   chunkDiffBudget NEW = 110_000 − 19_800 = 90_200
 *     → 92_400 > 90_200 → 2+ chunks → review proceeds (the fix)
 */
function makeProdReplayInput(): ReviewAgentInput {
    const FILES = 77;
    const CHARS_PER_FILE = 4_800;
    const CALLGRAPH_CHARS = 10_938;
    const files = Array.from({ length: FILES }, (_, i) =>
        makeFile(`src/file_${i}.ts`, CHARS_PER_FILE),
    );
    return {
        ...BASE_INPUT_FIELDS,
        changedFiles: files,
        callGraph: 'x'.repeat(CALLGRAPH_CHARS),
    } as ReviewAgentInput;
}

/**
 * Wrap agent.execute() with a counter + hard cap so a runaway recursion
 * cannot hang the test runner. The cap throw is caught by executeChunked's
 * per-batch try/catch and absorbed into an empty result — exactly what
 * happens in production today, just bounded.
 */
const RECURSION_CAP = 25;

function setupExecuteSpy(agent: TestAgent) {
    const original = TestAgent.prototype.execute;
    let count = 0;
    const calls: ReviewAgentInput[] = [];
    const spy = jest
        .spyOn(agent, 'execute')
        .mockImplementation(async function (
            this: TestAgent,
            input: ReviewAgentInput,
        ) {
            count++;
            calls.push(input);
            if (count > RECURSION_CAP) {
                throw new Error(
                    `TEST_RECURSION_CAP_EXCEEDED after ${count} calls`,
                );
            }
            return original.call(this, input);
        });
    return { spy, calls, getCount: () => count };
}

describe('BaseCodeReviewAgentProvider — recursion bug + proposed fixes', () => {
    let agent: TestAgent;

    beforeEach(() => {
        agent = new TestAgent();
        jest.clearAllMocks();
    });

    describe('No-recursion contract — chunker returning 1 chunk falls through to a single runAgentLoop', () => {
        // The pathological scenario produces 3 tiny files + a 400K-char
        // callGraph. estimatePromptTokens exceeds promptBudget so the
        // chunking branch enters, but chunkFilesByTokenBudget packs all
        // 3 files into ONE chunk (each diff is tiny). The pre-check
        // detects this and skips executeChunked — review proceeds as a
        // single batch via the mocked runAgentLoop. Crucially, execute()
        // is never re-entered, which is the historical worker-OOM
        // regression this suite was written to lock down.
        it('completes without recursing — single execute() call, no chunked recursion', async () => {
            const { getCount } = setupExecuteSpy(agent);
            const result = await agent.execute(makePathologicalInput());
            expect(result).toBeDefined();
            expect(getCount()).toBe(1);
        });

        it('does not throw AGENT_PROMPT_OVERHEAD_EXCEEDS_BUDGET — the older guard was relaxed', async () => {
            setupExecuteSpy(agent);
            // The genuine "overhead larger than the window" case is now
            // caught by assertContextWindowFitsOverhead earlier in
            // execute(), so this scenario (overhead within window but
            // bigger than the 55%-of-window budget) is handled by
            // falling through to a single runAgentLoop, not aborting.
            await expect(
                agent.execute(makePathologicalInput()),
            ).resolves.toBeDefined();
        });
    });

    describe('Fix A — recursion-depth guard (defense in depth)', () => {
        it('rejects with AGENT_RECURSION_LIMIT_EXCEEDED when execute() is called directly with recursionDepth >= 2', async () => {
            const input = makeSmallInput() as any;
            input.recursionDepth = 2;
            await expect(agent.execute(input)).rejects.toThrow(
                'AGENT_RECURSION_LIMIT_EXCEEDED',
            );
        });

        it('propagates an incrementing recursionDepth from executeChunked into each per-batch execute() call', async () => {
            const { calls } = setupExecuteSpy(agent);
            await agent
                .execute(makeHealthyChunkingInput())
                .catch(() => undefined);
            // calls[0] = root execute, calls[1] = batch 1, calls[2] = batch 2
            expect(calls.length).toBeGreaterThanOrEqual(3);
            expect((calls[0] as any)?.recursionDepth ?? 0).toBe(0);
            expect((calls[1] as any)?.recursionDepth).toBe(1);
            expect((calls[2] as any)?.recursionDepth).toBe(1);
        });
    });

    describe('Log readability — batchLabel must not accumulate " batch X/Y" suffixes', () => {
        it('agentRuntimeName seen at every recursion level carries at most ONE " batch " segment', async () => {
            const { calls } = setupExecuteSpy(agent);
            await agent
                .execute(makePathologicalInput())
                .catch(() => undefined);
            for (const call of calls) {
                const name = call.agentRuntimeName || '';
                const occurrences = (name.match(/ batch /g) || []).length;
                expect(occurrences).toBeLessThanOrEqual(1);
            }
        });
    });

    describe('Regression guard — healthy paths must keep working', () => {
        it('chunker that reduces file count completes without recursing (root + 2 batches = 3 execute() calls)', async () => {
            const { getCount } = setupExecuteSpy(agent);
            const result = await agent.execute(makeHealthyChunkingInput());
            expect(result).toBeDefined();
            expect(getCount()).toBe(3);
        });

        it('small PR skips the chunking gate entirely (execute called once)', async () => {
            const { getCount } = setupExecuteSpy(agent);
            const result = await agent.execute(makeSmallInput());
            expect(result).toBeDefined();
            expect(getCount()).toBe(1);
        });
    });

    describe('Marginal-overflow scenario — dynamic overhead pushes prompt 2% over budget', () => {
        it('splits diffs that fit under the static-only budget but overflow the full prompt — no false-positive guard trip', async () => {
            const { getCount } = setupExecuteSpy(agent);
            const result = await agent.execute(makeMarginalOverflowInput());
            // 2 chunks → root + 2 per-batch executes = 3 calls.
            // Pre-fix this returned 1 chunk and threw
            // AGENT_PROMPT_OVERHEAD_EXCEEDS_BUDGET on the second pass.
            expect(result).toBeDefined();
            expect(getCount()).toBeGreaterThanOrEqual(3);
        });

        it('does NOT throw AGENT_PROMPT_OVERHEAD_EXCEEDS_BUDGET on the marginal scenario', async () => {
            setupExecuteSpy(agent);
            await expect(
                agent.execute(makeMarginalOverflowInput()),
            ).resolves.toBeDefined();
        });

        // Higher-fidelity regression test using the exact numbers from
        // the prod incident trace (77 files × ~4_800 chars, 10_938-char
        // callGraph). Verifies the fix against the real shape, not just
        // a constructed minimal case.
        it('replays prod trace shape — 77 files + 10_938-char callGraph + 200k window → split, not abort', async () => {
            const { getCount } = setupExecuteSpy(agent);
            const result = await agent.execute(makeProdReplayInput());
            expect(result).toBeDefined();
            // Root execute + at least 2 batch executes
            expect(getCount()).toBeGreaterThanOrEqual(3);
        });
    });
});
