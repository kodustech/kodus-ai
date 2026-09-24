// resolveReviewAgentModel routes the codeReview MAIN model through the single
// task→SLOT entry point owned by the permission service
// (permissionService.resolveTaskSlot(org, task, opts)) and maps the returned slot
// onto AgentModelParams. It no longer BUILDS a model — LLM.run does that from the
// slot at call time. So the mock is `resolveTaskSlot` (returns the slot), and we
// assert the routing delegation (task + override ctx) + the slot→params mapping.
jest.mock('@libs/llm/byok-to-vercel', () => ({
    getModelName: jest.fn((slot: any, override?: string) =>
        slot ? `${slot.provider}:${slot.model}` : (override ?? 'default:model'),
    ),
}));

const resolveTaskSlotMock = jest.fn();

import { resolveReviewAgentModel } from './model-factory';

const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;

// getBYOKConfig is retained only to assert it is NEVER consulted (routing is by
// task through resolveTaskSlot, not the collapsed accessor).
function permissionServiceReturning(byokConfig: any) {
    return {
        getBYOKConfig: jest.fn().mockResolvedValue(byokConfig),
        resolveTaskSlot: resolveTaskSlotMock,
    } as any;
}

function permissionServiceReturningV2(_v2Config: any) {
    return {
        getBYOKConfig: jest
            .fn()
            .mockRejectedValue(
                new Error('getBYOKConfig must not run on the branch'),
            ),
        resolveTaskSlot: resolveTaskSlotMock,
    } as any;
}

const v2 = (routing: any, models?: any[], credentials?: any[]) => ({
    version: 2,
    credentials: credentials ?? [
        { id: 'c-oa', provider: 'openai', apiKey: 'enc-oa' },
    ],
    models: models ?? [
        { id: 'm-A', credentialId: 'c-oa', model: 'gpt-4o' },
        { id: 'm-B', credentialId: 'c-oa', model: 'gpt-5-mini' },
    ],
    routing,
});

// A sentinel routed openai SLOT (what resolveTaskSlot returns now — no built model).
function routedSlot(overrides: any = {}) {
    return {
        provider: 'openai',
        model: 'gpt-5-mini',
        apiKey: 'enc-oa',
        maxInputTokens: 4096,
        reasoningEffort: 'high',
        reasoningConfigOverride: 'cfg-x',
        ...overrides,
    };
}

describe('resolveReviewAgentModel', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('no BYOK config (null v2 raw) → env/managed default', () => {
        it('routes through resolveTaskSlot(null) and carries no byokConfig', async () => {
            resolveTaskSlotMock.mockReturnValue(undefined);
            const svc = permissionServiceReturning(null);

            const resolved = await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            expect(resolveTaskSlotMock).toHaveBeenCalledTimes(1);
            expect(resolveTaskSlotMock.mock.calls[0][0]).toBe(orgTeam);
            expect(resolveTaskSlotMock.mock.calls[0][1]).toBe('codeReview');
            expect(resolved.main.role).toBe('main');
            expect(resolved.main.modelName).toBe('default:model');
            expect(resolved.main.byokProvider).toBeUndefined();
            expect(resolved.byokConfig).toBeUndefined();
            expect(resolved).not.toHaveProperty('fallback');
            expect(svc.getBYOKConfig).not.toHaveBeenCalled();
        });

        it('passes a per-repo byokModel NAME override into resolveTaskSlot ctx', async () => {
            resolveTaskSlotMock.mockReturnValue(undefined);
            const svc = permissionServiceReturning(null);

            await resolveReviewAgentModel(
                {
                    organizationAndTeamData: orgTeam,
                    byokModel: '  gpt-override  ',
                },
                svc,
            );

            expect(resolveTaskSlotMock.mock.calls[0][2].ctx).toEqual({
                override: { modelId: 'gpt-override' },
            });
        });
    });

    describe('v2 configs (MAIN routed via resolveTaskSlot)', () => {
        it('routes the codeReview task through resolveTaskSlot with the id override in ctx', async () => {
            resolveTaskSlotMock.mockReturnValue(routedSlot());
            const svc = permissionServiceReturningV2(v2({ defaultModelId: 'm-A' }));

            await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam, byokModelId: 'm-B' },
                svc,
            );

            expect(resolveTaskSlotMock).toHaveBeenCalledTimes(1);
            const [passedOrg, task, opts] = resolveTaskSlotMock.mock.calls[0];
            expect(passedOrg).toBe(orgTeam);
            expect(task).toBe('codeReview');
            expect(opts.ctx).toEqual({ override: { modelId: 'm-B' } });
            expect(svc.getBYOKConfig).not.toHaveBeenCalled();
        });

        it('lets byokModelId (id) win over the legacy byokModel NAME in the override ctx', async () => {
            resolveTaskSlotMock.mockReturnValue(routedSlot());
            const svc = permissionServiceReturningV2(v2({ defaultModelId: 'm-A' }));

            await resolveReviewAgentModel(
                {
                    organizationAndTeamData: orgTeam,
                    byokModelId: 'm-B',
                    byokModel: 'gpt-4o',
                },
                svc,
            );

            expect(resolveTaskSlotMock.mock.calls[0][2].ctx).toEqual({
                override: { modelId: 'm-B' },
            });
        });

        it('passes the legacy byokModel NAME as the override when no id is set (window)', async () => {
            resolveTaskSlotMock.mockReturnValue(routedSlot());
            const svc = permissionServiceReturningV2(v2({ defaultModelId: 'm-A' }));

            await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam, byokModel: 'gpt-5-mini' },
                svc,
            );

            expect(resolveTaskSlotMock.mock.calls[0][2].ctx).toEqual({
                override: { modelId: 'gpt-5-mini' },
            });
        });

        it('builds the MAIN bundle from the routed slot (modelName + tuning fields)', async () => {
            resolveTaskSlotMock.mockReturnValue(routedSlot());
            const svc = permissionServiceReturningV2(v2({ defaultModelId: 'm-A' }));

            const resolved = await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            expect(resolved.main.role).toBe('main');
            expect(resolved.main.modelName).toBe('openai:gpt-5-mini');
            expect(resolved.main.byokProvider).toBe('openai');
            expect(resolved.main.maxInputTokens).toBe(4096);
            expect(resolved.main.reasoningEffort).toBe('high');
            expect(resolved.main.reasoningConfigOverride).toBe('cfg-x');
            expect(resolved.byokConfig).toEqual(routedSlot());
            // No per-run override → empty ctx.
            expect(resolveTaskSlotMock.mock.calls[0][2].ctx).toEqual({});
        });

        it('ignores routing.fallbackModelId — no fallback slot is resolved', async () => {
            resolveTaskSlotMock.mockReturnValue(routedSlot());
            const svc = permissionServiceReturningV2(
                v2({ defaultModelId: 'm-A', fallbackModelId: 'm-B' }),
            );

            const resolved = await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            // ONE slot resolution, no fallback branch.
            expect(resolveTaskSlotMock).toHaveBeenCalledTimes(1);
            expect(resolved).not.toHaveProperty('fallback');
        });

        it('degrades to the env/managed default (no byokConfig) on a null-slot verdict', async () => {
            resolveTaskSlotMock.mockReturnValue(undefined);
            const svc = permissionServiceReturningV2(v2({ defaultModelId: 'm-A' }));

            const resolved = await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            expect(resolved.byokConfig).toBeUndefined();
            expect(resolved.main.modelName).toBe('default:model');
            expect(resolved.main.byokProvider).toBeUndefined();
            expect(resolved).not.toHaveProperty('fallback');
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// CONTRACT TESTS for the deterministic assembly layer around the resolveTaskSlot
// boundary (issue #1786 class). resolveReviewAgentModel does not call LLM.run
// directly, but it is the "config → model params" assembly that sits BETWEEN the
// slot-resolution boundary (permissionService.resolveTaskSlot, its N-model
// door — DB read + pure resolver, one per provider) and LLM.run, which BUILDS
// and runs the model from whatever slot this layer hands back.
//
// The #1786 failure shape here: resolveTaskSlot is contracted to return a
// `NormalizedModel | undefined`, but the underlying config/resolver is exactly
// the surface that misbehaves per-provider. If it ever yields an off-schema
// truthy value (a bare array, a `{result:...}`/`{groups:...}` wrapper, a
// stringified blob, an object with the data under the wrong keys, a partial
// slot), the assembly must NOT quietly forward that junk as a "valid" BYOK
// config — the caller in base-code-review-agent.provider gates downstream on
// `!!byokConfig` and logs `main.modelName`, so a truthy-but-invalid slot
// silently ships a garbage model + garbage telemetry name (the analog of dedup
// keeping all → duplicate comments ship).
//
// A truthy-but-invalid slot is passed straight through today (`byokConfig =
// slot ?? undefined` gates on nullish only; `getModelName` reads
// `slot.provider`/`slot.model` off whatever it is), so the non-degrading
// assertions below are written with `it.failing` — green now, they flip to a
// real failure the day the assembly validates the slot shape.
// ─────────────────────────────────────────────────────────────────────────
describe('resolveReviewAgentModel — off-schema slot robustness (#1786)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // The MANDATORY declared shape a caller can rely on across every layer.
    const assertDeclaredShape = (resolved: any) => {
        expect(resolved).toBeDefined();
        expect(resolved).toHaveProperty('main');
        expect(resolved.main).toBeInstanceOf(Object);
        expect(resolved.main.role).toBe('main');
        expect(typeof resolved.main.modelName).toBe('string');
        expect(resolved).not.toHaveProperty('fallback');
    };

    // Each entry is a shape the non-strict / mis-wired resolver could emit
    // instead of a clean `NormalizedModel`. `label` names the malformed envelope.
    const offSchemaSlots: Array<{ label: string; slot: any }> = [
        { label: 'empty object {}', slot: {} },
        { label: 'bare empty array []', slot: [] },
        {
            label: 'bare array of slots [slot] (not the object)',
            slot: [routedSlot()],
        },
        {
            label: 'a {result:slot} wrapper',
            slot: { result: routedSlot() },
        },
        {
            label: 'a {groups:[]} wrapper (wrong key)',
            slot: { groups: [] },
        },
        {
            label: 'a stringified JSON slot',
            slot: JSON.stringify(routedSlot()),
        },
        {
            label: 'right data under the wrong keys',
            slot: { vendor: 'openai', modelId: 'gpt-5-mini' },
        },
        {
            label: 'partial slot — provider present, model missing',
            slot: { provider: 'openai' },
        },
        {
            label: 'partial slot — model present, provider missing',
            slot: { model: 'gpt-4o' },
        },
    ];

    // The type/shape contract holds even on junk (that is precisely WHY the
    // degradation is silent — a valid-looking envelope wrapping a wrong model).
    it.each(offSchemaSlots)(
        'always returns the declared ResolvedAgentModel shape for %#: $label',
        async ({ slot }) => {
            resolveTaskSlotMock.mockReturnValue(slot);
            const svc = permissionServiceReturning(null);

            const resolved = await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            assertDeclaredShape(resolved);
        },
    );

    // #1786: an off-schema truthy slot must NOT be forwarded as a valid BYOK
    // config, and the telemetry name must NOT be assembled from junk fields.
    // CORRECT behaviour = degrade to the managed default (byokConfig undefined,
    // default model name, no byokProvider) OR signal — never quietly forward.
    it.failing.each(offSchemaSlots)(
        'does NOT silently forward an off-schema slot as valid BYOK for %#: $label',
        async ({ slot }) => {
            resolveTaskSlotMock.mockReturnValue(slot);
            const svc = permissionServiceReturning(null);

            const resolved = await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            // 1. never passes the `!!byokConfig` gate the caller relies on.
            expect(resolved.byokConfig).toBeUndefined();
            // 2. never emits a garbage `provider:model` telemetry label.
            expect(resolved.main.modelName).not.toMatch(/undefined/);
            expect(resolved.main.modelName).toBe('default:model');
            // 3. never advertises a provider it cannot actually build.
            expect(resolved.main.byokProvider).toBeUndefined();
        },
    );

    // Focused restatement of the two most dangerous concrete instances, so a
    // future reader sees the exact silent-degradation values (not just the
    // parametrised sweep). Both `it.failing` for the same reason.
    it.failing(
        'an empty {} slot must not become a truthy byokConfig (downstream builds a garbage model)',
        async () => {
            resolveTaskSlotMock.mockReturnValue({});
            const svc = permissionServiceReturning(null);

            const resolved = await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            // BUG today: byokConfig === {} (truthy → passes `!!byokConfig`).
            expect(resolved.byokConfig).toBeUndefined();
        },
    );

    it.failing(
        'a stringified-JSON slot must be parsed or rejected, never yield "undefined:undefined"',
        async () => {
            resolveTaskSlotMock.mockReturnValue(JSON.stringify(routedSlot()));
            const svc = permissionServiceReturning(null);

            const resolved = await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            // BUG today: modelName === 'undefined:undefined' (string has no
            // .provider/.model), and byokConfig === the raw JSON string.
            expect(resolved.main.modelName).not.toBe('undefined:undefined');
            expect(typeof resolved.byokConfig).not.toBe('string');
        },
    );
});

// ─────────────────────────────────────────────────────────────────────────
// CONTRACT: happy path (exact side effect) + documented fallback + fail-safe.
// ─────────────────────────────────────────────────────────────────────────
describe('resolveReviewAgentModel — happy path exact contract', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('maps a correct-schema slot onto the EXACT declared AgentModelParams (incl. openrouter fields)', async () => {
        const slot = {
            provider: 'open_router',
            model: 'moonshotai/kimi-k2',
            apiKey: 'enc-or',
            maxInputTokens: 128000,
            reasoningEffort: 'medium',
            reasoningConfigOverride: 'cfg-or',
            openrouterProviderOrder: ['moonshotai', 'together'],
            openrouterAllowFallbacks: false,
        };
        resolveTaskSlotMock.mockReturnValue(slot);
        const svc = permissionServiceReturning(null);

        const resolved = await resolveReviewAgentModel(
            { organizationAndTeamData: orgTeam },
            svc,
        );

        // Exact main bundle — deep equality on every declared knob.
        expect(resolved.main).toEqual({
            role: 'main',
            modelName: 'open_router:moonshotai/kimi-k2',
            maxInputTokens: 128000,
            reasoningEffort: 'medium',
            reasoningConfigOverride: 'cfg-or',
            byokProvider: 'open_router',
            openrouterProviderOrder: ['moonshotai', 'together'],
            openrouterAllowFallbacks: false,
        });
        // byokConfig is the slot itself (same reference passed through).
        expect(resolved.byokConfig).toBe(slot);
        expect(resolved).not.toHaveProperty('fallback');
    });

    it('routes the kodyRulesReview task through resolveTaskSlot when asked', async () => {
        resolveTaskSlotMock.mockReturnValue(routedSlot());
        const svc = permissionServiceReturning(null);

        await resolveReviewAgentModel(
            { organizationAndTeamData: orgTeam },
            svc,
            'kodyRulesReview' as any,
        );

        expect(resolveTaskSlotMock.mock.calls[0][1]).toBe('kodyRulesReview');
    });
});

describe('resolveReviewAgentModel — fail-safe when the slot boundary rejects', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // The boundary can reject (suspended key / DB / provider error). The method
    // has NO documented silent fallback for a rejection — it must fail LOUD, not
    // quietly return the managed default (which would run the review on a model
    // the org never chose without any signal). A propagated rejection is the
    // SAFE, non-silent outcome; the caller does not swallow it.
    it('propagates a boundary rejection loudly (never silently swaps to a default)', async () => {
        const boom = new Error('BYOK key suspended');
        resolveTaskSlotMock.mockRejectedValue(boom);
        const svc = permissionServiceReturning(null);

        await expect(
            resolveReviewAgentModel({ organizationAndTeamData: orgTeam }, svc),
        ).rejects.toThrow('BYOK key suspended');
    });
});

// ═════════════════════════════════════════════════════════════════════════
// MATRIX BACKFILL — close the remaining LLM.run I/O contract rows for this
// boundary. The "LLM.run site" this layer sits in front of is
// permissionService.resolveTaskSlot: it is the N-model door (DB read + the
// per-provider structured-output resolver behind structured-output-gate). Its
// declared output schema D = `NormalizedModel | undefined`. This assembly must
// never quietly forward an off-schema truthy slot as a valid BYOK config
// (`byokConfig = slot ?? undefined`, model-factory.ts:99) nor assemble a
// telemetry label from junk fields (`getModelName(slot, …)`, model-factory.ts:87).
//
// Rows deliberately NOT applicable to THIS boundary (recorded, not skipped):
//   A-25 index out of range     — the boundary holds no index-based references.
//   B-26 duplicate JSON keys    — it never parses JSON text; a JS object is
//                                  already deduped and the string-slot case is
//                                  passed through untouched.
//   C-33 refusal prose          — there is no LLM content channel; the "cannot
//                                  serve" path is a boundary rejection (C-30).
//   C-34 abort signal           — resolveReviewAgentModel takes no abortSignal.
//   D-37 large/batch-crossing    — input is scalar fields, not a list.
//   D-38 duplicate list items    — no list input (id-vs-name is covered by D-42).
//   D-41 off-by-one batch edge   — no batching in this boundary.
// ═════════════════════════════════════════════════════════════════════════

const assertShape = (resolved: any) => {
    expect(resolved).toBeDefined();
    expect(resolved).toHaveProperty('main');
    expect(resolved.main).toBeInstanceOf(Object);
    expect(resolved.main.role).toBe('main');
    expect(typeof resolved.main.modelName).toBe('string');
    expect(resolved).not.toHaveProperty('fallback');
};

const runWithSlot = async (slot: any, input: any = {}) => {
    resolveTaskSlotMock.mockReturnValue(slot);
    const svc = permissionServiceReturning(null);
    return resolveReviewAgentModel(
        { organizationAndTeamData: orgTeam, ...input },
        svc,
    );
};

// ─────────────────────────────────────────────────────────────────────────
// A. Output-shape zoo — the remaining malformed slot envelopes (rows the
// original sweep did not enumerate). Two assertions per row: the declared
// ResolvedAgentModel shape ALWAYS holds (it), and the non-degradation
// invariant — an off-schema truthy slot must NOT be forwarded as valid BYOK
// nor produce a garbage telemetry label (it.failing, pinning the CORRECT
// behaviour; flips red the day the assembly validates the slot shape).
// ─────────────────────────────────────────────────────────────────────────
describe('resolveReviewAgentModel — A. output-shape zoo (remaining rows)', () => {
    beforeEach(() => jest.clearAllMocks());

    const zoo: Array<{ row: string; slot: any }> = [
        // A3 — single object where an array is the (inverted) expectation is the
        // native case; the array-when-object direction is A2 (already covered).
        // A5 — double wrapper.
        { row: 'A5 double wrapper {result:{result:slot}}', slot: { result: { result: routedSlot() } } },
        // A6 — numeric / opaque single-key wrap.
        { row: 'A6 numeric-key wrap {"0":slot}', slot: { 0: routedSlot() } },
        { row: 'A6 content-key wrap {content:slot}', slot: { content: routedSlot() } },
        // A8 — markdown-fenced JSON string.
        { row: 'A8 markdown-fenced slot', slot: '```json\n' + JSON.stringify(routedSlot()) + '\n```' },
        // A9 — prose-wrapped.
        { row: 'A9 prose-wrapped slot', slot: 'Here is the config: ' + JSON.stringify(routedSlot()) },
        // A11 — case / convention mismatch on the keys.
        { row: 'A11 case mismatch {Provider,Model}', slot: { Provider: 'openai', Model: 'gpt-5-mini' } },
        { row: 'A11 snake_case {provider_name,model_name}', slot: { provider_name: 'openai', model_name: 'gpt-5-mini' } },
        // A16 — empty / whitespace-only string.
        { row: 'A16 empty string', slot: '' },
        { row: 'A16 whitespace-only string', slot: '   \n\t ' },
        // A18 — primitive where an object is expected.
        { row: 'A18 primitive true', slot: true },
        { row: 'A18 primitive number 0', slot: 0 },
        { row: 'A18 primitive number 1', slot: 1 },
        { row: 'A18 primitive string "ok"', slot: 'ok' },
        // A19 — provider envelope leak.
        { row: 'A19 provider envelope {choices:[{message:{content}}]}', slot: { choices: [{ message: { content: JSON.stringify(routedSlot()) } }] } },
        { row: 'A19 tool_call arguments-as-string', slot: { arguments: JSON.stringify(routedSlot()) } },
        // A20 — reasoning / thinking leak wrapping the payload.
        { row: 'A20 thinking leak {thinking,content}', slot: { thinking: 'let me decide…', content: routedSlot() } },
    ];

    it.each(zoo)('shape holds for $row', async ({ slot }) => {
        const resolved = await runWithSlot(slot);
        assertShape(resolved);
    });

    it.failing.each(zoo)(
        'does NOT silently forward an off-schema slot as valid BYOK: $row',
        async ({ slot }) => {
            const resolved = await runWithSlot(slot);
            // CORRECT: degrade to the managed default (observable), never forward junk.
            expect(resolved.byokConfig).toBeUndefined();
            expect(resolved.main.modelName).not.toMatch(/undefined/);
            expect(resolved.main.modelName).toBe('default:model');
            expect(resolved.main.byokProvider).toBeUndefined();
        },
    );

    // A13 — extra unknown keys alongside the right ones MUST be tolerated
    // (recovered), not crash. This is a happy-path recovery, not a degradation.
    it('A13 tolerates extra unknown keys and maps only the declared knobs', async () => {
        const slot = {
            ...routedSlot(),
            somethingUnexpected: { nested: true },
            __extra: [1, 2, 3],
            temperature: 0.7,
        };
        const resolved = await runWithSlot(slot);
        assertShape(resolved);
        expect(resolved.main.modelName).toBe('openai:gpt-5-mini');
        expect(resolved.main.byokProvider).toBe('openai');
        expect(resolved.main.maxInputTokens).toBe(4096);
        // Junk keys are NOT leaked onto the declared params bundle.
        expect(resolved.main).not.toHaveProperty('somethingUnexpected');
        expect(resolved.main).not.toHaveProperty('temperature');
        expect(Object.keys(resolved.main).sort()).toEqual(
            [
                'byokProvider',
                'maxInputTokens',
                'modelName',
                'openrouterAllowFallbacks',
                'openrouterProviderOrder',
                'reasoningConfigOverride',
                'reasoningEffort',
                'role',
            ].sort(),
        );
    });

    // A17 — explicit null (distinct from undefined) degrades to the default.
    it('A17 null slot degrades to the env/managed default', async () => {
        const resolved = await runWithSlot(null);
        assertShape(resolved);
        expect(resolved.byokConfig).toBeUndefined();
        expect(resolved.main.modelName).toBe('default:model');
        expect(resolved.main.byokProvider).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// B. Semantic-but-wrong — valid slot object, wrong value encoding on the
// declared passthrough knobs (openrouterAllowFallbacks boolean, reasoningEffort
// enum) and unicode in string fields. This layer is a DECLARED passthrough of
// those knobs (validation is owned upstream by resolveTaskSlot / the gate), so
// the honest non-degradation assertion is: it forwards the value verbatim,
// never crashes, and the declared shape holds — an observable outcome, not a
// silent drop. Value coercion is asserted where the boundary is contracted to
// perform it (trimming — see D-40); it is NOT for these knobs.
// ─────────────────────────────────────────────────────────────────────────
describe('resolveReviewAgentModel — B. semantic-but-wrong value encodings', () => {
    beforeEach(() => jest.clearAllMocks());

    // B21/B22/B23 — boolean knob arriving as string / yes-no / number.
    const boolEncodings = [
        { row: 'B21 boolean as string "true"', value: 'true' },
        { row: 'B21 boolean as string "false"', value: 'false' },
        { row: 'B22 boolean as "yes"', value: 'yes' },
        { row: 'B22 boolean as "no"', value: 'no' },
        { row: 'B23 boolean as number 1', value: 1 },
        { row: 'B23 boolean as number 0', value: 0 },
    ];
    it.each(boolEncodings)(
        'carries a mis-encoded openrouterAllowFallbacks without crashing: $row',
        async ({ value }) => {
            const resolved = await runWithSlot(
                routedSlot({ openrouterAllowFallbacks: value }),
            );
            assertShape(resolved);
            // Observable passthrough (no silent drop / no crash); coercion is
            // the upstream gate's job, not this assembly layer's.
            expect(resolved.main.openrouterAllowFallbacks).toBe(value);
        },
    );

    // B24 — reasoningEffort enum outside the allowed set.
    it.each(['URGENT', 'ultra', '', 'HIGH'])(
        'B24 forwards an out-of-set reasoningEffort verbatim without crashing: %s',
        async (effort) => {
            const resolved = await runWithSlot(
                routedSlot({ reasoningEffort: effort }),
            );
            assertShape(resolved);
            expect(resolved.main.reasoningEffort).toBe(effort);
        },
    );

    // B27 — unicode / emoji / escaped newlines inside the model string field.
    it('B27 preserves unicode/emoji/newlines in the model name field', async () => {
        const slot = routedSlot({ model: 'gpt-5-mini-日本語-🚀\n<v2>' });
        const resolved = await runWithSlot(slot);
        assertShape(resolved);
        expect(resolved.main.modelName).toBe('openai:gpt-5-mini-日本語-🚀\n<v2>');
        // No mangling / truncation of the string.
        expect(resolved.byokConfig).toBe(slot);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// C. Unparseable / transport — the fail-safe layer. resolveTaskSlot may return
// a broken JSON string (a mis-wired resolver leaking raw text), an error
// object instead of throwing, or an empty-success shell; it may also throw. The
// invariant: never crash the stage on junk, never forward junk as valid BYOK.
// ─────────────────────────────────────────────────────────────────────────
describe('resolveReviewAgentModel — C. unparseable / transport fail-safe', () => {
    beforeEach(() => jest.clearAllMocks());

    const brokenStrings = [
        { row: 'C28 truncated JSON', slot: '{"provider":"openai","model":"gpt-5-mi' },
        { row: 'C29 trailing comma', slot: '{"provider":"openai","model":"gpt-5-mini",}' },
        { row: 'C29 single quotes', slot: "{'provider':'openai','model':'gpt-5-mini'}" },
        { row: 'C29 unquoted keys', slot: '{provider:openai,model:gpt-5-mini}' },
    ];

    it.each(brokenStrings)('shape holds on $row (never crashes the stage)', async ({ slot }) => {
        const resolved = await runWithSlot(slot);
        assertShape(resolved);
    });

    it.failing.each(brokenStrings)(
        'does NOT forward an unparseable string slot as valid BYOK: $row',
        async ({ slot }) => {
            const resolved = await runWithSlot(slot);
            expect(resolved.byokConfig).toBeUndefined();
            expect(resolved.main.modelName).not.toMatch(/undefined/);
            expect(resolved.main.modelName).toBe('default:model');
        },
    );

    // C31 — error object returned instead of throwing. Must be treated as a
    // non-config (degrade to default / signal), not forwarded as a valid slot.
    it('C31 shape holds when the boundary returns an {error} object', async () => {
        const resolved = await runWithSlot({ error: 'KEY_SUSPENDED', code: 401 });
        assertShape(resolved);
    });
    it.failing('C31 does NOT forward an {error} object as valid BYOK', async () => {
        const resolved = await runWithSlot({ error: 'KEY_SUSPENDED', code: 401 });
        expect(resolved.byokConfig).toBeUndefined();
        expect(resolved.main.modelName).toBe('default:model');
        expect(resolved.main.byokProvider).toBeUndefined();
    });

    // C32 — empty-success shell (analog of content:'' / finish_reason:'length'):
    // a slot object whose declared fields are empty strings.
    it('C32 shape holds on an empty-success slot (blank provider/model)', async () => {
        const resolved = await runWithSlot({ provider: '', model: '' });
        assertShape(resolved);
    });
    it.failing('C32 does NOT forward an empty-success slot as valid BYOK', async () => {
        const resolved = await runWithSlot({ provider: '', model: '' });
        // BUG today: byokConfig={provider:'',model:''} (truthy) and
        // modelName===':' (empty provider:model label).
        expect(resolved.byokConfig).toBeUndefined();
        expect(resolved.main.modelName).toBe('default:model');
    });

    // C30 — the boundary throws: fail LOUD, never a silent default swap. (The
    // existing "propagates a boundary rejection" test covers the async-reject
    // channel; this pins the synchronous-throw channel too.)
    it('C30 propagates a synchronous throw from the slot boundary', async () => {
        resolveTaskSlotMock.mockImplementation(() => {
            throw new Error('resolver exploded');
        });
        const svc = permissionServiceReturning(null);
        await expect(
            resolveReviewAgentModel({ organizationAndTeamData: orgTeam }, svc),
        ).rejects.toThrow('resolver exploded');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// D. Input variants — the boundary's input is the scalar ModelInput
// (organizationAndTeamData + byokModel/byokModelId/defaultModelOverride), not a
// list, so the batch rows (D37/D38/D41) are N/A. The applicable rows: empty
// input, single override, null/undefined override fields, special-char /
// whitespace override (trim contract), and the order/permutation invariant
// (byokModelId always wins over byokModel regardless of which the caller set).
// ─────────────────────────────────────────────────────────────────────────
describe('resolveReviewAgentModel — D. input variants', () => {
    beforeEach(() => jest.clearAllMocks());

    // D35 — empty input (no override fields) → empty ctx, clean delegation.
    it('D35 empty input routes with an empty override ctx', async () => {
        await runWithSlot(routedSlot(), {});
        expect(resolveTaskSlotMock.mock.calls[0][2].ctx).toEqual({});
    });

    // D36 — a single override present → carried into ctx.
    it('D36 a single byokModelId override is carried into ctx', async () => {
        await runWithSlot(routedSlot(), { byokModelId: 'm-B' });
        expect(resolveTaskSlotMock.mock.calls[0][2].ctx).toEqual({
            override: { modelId: 'm-B' },
        });
    });

    // D39 — null / undefined required-ish fields must not crash and produce an
    // empty ctx (no override).
    it.each([
        { row: 'both null', input: { byokModel: null, byokModelId: null } },
        { row: 'both undefined', input: { byokModel: undefined, byokModelId: undefined } },
        { row: 'empty strings', input: { byokModel: '', byokModelId: '' } },
    ])('D39 null/blank override fields → empty ctx ($row)', async ({ input }) => {
        const resolved = await runWithSlot(routedSlot(), input);
        assertShape(resolved);
        expect(resolveTaskSlotMock.mock.calls[0][2].ctx).toEqual({});
    });

    // D40 — whitespace-only override is trimmed to falsy → empty ctx (the
    // boundary's documented trim contract), and special chars survive intact.
    it('D40 whitespace-only byokModel is trimmed away → empty ctx', async () => {
        await runWithSlot(routedSlot(), { byokModel: '   \t\n  ' });
        expect(resolveTaskSlotMock.mock.calls[0][2].ctx).toEqual({});
    });
    it('D40 special-char override survives trimming (only edges trimmed)', async () => {
        await runWithSlot(routedSlot(), {
            byokModelId: '  provider/model:тест-🚀  ',
        });
        expect(resolveTaskSlotMock.mock.calls[0][2].ctx).toEqual({
            override: { modelId: 'provider/model:тест-🚀' },
        });
    });

    // D42 — order/permutation metamorphic: the same decision (id wins) holds
    // regardless of which field the caller populated first / together.
    it('D42 byokModelId wins over byokModel regardless of field order', async () => {
        // id + name together.
        await runWithSlot(routedSlot(), { byokModelId: 'id-wins', byokModel: 'name-loses' });
        const ctxA = resolveTaskSlotMock.mock.calls[0][2].ctx;

        jest.clearAllMocks();
        // same pair, "reversed" intent (name set, then id) — object key order is
        // irrelevant to the trim-precedence rule.
        await runWithSlot(routedSlot(), { byokModel: 'name-loses', byokModelId: 'id-wins' });
        const ctxB = resolveTaskSlotMock.mock.calls[0][2].ctx;

        expect(ctxA).toEqual({ override: { modelId: 'id-wins' } });
        expect(ctxB).toEqual(ctxA);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// E. Provider / model matrix — resolveReviewAgentModel does NOT branch on the
// model/provider; the structured-output gate (strict json_schema for
// openai/anthropic/google/moonshotai vs json_object fallback for
// kimi/glm/deepseek/z-ai) lives BEHIND resolveTaskSlot. So the contract at THIS
// layer is provider-agnostic: a clean slot maps identically whatever the
// provider, and an off-schema slot degrades identically whether it carries a
// strict-family or fallback-family provider hint. Asserting identical treatment
// across both families is how this layer proves it delegates the gate rather
// than re-implementing (and mis-implementing) it.
// ─────────────────────────────────────────────────────────────────────────
describe('resolveReviewAgentModel — E. provider matrix (delegated, non-branching)', () => {
    beforeEach(() => jest.clearAllMocks());

    const strictFamily = ['openai', 'anthropic', 'google', 'moonshotai'];
    const fallbackFamily = ['kimi', 'glm', 'deepseek', 'z-ai'];

    // Clean slot: same mapping regardless of provider family.
    it.each([...strictFamily, ...fallbackFamily])(
        'maps a clean slot identically for provider %s',
        async (provider) => {
            const slot = routedSlot({ provider, model: 'the-model' });
            const resolved = await runWithSlot(slot);
            assertShape(resolved);
            expect(resolved.main.modelName).toBe(`${provider}:the-model`);
            expect(resolved.main.byokProvider).toBe(provider);
            expect(resolved.byokConfig).toBe(slot);
        },
    );

    // Off-schema envelope carrying a provider hint: the non-degradation
    // invariant is identical across both gate branches (the boundary never
    // trusts a family more than another because it does not branch at all).
    const offSchemaFor = (provider: string) => ({
        result: routedSlot({ provider, model: 'wrapped' }),
    });

    it.failing.each([...strictFamily, ...fallbackFamily])(
        'off-schema slot degrades identically (no silent forward) for provider %s',
        async (provider) => {
            const resolved = await runWithSlot(offSchemaFor(provider));
            expect(resolved.byokConfig).toBeUndefined();
            expect(resolved.main.modelName).toBe('default:model');
            expect(resolved.main.byokProvider).toBeUndefined();
        },
    );
});
