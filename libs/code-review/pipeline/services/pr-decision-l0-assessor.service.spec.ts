import type { GateVerdict } from '@libs/code-review/domain/risk/pr-decision-graph-verdict';
import type { L0Verdict } from '@libs/code-review/domain/risk/pr-decision-reducer';

import { PrDecisionL0AssessorService } from './pr-decision-l0-assessor.service';

/** Narrow a verdict to its Ready branch; fails the test otherwise. */
function ready<T>(verdict: GateVerdict<T>): T {
    if (verdict.status !== 'Ready') {
        throw new Error(`Expected a Ready verdict, got ${verdict.status}`);
    }
    return verdict.value;
}

const INPUT = (
    over: Partial<{ isDraft: boolean; isBotAuthor: boolean }> = {},
) => ({
    prShape: {
        isDraft: over.isDraft,
        isBotAuthor: over.isBotAuthor,
    },
    snapshotKey: 'cfg=abc;head=1234567',
});

describe('PrDecisionL0AssessorService', () => {
    const service = new PrDecisionL0AssessorService();

    it('passes both conditions for a normal human PR', async () => {
        const value = ready<L0Verdict>(
            await service.assess(INPUT({ isDraft: false, isBotAuthor: false })),
        );

        expect(value.every((c) => c.passed)).toBe(true);
    });

    it('fails the draft condition for a draft PR', async () => {
        const value = ready<L0Verdict>(
            await service.assess(INPUT({ isDraft: true })),
        );

        const draft = value.find((c) => c.name === 'not-draft');
        expect(draft?.passed).toBe(false);
        expect(draft?.reason).toMatch(/draft/i);
    });

    it('fails the bot condition for a bot author', async () => {
        const value = ready<L0Verdict>(
            await service.assess(INPUT({ isBotAuthor: true })),
        );

        const bot = value.find((c) => c.name === 'not-bot-author');
        expect(bot?.passed).toBe(false);
    });

    it('is Ready even with no shape at all — L0 never fails closed', async () => {
        const value = ready<L0Verdict>(
            await service.assess({
                prShape: {},
                snapshotKey: 'k',
            }),
        );

        expect(value).toHaveLength(2);
        expect(value.every((c) => c.passed)).toBe(true);
    });

    it('carries the snapshot key the stage set', async () => {
        const verdict = await service.assess({
            prShape: {},
            snapshotKey: 'cfg=deadbeef;head=abc1234',
        });

        expect(verdict.snapshotKey).toBe('cfg=deadbeef;head=abc1234');
    });

    it('is deterministic — the same shape yields the same verdict', async () => {
        const first = ready<L0Verdict>(
            await service.assess(INPUT({ isDraft: true })),
        );
        const second = ready<L0Verdict>(
            await service.assess(INPUT({ isDraft: true })),
        );

        expect(first).toEqual(second);
    });

    it('reads the shape from ITS input — two calls do not share state', async () => {
        // The reconciler may run for several PRs concurrently in one worker
        // process, so the assessor must not hold the shape between calls.
        const draft = ready<L0Verdict>(
            await service.assess(INPUT({ isDraft: true })),
        );
        const normal = ready<L0Verdict>(
            await service.assess(INPUT({ isDraft: false })),
        );

        expect(draft.find((c) => c.name === 'not-draft')?.passed).toBe(false);
        expect(normal.find((c) => c.name === 'not-draft')?.passed).toBe(true);
    });
});
