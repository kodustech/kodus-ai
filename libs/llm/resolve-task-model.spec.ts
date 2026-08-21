/**
 * resolve-task-model.spec.ts — the task→SLOT routing primitive `resolveTaskSlot`
 * (the "decide which model + creds" step; the model itself is BUILT later by
 * LLM.run, not here — `resolveTaskModel` was removed when LLM.run became the one
 * door to a built model).
 *
 * Proves:
 *  - v2 verdict parity: the returned slot's model == StaticTaskStrategy's
 *    verdict.modelId's model; the slot carries the routed provider + ciphertext.
 *  - id override + legacy NAME override (id-THEN-name applied onto the slot).
 *  - no-BYOK (config null) and a BLOCKED verdict both degrade to `{ slot:
 *    undefined }` (never throws) — the caller/LLM.run takes the managed default.
 *  - secret hygiene: the returned slot carries CIPHERTEXT; `resolveTaskSlot`
 *    never decrypts (only `buildModelFromSlot`, elsewhere, touches plaintext).
 *
 * Seam strategy: mock the provider REGISTRY so `capabilities()` makes codeReview
 * eligible (the routing gate). No build/decrypt/env-SDK mocks — routing to a slot
 * neither builds a model nor decrypts a key.
 */
jest.mock('@libs/llm/providers', () => ({
    REGISTRY: {
        has: (_p: string) => true,
        get: (_p: string) => ({
            capabilities: (_model: string) => ({
                structuredOutput: 'json_schema',
                toolCalling: 'native',
            }),
        }),
    },
}));

import { resolveTaskSlot } from './resolve-task-model';

// openai gpt-* → structuredOutput json_schema (eligible for codeReview).
const v2 = (routing: any, models?: any[], credentials?: any[]) => ({
    version: 2 as const,
    credentials: credentials ?? [
        { id: 'c-oa', provider: 'openai', apiKey: 'enc-oa' },
    ],
    models: models ?? [
        { id: 'm-A', credentialId: 'c-oa', model: 'gpt-4o' },
        { id: 'm-B', credentialId: 'c-oa', model: 'gpt-5-mini' },
    ],
    routing,
});

describe('resolveTaskSlot', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('v2 verdict parity', () => {
        it('resolves the routed slot (default) with verdict + slot parity', () => {
            const res = resolveTaskSlot(v2({ defaultModelId: 'm-A' }), 'codeReview', {});

            expect(res.verdict?.modelId).toBe('m-A');
            expect(res.slot?.model).toBe('gpt-4o');
            expect(res.slot?.provider).toBe('openai');
            // The slot carries the CIPHERTEXT key — never decrypted here.
            expect(res.slot?.apiKey).toBe('enc-oa');
            // Routing provenance rides on the slot: `route` is the TASK (not the
            // tier), giving the usage span its per-task dimension.
            expect(res.slot?.route).toBe('codeReview');
            expect(res.slot?.usedFallback).toBe(false);
        });

        it('routes to an id override (verdict.modelId parity)', () => {
            const res = resolveTaskSlot(v2({ defaultModelId: 'm-A' }), 'codeReview', {
                ctx: { override: { modelId: 'm-B' } },
            });

            expect(res.verdict?.modelId).toBe('m-B');
            expect(res.slot?.model).toBe('gpt-5-mini');
        });

        it('applies a legacy NAME override onto the resolved slot (id-THEN-name)', () => {
            const res = resolveTaskSlot(v2({ defaultModelId: 'm-A' }), 'codeReview', {
                ctx: { override: { modelId: 'gpt-5-mini-name' } },
            });

            // NAME is not a models[] id → default slot m-A (openai credential) with
            // the name applied onto `.model`; the ciphertext is preserved.
            expect(res.verdict?.modelId).toBe('m-A');
            expect(res.verdict?.modelName).toBe('gpt-5-mini-name');
            expect(res.slot?.model).toBe('gpt-5-mini-name');
            expect(res.slot?.provider).toBe('openai');
            expect(res.slot?.apiKey).toBe('enc-oa');
        });
    });

    describe('null slot → managed/env default (never throws)', () => {
        it('no-BYOK (config null) yields an undefined slot', () => {
            const res = resolveTaskSlot(null, 'codeReview', {});

            expect(res.slot).toBeUndefined();
            expect(res.verdict).toBeUndefined();
        });

        it('a BLOCKED verdict (managed credential) degrades to an undefined slot', () => {
            const res = resolveTaskSlot(
                v2(
                    { defaultModelId: 'm-M' },
                    [{ id: 'm-M', credentialId: 'c-m', model: 'gpt-4o' }],
                    [{ id: 'c-m', provider: 'openai', managed: true }],
                ),
                'codeReview',
                {},
            );

            // managed credential → StaticTaskStrategy skips → BLOCKED (modelId null)
            // → undefined slot → the caller takes the managed default. Never throws.
            expect(res.verdict?.modelId).toBeNull();
            expect(res.slot).toBeUndefined();
        });
    });

    describe('secret hygiene (log-spy)', () => {
        it('never decrypts — the returned slot carries CIPHERTEXT and no plaintext leaks', () => {
            const spies = [
                jest.spyOn(console, 'log').mockImplementation(() => {}),
                jest.spyOn(console, 'warn').mockImplementation(() => {}),
                jest.spyOn(console, 'error').mockImplementation(() => {}),
                jest.spyOn(console, 'info').mockImplementation(() => {}),
                jest.spyOn(console, 'debug').mockImplementation(() => {}),
            ];

            const res = resolveTaskSlot(v2({ defaultModelId: 'm-A' }), 'codeReview', {});

            expect(res.slot?.apiKey).toBe('enc-oa');
            expect(JSON.stringify(res.slot)).not.toContain('PLAINTEXT');
            expect(JSON.stringify(res.verdict)).not.toContain('PLAINTEXT');

            const logged = spies
                .flatMap((s) => s.mock.calls)
                .map((args) => args.map((a) => String(a)).join(' '))
                .join(' | ');
            expect(logged).not.toContain('PLAINTEXT');

            spies.forEach((s) => s.mockRestore());
        });
    });

    describe('runtime fallback (slot.fallback)', () => {
        it('stamps a distinct, eligible fallback onto slot.fallback', () => {
            const res = resolveTaskSlot(
                v2({ defaultModelId: 'm-A', fallbackModelId: 'm-B' }),
                'codeReview',
                {},
            );

            // primary
            expect(res.slot?.model).toBe('gpt-4o');
            expect(res.slot?.usedFallback).toBe(false);
            // fallback rides inside the slot: distinct model, task-tagged, flagged
            // usedFallback, ciphertext preserved. The one-hop invariant (no nested
            // fallback) is enforced by the TYPE now — `Omit<NormalizedModel,
            // 'fallback'>` makes `.fallback.fallback` a compile error, so there is
            // nothing to assert at runtime.
            expect(res.slot?.fallback?.model).toBe('gpt-5-mini');
            expect(res.slot?.fallback?.route).toBe('codeReview');
            expect(res.slot?.fallback?.usedFallback).toBe(true);
            expect(res.slot?.fallback?.apiKey).toBe('enc-oa');
        });

        it('omits fallback when none is configured', () => {
            const res = resolveTaskSlot(
                v2({ defaultModelId: 'm-A' }),
                'codeReview',
                {},
            );
            expect(res.slot?.fallback).toBeUndefined();
        });

        it('omits fallback when it resolves to the same model as the primary', () => {
            const res = resolveTaskSlot(
                v2({ defaultModelId: 'm-A', fallbackModelId: 'm-A' }),
                'codeReview',
                {},
            );
            expect(res.slot?.model).toBe('gpt-4o');
            expect(res.slot?.fallback).toBeUndefined();
        });

        it('omits fallback when the configured fallback fails the gate', () => {
            // m-A (openai) is a valid primary; the configured fallback m-M has a
            // MANAGED credential, so resolveFallback gates it out — a fallback that
            // can't run is never offered.
            const res = resolveTaskSlot(
                v2(
                    { defaultModelId: 'm-A', fallbackModelId: 'm-M' },
                    [
                        { id: 'm-A', credentialId: 'c-oa', model: 'gpt-4o' },
                        { id: 'm-M', credentialId: 'c-m', model: 'gpt-4o' },
                    ],
                    [
                        { id: 'c-oa', provider: 'openai', apiKey: 'enc-oa' },
                        { id: 'c-m', provider: 'openai', managed: true },
                    ],
                ),
                'codeReview',
                {},
            );
            expect(res.slot?.model).toBe('gpt-4o');
            expect(res.slot?.fallback).toBeUndefined();
        });

        it('omits fallback when the model that WON is already the fallback', () => {
            // No default/override → the primary tier is empty, so the fallback wins
            // at gate-time (usedFallback). There is nothing further to cascade to.
            const res = resolveTaskSlot(
                v2({ fallbackModelId: 'm-B' }),
                'codeReview',
                {},
            );
            expect(res.slot?.model).toBe('gpt-5-mini');
            expect(res.slot?.usedFallback).toBe(true);
            expect(res.slot?.fallback).toBeUndefined();
        });
    });
});
