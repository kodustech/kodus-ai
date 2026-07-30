import { SNAPSHOT_FIELDS, pickSnapshot } from './featured-review-snapshot';

describe('featured-review snapshot', () => {
    const fullDoc = {
        _id: '507f1f77bcf86cd799439011',
        slug: 'react-fizz-resume-abort',
        published: true,
        tags: ['react', 'bug'],
        highlight: 'Dropped abort path',
        sortOrder: 1,
        prUrl: 'https://github.com/facebook/react/pull/36584',
        pr: { owner: 'facebook', repo: 'react', prNumber: 36584 },
        diff: 'diff --git a/x b/x',
        result: { summary: 's', issues: [{ file: 'x', line: 1 }] },
        sourceJobId: 'job-123',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-02-01T00:00:00Z'),
    };

    it('keeps every whitelisted field with its value', () => {
        const snap = pickSnapshot(fullDoc);
        for (const key of SNAPSHOT_FIELDS) {
            expect(snap[key]).toEqual((fullDoc as any)[key]);
        }
    });

    it('drops storage bookkeeping (_id, createdAt, updatedAt)', () => {
        const snap = pickSnapshot(fullDoc);
        expect(snap).not.toHaveProperty('_id');
        expect(snap).not.toHaveProperty('createdAt');
        expect(snap).not.toHaveProperty('updatedAt');
    });

    it('drops any field outside the whitelist', () => {
        const snap = pickSnapshot({ ...fullDoc, secretInternalFlag: true });
        expect(snap).not.toHaveProperty('secretInternalFlag');
    });

    it('omits keys that are absent on the source doc (no undefined leakage)', () => {
        const minimal = {
            slug: 'trpc-error-handling-vm',
            pr: { prNumber: 7280 },
            diff: 'd',
            result: { issues: [] },
        };
        const snap = pickSnapshot(minimal);
        expect(Object.keys(snap).sort()).toEqual(
            ['diff', 'pr', 'result', 'slug'].sort(),
        );
        expect('highlight' in snap).toBe(false);
        expect('sortOrder' in snap).toBe(false);
    });

    it('slug stays first-class so import upsert can key on it', () => {
        expect(SNAPSHOT_FIELDS).toContain('slug');
        expect(pickSnapshot(fullDoc).slug).toBe('react-fizz-resume-abort');
    });
});
