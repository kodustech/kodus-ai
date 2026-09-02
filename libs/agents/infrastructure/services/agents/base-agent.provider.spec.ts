import type { LlmTask, NormalizedModel } from '@libs/llm/byok-config';
import { LLM_TASK } from '@libs/llm/byok-config';

import { BaseAgentProvider } from './base-agent.provider';

/**
 * CONTRACT tests for the BaseAgentProvider request-assembly boundary.
 *
 * This base provider has NO direct `LLM.run` call and does NOT parse raw model
 * text. Its boundary is `permissionValidationService.resolveTaskSlot(...)` — the
 * deterministic layer that ASSEMBLES the model request (org/team + routed task +
 * override ctx) and FALLS BACK to the managed/env default when no BYOK slot
 * resolves. `resolveTaskSlot` returns an already-typed `NormalizedModel |
 * undefined`, never raw provider text, so the "output-shape zoo / JSON-parse /
 * provider-envelope / structured-output-gate" rows of the LLM.run I/O matrix do
 * not exist at THIS boundary (they live at the downstream `LLM.run` call site).
 *
 * The rows that DO apply here:
 *   - request assembly (task threading, override precedence, ctx shape, trim),
 *   - the nullish fail-safe (`resolveTaskSlot() ?? undefined`),
 *   - verbatim threading of whatever truthy slot the resolver returns (the
 *     boundary must not reshape a resolved config — validation is the resolver's
 *     job), and
 *   - input variants (empty / single / null-field / special-chars / duplicate
 *     override / order independence).
 *
 * The boundary spy is the injected `resolveTaskSlot` jest.fn(): a fresh mock is
 * built per test (jest.clearAllMocks in beforeEach), so no module spy leaks
 * across tests.
 *
 * Matrix source line under test:
 *   base-agent.provider.ts:76-85  `this.byokConfig = (await …resolveTaskSlot(…)) ?? undefined`
 */

// ── Test harness: a minimal concrete subclass so we can construct the abstract base ──

class TestAgentProvider extends BaseAgentProvider {
    protected readonly maxOutputTokensFallback = 4096;

    protected async createMCPAdapter(): Promise<void> {
        // no-op for these deterministic config-assembly tests
    }

    /** Expose the protected async fetch under a public name for the tests. */
    public runFetch(
        org: any,
        nameOverride?: string,
        idOverride?: string,
    ): Promise<void> {
        return this.fetchBYOKConfig(org, nameOverride, idOverride);
    }

    /** Read the protected byokConfig the boundary set. */
    public get resolvedConfig(): NormalizedModel | undefined {
        return (this as any).byokConfig;
    }

    /** Read the protected org/team data the boundary stored. */
    public get storedOrg(): any {
        return (this as any).organizationAndTeamData;
    }
}

/** A subclass that routes to a NON-default task, to prove the getLlmTask() hook
 *  is what threads the task into the resolver call. */
class BusinessTaskAgentProvider extends TestAgentProvider {
    protected getLlmTask(): LlmTask {
        return LLM_TASK.businessValidation;
    }
}

// A fully-populated slot to stand in for the "exact D" happy path.
const FULL_SLOT: NormalizedModel = {
    provider: 'openai' as any,
    apiKey: 'enc:ciphertext',
    model: 'gpt-4o',
    byokModelId: 'model-123',
    credentialId: 'cred-9',
    temperature: 0.2,
    maxOutputTokens: 8192,
    route: 'conversation',
    usedFallback: false,
};

// Convenience: build a provider whose resolveTaskSlot returns/does whatever we say.
function makeProvider<T extends TestAgentProvider = TestAgentProvider>(
    resolveImpl: jest.Mock,
    Ctor: new (perm: any, obs: any) => T = TestAgentProvider as any,
): { provider: T; resolveTaskSlot: jest.Mock } {
    const perm = { resolveTaskSlot: resolveImpl };
    const provider = new Ctor(perm as any, {} as any);
    return { provider, resolveTaskSlot: resolveImpl };
}

const ORG = { organizationId: 'org-1', teamId: 'team-1' } as any;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('BaseAgentProvider — boundary: getLlmTask() routing', () => {
    it('[req-assembly] defaults to the conversation task', () => {
        const { provider } = makeProvider(jest.fn());
        // getLlmTask is protected; reach it via cast.
        expect((provider as any).getLlmTask()).toBe(LLM_TASK.conversation);
    });

    it('[req-assembly] a subclass override routes to its own task', () => {
        const { provider } = makeProvider(
            jest.fn(),
            BusinessTaskAgentProvider,
        );
        expect((provider as any).getLlmTask()).toBe(
            LLM_TASK.businessValidation,
        );
    });

    it('[req-assembly] threads getLlmTask() into the resolveTaskSlot call', async () => {
        const resolve = jest.fn().mockResolvedValue(FULL_SLOT);
        const { provider } = makeProvider(resolve, BusinessTaskAgentProvider);
        await provider.runFetch(ORG);
        expect(resolve).toHaveBeenCalledTimes(1);
        const [, task] = resolve.mock.calls[0];
        expect(task).toBe(LLM_TASK.businessValidation);
    });
});

describe('BaseAgentProvider — request assembly (matrix D: input variants)', () => {
    it('[row 1 · req-assembly] passes the org/team data verbatim as arg #1 and stores it', async () => {
        const resolve = jest.fn().mockResolvedValue(FULL_SLOT);
        const { provider } = makeProvider(resolve);
        await provider.runFetch(ORG);
        expect(resolve.mock.calls[0][0]).toBe(ORG);
        expect(provider.storedOrg).toBe(ORG);
    });

    it('[row 36 · single override — id only] builds ctx.override.modelId from the id and inherits nothing else', async () => {
        const resolve = jest.fn().mockResolvedValue(FULL_SLOT);
        const { provider } = makeProvider(resolve);
        await provider.runFetch(ORG, undefined, 'id-only-model');
        const [, , options] = resolve.mock.calls[0];
        expect(options).toEqual({ ctx: { override: { modelId: 'id-only-model' } } });
    });

    it('[row 36 · single override — name only] builds ctx.override.modelId from the legacy NAME when no id is present', async () => {
        const resolve = jest.fn().mockResolvedValue(FULL_SLOT);
        const { provider } = makeProvider(resolve);
        await provider.runFetch(ORG, 'legacy-name', undefined);
        const [, , options] = resolve.mock.calls[0];
        expect(options).toEqual({ ctx: { override: { modelId: 'legacy-name' } } });
    });

    it('[row 38 · duplicate override input] id WINS over name when BOTH are supplied', async () => {
        const resolve = jest.fn().mockResolvedValue(FULL_SLOT);
        const { provider } = makeProvider(resolve);
        await provider.runFetch(ORG, 'legacy-name', 'id-model');
        const [, , options] = resolve.mock.calls[0];
        expect(options.ctx.override.modelId).toBe('id-model');
    });

    it('[row 42 · order independence] id-wins is independent of whether name is also present (metamorphic)', async () => {
        const resolveA = jest.fn().mockResolvedValue(FULL_SLOT);
        const resolveB = jest.fn().mockResolvedValue(FULL_SLOT);
        const { provider: a } = makeProvider(resolveA);
        const { provider: b } = makeProvider(resolveB);
        await a.runFetch(ORG, 'name-x', 'id-x');
        await b.runFetch(ORG, undefined, 'id-x');
        expect(resolveA.mock.calls[0][2].ctx.override.modelId).toBe('id-x');
        expect(resolveB.mock.calls[0][2].ctx.override.modelId).toBe('id-x');
        expect(resolveA.mock.calls[0][2]).toEqual(resolveB.mock.calls[0][2]);
    });

    it('[row 35 · empty input] an empty org object still calls the resolver with empty ctx and no crash', async () => {
        const resolve = jest.fn().mockResolvedValue(undefined);
        const { provider } = makeProvider(resolve);
        await expect(provider.runFetch({} as any)).resolves.toBeUndefined();
        const [org, , options] = resolve.mock.calls[0];
        expect(org).toEqual({});
        expect(options).toEqual({ ctx: {} });
    });

    it('[row 39 · null/undefined required fields] undefined overrides → inherit (ctx = {}); a null-field org is threaded verbatim', async () => {
        const resolve = jest.fn().mockResolvedValue(undefined);
        const nullyOrg = { organizationId: null, teamId: undefined } as any;
        const { provider } = makeProvider(resolve);
        await provider.runFetch(nullyOrg, undefined, undefined);
        const [org, , options] = resolve.mock.calls[0];
        expect(org).toBe(nullyOrg);
        expect(options).toEqual({ ctx: {} });
    });

    it('[row 40 · whitespace-only override] a whitespace-only id and name trim to empty → inherit (ctx = {})', async () => {
        const resolve = jest.fn().mockResolvedValue(undefined);
        const { provider } = makeProvider(resolve);
        await provider.runFetch(ORG, '   ', '  \t\n ');
        const [, , options] = resolve.mock.calls[0];
        expect(options).toEqual({ ctx: {} });
    });

    it('[row 40 · whitespace id falls through] a whitespace-only id defers to a real name', async () => {
        const resolve = jest.fn().mockResolvedValue(undefined);
        const { provider } = makeProvider(resolve);
        await provider.runFetch(ORG, 'real-name', '   ');
        const [, , options] = resolve.mock.calls[0];
        expect(options.ctx.override.modelId).toBe('real-name');
    });

    it('[row 40 · special chars] special-character override ids are preserved (trim only strips edge whitespace)', async () => {
        const resolve = jest.fn().mockResolvedValue(undefined);
        const { provider } = makeProvider(resolve);
        const weird = '  accounts/fireworks/models/llama-v3🚀-"x"\n';
        await provider.runFetch(ORG, undefined, weird);
        const [, , options] = resolve.mock.calls[0];
        expect(options.ctx.override.modelId).toBe(weird.trim());
    });
});

describe('BaseAgentProvider — return shape / fallback (matrix A + C)', () => {
    it('[row 1 · exact D] a fully-resolved slot is stored verbatim as byokConfig', async () => {
        const resolve = jest.fn().mockResolvedValue(FULL_SLOT);
        const { provider } = makeProvider(resolve);
        await provider.runFetch(ORG);
        expect(provider.resolvedConfig).toBe(FULL_SLOT);
        expect(provider.resolvedConfig).toEqual(FULL_SLOT);
    });

    it('[row 17 · null return → fail-safe] resolver returning null coalesces to undefined (degrade to managed/env default)', async () => {
        const resolve = jest.fn().mockResolvedValue(null);
        const { provider } = makeProvider(resolve);
        await provider.runFetch(ORG);
        expect(provider.resolvedConfig).toBeUndefined();
    });

    it('[row 17 · undefined return → fail-safe] resolver returning undefined stays undefined', async () => {
        const resolve = jest.fn().mockResolvedValue(undefined);
        const { provider } = makeProvider(resolve);
        await provider.runFetch(ORG);
        expect(provider.resolvedConfig).toBeUndefined();
    });

    // Rows 2-6, 10-13, 18: `resolveTaskSlot` is typed to return NormalizedModel |
    // undefined, so these off-shape returns cannot occur in production — but the
    // boundary's contract is to thread ANY truthy resolver value VERBATIM (no
    // reshape, no key-fixing, no default-filling); that pass-through IS the
    // correct non-degradation here, because config validation belongs to the
    // resolver, not this base. We pin the pass-through so a future "helpful"
    // reshape at this boundary would break the test.
    it.each([
        ['row 2 · bare array', [{ model: 'a' }] as any],
        ['row 3 · object/array swap', { model: 'x' } as any],
        ['row 4 · wrapper key', { result: FULL_SLOT } as any],
        ['row 5 · double wrapper', { result: { result: FULL_SLOT } } as any],
        ['row 6 · numeric single-key wrap', { '0': FULL_SLOT } as any],
        ['row 10 · right data wrong keys', { duplicateGroups: 1, uniqueIndices: [] } as any],
        ['row 11 · case mismatch', { Provider: 'openai', Model: 'x' } as any],
        ['row 12 · partial object', { provider: 'openai' } as any],
        ['row 13 · extra unknown keys', { ...FULL_SLOT, __weird: true } as any],
        ['row 18 · primitive true', true as any],
    ])(
        '[%s] a truthy resolver value is threaded verbatim (never reshaped)',
        async (_label, weird) => {
            const resolve = jest.fn().mockResolvedValue(weird);
            const { provider } = makeProvider(resolve);
            await provider.runFetch(ORG);
            expect(provider.resolvedConfig).toBe(weird);
        },
    );

    it('[row 14 · empty object] {} is truthy → threaded verbatim (resolver contract never returns {})', async () => {
        const empty = {} as any;
        const resolve = jest.fn().mockResolvedValue(empty);
        const { provider } = makeProvider(resolve);
        await provider.runFetch(ORG);
        expect(provider.resolvedConfig).toBe(empty);
    });

    it('[row 15 · empty array] [] is truthy → threaded verbatim (resolver contract never returns an array)', async () => {
        const empty = [] as any;
        const resolve = jest.fn().mockResolvedValue(empty);
        const { provider } = makeProvider(resolve);
        await provider.runFetch(ORG);
        expect(provider.resolvedConfig).toBe(empty);
    });

    it('[row 16 · empty string] `?? undefined` is nullish-only: an empty string is NOT coalesced', async () => {
        const resolve = jest.fn().mockResolvedValue('' as any);
        const { provider } = makeProvider(resolve);
        await provider.runFetch(ORG);
        // Documents the exact operator semantics: '' is falsy but not nullish, so
        // it survives `?? undefined`. The resolver never returns a string, so this
        // is a contract guard, not a live degradation.
        expect(provider.resolvedConfig).toBe('');
    });

    it('[row 30 · resolver throws → fail EXPLICIT] a resolver rejection propagates (never swallowed into a silent wrong default)', async () => {
        const boom = new Error('DB down inside getBYOKConfig');
        const resolve = jest.fn().mockRejectedValue(boom);
        const { provider } = makeProvider(resolve);
        await expect(provider.runFetch(ORG)).rejects.toBe(boom);
        // fail-explicit: byokConfig is NOT set to a bogus value on the failure path.
        expect(provider.resolvedConfig).toBeUndefined();
        // org/team is stored BEFORE the resolver call (it precedes the throw).
        expect(provider.storedOrg).toBe(ORG);
    });

    it('[row 31 · error object] a truthy {error} is threaded verbatim (resolver contract returns undefined, not {error})', async () => {
        const errObj = { error: 'BLOCKED' } as any;
        const resolve = jest.fn().mockResolvedValue(errObj);
        const { provider } = makeProvider(resolve);
        await provider.runFetch(ORG);
        expect(provider.resolvedConfig).toBe(errObj);
    });

    it('[invariant] fetchBYOKConfig always resolves to void and leaves byokConfig as NormalizedModel|undefined across layers', async () => {
        for (const ret of [FULL_SLOT, null, undefined, {} as any]) {
            const resolve = jest.fn().mockResolvedValue(ret);
            const { provider } = makeProvider(resolve);
            const result = await provider.runFetch(ORG);
            expect(result).toBeUndefined();
            const cfg = provider.resolvedConfig;
            expect(cfg === undefined || typeof cfg === 'object').toBe(true);
        }
    });
});
