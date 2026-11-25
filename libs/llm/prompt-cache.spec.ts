/**
 * Contract tests for the prompt-cache boundary (`libs/llm/prompt-cache.ts`)
 * that need the hint resolver (`./system-cache`) under control: the hit/miss
 * gate, the fail-safe on a throwing resolver, stamper edge cases, and the
 * shared-prefix boundary (#2172).
 *
 * Happy paths against the real registry live in apply-cache-breakpoints.spec.ts,
 * the stampers in prompt-cache-markers.spec.ts, and the per-provider decision in
 * system-cache.spec.ts.
 */
import type { ModelMessage } from 'ai';
import {
    applyCacheBreakpoints,
    CACHE_PREFIX_BOUNDARY,
    markLastToolForCache,
    markLatestUserForCache,
    withoutPrefixBoundary,
} from './prompt-cache';

// Auto-mock the hint resolver; the default implementation DELEGATES to the real
// module (real provider registry), while individual tests override it to inject
// an absent or throwing resolver.
jest.mock('./system-cache');
import { systemCacheControl } from './system-cache';
const mockHint = systemCacheControl as jest.Mock;
const actualSystemCache = jest.requireActual(
    './system-cache',
) as typeof import('./system-cache');

const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' } } };

const userMsg = (text = 'hi'): ModelMessage => ({ role: 'user', content: text });
const tools = () => ({
    findFile: { description: 'a' },
    listDir: { description: 'b' },
});

beforeEach(() => {
    jest.clearAllMocks();
    // Default: the real registry-backed resolver.
    mockHint.mockImplementation(actualSystemCache.systemCacheControl);
});

// A well-formed multi-step Anthropic call (the "hit" path) used as the fixture
// for the input-variant rows.
const runHit = (over: Partial<Parameters<typeof applyCacheBreakpoints>[0]>) =>
    applyCacheBreakpoints({
        system: 'SYS',
        messages: [userMsg()],
        tools: tools(),
        maxSteps: 4,
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        ...over,
    });

// ───────────────────────────────────────────────────────────────────────────
// Hit / miss gate — the "cache lookup" of this boundary.
//   maxSteps>1 AND resolver returns a truthy hint  → HIT (stamp)
//   maxSteps<=1 OR resolver returns falsy           → MISS (pass-through refs)
// ───────────────────────────────────────────────────────────────────────────
describe('hit / miss gate', () => {
    it('MISS: single-step (maxSteps=1) never calls the resolver and passes refs through', () => {
        const messages = [userMsg()];
        const t = tools();
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages,
            tools: t,
            maxSteps: 1,
            provider: 'anthropic',
            model: 'claude-sonnet-4',
        });
        expect(mockHint).not.toHaveBeenCalled();
        expect(out.systemArg).toBe('SYS');
        expect(out.callMessages).toBe(messages);
        expect(out.callTools).toBe(t);
    });

    it('MISS: maxSteps=0 also gates cache off (boundary is >1, not >=1)', () => {
        const messages = [userMsg()];
        const t = tools();
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages,
            tools: t,
            maxSteps: 0,
            provider: 'anthropic',
            model: 'claude-sonnet-4',
        });
        expect(mockHint).not.toHaveBeenCalled();
        expect(out.callMessages).toBe(messages);
    });

    it('MISS: resolver returns undefined → pass-through, no stamping', () => {
        mockHint.mockReturnValue(undefined);
        const messages = [userMsg()];
        const t = tools();
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages,
            tools: t,
            maxSteps: 4,
            provider: 'whatever',
            model: 'whatever',
        });
        expect(out.systemArg).toBe('SYS');
        expect(out.callMessages).toBe(messages);
        expect(out.callTools).toBe(t);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// C. Unparseable / transport / fail-safe.
//   The only external call this boundary makes is to the hint resolver.
//   Row 30 (resolver throws) is the fail-safe row: a cache hint is a
//   non-essential optimization, so a throw MUST degrade to no-cache, never crash
//   the model call. Production has NO guard around the resolver
//   (prompt-cache.ts:132-138) so it propagates — pinned as it.failing (green
//   today, red once a try/catch fallback lands).
// ───────────────────────────────────────────────────────────────────────────
describe('C. fail-safe layer', () => {
    // Row 30 — resolver throws. CORRECT behavior = degrade to pass-through.
    it.failing(
        'row30 a throwing hint resolver should degrade to no-cache pass-through, not crash the call',
        () => {
            mockHint.mockImplementation(() => {
                throw new Error('registry boom');
            });
            const messages = [userMsg()];
            const t = tools();
            let out: ReturnType<typeof applyCacheBreakpoints>;
            expect(() => {
                out = applyCacheBreakpoints({
                    system: 'SYS',
                    messages,
                    tools: t,
                    maxSteps: 4,
                    provider: 'anthropic',
                    model: 'claude-sonnet-4',
                });
            }).not.toThrow();
            // and it should be a clean pass-through (no cache applied)
            expect(out!.systemArg).toBe('SYS');
            expect(out!.callMessages).toBe(messages);
            expect(out!.callTools).toBe(t);
        },
    );
});

// ───────────────────────────────────────────────────────────────────────────
// D. Stamper edge cases.
// ───────────────────────────────────────────────────────────────────────────
describe('D. input variants', () => {
    // Row 39 — input item with null/undefined field: a null last tool entry, and
    // a messages array whose only user entry is well-formed.
    it('row39 null/non-object last tool: markLastToolForCache returns same ref (safe)', () => {
        const t = { good: { description: 'x' }, bad: null } as any;
        const out = markLastToolForCache(t, EPHEMERAL);
        expect(out).toBe(t); // last entry not an object → untouched
    });

    // Idempotence — re-stamping an already-marked prefix does not double-apply.
    it('idempotent: re-running the stampers is a no-op on already-marked entries', () => {
        const once = markLatestUserForCache([userMsg()], EPHEMERAL);
        const twice = markLatestUserForCache(once, EPHEMERAL);
        expect((twice[0] as any).providerOptions).toEqual(EPHEMERAL);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Shared-prefix boundary (#2172) — the custom agents of one review send the
// same system prefix; the marker gives it its own breakpoint and never
// reaches a model.
// ───────────────────────────────────────────────────────────────────────────
describe('shared-prefix boundary', () => {
    const SYSTEM = `SHARED RULES${CACHE_PREFIX_BOUNDARY}AGENT ROLE`;

    it('splits the system prompt at the marker into two cached parts', () => {
        const out = runHit({ system: SYSTEM });

        expect(out.systemArg).toEqual([
            {
                role: 'system',
                content: 'SHARED RULES',
                providerOptions: EPHEMERAL,
            },
            {
                role: 'system',
                content: 'AGENT ROLE',
                providerOptions: EPHEMERAL,
            },
        ]);
        // 4 breakpoints in all: tool + 2 system parts + latest user.
        expect((out.callTools as any).listDir.providerOptions).toEqual(
            EPHEMERAL,
        );
        expect((out.callMessages[0] as any).providerOptions).toEqual(EPHEMERAL);
    });

    it('removes the marker when the provider takes no inline hint', () => {
        const out = runHit({
            system: SYSTEM,
            provider: 'openai',
            model: 'gpt-4o',
        });

        expect(out.systemArg).toBe('SHARED RULESAGENT ROLE');
    });

    it('removes the marker on a single-step call', () => {
        expect(runHit({ system: SYSTEM, maxSteps: 1 }).systemArg).toBe(
            'SHARED RULESAGENT ROLE',
        );
    });

    it('keeps one cached part when a side of the marker is empty', () => {
        const out = runHit({ system: `${CACHE_PREFIX_BOUNDARY}AGENT ROLE` });

        expect(out.systemArg).toEqual({
            role: 'system',
            content: 'AGENT ROLE',
            providerOptions: EPHEMERAL,
        });
    });

    it('leaves a system prompt without the marker exactly as before', () => {
        expect(runHit({}).systemArg).toEqual({
            role: 'system',
            content: 'SYS',
            providerOptions: EPHEMERAL,
        });
        expect(withoutPrefixBoundary('SYS')).toBe('SYS');
    });
});
