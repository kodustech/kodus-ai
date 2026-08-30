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
    version: 2,
    credentials: [
        {
            id: 'c1',
            provider: 'openai_compatible',
            apiKey: 'enc',
            settings: { baseURL: 'https://api.moonshot.ai/v1' },
        },
    ],
    models: [],
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
                version: 2,
                credentials: [
                    {
                        id: 'c1',
                        provider: 'amazon_bedrock',
                        settings: { awsBearerToken: 'enc' },
                    },
                ],
                models: [],
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
                version: 2,
                credentials: [
                    {
                        id: 'c1',
                        provider: 'anthropic_compatible',
                        apiKey: 'enc',
                        settings: { baseURL: 'https://x' },
                    },
                ],
                models: [],
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

    const bedrock = {
        version: 2,
        credentials: [
            {
                id: 'c1',
                provider: 'amazon_bedrock',
                settings: { awsBearerToken: 'enc', awsRegion: 'us-east-1' },
            },
        ],
        models: [],
    };

    it('a CHANGED safe setting (region) skips the catalog and probes with the OVERRIDDEN region', async () => {
        const { useCase, connectionUseCase } = build({
            configValue: bedrock,
            // The stored-region catalog WOULD "find" it — but a changed region must
            // not ride the stored-region listing.
            catalog: [{ id: 'model-x', name: 'X' }],
        });
        await useCase.execute({
            provider: 'amazon_bedrock',
            model: 'model-x',
            organizationAndTeamData: org,
            awsRegion: 'eu-west-1', // differs from the stored us-east-1
        });
        // Catalog shortcut skipped → a real probe ran against the NEW region.
        expect(connectionUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({ awsRegion: 'eu-west-1' }),
        );
    });

    it('the SAME region keeps the fast catalog path (no needless probe)', async () => {
        const { useCase, connectionUseCase } = build({
            configValue: bedrock,
            catalog: [{ id: 'model-x', name: 'X' }],
        });
        const res = await useCase.execute({
            provider: 'amazon_bedrock',
            model: 'model-x',
            organizationAndTeamData: org,
            awsRegion: 'us-east-1', // equal to stored → not a change
        });
        expect(res.ok).toBe(true);
        expect(connectionUseCase.execute).not.toHaveBeenCalled();
    });

    it('NEVER sends the stored secret to a caller-supplied baseURL (keeps the stored endpoint)', async () => {
        const { useCase, connectionUseCase } = build({
            configValue: moonshot, // stored baseURL = https://api.moonshot.ai/v1
            catalog: new Error('unlistable'), // force the connection probe path
        });
        // A caller trying to smuggle an exfil endpoint past the type. The stored
        // secret must reach the STORED host only — never the caller's.
        await useCase.execute({
            provider: 'openai_compatible',
            model: 'some-model',
            organizationAndTeamData: org,
            baseURL: 'https://evil.example/v1',
        } as any);
        expect(connectionUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                apiKey: 'dec:enc',
                baseURL: 'https://api.moonshot.ai/v1',
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

    // Regression (catalog removal): a key-only connect to an Anthropic-protocol
    // BRAND stores NO baseURL. On a listing miss the probe still runs, delegated to
    // TestByokConnection with the empty stored baseURL — which resolves the brand's
    // defaultBaseURL (covered by that use-case's own spec). Before the fix this path
    // had no endpoint and the probe threw "baseURL is required".
    it('key-only brand connect (no stored baseURL) delegates the probe for the endpoint to be resolved', async () => {
        const { useCase, connectionUseCase } = build({
            configValue: {
                version: 2,
                credentials: [
                    { id: 'c1', provider: 'moonshot', apiKey: 'enc', settings: {} },
                ],
                models: [],
            },
            catalog: [], // listing miss → fall through to the probe
        });
        await useCase.execute({
            provider: 'moonshot',
            model: 'kimi-k2.7-code',
            organizationAndTeamData: org,
        });
        expect(connectionUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'moonshot',
                model: 'kimi-k2.7-code',
                baseURL: undefined, // stored key-only → TestByokConnection fills it
            }),
        );
    });
});
