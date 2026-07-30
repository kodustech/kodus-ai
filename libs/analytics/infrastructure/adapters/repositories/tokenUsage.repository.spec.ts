import { TokenUsageRepository } from './tokenUsage.repository';

/**
 * Regression coverage for the tier expression the aggregation pipelines share.
 *
 * `_tierExpr` is pure (it only reads its `thresholds` argument), so we exercise
 * it off the prototype without wiring the repository's Mongo deps.
 */
describe('TokenUsageRepository._tierExpr', () => {
    const call = (thresholds: Map<string, number[]>) =>
        (TokenUsageRepository.prototype as any)['_tierExpr'].call(
            Object.create(TokenUsageRepository.prototype),
            thresholds,
        );

    it('degrades to a literal 0 (not a bare 0) when no model is tiered', () => {
        // A bare `0` in the overview `$project` is read by Mongo as field
        // EXCLUSION and crashes the mixed projection with "Cannot do exclusion
        // on field tier in inclusion projection" — real bug caught against prod
        // data when the pricing catalog fetch returned empty. `$literal` forces
        // the VALUE 0 (bracket 0 = default band), safe in both $project and
        // $addFields.
        const expr = call(new Map());
        expect(expr).toEqual({ $literal: 0 });
        expect(expr).not.toBe(0);
    });

    it('returns a computed bracket-index expression when a model is tiered', () => {
        const expr = call(new Map([['gemini-3.1-pro-preview', [200000]]]));
        // A computed object (not a bare number) is a valid $project field.
        expect(typeof expr).toBe('object');
        expect(expr.$literal).toBeUndefined();
        expect(expr.$let).toBeDefined();
        // Bracket index = count of thresholds the call's input exceeds.
        expect(expr.$let.in.$size.$filter.cond).toEqual({
            $gt: ['$attributes.tu.input', '$$t'],
        });
        const branch = expr.$let.vars.thrs.$switch.branches[0];
        expect(branch).toEqual({
            case: { $eq: ['$attributes.tu.model', 'gemini-3.1-pro-preview'] },
            then: [200000],
        });
    });
});
