import { environmentHealthOf } from './environment-health';

const now = new Date('2026-11-16T12:00:00Z');
const day = 24 * 3_600_000;
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

describe('environmentHealthOf', () => {
    it('an environment with no setup reads not_set_up, with no rate and no blocker', () => {
        expect(environmentHealthOf({ environmentId: 'env-1' }, now)).toEqual({ environmentId: 'env-1', state: 'not_set_up', boots7d: 0, blockers: [] });
    });

    it('the week of boots gives the share that became ready and their median time to ready; an older boot does not count', () => {
        const h = environmentHealthOf(
            {
                environmentId: 'env-1',
                state: 'active',
                imageId: 'img-9',
                cellId: 'cell-a',
                boots: [
                    { at: ago(1_000), outcome: 'ready', ms: 30_000 },
                    { at: ago(2_000), outcome: 'ready', ms: 50_000 },
                    { at: ago(3_000), outcome: 'failed', ms: 10_000, signature: 'npm_ci_failed' },
                    { at: ago(8 * day), outcome: 'failed', ms: 1, signature: 'old' },
                ],
            },
            now,
        );
        expect(h).toMatchObject({ state: 'active', imageId: 'img-9', cellId: 'cell-a', boots7d: 3, readyP50Ms: 30_000 });
        expect(h.bootRate7d).toBeCloseTo(2 / 3);
        expect(h.blockers).toEqual([{ signature: 'npm_ci_failed', kind: 'unknown', count: 1, lastAt: ago(3_000) }]);
    });

    it('groups a blocker by signature: the open one gives its kind, each failed boot of the week adds to its count, the latest sets lastAt', () => {
        const h = environmentHealthOf(
            {
                environmentId: 'env-1',
                state: 'blocked',
                blockers: [{ kind: 'missing_env', signature: 'env:STRIPE_KEY', at: ago(500) }],
                boots: [
                    { at: ago(500), outcome: 'failed', ms: 1, signature: 'env:STRIPE_KEY' },
                    { at: ago(day), outcome: 'failed', ms: 1, signature: 'env:STRIPE_KEY' },
                    { at: ago(2 * day), outcome: 'failed', ms: 1, signature: 'boot_timeout' },
                ],
            },
            now,
        );
        expect(h.state).toBe('blocked');
        expect(h.bootRate7d).toBe(0);
        expect(h.readyP50Ms).toBeUndefined();
        expect(h.blockers).toEqual([
            { signature: 'env:STRIPE_KEY', kind: 'missing_env', count: 2, lastAt: ago(500) },
            { signature: 'boot_timeout', kind: 'unknown', count: 1, lastAt: ago(2 * day) },
        ]);
    });

    it('a kind outside the catalog reads unknown, never a free string', () => {
        const h = environmentHealthOf({ environmentId: 'e', state: 'blocked', blockers: [{ kind: 'weird', signature: 's', at: ago(1) }] }, now);
        expect(h.blockers).toEqual([{ signature: 's', kind: 'unknown', count: 1, lastAt: ago(1) }]);
    });
});
