import {
    computeBudget,
    computeRequirementsHash,
    createRevisionEntry,
} from './context-pack';
import type {
    ContextLayer,
    ContextRequirement,
    ContextRevisionActor,
    ContextRevisionScope,
} from './context-pack';

/**
 * Deterministic free functions of the context-pack runtime:
 *   - computeBudget          — sums layer tokens into a TokenBudget
 *   - computeRequirementsHash — stable sha256 over id-sorted requirements
 *   - createRevisionEntry    — assembles a revision-log entry with payload defaults
 *
 * These feed the pack budget shown to the LLM, the dedup/revision key, and the
 * commit log. A silent regression here mis-sizes the budget, breaks revision
 * dedup, or drops fields from the commit. Every branch, boundary and literal
 * below is pinned so a plausible mutant fails.
 */
describe('context-pack deterministic runtime', () => {
    const makeLayer = (
        kind: string,
        tokens: number,
        priority = 0,
    ): ContextLayer => ({
        kind,
        priority,
        tokens,
        content: null,
        references: [],
    });

    describe('computeBudget', () => {
        it('passes the limit through verbatim, independent of layer tokens', () => {
            const budget = computeBudget(4096, [makeLayer('core', 10)]);
            expect(budget.limit).toBe(4096);
        });

        it('sums usage as the exact total of layer tokens', () => {
            const budget = computeBudget(8192, [
                makeLayer('core', 100),
                makeLayer('catalog', 25),
                makeLayer('active', 7),
            ]);
            expect(budget.usage).toBe(132);
        });

        it('returns the full budget shape for multiple distinct kinds', () => {
            const budget = computeBudget(1000, [
                makeLayer('core', 100),
                makeLayer('catalog', 50),
            ]);
            expect(budget).toEqual({
                limit: 1000,
                usage: 150,
                breakdown: { core: 100, catalog: 50 },
            });
        });

        it('yields usage 0 and an empty breakdown for no layers', () => {
            const budget = computeBudget(512, []);
            expect(budget).toEqual({
                limit: 512,
                usage: 0,
                breakdown: {},
            });
        });

        it('keys breakdown by layer.kind (not id/priority) and last-write-wins on duplicate kinds', () => {
            const budget = computeBudget(2048, [
                makeLayer('core', 10),
                makeLayer('core', 30),
            ]);
            // usage still sums BOTH layers...
            expect(budget.usage).toBe(40);
            // ...but breakdown is keyed by kind, so the second core overwrites.
            expect(budget.breakdown).toEqual({ core: 30 });
        });

        it('preserves the specific kind string as the breakdown key', () => {
            const budget = computeBudget(100, [makeLayer('instructions', 5)]);
            expect(Object.keys(budget.breakdown)).toEqual(['instructions']);
            expect(budget.breakdown.instructions).toBe(5);
        });

        it('handles a single layer with zero tokens', () => {
            const budget = computeBudget(64, [makeLayer('facts', 0)]);
            expect(budget.usage).toBe(0);
            expect(budget.breakdown).toEqual({ facts: 0 });
        });
    });

    describe('computeRequirementsHash', () => {
        const reqA = { id: 'a', foo: 2 } as unknown as ContextRequirement;
        const reqB = { id: 'b', foo: 1 } as unknown as ContextRequirement;

        it('returns the exact sha256 hex digest of the id-sorted requirements', () => {
            expect(computeRequirementsHash([reqB, reqA])).toBe(
                'd98cc46d1df20e4fbc6858df274f200853bcfb621471dbc6e78478cc89db4907',
            );
        });

        it('is order-independent: input order does not change the digest (sort is applied)', () => {
            const forward = computeRequirementsHash([reqA, reqB]);
            const reversed = computeRequirementsHash([reqB, reqA]);
            expect(forward).toBe(reversed);
            expect(forward).toBe(
                'd98cc46d1df20e4fbc6858df274f200853bcfb621471dbc6e78478cc89db4907',
            );
        });

        it("does not mutate the caller's array (sorts a copy)", () => {
            const input = [reqB, reqA];
            computeRequirementsHash(input);
            expect(input).toEqual([reqB, reqA]);
            expect(input[0]).toBe(reqB);
            expect(input[1]).toBe(reqA);
        });

        it('produces a distinct digest for different content', () => {
            const single = computeRequirementsHash([
                { id: 'x' } as unknown as ContextRequirement,
            ]);
            expect(single).toBe(
                '66a687dfc2694176d84b63a338c9a36e6d7c631cea43b90fa166145cb43da479',
            );
            expect(single).not.toBe(
                'd98cc46d1df20e4fbc6858df274f200853bcfb621471dbc6e78478cc89db4907',
            );
        });

        it('hashes an empty list to the sha256 of "[]"', () => {
            expect(computeRequirementsHash([])).toBe(
                '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
            );
        });

        it('returns a 64-char lowercase hex string (sha256/hex encoding)', () => {
            const hash = computeRequirementsHash([reqA]);
            expect(hash).toMatch(/^[0-9a-f]{64}$/);
        });
    });

    describe('createRevisionEntry', () => {
        const scope: ContextRevisionScope = { level: 'org' };
        const origin: ContextRevisionActor = { kind: 'human', id: 'u1' };
        const requirements = [{ id: 'r1' } as unknown as ContextRequirement];

        let nowSpy: jest.SpyInstance;
        beforeEach(() => {
            nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        });
        afterEach(() => {
            nowSpy.mockRestore();
        });

        it('stamps createdAt with Date.now()', () => {
            const entry = createRevisionEntry({
                revisionId: 'rev-1',
                scope,
                entityType: 'rule',
                entityId: 'e1',
            });
            expect(entry.createdAt).toBe(1_700_000_000_000);
        });

        it('uses the explicit payload verbatim when provided (default branch skipped)', () => {
            const payload = { custom: 'value' };
            const entry = createRevisionEntry({
                revisionId: 'rev-1',
                scope,
                entityType: 'rule',
                entityId: 'e1',
                payload,
                requirements, // present, but must NOT override the explicit payload
            });
            expect(entry.payload).toBe(payload);
        });

        it('falls back to {requirements} when payload is absent but requirements exist', () => {
            const entry = createRevisionEntry({
                revisionId: 'rev-1',
                scope,
                entityType: 'rule',
                entityId: 'e1',
                requirements,
            });
            expect(entry.payload).toEqual({ requirements });
            expect((entry.payload as any).requirements).toBe(requirements);
        });

        it('falls back to an empty object when neither payload nor requirements are given', () => {
            const entry = createRevisionEntry({
                revisionId: 'rev-1',
                scope,
                entityType: 'rule',
                entityId: 'e1',
            });
            expect(entry.payload).toEqual({});
        });

        it('treats an explicit empty-object payload as provided (not the requirements fallback)', () => {
            const payload = {};
            const entry = createRevisionEntry({
                revisionId: 'rev-1',
                scope,
                entityType: 'rule',
                entityId: 'e1',
                payload,
                requirements,
            });
            // {} is not nullish, so ?? keeps it; requirements must NOT be folded in.
            expect(entry.payload).toBe(payload);
            expect(entry.payload).toEqual({});
        });

        it('maps every field into the returned entry', () => {
            const knowledgeRefs = [{ itemId: 'k1', version: '2' }];
            const metadata = { source: 'test' };
            const entry = createRevisionEntry({
                revisionId: 'rev-42',
                parentRevisionId: 'rev-41',
                scope,
                entityType: 'kody-rule',
                entityId: 'entity-9',
                payload: { p: 1 },
                requirements,
                origin,
                knowledgeRefs,
                metadata,
            });
            expect(entry).toEqual({
                revisionId: 'rev-42',
                parentRevisionId: 'rev-41',
                scope,
                entityType: 'kody-rule',
                entityId: 'entity-9',
                payload: { p: 1 },
                requirements,
                origin,
                createdAt: 1_700_000_000_000,
                knowledgeRefs,
                metadata,
            });
        });

        it('carries optional fields through as undefined when omitted', () => {
            const entry = createRevisionEntry({
                revisionId: 'rev-1',
                scope,
                entityType: 'rule',
                entityId: 'e1',
            });
            expect(entry.parentRevisionId).toBeUndefined();
            expect(entry.requirements).toBeUndefined();
            expect(entry.origin).toBeUndefined();
            expect(entry.knowledgeRefs).toBeUndefined();
            expect(entry.metadata).toBeUndefined();
        });

        it('preserves the exact scope/entity identity references', () => {
            const entry = createRevisionEntry({
                revisionId: 'rev-1',
                scope,
                entityType: 'rule',
                entityId: 'e1',
                origin,
            });
            expect(entry.scope).toBe(scope);
            expect(entry.origin).toBe(origin);
            expect(entry.entityType).toBe('rule');
            expect(entry.entityId).toBe('e1');
            expect(entry.revisionId).toBe('rev-1');
        });
    });
});
