/**
 * StaticTaskStrategy — REQ-ROUTE-01 (Phase 4, plan 04-01).
 *
 * Exercises the resolver against in-memory v2 configs + the REAL provider
 * registry (no live keys): openai `gpt-*` reports structuredOutput 'json_schema';
 * anthropic `claude-*` reports structuredOutput 'none' but toolCalling 'native',
 * so it IS eligible for codeReview (structured output via tool use), prSummary
 * and conversation. Only a model with neither a native json_schema nor native
 * tool calling — or an unregistered provider — fails the codeReview gate. No
 * decryption anywhere — the apiKey values are opaque ciphertext placeholders the
 * resolver never touches.
 */
import '@libs/llm/providers'; // side-effect: self-register every provider module
// Import the registry from the SAME specifier the source uses ('./providers'),
// so `REGISTRY.get('openai')` here hands back the very module object the resolver
// calls — spies on `.capabilities` then intercept the resolver's real call.
import { REGISTRY } from './providers';
import { StaticTaskStrategy } from './static-task-strategy';
import type { RoutingVerdict, RequestContext } from './routing-strategy';
import type {
    BYOKConfig,
    BYOKCredential,
    BYOKModelConfig,
    BYOKRouting,
    LlmTask,
} from './byok-config';

const OA: BYOKCredential = { id: 'c-oa', provider: 'openai', apiKey: 'enc-oa' };
const AN: BYOKCredential = {
    id: 'c-an',
    provider: 'anthropic',
    apiKey: 'enc-an',
};
const MANAGED: BYOKCredential = {
    id: 'c-mg',
    provider: 'openai',
    managed: true,
};
const UNKNOWN: BYOKCredential = {
    id: 'c-uk',
    provider: 'totally-unknown-provider',
    apiKey: 'enc-uk',
};

const M = {
    A: { id: 'm-A', credentialId: 'c-oa', model: 'gpt-4o' },
    B: { id: 'm-B', credentialId: 'c-oa', model: 'gpt-5-mini' },
    ANT: { id: 'm-ANT', credentialId: 'c-an', model: 'claude-3-5-sonnet' },
    MG: { id: 'm-MG', credentialId: 'c-mg', model: 'gpt-4o' },
    UK: { id: 'm-UK', credentialId: 'c-uk', model: 'whatever-1' },
} satisfies Record<string, BYOKModelConfig>;

const cfg = (
    routing: BYOKRouting,
    models: BYOKModelConfig[] = [M.A, M.B, M.ANT, M.MG, M.UK],
    credentials: BYOKCredential[] = [OA, AN, MANAGED, UNKNOWN],
): BYOKConfig => ({ version: 2, credentials, models, routing });

const NO_CTX: RequestContext = {};

describe('StaticTaskStrategy — REQ-ROUTE-01', () => {
    const strategy = new StaticTaskStrategy();

    describe('precedence: override > taskOverride > default', () => {
        it('routes to routing.taskOverrides[task] over the default', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg({ taskOverrides: { codeReview: 'm-B' }, defaultModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-B');
        });

        it('falls to routing.defaultModelId when no taskOverride exists', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg({ defaultModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-A');
        });

        it('lets a folder/repo override (by id) win over taskOverride and default', () => {
            const v = strategy.resolve(
                'codeReview',
                { override: { modelId: 'm-B' } },
                cfg({ taskOverrides: { codeReview: 'm-A' }, defaultModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-B');
        });
    });

    describe('flat inheritance (no task→task chaining)', () => {
        // Routing is FLAT (TASK_ROUTING_FALLBACK is empty): a task with no override
        // of its own inherits the org DEFAULT directly — never another task's model.
        it('resolves kodyRulesReview to the DEFAULT (not the codeReview override) when it has none of its own', () => {
            const v = strategy.resolve(
                'kodyRulesReview',
                NO_CTX,
                cfg({ taskOverrides: { codeReview: 'm-B' }, defaultModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-A');
            expect(v.reason).not.toMatch(/inherited:/);
        });

        it('resolves businessValidation to the DEFAULT (not the conversation override) when it has none of its own', () => {
            const v = strategy.resolve(
                'businessValidation',
                NO_CTX,
                cfg({
                    taskOverrides: { conversation: 'm-ANT' },
                    defaultModelId: 'm-A',
                }),
            );
            expect(v.modelId).toBe('m-A');
            expect(v.reason).not.toMatch(/inherited:/);
        });

        it("uses the task's OWN override when it has one", () => {
            const v = strategy.resolve(
                'kodyRulesReview',
                NO_CTX,
                cfg({
                    taskOverrides: { codeReview: 'm-A', kodyRulesReview: 'm-B' },
                    defaultModelId: 'm-A',
                }),
            );
            expect(v.modelId).toBe('m-B');
        });

        it('falls to defaultModelId when the task has no override', () => {
            const v = strategy.resolve(
                'kodyRulesReview',
                NO_CTX,
                cfg({ defaultModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-A');
        });
    });

    describe('single fallback', () => {
        it('returns routing.fallbackModelId with reason "fallback" when the chosen tier fails the gate', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                // default is an unregistered provider → skipped;
                // fallback is openai (json_schema) → eligible.
                cfg({ defaultModelId: 'm-UK', fallbackModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-A');
            expect(v.reason).toMatch(/fallback/i);
        });
    });

    describe('capability gate', () => {
        it('accepts anthropic (structuredOutput none) for codeReview via native tool calling', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                // anthropic default: structuredOutput 'none' BUT toolCalling
                // 'native' → structured output via tool use → eligible.
                cfg({ defaultModelId: 'm-ANT' }),
            );
            expect(v.modelId).toBe('m-ANT');
        });

        it('skips an ungateable candidate and records the reason', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg({ taskOverrides: { codeReview: 'm-UK' }, defaultModelId: 'm-A' }),
            );
            // unregistered-provider taskOverride skipped → falls to openai default.
            expect(v.modelId).toBe('m-A');
            expect(v.reason).toMatch(/not registered/i);
        });

        it('BLOCKS (modelId null) when no candidate can be gated', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg(
                    { defaultModelId: 'm-UK' },
                    [M.UK],
                    [UNKNOWN],
                ),
            );
            expect(v.modelId).toBeNull();
            expect(v.reason).toMatch(/not registered/i);
        });

        it('applies no requirement for prSummary (anthropic none is eligible)', () => {
            const v = strategy.resolve(
                'prSummary',
                NO_CTX,
                cfg({ defaultModelId: 'm-ANT' }),
            );
            expect(v.modelId).toBe('m-ANT');
        });

        it('requires native toolCalling for conversation (anthropic native is eligible)', () => {
            const v = strategy.resolve(
                'conversation',
                NO_CTX,
                cfg({ defaultModelId: 'm-ANT' }),
            );
            expect(v.modelId).toBe('m-ANT');
        });
    });

    describe('managed / unknown provider degrades (never throws)', () => {
        it('skips a managed credential and falls through', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg({ defaultModelId: 'm-MG', fallbackModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-A');
        });

        it('skips a model whose provider is not registered', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg({ defaultModelId: 'm-UK', fallbackModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-A');
        });

        it('never throws on a wholly unresolvable config', () => {
            expect(() =>
                strategy.resolve(
                    'codeReview',
                    NO_CTX,
                    cfg({ defaultModelId: 'm-UK' }, [M.UK], [UNKNOWN]),
                ),
            ).not.toThrow();
        });
    });

    describe('W1: legacy byokModel NAME override on a config (id-THEN-name)', () => {
        it('applies a NAME override onto the chosen slot and carries it in modelName', () => {
            const v = strategy.resolve(
                'codeReview',
                // 'gpt-5-mini' is NOT a models[] id → treat as a legacy model NAME.
                { override: { modelId: 'gpt-5-mini' } },
                cfg({ defaultModelId: 'm-A' }),
            );
            // Chosen slot = the default (m-A, openai credential); the NAME overrides
            // its model string; capability gate ran against the NAME.
            expect(v.modelId).toBe('m-A');
            expect(v.modelName).toBe('gpt-5-mini');
        });
    });
});

/**
 * ── LLM.run I/O contract matrix — deterministic routing boundary ─────────────
 *
 * This boundary makes NO `LLM.run` call and parses NO model envelope: it is the
 * DETERMINISTIC task→model policy layer. Its declared output `D` is
 * `RoutingVerdict` ({ modelId, reason, modelName?, usedFallback? }); its "input"
 * is (task, ctx, config). The matrix's model-envelope rows (A2-9/19-20 shape
 * zoo, B21-23 value-encoding, C28-29/31-34 transport) have no analog and are
 * recorded in rowsNA. The rows that DO map — the return-shape invariant (A1,
 * A12-17), config-key/reference correctness (A10-11, B24-27), the one external
 * call's fail-safe (C30), the input-variant invariants (D35-42), and the
 * capability-gate model policy (E) — are closed below, plus the #1786
 * non-degradation guard.
 */

// A model whose provider ('openai') is a registered module we can spy on to
// force capability shapes at the resolver's one external call site.
const M_OA_ONLY: BYOKModelConfig = {
    id: 'm-A',
    credentialId: 'c-oa',
    model: 'gpt-4o',
};
const soloCfg = (routing: BYOKRouting): BYOKConfig => ({
    version: 2,
    credentials: [{ id: 'c-oa', provider: 'openai', apiKey: 'enc-oa' }],
    models: [M_OA_ONLY],
    routing,
});

const isVerdictShape = (v: unknown): v is RoutingVerdict => {
    if (!v || typeof v !== 'object') return false;
    const r = v as Record<string, unknown>;
    const idOk = r.modelId === null || typeof r.modelId === 'string';
    const reasonOk = typeof r.reason === 'string';
    const nameOk = r.modelName === undefined || typeof r.modelName === 'string';
    const fbOk = r.usedFallback === undefined || typeof r.usedFallback === 'boolean';
    return idOk && reasonOk && nameOk && fbOk;
};

describe('StaticTaskStrategy — I/O contract matrix (deterministic boundary)', () => {
    const strategy = new StaticTaskStrategy();

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ── A1 + "always the declared shape across all layers" ──────────────────
    describe('A1 / return-shape invariant: always a well-formed RoutingVerdict', () => {
        it('A1: a clean default resolve returns EXACTLY the declared eligible shape', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg({ defaultModelId: 'm-A' }),
            );
            // No skipped tiers, no name override, not a fallback → the minimal
            // eligible verdict: modelId + trace reason + usedFallback:false only.
            expect(v).toEqual({
                modelId: 'm-A',
                reason: 'resolved "codeReview" via default to "m-A"',
                usedFallback: false,
            });
        });

        it('A1: a clean fallback verdict (via resolveFallback) carries usedFallback:true and no skip prefix', () => {
            const v = strategy.resolveFallback(
                'codeReview',
                cfg({ fallbackModelId: 'm-A' }),
            );
            expect(v).toEqual({
                modelId: 'm-A',
                reason: 'resolved "codeReview" via fallback to "m-A"',
                usedFallback: true,
            });
        });

        it('A1: a BLOCKED resolve returns EXACTLY { modelId:null, reason } (no stray keys)', () => {
            const v = strategy.resolve('codeReview', NO_CTX, cfg({}));
            expect(v).toEqual({
                modelId: null,
                reason: 'BLOCKED for "codeReview": no routing target configured',
            });
            expect(v).not.toHaveProperty('usedFallback');
            expect(v).not.toHaveProperty('modelName');
        });

        it('resolve() ALWAYS returns a RoutingVerdict shape across every config variant', () => {
            const tasks: LlmTask[] = [
                'codeReview',
                'kodyRulesReview',
                'ruleGeneration',
                'businessValidation',
                'prSummary',
                'conversation',
            ];
            const variants: BYOKConfig[] = [
                cfg({}),
                cfg({ defaultModelId: 'm-A' }),
                cfg({ defaultModelId: 'm-GHOST' }),
                cfg({ taskOverrides: { codeReview: 'm-UK' }, fallbackModelId: 'm-A' }),
                cfg({ defaultModelId: 'm-MG', fallbackModelId: 'm-ANT' }),
                { version: 2, credentials: [], models: [], routing: {} },
                { version: 2 } as unknown as BYOKConfig,
            ];
            for (const t of tasks) {
                for (const c of variants) {
                    const v = strategy.resolve(t, NO_CTX, c);
                    expect(isVerdictShape(v)).toBe(true);
                    // resolveFallback shares the shape (or undefined).
                    const f = strategy.resolveFallback(t, c);
                    expect(f === undefined || isVerdictShape(f)).toBe(true);
                }
            }
        });
    });

    // ── A10-11: key/reference resolution is exact (no lenient/fuzzy match) ───
    describe('A10-11 / config key + reference resolution', () => {
        it('A10: a legacy renamed routing key (byTask) is ignored — reads only taskOverrides', () => {
            // `byTask` was renamed to `taskOverrides`; a stale config carrying the
            // old key must NOT be honored (it would silently route on dead data).
            const legacy = cfg({
                defaultModelId: 'm-A',
            });
            (legacy.routing as Record<string, unknown>).byTask = { codeReview: 'm-B' };
            const v = strategy.resolve('codeReview', NO_CTX, legacy);
            // byTask ignored → resolves the DEFAULT, never m-B.
            expect(v.modelId).toBe('m-A');
        });

        it('A11: model-id lookup is case-sensitive — a case-mismatched override id is NOT a match', () => {
            const v = strategy.resolve(
                'codeReview',
                { override: { modelId: 'M-A' } }, // stored id is lowercase 'm-A'
                cfg({ defaultModelId: 'm-B' }),
            );
            // 'M-A' is neither a models[] id nor bare-name-applicable onto a slot
            // that yields 'M-A'; it falls through to the default (m-B) as a NAME
            // override applied onto it — never a fuzzy match to 'm-A'.
            expect(v.modelId).toBe('m-B');
            expect(v.modelName).toBe('M-A');
        });
    });

    // ── A12-17: partial / empty / null / extra-key config resilience ────────
    describe('A12-17 / partial, empty, null, extra-keys config', () => {
        it('A12: a partial routing block (only fallbackModelId) resolves through the fallback tier', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg({ fallbackModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-A');
            expect(v.usedFallback).toBe(true);
        });

        it('A13: extra unknown keys on routing/model/credential are tolerated (no crash)', () => {
            const c = cfg({ defaultModelId: 'm-A' });
            // The case is precisely that UNKNOWN keys are tolerated, so the
            // writes are off-schema on purpose and need the double cast.
            const routing = c.routing as unknown as Record<string, unknown>;
            routing.mode = 'manual';
            routing.experimentalFoo = 42;
            (c.models[0] as unknown as Record<string, unknown>).unknownField =
                'x';
            const v = strategy.resolve('codeReview', NO_CTX, c);
            expect(v.modelId).toBe('m-A');
        });

        it('A14: an empty routing object {} → BLOCKED "no routing target configured"', () => {
            const v = strategy.resolve('codeReview', NO_CTX, cfg({}));
            expect(v.modelId).toBeNull();
            expect(v.reason).toMatch(/no routing target configured/);
        });

        it('A15: empty models[] and empty credentials[] → BLOCKED, never throws', () => {
            const c: BYOKConfig = {
                version: 2,
                credentials: [],
                models: [],
                routing: { defaultModelId: 'm-A' },
            };
            let v: RoutingVerdict;
            expect(() => {
                v = strategy.resolve('codeReview', NO_CTX, c);
            }).not.toThrow();
            expect(v.modelId).toBeNull();
        });

        it('A16: empty-string / whitespace ids are treated as unset (falsy) → BLOCKED', () => {
            const v = strategy.resolve(
                'codeReview',
                { override: { modelId: '   ' } },
                cfg({ defaultModelId: '', taskOverrides: { codeReview: '' } }),
            );
            expect(v.modelId).toBeNull();
        });

        it('A17: undefined routing / models / credentials are all defaulted (no crash)', () => {
            const bare = { version: 2 } as unknown as BYOKConfig;
            let v: RoutingVerdict;
            expect(() => {
                v = strategy.resolve('codeReview', NO_CTX, bare);
            }).not.toThrow();
            expect(v.modelId).toBeNull();
            expect(v.reason).toMatch(/no routing target configured/);
        });
    });

    // ── B24-27: semantic-but-wrong config VALUES ────────────────────────────
    describe('B24-27 / semantic-but-wrong config values', () => {
        it('B24: an unknown/out-of-set task carries no capability requirement (documents actual behavior)', () => {
            // task is typed LlmTask at the seam; an untyped caller passing a stale
            // task hits requirement=undefined → any registered model qualifies.
            const v = strategy.resolve(
                'notARealTask' as unknown as LlmTask,
                NO_CTX,
                cfg({ defaultModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-A');
            // Boundary still returns a well-formed verdict, never throws.
            expect(isVerdictShape(v)).toBe(true);
        });

        it('B25: a dangling defaultModelId (id not in models[]) yields no candidate → BLOCKED', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg({ defaultModelId: 'm-GHOST' }),
            );
            expect(v.modelId).toBeNull();
        });

        it('B25: a dangling credentialId is skipped with an explicit "credential not found" reason', () => {
            const c: BYOKConfig = {
                version: 2,
                credentials: [{ id: 'c-oa', provider: 'openai', apiKey: 'enc' }],
                models: [{ id: 'm-X', credentialId: 'c-MISSING', model: 'gpt-4o' }],
                routing: { defaultModelId: 'm-X' },
            };
            const v = strategy.resolve('codeReview', NO_CTX, c);
            expect(v.modelId).toBeNull();
            expect(v.reason).toMatch(/credential "c-MISSING" not found/);
        });

        it('B26: duplicate model ids → last-wins in the id map (proved via a managed dupe skipping)', () => {
            const c: BYOKConfig = {
                version: 2,
                credentials: [
                    { id: 'c-oa', provider: 'openai', apiKey: 'enc' },
                    { id: 'c-mg', provider: 'openai', managed: true },
                ],
                // Two entries share id 'm-A'; the LAST (managed) must win the map.
                models: [
                    { id: 'm-A', credentialId: 'c-oa', model: 'gpt-4o' },
                    { id: 'm-A', credentialId: 'c-mg', model: 'gpt-4o' },
                ],
                routing: { defaultModelId: 'm-A' },
            };
            const v = strategy.resolve('codeReview', NO_CTX, c);
            // Last-wins → 'm-A' resolves to the managed credential → skipped
            // (env-default path) → BLOCKED. If first-wins, it would resolve to
            // the openai slot and return 'm-A'.
            expect(v.modelId).toBeNull();
            expect(v.reason).toMatch(/managed/);
        });

        it('B27: unicode / emoji in a model name is threaded through without throwing', () => {
            const c: BYOKConfig = {
                version: 2,
                credentials: [{ id: 'c-oa', provider: 'openai', apiKey: 'enc' }],
                models: [{ id: 'm-U', credentialId: 'c-oa', model: 'gpt-4o-🚀-café' }],
                routing: { defaultModelId: 'm-U' },
            };
            let v: RoutingVerdict;
            expect(() => {
                v = strategy.resolve('codeReview', NO_CTX, c);
            }).not.toThrow();
            expect(isVerdictShape(v)).toBe(true);
        });
    });

    // ── C30-31: fail-safe on the ONE external call (provider.capabilities) ──
    describe('C30-31 / capability-lookup fail-safe (never throws past the boundary)', () => {
        it('C30: capabilities() THROWS → degrades to a skip, never crashes the resolve', () => {
            jest.spyOn(REGISTRY.get('openai'), 'capabilities').mockImplementation(
                () => {
                    throw new Error('boom: provider capabilities exploded');
                },
            );
            let v: RoutingVerdict;
            expect(() => {
                v = strategy.resolve('codeReview', NO_CTX, soloCfg({ defaultModelId: 'm-A' }));
            }).not.toThrow();
            expect(v.modelId).toBeNull();
            expect(v.reason).toMatch(/capability lookup failed/i);
        });

        it('C30: a throwing capabilities() on the primary still lets a healthy fallback win', () => {
            // openai capabilities throws → primary skipped; anthropic fallback is
            // healthy → resolve degrades onto it rather than to BLOCKED.
            jest.spyOn(REGISTRY.get('openai'), 'capabilities').mockImplementation(
                () => {
                    throw new Error('boom');
                },
            );
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg({ defaultModelId: 'm-A', fallbackModelId: 'm-ANT' }),
            );
            expect(v.modelId).toBe('m-ANT');
            expect(v.usedFallback).toBe(true);
        });

        it('C31: a degenerate empty capabilities object is handled without throwing (documents actual behavior)', () => {
            // capabilities() returning {} (no structuredOutput/toolCalling) — the
            // codeReview predicate `structuredOutput !== "none"` treats absent as
            // NOT-explicitly-none, so it is accepted. Recorded as boundary
            // behavior; the provider contract is conformance-tested elsewhere.
            jest.spyOn(REGISTRY.get('openai'), 'capabilities').mockReturnValue(
                {} as never,
            );
            let v: RoutingVerdict;
            expect(() => {
                v = strategy.resolve('codeReview', NO_CTX, soloCfg({ defaultModelId: 'm-A' }));
            }).not.toThrow();
            expect(v.modelId).toBe('m-A');
        });
    });

    // ── D35-42: input variants (the config/ctx is the "input") ──────────────
    describe('D35-42 / input variants', () => {
        it('D35: fully empty input (no creds, no models, empty routing) → BLOCKED, no throw', () => {
            const c: BYOKConfig = { version: 2, credentials: [], models: [], routing: {} };
            const v = strategy.resolve('codeReview', NO_CTX, c);
            expect(v.modelId).toBeNull();
        });

        it('D36: a single model + single credential resolves cleanly', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                soloCfg({ defaultModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-A');
        });

        it('D37: a large models[] does not change resolution (O(1) id lookup, no batching)', () => {
            const many: BYOKModelConfig[] = Array.from({ length: 500 }, (_, i) => ({
                id: `bulk-${i}`,
                credentialId: 'c-oa',
                model: 'gpt-4o',
            }));
            const target: BYOKModelConfig = {
                id: 'm-target',
                credentialId: 'c-oa',
                model: 'gpt-4o',
            };
            const c: BYOKConfig = {
                version: 2,
                credentials: [{ id: 'c-oa', provider: 'openai', apiKey: 'enc' }],
                models: [...many, target],
                routing: { defaultModelId: 'm-target' },
            };
            const v = strategy.resolve('codeReview', NO_CTX, c);
            expect(v.modelId).toBe('m-target');
        });

        it('D38: duplicate candidate tiers (override id == default id) are gated ONCE (dedup)', () => {
            // Same model referenced by both the folder override and the default.
            // The `seen` set must gate it a single time — the winning verdict
            // must NOT carry a duplicated skip reason for the same slot.
            const v = strategy.resolve(
                'codeReview',
                { override: { modelId: 'm-A' } },
                cfg({ defaultModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-A');
            // Winner reached on the override tier; no skip prefix (dedup meant the
            // default repeat was never re-evaluated into a skip).
            expect(v.reason).toBe('resolved "codeReview" via override to "m-A"');
        });

        it('D39: null/undefined entries and null id fields are filtered, not fatal', () => {
            const c: BYOKConfig = {
                version: 2,
                credentials: [
                    null as unknown as BYOKCredential,
                    { id: null as unknown as string, provider: 'openai', apiKey: 'e' },
                    { id: 'c-oa', provider: 'openai', apiKey: 'enc' },
                ],
                models: [
                    null as unknown as BYOKModelConfig,
                    { id: null as unknown as string, credentialId: 'c-oa', model: 'gpt-4o' },
                    { id: 'm-A', credentialId: 'c-oa', model: 'gpt-4o' },
                ],
                routing: { defaultModelId: 'm-A' },
            };
            let v: RoutingVerdict;
            expect(() => {
                v = strategy.resolve('codeReview', NO_CTX, c);
            }).not.toThrow();
            expect(v.modelId).toBe('m-A');
        });

        it('D40: whitespace-only override modelId is trimmed to unset → falls through', () => {
            const v = strategy.resolve(
                'codeReview',
                { override: { modelId: '\t\n  ' } },
                cfg({ defaultModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-A');
            expect(v.modelName).toBeUndefined();
        });

        it('D42: order permutation of models[] yields the same verdict (metamorphic)', () => {
            const base = [M.A, M.B, M.ANT];
            const permuted = [M.ANT, M.B, M.A];
            const routing: BYOKRouting = { taskOverrides: { codeReview: 'm-B' }, defaultModelId: 'm-A' };
            const v1 = strategy.resolve('codeReview', NO_CTX, cfg(routing, base));
            const v2 = strategy.resolve('codeReview', NO_CTX, cfg(routing, permuted));
            expect(v1.modelId).toBe('m-B');
            expect(v2.modelId).toBe(v1.modelId);
            expect(v2.reason).toBe(v1.reason);
        });
    });

    // ── E: capability-gate model policy (the "N modelos" branch at THIS seam)
    // This boundary does not use structured-output-gate.ts; its model-policy
    // fork is the capability predicate (structuredOutput !== 'none' OR native
    // toolCalling). Exercise all three provider-capability shapes.
    describe('E / capability-gate model policy branches', () => {
        it('E-strict: a json_schema provider is eligible for codeReview', () => {
            jest.spyOn(REGISTRY.get('openai'), 'capabilities').mockReturnValue({
                structuredOutput: 'json_schema',
                toolCalling: 'none',
            } as never);
            const v = strategy.resolve('codeReview', NO_CTX, soloCfg({ defaultModelId: 'm-A' }));
            expect(v.modelId).toBe('m-A');
        });

        it('E-toolpath: a structuredOutput:none + native-toolCalling provider is eligible for codeReview', () => {
            jest.spyOn(REGISTRY.get('openai'), 'capabilities').mockReturnValue({
                structuredOutput: 'none',
                toolCalling: 'native',
            } as never);
            const v = strategy.resolve('codeReview', NO_CTX, soloCfg({ defaultModelId: 'm-A' }));
            expect(v.modelId).toBe('m-A');
        });

        it('E-neither: a provider with neither json_schema nor native tools is SKIPPED for codeReview', () => {
            jest.spyOn(REGISTRY.get('openai'), 'capabilities').mockReturnValue({
                structuredOutput: 'none',
                toolCalling: 'none',
            } as never);
            const v = strategy.resolve('codeReview', NO_CTX, soloCfg({ defaultModelId: 'm-A' }));
            expect(v.modelId).toBeNull();
            expect(v.reason).toMatch(/lacks required capability/i);
        });

        it('E-conversation: a json_schema-only provider (no native tools) is SKIPPED for conversation', () => {
            jest.spyOn(REGISTRY.get('openai'), 'capabilities').mockReturnValue({
                structuredOutput: 'json_schema',
                toolCalling: 'none',
            } as never);
            const v = strategy.resolve('conversation', NO_CTX, soloCfg({ defaultModelId: 'm-A' }));
            expect(v.modelId).toBeNull();
            expect(v.reason).toMatch(/lacks required capability "toolCalling"/i);
        });
    });

    // ── resolveFallback contract (the runtime-failover sibling) ─────────────
    describe('resolveFallback / runtime-failover verdict contract', () => {
        it('returns undefined when no fallbackModelId is configured', () => {
            expect(
                strategy.resolveFallback('codeReview', cfg({ defaultModelId: 'm-A' })),
            ).toBeUndefined();
        });

        it('returns undefined when the configured fallback fails the capability gate', () => {
            // m-UK is an unregistered provider → the fallback is not offered.
            expect(
                strategy.resolveFallback('codeReview', cfg({ fallbackModelId: 'm-UK' })),
            ).toBeUndefined();
        });

        it('returns the fallback verdict (usedFallback:true) when it passes the gate', () => {
            const v = strategy.resolveFallback('codeReview', cfg({ fallbackModelId: 'm-A' }));
            expect(v).toEqual({
                modelId: 'm-A',
                reason: 'resolved "codeReview" via fallback to "m-A"',
                usedFallback: true,
            });
        });
    });

    // ── #1786 non-degradation guard ─────────────────────────────────────────
    describe('#1786 non-degradation: a dangling routing target must SIGNAL its cause', () => {
        // KNOWN DEGRADATION (static-task-strategy.ts:230-231 + 259-264 drop the
        // unresolvable id silently; the BLOCKED reason at :150-154 then claims
        // "no routing target configured" even though a default WAS configured —
        // it just dangles). The routing DECISION (BLOCKED) is correct; the TRACE
        // masks the real cause (a typo'd/removed model id), so an operator gets a
        // misleading diagnostic with no signal. Green today, red once the reason
        // names the dangling id.
        it.failing(
            'names the dangling defaultModelId in the BLOCKED reason (currently swallowed)',
            () => {
                const v = strategy.resolve(
                    'codeReview',
                    NO_CTX,
                    cfg({ defaultModelId: 'm-GHOST' }),
                );
                expect(v.modelId).toBeNull();
                // Correct behavior: the trace should point at the dangling id, not
                // claim nothing was configured.
                expect(v.reason).toMatch(/m-GHOST|unknown model|unresolvable/i);
                expect(v.reason).not.toMatch(/no routing target configured/);
            },
        );
    });
});
