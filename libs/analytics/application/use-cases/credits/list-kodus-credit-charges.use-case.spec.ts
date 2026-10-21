import { KodusCreditChargeModel } from '@libs/analytics/infrastructure/adapters/repositories/schemas/kodusCreditCharge.model';

import { ListKodusCreditChargesUseCase } from './list-kodus-credit-charges.use-case';

/**
 * The use-case owns the projection of a stored charge into the wire shape, so
 * these tests pin exactly that: the query reaches the journal untouched, the
 * catalog id is exposed as `model`, and operational columns never leak to a
 * client (an org must not read another org's id back, and `lastError` can
 * carry an upstream message).
 */
describe('ListKodusCreditChargesUseCase', () => {
    const charge = (over: Partial<KodusCreditChargeModel> = {}) =>
        ({
            spanId: 'span-1',
            organizationId: 'org-1',
            teamId: 'team-1',
            correlationId: 'corr-1',
            prNumber: 42,
            modelId:
                'fireworks/accounts/fireworks/models/deepseek-v4-flash-0731',
            area: 'codeReview',
            route: 'analyze',
            tokens: {
                input: 1000,
                output: 200,
                reasoning: 10,
                cacheRead: 5,
                cacheWrite: 1,
            },
            amountUsd: 0.000354,
            pricingAsOf: '2026-09-09',
            status: 'debited',
            spanAt: new Date('2026-09-10T12:00:00.000Z'),
            debitedAt: new Date('2026-09-10T12:02:00.000Z'),
            lastError: 'billing timeout on a previous attempt',
            ...over,
        }) as KodusCreditChargeModel;

    const build = (rows: KodusCreditChargeModel[]) => {
        const listCharges = jest.fn().mockResolvedValue(rows);
        const useCase = new ListKodusCreditChargesUseCase({
            listCharges,
        } as never);
        return { useCase, listCharges };
    };

    it('passes the query through to the journal', async () => {
        const { useCase, listCharges } = build([]);
        const before = '2026-09-10T00:00:00.000Z';

        await useCase.execute('org-1', { limit: 25, before, prNumber: 42 });

        expect(listCharges).toHaveBeenCalledWith('org-1', {
            limit: 25,
            before,
            prNumber: 42,
        });
    });

    it('defaults to an empty query when none is given', async () => {
        const { useCase, listCharges } = build([]);

        await expect(useCase.execute('org-1')).resolves.toEqual({
            charges: [],
        });
        expect(listCharges).toHaveBeenCalledWith('org-1', {
            limit: undefined,
            before: undefined,
            prNumber: undefined,
        });
    });

    it('projects the catalog id as `model` and drops internal fields', async () => {
        const { useCase } = build([charge()]);

        const { charges } = await useCase.execute('org-1', {});

        expect(charges).toHaveLength(1);
        expect(charges[0]).toEqual({
            spanId: 'span-1',
            correlationId: 'corr-1',
            prNumber: 42,
            model: 'fireworks/accounts/fireworks/models/deepseek-v4-flash-0731',
            area: 'codeReview',
            route: 'analyze',
            tokens: {
                input: 1000,
                output: 200,
                reasoning: 10,
                cacheRead: 5,
                cacheWrite: 1,
            },
            amountUsd: 0.000354,
            status: 'debited',
            spanAt: new Date('2026-09-10T12:00:00.000Z'),
            debitedAt: new Date('2026-09-10T12:02:00.000Z'),
        });
        // Explicit, because a leak here is a data-exposure bug, not a typo.
        for (const hidden of [
            'organizationId',
            'teamId',
            'lastError',
            'pricingAsOf',
            'modelId',
        ]) {
            expect(charges[0]).not.toHaveProperty(hidden);
        }
    });

    it('keeps a pending charge pending (status is not massaged)', async () => {
        const { useCase } = build([
            charge({ status: 'pending', debitedAt: undefined }),
            charge({ spanId: 'span-2', status: 'unpriced', amountUsd: 0 }),
        ]);

        const { charges } = await useCase.execute('org-1', {});

        expect(charges.map((c) => c.status)).toEqual(['pending', 'unpriced']);
        expect(charges[0].debitedAt).toBeUndefined();
    });
});
