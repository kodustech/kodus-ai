import { leafChanges, leafPathOf, LEAF_CHANGES_MAX, LEAF_DEPTH_MAX } from './leaf-changes';

const j = JSON.stringify;

describe('leafChanges: the leaves that differ between two stored whole values', () => {
    it('an object differs by key: each changed leaf is named by its path with the two values', () => {
        const out = leafChanges(j({ a: { b: 1, c: 'x' }, d: true }), j({ a: { b: 2, c: 'x' }, d: true }), { prefix: 'cfg' });
        expect(out).toEqual({ leaves: [{ path: 'cfg.a.b', kind: 'changed', base: '1', pr: '2' }], truncated: false });
    });

    it('an array differs by index, down to the string inside an element', () => {
        const base = j({ details: [{ appIDs: ['A'], paths: ['/share/*'] }] });
        const pr = j({ details: [{ appIDs: ['B'], paths: ['/shares/*'] }] });
        const out = leafChanges(base, pr, { prefix: 'applinks' });
        expect(out.leaves.map((l) => [l.path, l.base, l.pr])).toEqual([
            ['applinks.details[0].appIDs[0]', '"A"', '"B"'],
            ['applinks.details[0].paths[0]', '"/share/*"', '"/shares/*"'],
        ]);
    });

    it('a field that is the array itself is walked from the field name', () => {
        const out = leafChanges(j([{ paths: ['/share/*'] }]), j([{ paths: ['/shares/*'] }]), { prefix: 'applinks.details' });
        expect(out.leaves.map((l) => l.path)).toEqual(['applinks.details[0].paths[0]']);
    });

    it('an element only one side has is one added or removed leaf, never walked into', () => {
        const out = leafChanges(j({ xs: [1, { k: 'v' }] }), j({ xs: [1] }), { prefix: 'r' });
        expect(out.leaves).toEqual([{ path: 'r.xs[1]', kind: 'removed', base: '{"k":"v"}' }]);
        const added = leafChanges(j({ xs: [1] }), j({ xs: [1, 2] }), { prefix: 'r' });
        expect(added.leaves).toEqual([{ path: 'r.xs[1]', kind: 'added', pr: '2' }]);
        const key = leafChanges(j({ a: 1 }), j({ a: 1, b: 'new' }), { prefix: 'r' });
        expect(key.leaves).toEqual([{ path: 'r.b', kind: 'added', pr: '"new"' }]);
    });

    it('the same elements in another order are one reordered change, never one per position', () => {
        const out = leafChanges(j({ ids: ['a', 'b', 'c'] }), j({ ids: ['c', 'a', 'b'] }), { prefix: 'r' });
        expect(out.leaves).toHaveLength(1);
        expect(out.leaves[0]).toMatchObject({ path: 'r.ids', kind: 'reordered', base: '["a","b","c"]', pr: '["c","a","b"]' });
    });

    it('a reordered array of objects ignores key order inside its elements', () => {
        const out = leafChanges(j([{ a: 1, b: 2 }, { a: 3, b: 4 }]), j([{ b: 4, a: 3 }, { b: 2, a: 1 }]), { prefix: 'r' });
        expect(out.leaves.map((l) => l.kind)).toEqual(['reordered']);
    });

    it('an array that changed an element while reordering is walked by index', () => {
        const out = leafChanges(j(['a', 'b']), j(['b', 'z']), { prefix: 'r' });
        expect(out.leaves.map((l) => [l.path, l.kind])).toEqual([['r[0]', 'changed'], ['r[1]', 'changed']]);
    });

    it('a value that is not JSON, or a side that has no such field, is one whole leaf at the field', () => {
        expect(leafChanges('not_json', j({ a: 1 }), { prefix: 'f' }).leaves).toEqual([{ path: 'f', kind: 'changed', base: 'not_json', pr: '{"a":1}' }]);
        expect(leafChanges(undefined, '5', { prefix: 'f' }).leaves).toEqual([{ path: 'f', kind: 'added', pr: '5' }]);
    });

    it('a root that is not a field name reads as $', () => {
        expect(leafChanges('1', '2').leaves).toEqual([{ path: '$', kind: 'changed', base: '1', pr: '2' }]);
    });

    it('never invents a field: every leaf path resolves to a different value in the two inputs', () => {
        const base = { a: { b: [1, 2, { c: 'x' }], d: null }, e: 'same' };
        const pr = { a: { b: [1, 3, { c: 'y' }, 9], d: { n: 1 } }, e: 'same', f: [] };
        const at = (v: unknown, path: string) => {
            const tokens = [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) => (m[2] !== undefined ? Number(m[2]) : m[1]));
            return tokens.reduce<any>((x, t) => (x === undefined || x === null ? undefined : x[t]), v);
        };
        const out = leafChanges(j(base), j(pr));
        expect(out.leaves.length).toBeGreaterThan(0);
        for (const l of out.leaves) expect(j(at(base, l.path))).not.toEqual(j(at(pr, l.path)));
        expect(out.leaves.map((l) => l.path)).not.toContain('e');
    });

    it('equal values have no leaves', () => {
        expect(leafChanges(j({ a: [1, { b: 2 }] }), j({ a: [1, { b: 2 }] }))).toEqual({ leaves: [], truncated: false });
    });

    it('a secret-looking key is [redacted] and its value appears nowhere, even inside an added subtree', () => {
        const out = leafChanges(j({ auth: { apiToken: 'sk-live-111' }, n: 1 }), j({ auth: { apiToken: 'sk-live-222' }, n: 1, extra: { password: 'hunter2', ok: 1 } }), { prefix: 'r' });
        const text = j(out);
        expect(text).not.toContain('sk-live');
        expect(text).not.toContain('hunter2');
        expect(out.leaves.find((l) => l.path === 'r.auth.apiToken')).toMatchObject({ base: '[redacted]', pr: '[redacted]' });
        expect(out.leaves.find((l) => l.path === 'r.extra')?.pr).toBe('{"password":"[redacted]","ok":1}');
    });

    it('the values pass through the cleaner first and are cut to 200 characters', () => {
        const long = 'x'.repeat(500);
        const out = leafChanges(j({ a: long }), j({ a: 'ghp_SECRET' }), { prefix: 'r', clean: (t) => t.replace(/ghp_\w+/g, '[token]') });
        expect(out.leaves[0].base!.length).toBe(200);
        expect(out.leaves[0].base!.endsWith('…')).toBe(true);
        expect(out.leaves[0].pr).toBe('"[token]"');
    });

    it('caps the leaves and says what was cut', () => {
        const base = j(Array.from({ length: LEAF_CHANGES_MAX + 50 }, (_, i) => i));
        const pr = j(Array.from({ length: LEAF_CHANGES_MAX + 50 }, (_, i) => i + 1000));
        const out = leafChanges(base, pr, { prefix: 'r' });
        expect(out.leaves).toHaveLength(LEAF_CHANGES_MAX);
        expect(out.truncated).toBe(true);
    });

    it('a difference below the depth cap is one leaf at the cap and marks the output truncated', () => {
        const nest = (leaf: unknown) => Array.from({ length: LEAF_DEPTH_MAX + 4 }).reduce<unknown>((acc) => ({ k: acc }), leaf);
        const out = leafChanges(j(nest(1)), j(nest(2)));
        expect(out.truncated).toBe(true);
        expect(out.leaves).toHaveLength(1);
        expect(out.leaves[0].path.split('.').length).toBeLessThanOrEqual(LEAF_DEPTH_MAX + 1);
    });

    it('leaves a leaf the base itself varied on out', () => {
        const out = leafChanges(j({ a: [{ nonce: 'n1', p: 'x' }] }), j({ a: [{ nonce: 'n2', p: 'y' }] }), { prefix: 'r', exclude: ['r.a[0].nonce'] });
        expect(out.leaves.map((l) => l.path)).toEqual(['r.a[0].p']);
    });
});

describe('leafPathOf: a path as the leaves spell it', () => {
    it('joins keys with dots and indexes with brackets', () => {
        expect(leafPathOf(['applinks', 'details', 0, 'appIDs'])).toBe('applinks.details[0].appIDs');
        expect(leafPathOf([])).toBe('$');
    });

    it('writes a key that is not a plain name in brackets with quotes, so a path never reads as two keys', () => {
        expect(leafPathOf(['applinks.details', 0, 'components', 0, '/'])).toBe('applinks.details[0].components[0]["/"]');
        expect(leafPathOf(['a', 'x.y', 'b c'])).toBe('a["x.y"]["b c"]');
    });

    it('names the leaf of an association file whose component key is a slash, with both values', () => {
        const base = j({ details: [{ components: [{ '/': '/invite/*' }] }] });
        const pr = j({ details: [{ components: [{ '/': '/invites/*' }] }] });
        expect(leafChanges(base, pr, { prefix: 'applinks' }).leaves).toEqual([{ path: 'applinks.details[0].components[0]["/"]', kind: 'changed', base: '"/invite/*"', pr: '"/invites/*"' }]);
    });
});
