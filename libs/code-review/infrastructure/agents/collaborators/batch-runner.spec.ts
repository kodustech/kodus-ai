/**
 * #2171 — a chunked review carries what each batch says about itself. A large
 * PR is split into batches; if one batch ended without finishing, or left
 * findings unverified, the aggregate the orchestrator sees has to say so.
 */
import { runChunkedReview } from './batch-runner';
import type {
    ReviewAgentInput,
    ReviewAgentOutput,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';

const bigPatch = (name: string) =>
    `@@ -1,1 +1,400 @@\n${Array.from({ length: 400 }, (_, i) => `+const ${name}${i} = ${i};`).join('\n')}`;

function makeInput(): ReviewAgentInput {
    return {
        organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
        changedFiles: [
            { filename: 'src/a.ts', patch: bigPatch('a') },
            { filename: 'src/b.ts', patch: bigPatch('b') },
        ],
        prNumber: 7,
    } as unknown as ReviewAgentInput;
}

function batchResult(over: Partial<ReviewAgentOutput> = {}): ReviewAgentOutput {
    return {
        suggestions: [],
        agentName: 'agent',
        agentCategory: 'bug',
        turnsUsed: 3,
        durationMs: 1,
        hitHardLimit: false,
        finishReason: 'stop',
        ...over,
    };
}

function run(results: Array<ReviewAgentOutput | Error>) {
    const queue = [...results];
    return runChunkedReview(makeInput(), {
        identity: {
            name: 'agent',
            description: 'd',
            goal: 'g',
            expertise: [],
        },
        agentCategory: 'bug',
        startTime: Date.now(),
        // Small enough that each file lands in its own batch.
        diffBudget: 3_000,
        runBatch: async () => {
            const next = queue.shift() ?? batchResult();
            if (next instanceof Error) {
                throw next;
            }
            return next;
        },
        logger: { log: jest.fn(), error: jest.fn() },
    });
}

describe('runChunkedReview — #2171', () => {
    it('splits the fixture into two batches', async () => {
        const runBatch = jest.fn(async () => batchResult());
        await runChunkedReview(makeInput(), {
            identity: {
                name: 'agent',
                description: 'd',
                goal: 'g',
                expertise: [],
            },
            agentCategory: 'bug',
            startTime: Date.now(),
            diffBudget: 3_000,
            runBatch,
            logger: { log: jest.fn(), error: jest.fn() },
        });
        expect(runBatch).toHaveBeenCalledTimes(2);
    });

    it('is incomplete when any batch ended without finishing', async () => {
        const out = await run([
            batchResult(),
            batchResult({ hitHardLimit: true, finishReason: 'truncated' }),
        ]);

        expect(out.hitHardLimit).toBe(true);
        expect(out.finishReason).toBe('truncated');
    });

    it('is complete when every batch finished', async () => {
        const out = await run([batchResult(), batchResult()]);

        expect(out.hitHardLimit).toBe(false);
        expect(out.finishReason).toBe('stop');
    });

    it('carries every batch’s unverified findings', async () => {
        const out = await run([
            batchResult({
                discardedByVerifyError: [{ relevantFile: 'src/a.ts' }],
            }),
            batchResult({
                discardedByVerifyError: [{ relevantFile: 'src/b.ts' }],
            }),
        ]);

        expect(
            (out.discardedByVerifyError ?? []).map((s) => s.relevantFile),
        ).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('is incomplete when one batch threw and another finished', async () => {
        const out = await run([
            batchResult(),
            new Error('provider rate limit'),
        ]);

        expect(out.hitHardLimit).toBe(true);
        expect(out.finishReason).toBe('no-result');
    });

    it('keeps the findings of the batches that finished', async () => {
        const out = await run([
            batchResult({ suggestions: [{ relevantFile: 'src/a.ts' }] }),
            new Error('timeout'),
        ]);

        expect(out.suggestions.map((s) => s.relevantFile)).toEqual([
            'src/a.ts',
        ]);
        expect(out.hitHardLimit).toBe(true);
    });

    it('still throws when every batch failed and nothing was found', async () => {
        await expect(
            run([new Error('first'), new Error('second')]),
        ).rejects.toThrow('first');
    });

    it('does not override a batch that was already cut short', async () => {
        const out = await run([
            batchResult({ hitHardLimit: true, finishReason: 'truncated' }),
            new Error('timeout'),
        ]);

        expect(out.finishReason).toBe('truncated');
    });
});
