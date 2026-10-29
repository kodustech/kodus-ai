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
    });

    describe('computeRequirementsHash', () => {
        const reqA = { id: 'a', foo: 2 } as unknown as ContextRequirement;
        const reqB = { id: 'b', foo: 1 } as unknown as ContextRequirement;

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
    });
});
