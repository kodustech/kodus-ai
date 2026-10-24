import { ANALYZER_SOURCE } from '@libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions';
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { AgentReviewStage } from './agent-review.stage';

/**
 * A self-hosted install without the platform OpenAI key has no embedder
 * (#2170). The dedup model's proposed merges then go to the tiebreak instead
 * of being vetoed; the Kody Rule × suggestion pass keeps the veto.
 */

type Merge = { honor: boolean; reason: string; score: number };

const makeStage = (embedder: 'none' | 'vectors' = 'none') => {
    const stage = new AgentReviewStage(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
    );
    if (embedder === 'none') {
        // What buildPlatformEmbedder returns without API_OPEN_AI_API_KEY.
        (stage as any).dedupEmbedder = null;
    }
    return stage;
};

const resolve = (
    stage: AgentReviewStage,
    dup: Partial<CodeSuggestion>,
    keep: Partial<CodeSuggestion>,
    tiebreak: jest.Mock,
    opts?: { crossStream?: boolean },
): Promise<Merge> =>
    (stage as any).resolveDedupMerge(
        dup,
        keep,
        'n0',
        'n1',
        new Map(),
        tiebreak,
        opts,
    );

// Low word overlap, so the lexical shortcut does not decide.
const dup: Partial<CodeSuggestion> = {
    relevantFile: 'src/orders.ts',
    relevantLinesStart: 10,
    relevantLinesEnd: 12,
    label: 'bug',
    suggestionContent:
        'The total ignores refunded items, so customers are overcharged.',
};
const keep: Partial<CodeSuggestion> = {
    relevantFile: 'src/orders.ts',
    relevantLinesStart: 10,
    relevantLinesEnd: 14,
    label: 'bug',
    suggestionContent:
        'Refunds never reach the sum computed in calculateTotal.',
};

describe('AgentReviewStage dedup guard without an embedding (#2170)', () => {
    it("asks the tiebreak about the model's proposed merge and honors a yes", async () => {
        const tiebreak = jest.fn().mockResolvedValue(true);

        const merge = await resolve(makeStage(), dup, keep, tiebreak);

        expect(tiebreak).toHaveBeenCalledWith(dup, keep);
        expect(merge).toMatchObject({
            honor: true,
            reason: 'llm-tiebreak=true (no-embed)',
        });
    });

    it('keeps both when the tiebreak says they are different bugs', async () => {
        const tiebreak = jest.fn().mockResolvedValue(false);

        const merge = await resolve(makeStage(), dup, keep, tiebreak);

        expect(merge).toMatchObject({
            honor: false,
            reason: 'llm-tiebreak=false (no-embed)',
        });
    });

    it('vetoes when the tiebreak fails', async () => {
        const tiebreak = jest.fn().mockResolvedValue(null);

        const merge = await resolve(makeStage(), dup, keep, tiebreak);

        expect(merge).toMatchObject({
            honor: false,
            reason: 'lexical-veto (no-embed)',
        });
    });

    it('keeps the veto on the cross-stream pass, without asking', async () => {
        const tiebreak = jest.fn().mockResolvedValue(true);

        const merge = await resolve(makeStage(), dup, keep, tiebreak, {
            crossStream: true,
        });

        expect(tiebreak).not.toHaveBeenCalled();
        expect(merge).toMatchObject({
            honor: false,
            reason: 'lexical-veto (no-embed)',
        });
    });

    it('merges a restated scanner finding without asking', async () => {
        const tiebreak = jest.fn().mockResolvedValue(false);
        const scanner: Partial<CodeSuggestion> = {
            relevantFile: 'src/config.ts',
            relevantLinesStart: 4,
            relevantLinesEnd: 4,
            label: 'deterministic',
            evidence: {
                source: ANALYZER_SOURCE,
                ruleId: 'generic-api-key',
            } as any,
        };
        const restatement: Partial<CodeSuggestion> = {
            relevantFile: 'src/config.ts',
            relevantLinesStart: 3,
            relevantLinesEnd: 6,
            label: 'security',
            suggestionContent: 'A hardcoded credential is committed here.',
        };

        const merge = await resolve(
            makeStage(),
            restatement,
            scanner,
            tiebreak,
        );

        expect(tiebreak).not.toHaveBeenCalled();
        expect(merge).toMatchObject({
            honor: true,
            reason: 'restates-analyzer (no-embed)',
        });
    });

    it('leaves the path with embeddings as it was', async () => {
        const stage = makeStage('vectors');
        // Orthogonal vectors: cosine 0, below the low cut.
        jest.spyOn(stage as any, 'embedDedupSuggestion')
            .mockResolvedValueOnce([1, 0])
            .mockResolvedValueOnce([0, 1]);
        const tiebreak = jest.fn().mockResolvedValue(true);

        const merge = await resolve(stage, dup, keep, tiebreak);

        expect(tiebreak).not.toHaveBeenCalled();
        expect(merge).toMatchObject({ honor: false, reason: 'embedding-low' });
    });
});
