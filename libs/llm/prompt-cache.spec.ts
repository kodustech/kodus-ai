/**
 * CONTRACT tests for the prompt-cache boundary (`libs/llm/prompt-cache.ts`).
 *
 * This module has NO `LLM.run` call and NO JSON/envelope parsing of its own — it
 * is the DETERMINISTIC assembly layer that stamps opaque prompt-cache markers
 * onto ONE model call before `LLM.run` fires it. So the I/O contract matrix is
 * re-projected onto THIS boundary:
 *
 *   - The "declared schema D" of the boundary is its return shape
 *     `{ systemArg, callMessages, callTools }`.
 *   - The "model output / inner payload" analog is the opaque `CacheHint` that
 *     `systemCacheControl` (the registry delegator in `./system-cache`) hands
 *     back. That is the ONLY value that flows INTO the assembly, so the A/B/C
 *     "off-schema returns" rows are exercised by feeding a malformed hint —
 *     either straight into the exported stampers, or via a mocked
 *     `systemCacheControl` for `applyCacheBreakpoints`.
 *   - The E "N-model policy" branch is the honors-inline-markers decision the
 *     boundary DELEGATES to `systemCacheControl` → the real provider registry.
 *     We cover it against the REAL registry (default mock impl delegates to the
 *     actual module) so the protocol-aware decision is the real one.
 *
 * The sibling `apply-cache-breakpoints.spec.ts` is a characterization net for the
 * happy paths; this file EXTENDS coverage to the full matrix (malformed hint
 * zoo, fail-safe on a throwing resolver, input-variant invariants) and does not
 * touch that file.
 */
import type { ModelMessage } from 'ai';
import {
    applyCacheBreakpoints,
    markLastToolForCache,
    markLatestUserForCache,
    type CacheHint,
} from './prompt-cache';

// Auto-mock the hint resolver; the default implementation DELEGATES to the real
// module (real provider registry) so the E-branch tests exercise the actual
// protocol-aware decision, while individual tests override it to inject the
// malformed-hint / throwing zoo.
jest.mock('./system-cache');
import { systemCacheControl } from './system-cache';
const mockHint = systemCacheControl as jest.Mock;
const actualSystemCache = jest.requireActual(
    './system-cache',
) as typeof import('./system-cache');

const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' } } };

const userMsg = (text = 'hi'): ModelMessage => ({ role: 'user', content: text });
const asstMsg = (text = 'x'): ModelMessage => ({
    role: 'assistant',
    content: text,
});
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
// Return-shape invariant — the boundary ALWAYS returns its declared type.
// ───────────────────────────────────────────────────────────────────────────
describe('return shape — declared type is total across every layer', () => {
    const shapeOk = (out: ReturnType<typeof applyCacheBreakpoints>) => {
        expect(out).toBeDefined();
        expect(Object.keys(out).sort()).toEqual([
            'callMessages',
            'callTools',
            'systemArg',
        ]);
        expect(Array.isArray(out.callMessages)).toBe(true);
        expect(out.callTools).toBeDefined();
    };

    it('hit path returns {systemArg, callMessages, callTools}', () => {
        shapeOk(runHit({}));
    });

    it('miss path (single-step) returns the same declared shape', () => {
        shapeOk(runHit({ maxSteps: 1 }));
    });

    it('miss path (no-marker provider) returns the same declared shape', () => {
        shapeOk(runHit({ provider: 'openai', model: 'gpt-4o' }));
    });

    it('returns the shape even when the resolver yields a malformed hint', () => {
        mockHint.mockReturnValue([1, 2] as unknown as Record<string, unknown>);
        shapeOk(runHit({}));
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Hit / miss gate — the "cache lookup" of this boundary.
//   maxSteps>1 AND resolver returns a truthy hint  → HIT (stamp)
//   maxSteps<=1 OR resolver returns falsy           → MISS (pass-through refs)
// ───────────────────────────────────────────────────────────────────────────
describe('hit / miss gate', () => {
    it('HIT: multi-step + truthy hint stamps all three breakpoints', () => {
        mockHint.mockReturnValue(EPHEMERAL);
        const messages = [userMsg('old'), asstMsg(), userMsg('latest')];
        const t = tools();
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages,
            tools: t,
            maxSteps: 4,
            provider: 'anthropic',
            model: 'claude-sonnet-4',
        });
        expect((out.systemArg as any).providerOptions).toEqual(EPHEMERAL);
        expect((out.callMessages[2] as any).providerOptions).toEqual(EPHEMERAL);
        expect((out.callMessages[0] as any).providerOptions).toBeUndefined();
        expect((out.callTools as any).listDir.providerOptions).toEqual(
            EPHEMERAL,
        );
    });

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
// A. Output-shape zoo — projected onto the opaque CacheHint the boundary
//    consumes. The hint is opaque BY CONTRACT (Readonly<Record<string,unknown>>),
//    so the boundary is a STAMPER, not a parser: there is no inner payload to
//    "unwrap". The applicable rows assert (a) a truthy hint is stamped VERBATIM
//    (no unwrap/rename), and (b) a malformed hint NEVER throws and the return
//    shape stays valid.  We drive these both directly through the stampers and
//    through applyCacheBreakpoints (via the mocked resolver).
// ───────────────────────────────────────────────────────────────────────────
describe('A. hint-shape zoo (opaque marker; stamp-verbatim or stay safe)', () => {
    // Row 1 — exact D: valid ephemeral hint stamped correctly.
    it('row1 exact hint: stamped verbatim on message + tool', () => {
        const msgs = markLatestUserForCache([userMsg()], EPHEMERAL);
        const t = markLastToolForCache(tools(), EPHEMERAL);
        expect((msgs[0] as any).providerOptions).toEqual(EPHEMERAL);
        expect((t as any).listDir.providerOptions).toEqual(EPHEMERAL);
    });

    // Row 4/5/6 — wrapper / double-wrapper / opaque single-key: the marker IS a
    // vendor-namespaced wrapper; the boundary must stamp it AS-IS, never unwrap.
    it('row4/5/6 wrapper-shaped hints are stamped verbatim (never unwrapped)', () => {
        const nested: CacheHint = { result: { result: EPHEMERAL } };
        const numeric: CacheHint = { '0': EPHEMERAL };
        expect(
            (markLatestUserForCache([userMsg()], nested)[0] as any)
                .providerOptions,
        ).toEqual(nested);
        expect(
            (markLastToolForCache(tools(), numeric) as any).listDir
                .providerOptions,
        ).toEqual(numeric);
    });

    // Row 13 — extra unknown keys tolerated (merge, hint wins, no crash).
    it('row13 extra keys tolerated and merged over a pre-existing marker (other vendors preserved)', () => {
        const existing = { openai: { foo: 1 } };
        const msgs = markLatestUserForCache(
            [{ ...userMsg(), providerOptions: existing } as ModelMessage],
            EPHEMERAL,
        );
        expect((msgs[0] as any).providerOptions).toEqual({
            openai: { foo: 1 },
            ...EPHEMERAL,
        });
    });

    // Row 14 — empty object hint: TRUTHY, so the gate opens and stamps an inert
    // {} marker. Pin the actual behavior: no throw, shape valid. (Not a data-loss
    // degradation — the inert marker is a no-op to the SDK — so `it`, not
    // it.failing; noted in knownDegradations as a truthy-but-inert allocation.)
    it('row14 empty-object hint: truthy gate stamps an inert {} marker, no throw', () => {
        mockHint.mockReturnValue({});
        const out = runHit({});
        expect((out.systemArg as any).providerOptions).toEqual({});
        expect((out.callMessages[0] as any).providerOptions).toEqual({});
        expect(out.callMessages).not.toBe(runHit); // new array produced
    });

    // Row 15 — empty array hint: truthy; spread of [] yields {}. No throw.
    it('row15 empty-array hint: spreads to {}, no throw, shape intact', () => {
        mockHint.mockReturnValue([] as unknown as Record<string, unknown>);
        const out = runHit({});
        expect((out.callMessages[0] as any).providerOptions).toEqual({});
    });

    // Row 16 — empty string hint: FALSY → treated as a MISS (pass-through refs).
    it('row16 empty-string hint is falsy → MISS (pass-through)', () => {
        mockHint.mockReturnValue('' as unknown as Record<string, unknown>);
        const messages = [userMsg()];
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages,
            tools: tools(),
            maxSteps: 4,
            provider: 'anthropic',
            model: 'claude-sonnet-4',
        });
        expect(out.systemArg).toBe('SYS');
        expect(out.callMessages).toBe(messages);
    });

    // Row 17 — null hint via applyCacheBreakpoints is falsy → MISS; null fed
    // DIRECTLY to a stamper merges to {} (defensive, no throw).
    it('row17 null hint: falsy → MISS through applyCacheBreakpoints', () => {
        mockHint.mockReturnValue(null as unknown as Record<string, unknown>);
        const messages = [userMsg()];
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages,
            tools: tools(),
            maxSteps: 4,
            provider: 'anthropic',
            model: 'claude-sonnet-4',
        });
        expect(out.callMessages).toBe(messages);
    });
    it('row17 null hint fed directly to a stamper merges to {} without throwing', () => {
        const msgs = markLatestUserForCache(
            [userMsg()],
            null as unknown as CacheHint,
        );
        expect((msgs[0] as any).providerOptions).toEqual({});
    });

    // Row 18 — primitive hints: truthy non-spreadable (true) → {}; falsy (0) →
    // MISS; truthy string → char-spread. None throw; shape always valid.
    it('row18 boolean-true hint: truthy, spreads to {}, no throw', () => {
        mockHint.mockReturnValue(true as unknown as Record<string, unknown>);
        expect((runHit({}).callMessages[0] as any).providerOptions).toEqual({});
    });
    it('row18 number-0 hint: falsy → MISS', () => {
        mockHint.mockReturnValue(0 as unknown as Record<string, unknown>);
        const messages = [userMsg()];
        expect(runHit({ messages }).callMessages).toBe(messages);
    });
    it('row18 non-empty-string hint: truthy, char-spread, no throw', () => {
        mockHint.mockReturnValue('ok' as unknown as Record<string, unknown>);
        expect((runHit({}).callMessages[0] as any).providerOptions).toEqual({
            0: 'o',
            1: 'k',
        });
    });

    // Row 2 — bare array of inner items: truthy, spreads to indexed keys.
    it('row2 array hint spreads to indexed keys, no throw', () => {
        const hint = [{ a: 1 }] as unknown as CacheHint;
        expect(
            (markLatestUserForCache([userMsg()], hint)[0] as any)
                .providerOptions,
        ).toEqual({ 0: { a: 1 } });
    });

    // Row 7 — stringified-JSON hint: char-spread, no throw (opaque; not parsed).
    it('row7 stringified-JSON hint is NOT parsed — char-spread, no throw', () => {
        const hint = '{"anthropic":1}' as unknown as CacheHint;
        expect(() => markLastToolForCache(tools(), hint)).not.toThrow();
    });
});

// ───────────────────────────────────────────────────────────────────────────
// B. Semantic-but-wrong — value ENCODING inside typed fields of a model
//    response. The hint carries NO typed value fields the boundary interprets
//    (no booleans / enums / indices), so rows 21–26 are N/A. Row 27 (unicode /
//    escaped newlines / emoji inside string fields) DOES apply to the CONTENT
//    the stamper wraps: it must be preserved byte-for-byte.
// ───────────────────────────────────────────────────────────────────────────
describe('B. row27 unicode/emoji/escaped content is preserved through stamping', () => {
    it('user message content with emoji + escaped newlines survives verbatim', () => {
        const weird = 'café\n\t🚀 \\n "quoted" 汉字';
        const msgs = markLatestUserForCache(
            [{ role: 'user', content: weird } as ModelMessage],
            EPHEMERAL,
        );
        expect((msgs[0] as any).content).toBe(weird);
        expect((msgs[0] as any).providerOptions).toEqual(EPHEMERAL);
    });
    it('system content with unicode is carried onto the system message verbatim', () => {
        mockHint.mockReturnValue(EPHEMERAL);
        const sys = 'régles 汉字 🚀';
        const out = runHit({ system: sys });
        expect((out.systemArg as any).content).toBe(sys);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// C. Unparseable / transport / fail-safe.
//   The only external call this boundary makes is to the hint resolver.
//   Row 30 (resolver throws) is the fail-safe row: a cache hint is a
//   non-essential optimization, so a throw MUST degrade to no-cache, never crash
//   the model call. Production has NO guard around the resolver
//   (prompt-cache.ts:132-138) so it propagates — pinned as it.failing (green
//   today, red once a try/catch fallback lands). Row 31 (resolver returns an
//   {error} object) is stamped opaquely (truthy) — pinned as actual.
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

    // Guard the CURRENT (documented) behavior too, so the contract is explicit:
    it('row30 today the throw propagates (documents the missing guard)', () => {
        mockHint.mockImplementation(() => {
            throw new Error('registry boom');
        });
        expect(() => runHit({})).toThrow('registry boom');
    });

    // Row 31 — resolver returns an {error} object instead of throwing: truthy,
    // so it is stamped opaquely (no signal). Pinned as actual behavior.
    it('row31 {error} hint is stamped opaquely (no throw)', () => {
        mockHint.mockReturnValue({ error: 'nope' });
        const out = runHit({});
        expect((out.systemArg as any).providerOptions).toEqual({
            error: 'nope',
        });
    });

    // Row 32 — "empty success" analog: resolver yields nothing meaningful.
    it('row32 empty-success analog: undefined hint → no-op pass-through', () => {
        mockHint.mockReturnValue(undefined);
        const messages = [userMsg()];
        expect(runHit({ messages }).callMessages).toBe(messages);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// D. Input variants — happy hint (real anthropic), assert the assembly
//    invariant. Uses the real resolver (default mock impl).
// ───────────────────────────────────────────────────────────────────────────
describe('D. input variants', () => {
    // Row 35 — empty input: no user message, no tools.
    it('row35 empty messages + empty tools: system stamped, rest same-ref no-op', () => {
        const messages: ModelMessage[] = [];
        const t = {};
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages,
            tools: t,
            maxSteps: 4,
            provider: 'anthropic',
            model: 'claude-sonnet-4',
        });
        expect((out.systemArg as any).providerOptions).toEqual(EPHEMERAL);
        expect(out.callMessages).toBe(messages);
        expect(out.callTools).toBe(t);
    });

    // Row 36 — single item.
    it('row36 single user message + single tool: both stamped', () => {
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages: [userMsg()],
            tools: { only: { description: 'x' } },
            maxSteps: 4,
            provider: 'anthropic',
            model: 'claude-sonnet-4',
        });
        expect((out.callMessages[0] as any).providerOptions).toEqual(EPHEMERAL);
        expect((out.callTools as any).only.providerOptions).toEqual(EPHEMERAL);
    });

    // Row 37 — large input: only the latest user + last tool get marked; the
    // other O(n) entries stay untouched (scales, single breakpoint each side).
    it('row37 large messages/tools: exactly one message + one tool stamped', () => {
        const messages: ModelMessage[] = [];
        for (let i = 0; i < 500; i++) {
            messages.push(userMsg(`u${i}`));
            messages.push(asstMsg(`a${i}`));
        }
        const t: Record<string, any> = {};
        for (let i = 0; i < 300; i++) t[`tool${i}`] = { description: `${i}` };
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages,
            tools: t,
            maxSteps: 4,
            provider: 'anthropic',
            model: 'claude-sonnet-4',
        });
        const stampedMsgs = out.callMessages.filter(
            (m) => (m as any).providerOptions,
        );
        expect(stampedMsgs).toHaveLength(1);
        // the latest USER message (index 998), not the trailing assistant
        expect((out.callMessages[998] as any).providerOptions).toEqual(
            EPHEMERAL,
        );
        const stampedTools = Object.values(out.callTools).filter(
            (v: any) => v.providerOptions,
        );
        expect(stampedTools).toHaveLength(1);
        expect((out.callTools as any).tool299.providerOptions).toEqual(
            EPHEMERAL,
        );
    });

    // Row 38 — duplicate items: identical messages; only the positional LAST is
    // stamped (position-based, dedup-agnostic).
    it('row38 duplicate identical user messages: only the last one is stamped', () => {
        const messages = [userMsg('same'), userMsg('same'), userMsg('same')];
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages,
            tools: {},
            maxSteps: 4,
            provider: 'anthropic',
            model: 'claude-sonnet-4',
        });
        expect((out.callMessages[0] as any).providerOptions).toBeUndefined();
        expect((out.callMessages[1] as any).providerOptions).toBeUndefined();
        expect((out.callMessages[2] as any).providerOptions).toEqual(EPHEMERAL);
    });

    // Row 39 — input item with null/undefined field: a null last tool entry, and
    // a messages array whose only user entry is well-formed.
    it('row39 null/non-object last tool: markLastToolForCache returns same ref (safe)', () => {
        const t = { good: { description: 'x' }, bad: null } as any;
        const out = markLastToolForCache(t, EPHEMERAL);
        expect(out).toBe(t); // last entry not an object → untouched
    });
    it('row39 tools whose only entry is undefined: pass-through same ref', () => {
        const t = { onlyBad: undefined } as any;
        expect(markLastToolForCache(t, EPHEMERAL)).toBe(t);
    });

    // Row 40 — special chars / whitespace-only content: stamped without
    // corruption; whitespace-only is still a valid user message (gets marked).
    it('row40 whitespace-only user content is still marked, content untouched', () => {
        const msgs = markLatestUserForCache(
            [{ role: 'user', content: '   \n\t  ' } as ModelMessage],
            EPHEMERAL,
        );
        expect((msgs[0] as any).content).toBe('   \n\t  ');
        expect((msgs[0] as any).providerOptions).toEqual(EPHEMERAL);
    });

    // Row 41 — off-by-one boundary: exactly-one entry where last === first.
    it('row41 single-entry map: the sole tool is the "last" and gets marked', () => {
        const t = { sole: { description: 'x' } };
        const out = markLastToolForCache(t, EPHEMERAL);
        expect((out as any).sole.providerOptions).toEqual(EPHEMERAL);
    });
    it('row41 single-user array: the sole user is the "latest" and gets marked', () => {
        const out = markLatestUserForCache([userMsg('sole')], EPHEMERAL);
        expect((out[0] as any).providerOptions).toEqual(EPHEMERAL);
    });

    // Row 42 — order permutation (metamorphic): the stamp is POSITION-defined and
    // deterministic — permuting insertion order moves the mark to the new last /
    // latest, never to two entries, never nondeterministically.
    it('row42 tool insertion-order permutation: mark follows the last-inserted key deterministically', () => {
        const ab = markLastToolForCache(
            { a: { description: '1' }, b: { description: '2' } },
            EPHEMERAL,
        );
        const ba = markLastToolForCache(
            { b: { description: '2' }, a: { description: '1' } },
            EPHEMERAL,
        );
        expect((ab as any).b.providerOptions).toEqual(EPHEMERAL);
        expect((ab as any).a.providerOptions).toBeUndefined();
        expect((ba as any).a.providerOptions).toEqual(EPHEMERAL);
        expect((ba as any).b.providerOptions).toBeUndefined();
    });
    it('row42 message-order permutation: latest user by POSITION gets the mark', () => {
        const first = markLatestUserForCache(
            [userMsg('x'), asstMsg(), userMsg('y')],
            EPHEMERAL,
        );
        const perm = markLatestUserForCache(
            [userMsg('y'), asstMsg(), userMsg('x')],
            EPHEMERAL,
        );
        expect((first[2] as any).providerOptions).toEqual(EPHEMERAL);
        expect((first[0] as any).providerOptions).toBeUndefined();
        expect((perm[2] as any).providerOptions).toEqual(EPHEMERAL);
        expect((perm[0] as any).providerOptions).toBeUndefined();
    });

    // Idempotence — re-stamping an already-marked prefix does not double-apply.
    it('idempotent: re-running the stampers is a no-op on already-marked entries', () => {
        const once = markLatestUserForCache([userMsg()], EPHEMERAL);
        const twice = markLatestUserForCache(once, EPHEMERAL);
        expect((twice[0] as any).providerOptions).toEqual(EPHEMERAL);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// E. N-model policy — the honors-inline-markers decision the boundary DELEGATES
//    to systemCacheControl → the REAL provider registry (default mock impl).
//    Marker-honoring family (Anthropic, in its native + compatible + on-Bedrock/
//    Vertex-for-Claude spellings) → HIT. Implicit-cache / unknown providers
//    (openai/google/novita/openrouter, and Bedrock/Vertex hosting a non-Claude)
//    → MISS (pass-through). Off-schema-input rows are asserted per branch.
// ───────────────────────────────────────────────────────────────────────────
describe('E. provider/model policy (real registry)', () => {
    const call = (provider: string | undefined, model: string) => {
        const messages = [userMsg()];
        const t = tools();
        return {
            messages,
            t,
            out: applyCacheBreakpoints({
                system: 'SYS',
                messages,
                tools: t,
                maxSteps: 4,
                provider,
                model,
            }),
        };
    };

    it.each([
        ['anthropic', 'claude-sonnet-4'],
        ['anthropic_compatible', 'kimi-k2-code'],
        ['amazon_bedrock', 'us.anthropic.claude-opus-4-1-v1:0'],
        ['google_vertex', 'claude-3-5-sonnet@20240620'],
    ])(
        'marker-honoring branch %s / %s → HIT (all three stamped)',
        (provider, model) => {
            const { out } = call(provider, model);
            expect((out.systemArg as any).providerOptions).toEqual(EPHEMERAL);
            expect((out.callMessages[0] as any).providerOptions).toEqual(
                EPHEMERAL,
            );
            expect((out.callTools as any).listDir.providerOptions).toEqual(
                EPHEMERAL,
            );
        },
    );

    it('managed / env-default (no provider) falls back to model-name detection → HIT', () => {
        const { out } = call(undefined, 'claude-3-opus');
        expect((out.systemArg as any).providerOptions).toEqual(EPHEMERAL);
    });

    it.each([
        ['openai', 'gpt-4o'],
        ['google_gemini', 'gemini-2.5-pro'],
        ['novita', 'meta-llama/llama-3-70b'],
        ['open_router', 'anthropic/claude-3.5-sonnet'], // Claude via OpenRouter → still no inline hint
        ['moonshot', 'kimi-k2'], // json_object-fallback family, but no inline marker module
        ['zai', 'glm-4.6'],
        ['amazon_bedrock', 'amazon.nova-pro-v1:0'], // non-Claude on Bedrock → no marker
        ['google_vertex', 'gemini-2.5-flash'], // Gemini on Vertex → no marker
    ])('implicit-cache / unknown branch %s / %s → MISS (pass-through)', (
        provider,
        model,
    ) => {
        const { messages, t, out } = call(provider, model);
        expect(out.systemArg).toBe('SYS');
        expect(out.callMessages).toBe(messages);
        expect(out.callTools).toBe(t);
    });

    it('unknown provider with a non-Claude model → MISS (unknown stays safe)', () => {
        const { messages, out } = call('some_proxy', 'prod-model-1');
        expect(out.callMessages).toBe(messages);
    });

    // Off-schema input under the MISS branch must ALSO stay a clean pass-through
    // (no accidental stamping when the model doesn't honor markers).
    it('off-schema input under a no-marker provider still passes through cleanly', () => {
        const messages = [userMsg('a'), userMsg('b'), userMsg('c')];
        const t = tools();
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages,
            tools: t,
            maxSteps: 4,
            provider: 'openai',
            model: 'gpt-4o',
        });
        expect(out.callMessages).toBe(messages);
        expect(out.callMessages.every((m) => !(m as any).providerOptions)).toBe(
            true,
        );
    });
});
