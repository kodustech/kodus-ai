import { NOT_A_SETUP_BOOT, SETUP_BOOTS_KEPT, SETUP_BOOTS_WINDOW_MS, withSetupBoot } from './environment-setup';

const at = (ms: number) => new Date(Date.parse('2026-11-06T12:00:00.000Z') + ms).toISOString();

describe('withSetupBoot', () => {
    it('adds the ended boot step with its outcome, duration and signature', () => {
        expect(withSetupBoot(undefined, { finishedAt: at(0), durationMs: 90_000 }, 'ready')).toEqual([{ at: at(0), outcome: 'ready', ms: 90_000 }]);
        expect(withSetupBoot([], { finishedAt: at(0), durationMs: 5 }, 'failed', 'compose_up')).toEqual([{ at: at(0), outcome: 'failed', ms: 5, signature: 'compose_up' }]);
    });

    it('keeps only the 7-day window and the last SETUP_BOOTS_KEPT', () => {
        const old = { at: at(-SETUP_BOOTS_WINDOW_MS), outcome: 'ready' as const, ms: 1 };
        const recent = { at: at(-1), outcome: 'ready' as const, ms: 2 };
        expect(withSetupBoot([old, recent], { finishedAt: at(0), durationMs: 3 }, 'ready').map((b) => b.ms)).toEqual([2, 3]);
        const many = Array.from({ length: SETUP_BOOTS_KEPT }, (_, i) => ({ at: at(-1_000 + i), outcome: 'ready' as const, ms: i }));
        const kept = withSetupBoot(many, { finishedAt: at(0), durationMs: 999 }, 'failed', 'x');
        expect(kept).toHaveLength(SETUP_BOOTS_KEPT);
        expect(kept[0].ms).toBe(1);
        expect(kept[kept.length - 1]).toMatchObject({ ms: 999, outcome: 'failed' });
    });

    it('counts no boot for a refusal that booted nothing, nor for a step that has not ended', () => {
        const prior = [{ at: at(-1), outcome: 'ready' as const, ms: 2 }];
        for (const signature of NOT_A_SETUP_BOOT) expect(withSetupBoot(prior, { finishedAt: at(0), durationMs: 1 }, 'failed', signature)).toEqual(prior);
        expect(withSetupBoot(prior, { durationMs: 1 }, 'ready')).toEqual(prior);
        expect(withSetupBoot(prior, { finishedAt: at(0) }, 'ready')).toEqual(prior);
    });
});
