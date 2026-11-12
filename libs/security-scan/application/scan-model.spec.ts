jest.mock(
    '@libs/code-review/infrastructure/agents/collaborators/model-factory',
    () => ({ resolveReviewAgentModel: jest.fn() }),
);

import { resolveReviewAgentModel } from '@libs/code-review/infrastructure/agents/collaborators/model-factory';

import { resolveScanModel } from './scan-model';

const resolveModel = resolveReviewAgentModel as jest.Mock;

describe('resolveScanModel', () => {
    it('runs on the BYOK model alone: its backup would spend past the cap uncounted', async () => {
        resolveModel.mockResolvedValue({
            byokConfig: {
                provider: 'openai_compatible',
                model: 'deepseek-v4',
                fallback: { provider: 'anthropic', model: 'claude-opus-5-5' },
            },
            main: { modelName: 'openai_compatible:deepseek-v4' },
        });

        const { model } = await resolveScanModel({
            organizationAndTeamData: { organizationId: 'org-1' } as any,
            permissionValidationService: {} as any,
            pricingResolver: {
                resolve: jest.fn(async () => ({ priced: true, rates: {} })),
            } as any,
        });

        expect(model.slot).toEqual(
            expect.objectContaining({ model: 'deepseek-v4' }),
        );
        expect(model.slot?.fallback).toBeUndefined();
        // The team picks the deep scan's model in routing, on a task of its own.
        expect(resolveModel.mock.calls[0][2]).toBe('securityScan');
    });

    it('leaves the slot empty on the Kodus provider, so the scan refuses to run on its platform credits', async () => {
        resolveModel.mockResolvedValue({
            byokConfig: { provider: 'kodus', model: 'deepseek-v4' },
            main: { modelName: 'kodus:deepseek-v4' },
        });

        const { model } = await resolveScanModel({
            organizationAndTeamData: { organizationId: 'org-1' } as any,
            permissionValidationService: {} as any,
            pricingResolver: {
                resolve: jest.fn(async () => ({ priced: true, rates: {} })),
            } as any,
        });

        expect(model.slot).toBeUndefined();
    });

    it('has no price for rates with one missing, negative or not a number', async () => {
        resolveModel.mockResolvedValue({
            byokConfig: { provider: 'openai_compatible', model: 'deepseek-v4' },
            main: { modelName: 'openai_compatible:deepseek-v4' },
        });
        const priced = (rates: unknown) =>
            resolveScanModel({
                organizationAndTeamData: { organizationId: 'org-1' } as any,
                permissionValidationService: {} as any,
                pricingResolver: {
                    resolve: jest.fn(async () => ({ priced: true, rates })),
                } as any,
            });
        const rate = (n: number) => ({ default: n });

        expect(
            (await priced({ input: rate(1e-6), output: rate(2e-6) })).rates,
        ).toBeNull();
        expect(
            (await priced({ input: rate(-1), output: rate(2e-6), cacheRead: rate(0), cacheWrite: rate(0) })).rates,
        ).toBeNull();
        expect(
            (await priced({ input: rate(1e-6), output: rate(2e-6), cacheRead: rate(1e-7), cacheWrite: rate(1e-6) })).rates,
        ).not.toBeNull();
    });
});

