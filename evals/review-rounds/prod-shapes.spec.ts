// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadSpecs, problems } = require('./prod-shapes');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { build } = require('./prod-shapes/build');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { capDecisions } = require('../../libs/code-review/application/use-cases/previousReviewDecisions/build-previous-review-decisions.use-case');

const specs = loadSpecs();

describe('review-rounds production-shape specs', () => {
    it('loads every spec with a unique P-numbered id', () => {
        const ids = specs.map((s: { id: string }) => s.id);
        expect(ids.length).toBeGreaterThan(0);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^P\d{2}-/);
    });

    // A claim on lines the rule judge never sees (unchanged context) passes
    // whether or not the judge would repost: the case would measure nothing.
    it.each(specs.map((s: { id: string }) => [s.id, s]))('%s can measure its claims', (_id: string, spec: unknown) => {
        expect(problems(spec)).toEqual([]);
    });

    it('the control twin drops the earlier comment and asks for the repost', () => {
        for (const spec of specs.filter((s: { earlier?: unknown }) => s.earlier)) {
            const [main, control] = build(spec);
            expect(control.id).toBe(`${main.id}-control`);
            expect(control.previousDecisions.some((d: { suggestionId: string }) => d.suggestionId === `round-a-${spec.id}`)).toBe(false);
            for (const c of control.claims) expect(['deliver', 'if_delivered_linked']).toContain(c.expect);
        }
    });

    // 'out-of-40' must reproduce production's cap, not a smaller history.
    it("an 'out-of-40' earlier comment is cut by the production cap", () => {
        const capped = specs.filter((s: { historySize?: unknown }) => s.historySize === 'out-of-40');
        expect(capped.length).toBeGreaterThan(0);
        for (const spec of capped) {
            const [main] = build(spec);
            const shown = capDecisions(main.previousDecisions);
            expect(shown.some((d: { suggestionId: string }) => d.suggestionId === `round-a-${spec.id}`)).toBe(false);
        }
    });
});
