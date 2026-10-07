import { TokenUsageRepository } from './tokenUsage.repository';

/**
 * Regression coverage for the tier derivation the aggregation pipelines share.
 *
 * `_distinctThresholds`, `_bracketExpr` and `_withTiers` are pure (they only
 * read their arguments), so we exercise them off the prototype without wiring
 * the repository's Mongo deps.
 */
describe('TokenUsageRepository tier brackets', () => {
    const repo = Object.create(TokenUsageRepository.prototype) as any;
    const distinctOf = (thresholds: Map<string, number[]>) =>
        repo._distinctThresholds(thresholds);
    const bracketExpr = (distinct: number[]) => repo._bracketExpr(distinct);
    const withTiers = (
        rows: any[],
        thresholds: Map<string, number[]>,
        distinct: number[],
    ) => repo._withTiers(rows, thresholds, distinct);

    it('degrades to a literal 0 (not a bare 0) when no model is tiered', () => {
        // A bare `0` in the overview `$project` is read by Mongo as field
        // EXCLUSION and crashes the mixed projection with "Cannot do exclusion
        // on field tier in inclusion projection" — real bug caught against prod
        // data when the pricing catalog fetch returned empty. `$literal` forces
        // the VALUE 0 (bracket 0 = default band), safe in $project and $group.
        const expr = bracketExpr([]);
        expect(expr).toEqual({ $literal: 0 });
        expect(expr).not.toBe(0);
    });

    it('collapses the per-model catalog into sorted distinct thresholds', () => {
        const distinct = distinctOf(
            new Map([
                ['gemini-3-pro', [200000]],
                ['gemini/gemini-3-pro', [200000]],
                ['doubao', [32000, 128000]],
                ['other', [128000]],
            ]),
        );
        expect(distinct).toEqual([32000, 128000, 200000]);
    });

    it('builds one constant comparison per distinct threshold, not one branch per model', () => {
        const expr = bracketExpr([128000, 200000]);
        expect(expr).toEqual({
            $add: [
                { $cond: [{ $gt: ['$attributes.tu.input', 128000] }, 1, 0] },
                { $cond: [{ $gt: ['$attributes.tu.input', 200000] }, 1, 0] },
            ],
        });
        expect(JSON.stringify(expr)).not.toContain('$switch');
    });

    it('maps brackets to exactly the tier the per-model $switch produced', () => {
        // Old semantics: tier = count of the MODEL's thresholds the input
        // exceeds. New: bracket = count of the DISTINCT thresholds exceeded,
        // mapped back per model. Must agree for every model and input.
        const thresholds = new Map<string, number[]>([
            ['a', [200000]],
            ['b', [32000, 128000]],
            ['c', [128000, 272000, 1000000]],
            ['d', [272000]],
        ]);
        const distinct = distinctOf(thresholds);
        const models = ['a', 'b', 'c', 'd', 'untiered'];
        const probes = [
            0, 1, 31999, 32000, 32001, 127999, 128000, 128001, 199999, 200000,
            200001, 271999, 272000, 272001, 999999, 1000000, 1000001, 5000000,
        ];
        let seed = 7;
        const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
        for (let i = 0; i < 2000; i++) probes.push(Math.floor(rnd() * 1.5e6));

        for (const model of models) {
            for (const input of probes) {
                const own = thresholds.get(model) ?? [];
                const oldTier = own.filter((t) => input > t).length;
                const bracket = distinct.filter((t) => input > t).length;
                const [row] = withTiers(
                    [{ model, tier: bracket }],
                    thresholds,
                    distinct,
                );
                expect({ model, input, tier: row.tier }).toEqual({
                    model,
                    input,
                    tier: oldTier,
                });
            }
        }
    });

    it('keeps untiered models in the default band whatever the bracket', () => {
        const thresholds = new Map([['a', [200000]]]);
        const distinct = distinctOf(thresholds);
        const rows = withTiers(
            [
                { model: 'untiered', tier: 1 },
                { model: 'a', tier: 0 },
            ],
            thresholds,
            distinct,
        );
        expect(rows.map((r: any) => r.tier)).toEqual([0, 0]);
    });
});

describe('TokenUsageRepository._tuRows row cap (by-review)', () => {
    it('caps whole logical buckets, never a subset of a bucket’s bracket rows', async () => {
        const exec = jest.fn().mockResolvedValue([]);
        const option = jest.fn().mockReturnValue({ exec });
        const aggregate = jest.fn().mockReturnValue({ option });
        const repo = new TokenUsageRepository(
            { aggregate } as any,
            {} as any,
        ) as any;

        await repo._tuRows(
            {
                organizationId: 'org-A',
                start: new Date('2026-01-01'),
                end: new Date('2026-02-01'),
                byok: true,
            },
            new Map([['gemini-3-pro', [200000]]]),
            { review: '$correlationId', pr: '$attributes.prNumber' },
            { review: '$_id.review' },
            true,
            {},
            {},
            8000,
        );

        const pipeline = aggregate.mock.calls[0][0];
        const stages = pipeline.map((s: any) => Object.keys(s)[0]);
        expect(stages).toEqual([
            '$match',
            '$group',
            '$group',
            '$sort',
            '$limit',
            '$unwind',
            '$replaceRoot',
            '$project',
        ]);
        // Bucket = model + the caller's group keys, WITHOUT the bracket/tier.
        expect(pipeline[2].$group._id).toEqual({
            model: '$_id.model',
            review: '$_id.review',
            pr: '$_id.pr',
        });
        expect(pipeline[3]).toEqual({ $sort: { bucketTotal: -1 } });
        expect(pipeline[4]).toEqual({ $limit: 8000 });
        expect(option).toHaveBeenCalledWith({ maxTimeMS: 50_000 });
    });

    it('adds no cap stages when maxRows is 0', async () => {
        const exec = jest.fn().mockResolvedValue([]);
        const aggregate = jest
            .fn()
            .mockReturnValue({ option: jest.fn().mockReturnValue({ exec }) });
        const repo = new TokenUsageRepository(
            { aggregate } as any,
            {} as any,
        ) as any;

        await repo._tuRows(
            {
                organizationId: 'org-A',
                start: new Date('2026-01-01'),
                end: new Date('2026-02-01'),
                byok: true,
            },
            new Map(),
        );

        const stages = aggregate.mock.calls[0][0].map(
            (s: any) => Object.keys(s)[0],
        );
        expect(stages).toEqual(['$match', '$group', '$project']);
    });
});
