import { TestByokConnectionUseCase } from './test-byok-connection.use-case';

/**
 * A passing test must say WHICH check passed.
 *
 * Two checks can answer "ok" and they are not the same promise. This use case
 * always makes a real call, so its pass is the strong one. The model use case
 * can short-circuit on the provider's catalog, which proves the key
 * authenticates and the id is listed while never calling the model at all.
 *
 * Production showed why the distinction has to reach the screen: a customer read
 * a catalog hit as proof the model worked, while every real call to it was being
 * refused for want of a route, and spent the day replacing a key that was fine.
 *
 * The stamp lives at the use case boundary, not on each success return, so that
 * a success added later is marked correctly by default rather than defaulting to
 * the weaker reading.
 */
describe('TestByokConnectionUseCase — every pass is a real call', () => {
    const build = (result: unknown) => {
        const useCase = Object.create(
            TestByokConnectionUseCase.prototype,
        ) as TestByokConnectionUseCase;
        (useCase as unknown as Record<string, unknown>).runTest = jest.fn(
            async () => result,
        );
        (useCase as unknown as Record<string, unknown>).logTestOutcome = jest.fn();
        return useCase;
    };

    it('marks a pass as verified by a real probe', async () => {
        const out = await build({ ok: true, code: 'ok', latencyMs: 12 }).execute(
            {} as never,
        );

        expect(out.verifiedBy).toBe('probe');
    });

    it('leaves a failure unmarked — there is nothing to claim', async () => {
        const out = await build({
            ok: false,
            code: 'not_found',
            latencyMs: 3,
        }).execute({} as never);

        expect(out.verifiedBy).toBeUndefined();
    });

    it('keeps every other field of the result intact', async () => {
        // The stamp must not become a rewrite: warnings and provider text are
        // what the screen shows next to the verdict.
        const out = await build({
            ok: true,
            code: 'ok',
            latencyMs: 12,
            warning: 'reasoning override ignored',
        }).execute({} as never);

        expect(out).toMatchObject({
            ok: true,
            code: 'ok',
            latencyMs: 12,
            warning: 'reasoning override ignored',
        });
    });

    it('does not overwrite a verification the inner result already stated', async () => {
        const out = await build({
            ok: true,
            code: 'ok',
            latencyMs: 12,
            verifiedBy: 'catalog',
        }).execute({} as never);

        expect(out.verifiedBy).toBe('catalog');
    });
});
