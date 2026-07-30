import { BadRequestException } from '@nestjs/common';

import { TestByokModelUseCase } from './test-byok-model.use-case';

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => `dec:${v}`,
}));

function build(opts: {
    configValue: unknown;
    catalog?: Array<{ id: string; name: string }> | Error;
}) {
    const orgParams = {
        findByKey: jest.fn().mockResolvedValue(
            opts.configValue ? { configValue: opts.configValue } : null,
        ),
    } as any;
    const connectionUseCase = {
        execute: jest.fn().mockResolvedValue({ ok: true, code: 'ok', latencyMs: 5 }),
    } as any;
    const getModels = {
        execute: jest.fn(async () => {
            if (opts.catalog instanceof Error) throw opts.catalog;
            return { models: opts.catalog ?? [] };
        }),
    } as any;
    return {
        useCase: new TestByokModelUseCase(orgParams, connectionUseCase, getModels),
        connectionUseCase,
    };
}

const org = { organizationId: 'org-1' };
const moonshot = {
    main: { provider: 'openai_compatible', apiKey: 'enc', baseURL: 'https://api.moonshot.ai/v1' },
};

describe('TestByokModelUseCase', () => {
    it('returns ok when the model IS in the provider catalog', async () => {
        const { useCase, connectionUseCase } = build({
            configValue: moonshot,
            catalog: [{ id: 'kimi-k2.7-code', name: 'Kimi' }],
        });
        const res = await useCase.execute({
            provider: 'openai_compatible',
            model: 'kimi-k2.7-code',
            organizationAndTeamData: org,
        });
        expect(res.ok).toBe(true);
        expect(connectionUseCase.execute).not.toHaveBeenCalled();
    });

    it('fails (not_found) when the model is NOT in the provider catalog', async () => {
        const { useCase } = build({
            configValue: moonshot,
            catalog: [{ id: 'kimi-k2.7-code', name: 'Kimi' }],
        });
        const res = await useCase.execute({
            provider: 'openai_compatible',
            model: 'kimi-DOES-NOT-EXIST',
            organizationAndTeamData: org,
        });
        expect(res.ok).toBe(false);
        expect(res.code).toBe('not_found');
    });

    it('falls through to a real probe on a CURATED-catalog miss (Bedrock/Vertex)', async () => {
        const { useCase, connectionUseCase } = build({
            configValue: {
                main: {
                    provider: 'amazon_bedrock',
                    awsBearerToken: 'enc',
                },
            },
            catalog: [{ id: 'us.anthropic.claude-opus-4-8', name: 'Opus' }],
        });
        // A model missing from the curated Bedrock list must NOT be rejected —
        // it may still be a valid cross-region profile.
        await useCase.execute({
            provider: 'amazon_bedrock',
            model: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
            organizationAndTeamData: org,
        });
        expect(connectionUseCase.execute).toHaveBeenCalled();
    });

    it('falls back to a real provider probe when there is no catalog', async () => {
        const { useCase, connectionUseCase } = build({
            configValue: {
                main: { provider: 'anthropic_compatible', apiKey: 'enc', baseURL: 'https://x' },
            },
            catalog: new Error('listing unavailable'),
        });
        await useCase.execute({
            provider: 'anthropic_compatible',
            model: 'some-model',
            organizationAndTeamData: org,
        });
        expect(connectionUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'anthropic_compatible',
                model: 'some-model',
                apiKey: 'dec:enc',
            }),
        );
    });

    it('rejects when the org has no saved slot for the provider', async () => {
        const { useCase } = build({ configValue: null });
        await expect(
            useCase.execute({
                provider: 'openai_compatible',
                model: 'x',
                organizationAndTeamData: org,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an empty model id', async () => {
        const { useCase } = build({ configValue: moonshot });
        await expect(
            useCase.execute({
                provider: 'openai_compatible',
                model: '  ',
                organizationAndTeamData: org,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});
