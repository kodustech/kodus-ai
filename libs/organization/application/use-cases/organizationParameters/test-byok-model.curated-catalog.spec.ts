import { TestByokModelUseCase } from './test-byok-model.use-case';

jest.mock('@libs/llm/providers', () => ({
    isCuratedCatalogProvider: (p: string) =>
        p === 'amazon_bedrock' || p === 'google_vertex',
}));

jest.mock('./byok-credentials.util', () => ({
    resolveByokSlot: jest.fn(async () => ({ apiKey: 'cipher' })),
}));

/**
 * A catalog hit is only evidence when the catalog was fetched with the key.
 *
 * Two provider shapes break that. Vertex ships a STATIC list that is never
 * fetched at all, and Bedrock serves its curated subset whenever the live call
 * cannot run — IAM-only credentials, no bearer token, a failed fetch. In both, a
 * hit can occur with a credential that authenticates nothing.
 *
 * Returning ok there is not merely a cosmetic overclaim: the rotate screen gates
 * its save on the probe, so a pass persists the credential. A dead Bedrock key
 * could be saved on the strength of a hard-coded array, and the screen would say
 * "Key works" while it did.
 *
 * Curated providers already fell through to a real probe on a MISS. This is the
 * same rule applied to the case that is easy to mistake for good news.
 */
const build = ({
    provider,
    models,
    exercisedCredential = false,
}: {
    provider: string;
    models: string[];
    /** Whether producing the list actually used the org's key. A live listing
     *  authenticates; a static or fallback list does not. */
    exercisedCredential?: boolean;
}) => {
    const probe = jest.fn(async () => ({ ok: true, code: 'ok', latencyMs: 7 }));
    const useCase = Object.create(
        TestByokModelUseCase.prototype,
    ) as TestByokModelUseCase;
    Object.assign(useCase as unknown as Record<string, unknown>, {
        logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
        organizationParametersService: {},
        testByokConnectionUseCase: { execute: probe },
        getModelsByProviderUseCase: {
            execute: jest.fn(async () => ({
                models: models.map((id) => ({ id })),
                exercisedCredential,
            })),
        },
    });
    return {
        probe,
        run: (model: string) =>
            useCase.execute({
                provider,
                model,
                organizationAndTeamData: {} as never,
            }),
    };
};

describe('a curated catalog cannot vouch for a credential', () => {
    it.each([['amazon_bedrock'], ['google_vertex']])(
        '%s: a catalog HIT still makes a real call',
        async (provider) => {
            const { probe, run } = build({ provider, models: ['m-1'] });

            await run('m-1');

            expect(probe).toHaveBeenCalled();
        },
    );

    it.each([['amazon_bedrock'], ['google_vertex']])(
        '%s: never claims catalog verification',
        async (provider) => {
            const { run } = build({ provider, models: ['m-1'] });

            const out = await run('m-1');

            expect(out.verifiedBy).not.toBe('catalog');
        },
    );

    it('an authoritative catalog still short-circuits — the saving is the point', async () => {
        // openai_compatible lists exhaustively with the org's own key, so a hit
        // is real evidence and spending an inference call would be waste.
        const { probe, run } = build({
            provider: 'openai_compatible',
            models: ['m-1'],
            exercisedCredential: true,
        });

        const out = await run('m-1');

        expect(probe).not.toHaveBeenCalled();
        expect(out).toMatchObject({ ok: true, verifiedBy: 'catalog' });
    });

    it('an authoritative MISS is still a hard failure, with no call spent', async () => {
        const { probe, run } = build({
            provider: 'openai_compatible',
            models: ['m-1'],
            exercisedCredential: true,
        });

        const out = await run('m-nope');

        expect(probe).not.toHaveBeenCalled();
        expect(out).toMatchObject({ ok: false, code: 'not_found' });
    });

    it.each([['amazon_bedrock'], ['google_vertex']])(
        '%s: a LIVE listing still takes the fast path — the saving is deliberate',
        async (provider) => {
            // The other half of the rule. Bedrock tries live first and only
            // serves its curated subset when it cannot; when the live call
            // authenticated, the hit IS evidence about the key and spending an
            // inference call would be waste. What decides is whether the
            // credential was used, not which provider it is.
            const { probe, run } = build({
                provider,
                models: ['m-1'],
                exercisedCredential: true,
            });

            const out = await run('m-1');

            expect(probe).not.toHaveBeenCalled();
            expect(out).toMatchObject({ ok: true, verifiedBy: 'catalog' });
        },
    );

    it('a curated MISS keeps falling through, as it always did', async () => {
        const { probe, run } = build({
            provider: 'amazon_bedrock',
            models: ['m-1'],
        });

        await run('m-nope');

        expect(probe).toHaveBeenCalled();
    });
});
