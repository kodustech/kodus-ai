import {
    SpendLimitConfigError,
    SpendLimitPriceabilityError,
} from '@libs/analytics/domain/spend-limit/spend-limit.errors';

import { ConfigureSpendLimitUseCase } from './configure-spend-limit.use-case';

const ORG = { organizationId: 'org-1', teamId: 'team-1' } as any;

describe('ConfigureSpendLimitUseCase', () => {
    let useCase: ConfigureSpendLimitUseCase;
    let configService: {
        getConfig: jest.Mock;
        saveConfig: jest.Mock;
        checkPriceability: jest.Mock;
    };

    beforeEach(() => {
        configService = {
            getConfig: jest.fn().mockResolvedValue(null),
            saveConfig: jest.fn(),
            checkPriceability: jest
                .fn()
                .mockResolvedValue({ priceable: true, unpriceable: [] }),
        };
        useCase = new ConfigureSpendLimitUseCase(configService as any);
    });

    it('rejects enabling without a positive monthly limit', async () => {
        await expect(
            useCase.execute({
                organizationAndTeamData: ORG,
                enabled: true,
                monthlyLimitUsd: 0,
            }),
        ).rejects.toBeInstanceOf(SpendLimitConfigError);
        expect(configService.saveConfig).not.toHaveBeenCalled();
    });

    it('blocks enabling when any configured model is unpriceable', async () => {
        configService.checkPriceability.mockResolvedValue({
            priceable: false,
            unpriceable: ['mystery-model'],
        });

        const error = await useCase
            .execute({
                organizationAndTeamData: ORG,
                enabled: true,
                monthlyLimitUsd: 1000,
                models: ['gpt-x', 'mystery-model'],
            })
            .catch((e) => e);

        expect(error).toBeInstanceOf(SpendLimitPriceabilityError);
        expect(error.unpriceableModels).toEqual(['mystery-model']);
        expect(configService.saveConfig).not.toHaveBeenCalled();
    });

    it('enables and persists when every model is priceable', async () => {
        const modelPricing = {
            custom: { input: 1e-6, output: 1e-6, cacheRead: 0, cacheWrite: 0 },
        };

        const saved = await useCase.execute({
            organizationAndTeamData: ORG,
            enabled: true,
            monthlyLimitUsd: 1000,
            modelPricing,
            models: ['custom'],
        });

        expect(configService.checkPriceability).toHaveBeenCalledWith(
            ['custom'],
            modelPricing,
        );
        expect(saved).toEqual({
            enabled: true,
            monthlyLimitUsd: 1000,
            modelPricing,
            thresholdsSent: undefined,
            finalNoticeSent: undefined,
        });
        expect(configService.saveConfig).toHaveBeenCalledWith(ORG, saved);
    });

    it('preserves existing per-period alert state across a config change', async () => {
        configService.getConfig.mockResolvedValue({
            enabled: true,
            monthlyLimitUsd: 500,
            modelPricing: { old: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
            thresholdsSent: { '2026-06': [50, 75] },
            finalNoticeSent: { '2026-06': true },
        });

        const saved = await useCase.execute({
            organizationAndTeamData: ORG,
            enabled: true,
            monthlyLimitUsd: 1000,
            models: ['custom'],
        });

        // Idempotency state is carried over so already-sent alerts don't re-fire.
        expect(saved.thresholdsSent).toEqual({ '2026-06': [50, 75] });
        expect(saved.finalNoticeSent).toEqual({ '2026-06': true });
        // Falls back to the previously stored pricing when none is provided.
        expect(saved.modelPricing).toEqual({
            old: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        });
    });

    it('disables without a priceability check', async () => {
        const saved = await useCase.execute({
            organizationAndTeamData: ORG,
            enabled: false,
            monthlyLimitUsd: 0,
        });

        expect(configService.checkPriceability).not.toHaveBeenCalled();
        expect(saved.enabled).toBe(false);
        expect(configService.saveConfig).toHaveBeenCalledWith(ORG, saved);
    });
});
