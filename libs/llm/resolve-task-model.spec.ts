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

    // ── I/O contract matrix (deterministic config→slot boundary) ──────────────
    //
    // This boundary calls NO LLM.run and parses NO model-output envelope: it is
    // the "decide which model + creds" router. The matrix's model-output rows (A
    // wrapper/stringified/fenced/prose; B value-encoding; C JSON-transport /
    // refusal / abort) have no envelope to assert against here (see rowsNA). What
    // IS in scope is the mirror invariant on the CONFIG INPUT + the declared
    // RETURN SHAPE: a malformed/truthy-but-invalid/partial/empty config must
    // DEGRADE to `{ slot: undefined }` (the documented, observable safe-default —
    // the consumer then takes the managed/env model) and NEVER throw past the
    // boundary, and the return must always carry the `{ slot, verdict }` shape.

    // Row 1 (exact D) — the declared return shape is always present, both keys.
    describe('return shape invariant (row 1, always-returns-{slot,verdict})', () => {
        it('always returns an object carrying both slot and verdict keys (happy path)', () => {
            const res = resolveTaskSlot(v2({ defaultModelId: 'm-A' }), 'codeReview', {});
            expect(res).toEqual(
                expect.objectContaining({
                    slot: expect.any(Object),
                    verdict: expect.any(Object),
                }),
            );
            expect('slot' in res).toBe(true);
            expect('verdict' in res).toBe(true);
        });

        it('still returns both keys on the degrade path (slot/verdict undefined, keys present)', () => {
            const res = resolveTaskSlot(null, 'codeReview', {});
            expect('slot' in res).toBe(true);
            expect('verdict' in res).toBe(true);
            expect(res.slot).toBeUndefined();
            expect(res.verdict).toBeUndefined();
        });
    });

    // Rows 10/14/16/17/18 — truthy-but-invalid / empty / primitive config (the
    // #1786 "wrong-shape envelope" class, mirrored onto the config INPUT): every
    // non-v2 shape degrades to `{ slot: undefined, verdict: undefined }` — the
    // documented safe-default — and never throws.
    describe('non-v2 config → degrade, never throw (rows 10, 14, 16, 17, 18)', () => {
        const cases: Array<[string, unknown]> = [
            ['null (row 17)', null],
            ['undefined (row 17)', undefined],
            ['empty object {} (row 14)', {}],
            ['empty string (row 16)', ''],
            ['whitespace-only string (row 16)', '   '],
            ['primitive true (row 18)', true],
            ['primitive 0 (row 18)', 0],
            ['primitive "ok" (row 18)', 'ok'],
            ['legacy v1 shape (row 10, wrong version)', { version: 1, models: [{ id: 'm-A' }] }],
            ['version as string "2" (row 10, wrong type)', { version: '2', models: [] }],
            ['config-shaped but no version (row 10)', { credentials: [], models: [], routing: {} }],
        ];
        it.each(cases)('%s → undefined slot + verdict, no throw', (_label, cfg) => {
            let res: ReturnType<typeof resolveTaskSlot>;
            expect(() => {
                res = resolveTaskSlot(cfg as any, 'codeReview', {});
            }).not.toThrow();
            expect(res!.slot).toBeUndefined();
            expect(res!.verdict).toBeUndefined();
        });
    });

    // Row 12 — partial config (a required sub-structure absent): missing routing,
    // missing models, or empty routing → no routable target → BLOCKED verdict
    // (observable, modelId null) + undefined slot. Degrade, never silently pick.
    describe('partial config → BLOCKED verdict + undefined slot (row 12)', () => {
        it('v2 with no routing block degrades (BLOCKED, undefined slot)', () => {
            const res = resolveTaskSlot(
                { version: 2, credentials: [{ id: 'c-oa', provider: 'openai', apiKey: 'enc-oa' }], models: [{ id: 'm-A', credentialId: 'c-oa', model: 'gpt-4o' }] } as any,
                'codeReview',
                {},
            );
            expect(res.verdict?.modelId).toBeNull();
            expect(res.slot).toBeUndefined();
        });

        it('v2 with empty routing {} degrades (no default/override → BLOCKED)', () => {
            const res = resolveTaskSlot(v2({}), 'codeReview', {});
            expect(res.verdict?.modelId).toBeNull();
            expect(res.slot).toBeUndefined();
        });

        it('v2 with routing but no models degrades (BLOCKED, undefined slot)', () => {
            const res = resolveTaskSlot(
                v2({ defaultModelId: 'm-A' }, []),
                'codeReview',
                {},
            );
            expect(res.verdict?.modelId).toBeNull();
            expect(res.slot).toBeUndefined();
        });
    });

    // Row 13 — extra unknown keys alongside the valid v2 shape must be TOLERATED,
    // not crash: the boundary resolves normally and ignores the junk.
    describe('extra unknown keys tolerated (row 13)', () => {
        it('resolves normally when the config carries unknown extra keys', () => {
            const cfg: any = v2({ defaultModelId: 'm-A' });
            cfg.__junk = { nested: [1, 2, 3] };
            cfg.models[0].__extra = 'ignored';
            cfg.routing.__futureFlag = true;
            const res = resolveTaskSlot(cfg, 'codeReview', {});
            expect(res.verdict?.modelId).toBe('m-A');
            expect(res.slot?.model).toBe('gpt-4o');
            expect((res.slot as any).__extra).toBeUndefined();
        });
    });

    // Row 24 (enum-out-of-set, on the INPUT: an unknown task) — the boundary must
    // not throw on a task outside the taxonomy; with no capability requirement it
    // still resolves the org default deterministically.
    describe('unknown task (row 24, out-of-enum input)', () => {
        it('does not throw and resolves the default (no capability requirement)', () => {
            let res: ReturnType<typeof resolveTaskSlot>;
            expect(() => {
                res = resolveTaskSlot(v2({ defaultModelId: 'm-A' }), 'notARealTask' as any, {});
            }).not.toThrow();
            expect(res!.verdict?.modelId).toBe('m-A');
            expect(res!.slot?.model).toBe('gpt-4o');
            // `route` is stamped from the task argument verbatim (span dimension).
            expect(res!.slot?.route).toBe('notARealTask');
        });
    });

    // Row 25 (dangling reference / index-out-of-range analog) — a routing target
    // or credentialId that points at a non-existent id must DEGRADE observably,
    // never resolve a wrong slot or throw.
    describe('dangling references degrade observably (row 25)', () => {
        it('defaultModelId pointing at a non-existent model → BLOCKED, undefined slot', () => {
            const res = resolveTaskSlot(v2({ defaultModelId: 'does-not-exist' }), 'codeReview', {});
            expect(res.verdict?.modelId).toBeNull();
            expect(res.slot).toBeUndefined();
        });

        it('model whose credentialId is dangling → BLOCKED (credential not found), undefined slot', () => {
            const res = resolveTaskSlot(
                v2(
                    { defaultModelId: 'm-A' },
                    [{ id: 'm-A', credentialId: 'c-missing', model: 'gpt-4o' }],
                    [{ id: 'c-oa', provider: 'openai', apiKey: 'enc-oa' }],
                ),
                'codeReview',
                {},
            );
            expect(res.verdict?.modelId).toBeNull();
            expect(res.slot).toBeUndefined();
        });

        it('id override pointing at a non-existent id falls back to the default slot (not a wrong slot)', () => {
            const res = resolveTaskSlot(v2({ defaultModelId: 'm-A' }), 'codeReview', {
                ctx: { override: { modelId: 'ghost-id' } },
            });
            // 'ghost-id' is not a models[] id → treated as a NAME override applied
            // onto the default slot m-A, never a dangling resolve.
            expect(res.verdict?.modelId).toBe('m-A');
            expect(res.slot?.model).toBe('ghost-id');
            expect(res.slot?.provider).toBe('openai');
        });
    });

    // Row 27/40 — unicode / emoji / special chars / whitespace in string fields
    // are preserved verbatim onto the slot (no mangling), and a whitespace-only
    // override id is trimmed to empty and ignored (falls through to the default).
    describe('special chars, unicode, whitespace in fields (rows 27, 40)', () => {
        it('preserves unicode/emoji model name verbatim onto the slot', () => {
            const name = 'gpt-4o-💥-ünïcode\n\ttab';
            const res = resolveTaskSlot(
                v2(
                    { defaultModelId: 'm-U' },
                    [{ id: 'm-U', credentialId: 'c-oa', model: name }],
                ),
                'codeReview',
                {},
            );
            expect(res.slot?.model).toBe(name);
        });

        it('preserves special-char model ids for routing + attribution', () => {
            const weirdId = 'm-A/@:v1.2#β';
            const res = resolveTaskSlot(
                v2(
                    { defaultModelId: weirdId },
                    [{ id: weirdId, credentialId: 'c-oa', model: 'gpt-4o' }],
                ),
                'codeReview',
                {},
            );
            expect(res.verdict?.modelId).toBe(weirdId);
            expect(res.slot?.byokModelId).toBe(weirdId);
        });

        it('a whitespace-only override id is trimmed to empty and ignored (default wins)', () => {
            const res = resolveTaskSlot(v2({ defaultModelId: 'm-A' }), 'codeReview', {
                ctx: { override: { modelId: '   \t ' } },
            });
            expect(res.verdict?.modelId).toBe('m-A');
            expect(res.slot?.model).toBe('gpt-4o');
        });
    });

    // Row 30 (fail-safe: never throws past the boundary) — a battery of malformed
    // configs and inputs; the contract says the boundary degrades, never crashes.
    describe('never throws past the boundary (row 30, fail-safe)', () => {
        const malformed: Array<[string, unknown, unknown]> = [
            ['null config', null, 'codeReview'],
            ['config with models:null', { version: 2, models: null, credentials: null, routing: { defaultModelId: 'm-A' } }, 'codeReview'],
            ['config with routing:null', { version: 2, models: [], credentials: [], routing: null }, 'codeReview'],
            ['config with a null model entry', { version: 2, models: [null], credentials: [null], routing: { defaultModelId: 'm-A' } }, 'codeReview'],
            ['config with model missing credentialId', { version: 2, models: [{ id: 'm-A', model: 'gpt-4o' }], credentials: [], routing: { defaultModelId: 'm-A' } }, 'codeReview'],
            ['unknown task', { version: 2, models: [], credentials: [], routing: {} }, 'zzz'],
        ];
        it.each(malformed)('%s → does not throw, returns the declared shape', (_l, cfg, task) => {
            let res: ReturnType<typeof resolveTaskSlot>;
            expect(() => {
                res = resolveTaskSlot(cfg as any, task as any, {});
            }).not.toThrow();
            expect('slot' in res!).toBe(true);
            expect('verdict' in res!).toBe(true);
        });
    });

    // Row 35 — empty input (0 models / 0 credentials): degrade to BLOCKED +
    // undefined slot (no candidate to route to).
    describe('empty input (row 35)', () => {
        it('empty models[] and credentials[] → BLOCKED, undefined slot', () => {
            const res = resolveTaskSlot(v2({ defaultModelId: 'm-A' }, [], []), 'codeReview', {});
            expect(res.verdict?.modelId).toBeNull();
            expect(res.slot).toBeUndefined();
        });
    });

    // Row 36 — single item: exactly one model + credential resolves cleanly.
    describe('single item (row 36)', () => {
        it('a one-model config resolves that model', () => {
            const res = resolveTaskSlot(
                v2(
                    { defaultModelId: 'only' },
                    [{ id: 'only', credentialId: 'c-oa', model: 'gpt-4o' }],
                ),
                'codeReview',
                {},
            );
            expect(res.verdict?.modelId).toBe('only');
            expect(res.slot?.model).toBe('gpt-4o');
        });
    });

    // Row 37 — large input: the routing lookup is O(map); a large models[] must
    // resolve the routed id correctly (no truncation, no scan miss).
    describe('large input (row 37)', () => {
        it('resolves the routed id inside a 500-model config', () => {
            const models = Array.from({ length: 500 }, (_, i) => ({
                id: `m-${i}`,
                credentialId: 'c-oa',
                model: `gpt-model-${i}`,
            }));
            const res = resolveTaskSlot(v2({ defaultModelId: 'm-437' }, models), 'codeReview', {});
            expect(res.verdict?.modelId).toBe('m-437');
            expect(res.slot?.model).toBe('gpt-model-437');
        });
    });

    // Row 38 — duplicate model ids in the input: the resolve is deterministic
    // (first config entry with that id wins at the slot layer) and never crashes.
    describe('duplicate ids in input (row 38)', () => {
        it('duplicate model ids resolve deterministically (first-wins slot, no throw)', () => {
            const res = resolveTaskSlot(
                v2(
                    { defaultModelId: 'dup' },
                    [
                        { id: 'dup', credentialId: 'c-oa', model: 'gpt-4o' },
                        { id: 'dup', credentialId: 'c-oa', model: 'gpt-5-mini' },
                    ],
                ),
                'codeReview',
                {},
            );
            expect(res.verdict?.modelId).toBe('dup');
            // resolveModelSlot resolves via `.find` → the FIRST entry with that id.
            expect(res.slot?.model).toBe('gpt-4o');
        });
    });

    // Row 39 — null/undefined required fields in input entries: null array
    // entries and entries without an id are filtered out (never crash), and the
    // valid entry alongside them still resolves.
    describe('null / undefined required fields (row 39)', () => {
        it('null model + null credential entries are skipped, the valid one resolves', () => {
            const res = resolveTaskSlot(
                v2(
                    { defaultModelId: 'm-A' },
                    [null as any, { id: 'm-A', credentialId: 'c-oa', model: 'gpt-4o' }, { credentialId: 'c-oa', model: 'no-id' } as any],
                    [null as any, { id: 'c-oa', provider: 'openai', apiKey: 'enc-oa' }],
                ),
                'codeReview',
                {},
            );
            expect(res.verdict?.modelId).toBe('m-A');
            expect(res.slot?.model).toBe('gpt-4o');
        });

        it('a routed model with a null `model` field degrades to an undefined slot', () => {
            const res = resolveTaskSlot(
                v2(
                    { defaultModelId: 'm-N' },
                    [{ id: 'm-N', credentialId: 'c-oa', model: null as any }],
                ),
                'codeReview',
                {},
            );
            // The routed slot is unresolvable (no model string) → undefined slot,
            // the documented degrade — the consumer takes the managed default.
            expect(res.slot).toBeUndefined();
        });
    });

    // Row 42 — order permutation of the same input yields the equivalent routing
    // decision (metamorphic: the router is keyed by id, not array position).
    describe('order permutation → equivalent decision (row 42)', () => {
        it('permuting models[] does not change the routed slot', () => {
            const base = [
                { id: 'm-A', credentialId: 'c-oa', model: 'gpt-4o' },
                { id: 'm-B', credentialId: 'c-oa', model: 'gpt-5-mini' },
                { id: 'm-C', credentialId: 'c-oa', model: 'gpt-5' },
            ];
            const a = resolveTaskSlot(v2({ defaultModelId: 'm-B' }, base), 'codeReview', {});
            const b = resolveTaskSlot(
                v2({ defaultModelId: 'm-B' }, [base[2], base[0], base[1]]),
                'codeReview',
                {},
            );
            expect(a.verdict?.modelId).toBe('m-B');
            expect(b.verdict?.modelId).toBe('m-B');
            expect(a.slot?.model).toBe(b.slot?.model);
            expect(a.slot?.model).toBe('gpt-5-mini');
        });
    });
});
