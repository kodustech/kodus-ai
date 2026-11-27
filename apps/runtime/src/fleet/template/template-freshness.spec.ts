import { refreshFingerprintOf, staleReason } from './template-freshness';

const DAY = 86_400_000;
const policy = { maxAgeDays: 14, maxMainCommits: 100 };

describe('when a template of an unchanged key is rebuilt anyway (freshness bound)', () => {
    // A ready template is stale when it is at least maxAgeDays old or at least maxMainCommits main commits behind; 0 turns a bound off.
    it.each([
        [{ ageMs: 0, commitsBehind: 0 }, policy, null],
        [{ ageMs: 14 * DAY - 1, commitsBehind: 99 }, policy, null],
        [{ ageMs: 14 * DAY, commitsBehind: 0 }, policy, 'max_age'],
        [{ ageMs: 0, commitsBehind: 100 }, policy, 'max_main_commits'],
        [{ ageMs: 20 * DAY, commitsBehind: 500 }, policy, 'max_age'],
        [{ ageMs: 20 * DAY, commitsBehind: 0 }, { maxAgeDays: 0, maxMainCommits: 100 }, null],
        [{ ageMs: 0, commitsBehind: 500 }, { maxAgeDays: 14, maxMainCommits: 0 }, null],
        [{ ageMs: 999 * DAY, commitsBehind: 99999 }, { maxAgeDays: 0, maxMainCommits: 0 }, null],
    ])('%j under %j is %s', (t, p, want) => expect(staleReason(t, p)).toBe(want));
});

describe('the fingerprint of a freshness rebuild', () => {
    it('is bare hex, differs from the key and from the next rebuild, and is repeatable for the same nonce', () => {
        const key = 'a'.repeat(64);
        const a = refreshFingerprintOf(key, 'n1');
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(a).not.toBe(key);
        expect(a).not.toBe(refreshFingerprintOf(key, 'n2'));
        expect(a).toBe(refreshFingerprintOf(key, 'n1'));
    });
});
