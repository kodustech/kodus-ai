import { routeCodeReviewModel } from './route-code-review-model';

const config = (over: Record<string, unknown> = {}) => ({
    version: 2,
    credentials: [{ id: 'c1', provider: 'openai', apiKey: 'enc-key', settings: {} }],
    models: [
        { id: 'm1', credentialId: 'c1', model: 'gpt-x', reasoningEffort: 'low' },
        { id: 'm2', credentialId: 'c1', model: 'gpt-y' },
    ],
    routing: { defaultModelId: 'm1' },
    ...over,
});

describe('routeCodeReviewModel', () => {
    it('routes nothing without a stored config: the env/managed default runs', () => {
        expect(routeCodeReviewModel(null, {})).toEqual({ resolvedModelSlot: undefined, blocked: false });
        expect(routeCodeReviewModel(undefined, {})).toEqual({ resolvedModelSlot: undefined, blocked: false });
    });

    it("routes the codeReview task to the config's default model, ciphertext kept", () => {
        const r = routeCodeReviewModel(config(), {});
        expect(r.blocked).toBe(false);
        expect(r.resolvedModelSlot).toMatchObject({ model: 'gpt-x', apiKey: 'enc-key', reasoningEffort: 'low' });
    });

    it('lets the model id override win over the NAME', () => {
        expect(routeCodeReviewModel(config(), { byokModelId: 'm2', byokModel: 'gpt-x' }).resolvedModelSlot?.model).toBe('gpt-y');
    });

    it('reports a stored config that routes the task nowhere', () => {
        const r = routeCodeReviewModel(config({ models: [], routing: {} }), {});
        expect(r.resolvedModelSlot).toBeUndefined();
        expect(r.blocked).toBe(true);
    });
});
